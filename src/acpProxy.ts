import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { escapeRegExp } from './glob';
import { SECRET_PIPE_TOOL_NAME, SECRET_SCRATCH_TOOL_NAME } from './mcp';
import type { SecretScratchPad } from './pad';
import { readText, writePrivate } from './padFormat';
import { contextSecretHits, SHAPED_SECRET_PATTERNS } from './patterns';
import { privatePathDenial } from './privacy';
import { SECRET_SCRATCH_GUIDANCE } from './refs';

const SESSION_METHODS = new Set(['session/new', 'session/load', 'session/resume', 'session/fork']);

const OWN_TOOL_PATTERN = new RegExp(
  `^(?:(?:mcp__)?secret[-_]scratch(?:__|/|:|\\.))?(?:${SECRET_SCRATCH_TOOL_NAME}|${SECRET_PIPE_TOOL_NAME})$`,
  'i',
);

const BUILTIN_FS_SHELL_KINDS = new Set([
  'read',
  'search',
  'edit',
  'delete',
  'move',
  'execute',
  'fetch',
]);

const SCRUBBABLE_UPDATE_KEYS = new Set([
  'text',
  'data',
  'title',
  'message',
  'output',
  'stdout',
  'stderr',
  'newText',
  'oldText',
  'description',
  'summary',
  'rawOutput',
]);

const SCRUB_MIN_LENGTH = 6;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

interface SessionState {
  padId: string;
  cwd?: string;
  guidanceSent: boolean;
  messageCount: number;
  knownSecrets: Map<string, string>;
}

interface PendingSessionOpen {
  method: string;
  padId: string;
  cwd?: string;
  requestedSessionId?: string;
}

export interface AcpProxyOptions {
  readonly pad: SecretScratchPad;
  readonly mcpCommand: string;
  readonly mcpArgs: readonly string[];
  readonly liftShaped?: boolean;
  readonly scrubOutput?: boolean;
  readonly privatePaths?: readonly string[];
}

export function secretNotice(counts: {
  readonly recognised: number;
  readonly contextHits: number;
}): string | undefined {
  const parts: string[] = [];
  if (counts.recognised > 0) {
    parts.push(
      `Recognised ${counts.recognised === 1 ? 'a secret' : `${counts.recognised} secrets`} by shape and lifted ${counts.recognised === 1 ? 'it' : 'them'} into the scratch pad.`,
    );
  }
  if (counts.contextHits > 0) {
    parts.push(
      'A credential-like value may still be in plain text. Prefix secrets with $$ (for example $$token) so they stay out of the conversation.',
    );
  }
  return parts.length ? parts.join(' ') : undefined;
}

function loadSessionMap(padDir: string): Record<string, string> {
  const raw = readText(join(padDir, 'sessions.json'));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function mergeSessionMap(padDir: string, sessionId: string, padId: string): void {
  const latest = loadSessionMap(padDir);
  if (latest[sessionId] === padId) return;
  latest[sessionId] = padId;
  writePrivate(join(padDir, 'sessions.json'), JSON.stringify(latest, null, 2));
}

function makePadId(): string {
  return `s_${randomBytes(6).toString('hex')}`;
}

function sanitizePadId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9_.:-]/g, '_');
  return /^[A-Za-z0-9_:-]/.test(cleaned) ? cleaned : `s_${cleaned}`;
}

function isOwnSecretTool(toolName: string, kind: string): boolean {
  if (kind && BUILTIN_FS_SHELL_KINDS.has(kind.toLowerCase())) return false;
  return OWN_TOOL_PATTERN.test(toolName.trim());
}

function nextMessageCounter(pad: SecretScratchPad, padId: string): number {
  let max = 0;
  try {
    for (const summary of pad.list(padId)) {
      for (const dagger of summary.daggers) {
        const match = /^m(\d+)$/.exec(dagger.message);
        if (match?.[1]) max = Math.max(max, Number(match[1]));
      }
    }
  } catch {
    /* ignore unreadable or missing pad */
  }
  return max;
}

function extractPermissionToolInput(toolCall: Record<string, unknown>): {
  toolName: string;
  kind: string;
  toolInput: Record<string, unknown>;
} {
  const title = typeof toolCall.title === 'string' ? toolCall.title : '';
  const kind = typeof toolCall.kind === 'string' ? toolCall.kind : '';
  const rawInput =
    toolCall.rawInput && typeof toolCall.rawInput === 'object' && !Array.isArray(toolCall.rawInput)
      ? { ...(toolCall.rawInput as Record<string, unknown>) }
      : {};

  const extraPaths: string[] = [];
  if (Array.isArray(toolCall.locations)) {
    for (const loc of toolCall.locations) {
      const path = loc && typeof loc === 'object' ? (loc as { path?: unknown }).path : undefined;
      if (typeof path === 'string' && path.length > 0) extraPaths.push(path);
    }
  }
  if (Array.isArray(toolCall.content)) {
    for (const item of toolCall.content) {
      if (!item || typeof item !== 'object') continue;
      const path = (item as { path?: unknown }).path;
      if (typeof path === 'string' && path.length > 0) extraPaths.push(path);
    }
  }
  if (extraPaths.length > 0) {
    const existing = Array.isArray(rawInput.paths) ? rawInput.paths : [];
    rawInput.paths = [...existing, ...extraPaths];
  }
  if (title && !isOwnSecretTool(title, kind) && typeof rawInput.command !== 'string') {
    rawInput.cmd = title;
  }

  return {
    toolName: title || kind || 'tool',
    kind,
    toolInput: rawInput,
  };
}

function pickRejectOptionId(options: unknown): string | undefined {
  if (!Array.isArray(options)) return undefined;
  const items = options.filter(
    (opt): opt is { optionId?: unknown; kind?: unknown } => Boolean(opt) && typeof opt === 'object',
  );
  const rejectOnce = items.find(
    (opt) => opt.kind === 'reject_once' && typeof opt.optionId === 'string',
  );
  if (rejectOnce) return rejectOnce.optionId as string;
  const rejectAlways = items.find(
    (opt) => opt.kind === 'reject_always' && typeof opt.optionId === 'string',
  );
  if (rejectAlways) return rejectAlways.optionId as string;
  return undefined;
}

function makeScrubber(
  knownSecrets: ReadonlyMap<string, string>,
): ((text: string) => string) | undefined {
  const entries = [...knownSecrets.entries()]
    .filter(([value]) => value.length >= SCRUB_MIN_LENGTH)
    .sort(([a], [b]) => b.length - a.length);
  if (entries.length === 0) return undefined;
  const pattern = new RegExp(entries.map(([value]) => escapeRegExp(value)).join('|'), 'g');
  return (text: string) => text.replace(pattern, (matched) => knownSecrets.get(matched) ?? matched);
}

function scrubUpdateFields(value: unknown, scrub: (text: string) => string, key?: string): unknown {
  if (typeof value === 'string') {
    return key && SCRUBBABLE_UPDATE_KEYS.has(key) ? scrub(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubUpdateFields(item, scrub, key));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubUpdateFields(v, scrub, k);
    }
    return out;
  }
  return value;
}

export interface AcpProxyController {
  handleClientMessage(message: unknown): {
    forward?: unknown;
    respondToClient?: unknown;
  };
  handleAgentMessage(message: unknown): {
    forward?: unknown;
    respondToAgent?: unknown;
  };
}

export function createAcpProxy(options: AcpProxyOptions): AcpProxyController {
  const { pad, mcpCommand, mcpArgs, liftShaped = true, scrubOutput = true, privatePaths } = options;
  const sessions = new Map<string, SessionState>();
  const pendingOpens = new Map<string, PendingSessionOpen>();

  function upsertSession(sessionId: string, padId: string, cwd?: string): SessionState {
    const existing = sessions.get(sessionId);
    const state: SessionState = {
      padId,
      cwd: cwd ?? existing?.cwd,
      guidanceSent: existing?.guidanceSent ?? false,
      messageCount: existing?.messageCount ?? nextMessageCounter(pad, padId),
      knownSecrets: existing?.knownSecrets ?? new Map(),
    };
    sessions.set(sessionId, state);
    mergeSessionMap(pad.dir, sessionId, padId);
    return state;
  }

  function getOrCreateSession(sessionId: string): SessionState {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    const persisted = loadSessionMap(pad.dir);
    const padId = persisted[sessionId] ?? sanitizePadId(sessionId);
    const state: SessionState = {
      padId,
      guidanceSent: false,
      messageCount: nextMessageCounter(pad, padId),
      knownSecrets: new Map(),
    };
    sessions.set(sessionId, state);
    return state;
  }

  function buildMcpEntry(padId: string, cwd?: string): Record<string, unknown> {
    const args = [...mcpArgs, '--dir', pad.dir, '--thread', padId];
    if (cwd) args.push('--cwd', cwd);
    return {
      name: 'secret-scratch',
      command: mcpCommand,
      args,
      env: [],
    };
  }

  function checkDenial(
    sessionId: string | undefined,
    toolName: string,
    toolInput: Record<string, unknown>,
    kind = '',
  ): string | undefined {
    const session = sessionId ? sessions.get(sessionId) : undefined;
    return privatePathDenial(
      { toolName, toolInput },
      {
        scratchDir: pad.dir,
        heldFiles: pad.heldFiles(),
        privatePaths,
        cwd: session?.cwd,
        isOwnTool: () => isOwnSecretTool(toolName, kind),
      },
    );
  }

  function rememberLiftedValues(session: SessionState, refs: readonly string[]): void {
    for (const ref of refs) {
      void pad.use(ref, session.padId, (value) => {
        if (value.length >= SCRUB_MIN_LENGTH) session.knownSecrets.set(value, ref);
      });
    }
  }

  function handleClientMessage(raw: unknown): { forward?: unknown; respondToClient?: unknown } {
    if (!raw || typeof raw !== 'object') return { forward: raw };
    const msg = raw as JsonRpcMessage;

    if (typeof msg.method === 'string' && SESSION_METHODS.has(msg.method)) {
      const params =
        msg.params && typeof msg.params === 'object'
          ? { ...msg.params }
          : ({} as Record<string, unknown>);
      const cwd = typeof params.cwd === 'string' ? params.cwd : undefined;
      const requestedSessionId =
        typeof params.sessionId === 'string' ? params.sessionId : undefined;
      const persisted = loadSessionMap(pad.dir);
      const existingPadId = requestedSessionId
        ? (persisted[requestedSessionId] ?? sessions.get(requestedSessionId)?.padId)
        : undefined;
      const padId = existingPadId ?? makePadId();

      const existingServers = Array.isArray(params.mcpServers)
        ? params.mcpServers.filter(
            (server) =>
              !(
                server &&
                typeof server === 'object' &&
                (server as { name?: unknown }).name === 'secret-scratch'
              ),
          )
        : [];
      params.mcpServers = [...existingServers, buildMcpEntry(padId, cwd)];

      if (msg.id !== undefined && msg.id !== null) {
        pendingOpens.set(String(msg.id), {
          method: msg.method,
          padId,
          cwd,
          requestedSessionId,
        });
      }
      if (
        requestedSessionId &&
        (msg.method === 'session/load' || msg.method === 'session/resume')
      ) {
        upsertSession(requestedSessionId, padId, cwd);
      }

      return { forward: { ...msg, params } };
    }

    if (msg.method === 'session/prompt' && msg.params && typeof msg.params === 'object') {
      const params = { ...msg.params };
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : 'default';
      const session = getOrCreateSession(sessionId);
      const prompt = Array.isArray(params.prompt) ? params.prompt : undefined;
      if (!prompt) return { forward: raw };

      session.messageCount += 1;
      const messageId = `m${session.messageCount}`;
      let totalRefs = 0;
      let totalRecognised = 0;
      let totalContextHits = 0;

      const patterns = liftShaped ? SHAPED_SECRET_PATTERNS : [];
      const liftText = (text: string): { text: string; changed: boolean } => {
        const lifted = pad.lift(text, { thread: session.padId, message: messageId }, { patterns });
        totalRefs += lifted.refs.length;
        totalRecognised += lifted.recognised;
        totalContextHits += contextSecretHits(lifted.text);
        if (lifted.refs.length > 0) rememberLiftedValues(session, lifted.refs);
        return { text: lifted.text, changed: lifted.refs.length > 0 };
      };

      const nextPrompt = prompt.map((block) => {
        if (!block || typeof block !== 'object') return block;
        const typed = block as Record<string, unknown>;
        if (typed.type === 'text' && typeof typed.text === 'string') {
          const out = liftText(typed.text);
          return out.changed ? { ...typed, text: out.text } : block;
        }
        if (
          typed.type === 'resource' &&
          typed.resource &&
          typeof typed.resource === 'object' &&
          typeof (typed.resource as { text?: unknown }).text === 'string'
        ) {
          const resource = typed.resource as Record<string, unknown>;
          const out = liftText(resource.text as string);
          return out.changed ? { ...typed, resource: { ...resource, text: out.text } } : block;
        }
        return block;
      });

      const notice = secretNotice({ recognised: totalRecognised, contextHits: totalContextHits });
      const extraLines: string[] = [];
      if (totalRefs > 0 && !session.guidanceSent) {
        session.guidanceSent = true;
        extraLines.push(SECRET_SCRATCH_GUIDANCE);
      }
      if (notice) extraLines.push(notice);

      if (extraLines.length > 0) {
        nextPrompt.push({
          type: 'text',
          text: `[secret-scratch]\n${extraLines.join('\n')}`,
        });
      }

      return { forward: { ...msg, params: { ...params, prompt: nextPrompt } } };
    }

    return { forward: raw };
  }

  function handleAgentMessage(raw: unknown): { forward?: unknown; respondToAgent?: unknown } {
    if (!raw || typeof raw !== 'object') return { forward: raw };
    const msg = raw as JsonRpcMessage;

    if (!msg.method && msg.id !== undefined && msg.id !== null) {
      const pending = pendingOpens.get(String(msg.id));
      if (pending) {
        pendingOpens.delete(String(msg.id));
        const returnedId =
          typeof msg.result?.sessionId === 'string'
            ? msg.result.sessionId
            : pending.requestedSessionId;
        if (returnedId && !msg.error) {
          upsertSession(returnedId, pending.padId, pending.cwd);
        }
      }
      return { forward: raw };
    }

    const params = msg.params && typeof msg.params === 'object' ? msg.params : undefined;
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : undefined;

    if (msg.method === 'session/request_permission' && params) {
      const toolCall =
        params.toolCall && typeof params.toolCall === 'object'
          ? (params.toolCall as Record<string, unknown>)
          : {};
      const { toolName, kind, toolInput } = extractPermissionToolInput(toolCall);
      const denial = checkDenial(sessionId, toolName, toolInput, kind);
      if (denial) {
        if (msg.id === undefined) return {};
        const optionId = pickRejectOptionId(params.options);
        return {
          respondToAgent: {
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' },
            },
          },
        };
      }
      return { forward: raw };
    }

    if ((msg.method === 'fs/read_text_file' || msg.method === 'fs/write_text_file') && params) {
      const denial = checkDenial(sessionId, msg.method, { path: params.path });
      if (denial) {
        if (msg.id === undefined) return {};
        return {
          respondToAgent: {
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32000, message: denial },
          },
        };
      }
      return { forward: raw };
    }

    if (msg.method === 'terminal/create' && params) {
      const denial = checkDenial(sessionId, 'terminal/create', {
        command: params.command,
        args: params.args,
        cwd: params.cwd,
        env: params.env,
      });
      if (denial) {
        if (msg.id === undefined) return {};
        return {
          respondToAgent: {
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32000, message: denial },
          },
        };
      }
      return { forward: raw };
    }

    if (scrubOutput && msg.method === 'session/update' && params?.update) {
      const session = sessionId ? sessions.get(sessionId) : undefined;
      const inMemoryScrubber = session ? makeScrubber(session.knownSecrets) : undefined;
      const padId = session?.padId ?? (sessionId ? loadSessionMap(pad.dir)[sessionId] : undefined);
      if (inMemoryScrubber || padId) {
        const scrub = inMemoryScrubber
          ? inMemoryScrubber
          : (text: string) => (padId ? pad.scrub(padId, text) : text);
        const scrubbed = scrubUpdateFields(params.update, scrub);
        return { forward: { ...msg, params: { ...params, update: scrubbed } } };
      }
    }

    return { forward: raw };
  }

  return { handleClientMessage, handleAgentMessage };
}

export interface RunAcpProxyOptions extends AcpProxyOptions {
  readonly agentCommand: string;
  readonly agentArgs: readonly string[];
  readonly clientIn?: Readable;
  readonly clientOut?: Writable;
  readonly stderr?: Writable;
}

function writeJsonLine(stream: Writable, message: unknown): void {
  if (!stream.destroyed && stream.writable) {
    stream.write(`${JSON.stringify(message)}\n`);
  }
}

export function runAcpProxy(options: RunAcpProxyOptions): Promise<number> {
  const clientIn = options.clientIn ?? process.stdin;
  const clientOut = options.clientOut ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const proxy = createAcpProxy(options);

  const child: ChildProcess = spawn(options.agentCommand, [...options.agentArgs], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  clientIn.on('error', () => undefined);
  clientOut.on('error', () => undefined);
  child.stdin?.on('error', () => undefined);
  child.stdout?.on('error', () => undefined);

  return new Promise((resolve) => {
    let settled = false;
    const clientLines = createInterface({ input: clientIn, crlfDelay: Number.POSITIVE_INFINITY });
    const agentLines = child.stdout
      ? createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY })
      : undefined;

    const forwardSignal = (signal: NodeJS.Signals): void => {
      if (!child.killed) child.kill(signal);
    };
    process.on('SIGINT', forwardSignal);
    process.on('SIGTERM', forwardSignal);

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', forwardSignal);
      process.off('SIGTERM', forwardSignal);
      clientLines.close();
      agentLines?.close();
      resolve(code);
    };

    child.on('error', (error) => {
      if (!stderr.destroyed && stderr.writable) {
        stderr.write(`secret-scratch: failed to spawn ${options.agentCommand}: ${error.message}\n`);
      }
      finish(1);
    });

    child.on('close', (code, signal) => {
      finish(code ?? (signal ? 128 : 1));
    });

    clientLines.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        if (child.stdin && !child.stdin.destroyed && child.stdin.writable) {
          child.stdin.write(`${line}\n`);
        }
        return;
      }
      const outcome = proxy.handleClientMessage(parsed);
      if (outcome.forward !== undefined && child.stdin) {
        writeJsonLine(child.stdin, outcome.forward);
      }
      if (outcome.respondToClient !== undefined) {
        writeJsonLine(clientOut, outcome.respondToClient);
      }
    });
    clientLines.on('close', () => {
      if (child.stdin && !child.stdin.destroyed) child.stdin.end();
    });

    agentLines?.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        if (!clientOut.destroyed && clientOut.writable) clientOut.write(`${line}\n`);
        return;
      }
      const outcome = proxy.handleAgentMessage(parsed);
      if (outcome.forward !== undefined) {
        writeJsonLine(clientOut, outcome.forward);
      }
      if (outcome.respondToAgent !== undefined && child.stdin) {
        writeJsonLine(child.stdin, outcome.respondToAgent);
      }
    });
  });
}
