import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { SecretScratchPad } from './pad';
import { scratchTarget } from './privacy';
import { parseScratchRef } from './refs';
import { type ScratchSource, SecretScratchError } from './types';
import { PACKAGE_VERSION } from './version';

export const SECRET_SCRATCH_TOOL_NAME = 'secret_scratch';
export const SECRET_PIPE_TOOL_NAME = 'secret_pipe';

const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
const MIN_PIPE_TIMEOUT_MS = 1_000;
const MAX_PIPE_TIMEOUT_MS = 300_000;

export const SECRET_SCRATCH_TOOLS = [
  {
    name: SECRET_SCRATCH_TOOL_NAME,
    description:
      'Use secrets held in the thread scratch pad (references like †m1.1) without ever reading their values. Supports list, env (set KEY in a dotenv file), write (replace or append a file), and consume (drop a held reference). Every file written becomes private and cannot be read back.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'env', 'write', 'consume'],
          description: 'Operation to perform on the scratch pad.',
        },
        ref: {
          type: 'string',
          description: 'Scratch pad reference like †m1.1.',
        },
        thread: {
          type: 'string',
          description:
            'Optional thread id for action=list (restricted to current session by default).',
        },
        path: {
          type: 'string',
          description: 'Target file path inside the working directory for env or write.',
        },
        key: {
          type: 'string',
          description: 'Environment variable name (e.g. STRIPE_SECRET_KEY) for action=env.',
        },
        mode: {
          type: 'string',
          enum: ['replace', 'append'],
          description: 'Write mode for action=write (default: replace).',
        },
        consume: {
          type: 'boolean',
          description: 'Remove the reference from the pad after a successful env or write.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: SECRET_PIPE_TOOL_NAME,
    description:
      'Run a shell command with a secret value piped to its stdin. Command stdout and stderr are discarded; only the numeric exitCode is returned. Source is either a held scratch pad reference (ref) or an existing envFile + key.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description:
            'Shell command that reads the secret from stdin (e.g. gh secret set API_KEY).',
        },
        ref: {
          type: 'string',
          description: 'Scratch pad reference like †m1.1.',
        },
        envFile: {
          type: 'string',
          description: 'Env file path inside the working directory (used with key).',
        },
        key: {
          type: 'string',
          description: 'Key inside envFile to pipe to command stdin.',
        },
        consume: {
          type: 'boolean',
          description: 'Remove ref from the pad if the command exits with code 0.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Timeout in milliseconds (1000-300000, default 120000).',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
] as const;

export interface SecretScratchMcpOptions {
  readonly pad: SecretScratchPad;
  readonly thread: string;
  readonly cwd?: string;
  readonly serverVersion?: string;
  readonly allowCrossThread?: boolean;
}

interface JsonRpcRequest {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SecretScratchError(`${field} must be a non-empty string.`);
  }
  return value;
}

function asOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return asString(value, field);
}

function asOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new SecretScratchError(`${field} must be a boolean.`);
  return value;
}

function toolResult(
  payload: unknown,
  isError = false,
): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function createSecretScratchMcpHandler(
  options: SecretScratchMcpOptions,
): (request: unknown) => Promise<JsonRpcResponse | undefined> {
  const { pad, thread, cwd, serverVersion = PACKAGE_VERSION, allowCrossThread = false } = options;

  function assertAllowedRef(ref: string): void {
    const parsed = parseScratchRef(ref, thread);
    if (!allowCrossThread && parsed.thread !== thread) {
      throw new SecretScratchError(
        `Cross-session reference ${ref} is not permitted from this session.`,
      );
    }
  }

  async function runTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    try {
      if (name === SECRET_SCRATCH_TOOL_NAME) {
        const action = asString(args.action, 'action');
        if (action === 'list') {
          const targetThread = asOptionalString(args.thread, 'thread');
          if (!allowCrossThread && targetThread && targetThread !== thread) {
            throw new SecretScratchError(
              'Cross-session scratch pad listing is not permitted from this session.',
            );
          }
          return toolResult({ pads: pad.list(targetThread ?? thread) });
        }
        if (action === 'consume') {
          const ref = asString(args.ref, 'ref');
          assertAllowedRef(ref);
          pad.consume(ref, thread);
          return toolResult({ ok: true, consumed: ref });
        }
        if (action === 'env') {
          const ref = asString(args.ref, 'ref');
          assertAllowedRef(ref);
          const path = asString(args.path, 'path');
          const key = asString(args.key, 'key');
          const consume = asOptionalBoolean(args.consume, 'consume');
          const target = scratchTarget(cwd, path);
          pad.env({ ref }, thread, target, key, { consume, cwd });
          return toolResult({ ok: true, action: 'env', path, key, consumed: Boolean(consume) });
        }
        if (action === 'write') {
          const ref = asString(args.ref, 'ref');
          assertAllowedRef(ref);
          const path = asString(args.path, 'path');
          const consume = asOptionalBoolean(args.consume, 'consume');
          const modeRaw = args.mode;
          if (modeRaw !== undefined && modeRaw !== 'replace' && modeRaw !== 'append') {
            throw new SecretScratchError("mode must be 'replace' or 'append'.");
          }
          const target = scratchTarget(cwd, path);
          pad.write({ ref }, thread, target, { mode: modeRaw, consume, cwd });
          return toolResult({
            ok: true,
            action: 'write',
            path,
            mode: modeRaw ?? 'replace',
            consumed: Boolean(consume),
          });
        }
        throw new SecretScratchError(`Unknown action: ${action}`);
      }

      if (name === SECRET_PIPE_TOOL_NAME) {
        const command = asString(args.command, 'command');
        const ref = asOptionalString(args.ref, 'ref');
        const envFile = asOptionalString(args.envFile, 'envFile');
        const key = asOptionalString(args.key, 'key');
        const consume = asOptionalBoolean(args.consume, 'consume');
        let timeoutMs: number | undefined;
        if (args.timeoutMs !== undefined) {
          if (
            typeof args.timeoutMs !== 'number' ||
            !Number.isFinite(args.timeoutMs) ||
            args.timeoutMs < MIN_PIPE_TIMEOUT_MS ||
            args.timeoutMs > MAX_PIPE_TIMEOUT_MS
          ) {
            throw new SecretScratchError(
              `timeoutMs must be between ${MIN_PIPE_TIMEOUT_MS} and ${MAX_PIPE_TIMEOUT_MS}.`,
            );
          }
          timeoutMs = Math.floor(args.timeoutMs);
        }

        let source: ScratchSource;
        if (ref && !envFile && !key) {
          assertAllowedRef(ref);
          source = { ref };
        } else if (!ref && envFile && key) {
          source = { envFile: scratchTarget(cwd, envFile), key };
        } else {
          throw new SecretScratchError('Provide either ref, or envFile and key (not both).');
        }

        const result = await pad.pipe(source, thread, command, { consume, cwd, timeoutMs });
        return toolResult({
          ok: result.exitCode === 0,
          exitCode: result.exitCode,
          consumed: Boolean(consume && ref && result.exitCode === 0),
        });
      }

      throw new SecretScratchError(`Unknown tool: ${name}`);
    } catch (error) {
      const message =
        error instanceof SecretScratchError ? error.message : 'Secret scratch operation failed.';
      return toolResult({ error: message }, true);
    }
  }

  return async (raw: unknown): Promise<JsonRpcResponse | undefined> => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' },
      };
    }
    const req = raw as JsonRpcRequest;
    const hasId = req.id !== undefined;
    const id = req.id ?? null;

    if (req.method === 'notifications/initialized' || req.method === 'notifications/cancelled') {
      return undefined;
    }

    if (req.method === 'initialize') {
      if (!hasId) return undefined;
      const clientVersion =
        typeof req.params?.protocolVersion === 'string'
          ? req.params.protocolVersion
          : DEFAULT_PROTOCOL_VERSION;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: clientVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'secret-scratch', version: serverVersion },
        },
      };
    }

    if (req.method === 'ping') {
      return hasId ? { jsonrpc: '2.0', id, result: {} } : undefined;
    }

    if (req.method === 'tools/list') {
      return hasId ? { jsonrpc: '2.0', id, result: { tools: SECRET_SCRATCH_TOOLS } } : undefined;
    }

    if (req.method === 'tools/call') {
      const name = typeof req.params?.name === 'string' ? req.params.name : '';
      const rawArgs = req.params?.arguments;
      const args =
        rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : {};
      const result = await runTool(name, args);
      return hasId ? { jsonrpc: '2.0', id, result } : undefined;
    }

    if (!hasId) return undefined;
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${String(req.method ?? '')}` },
    };
  };
}

function writeLineSafe(stream: Writable, payload: unknown): void {
  if (!stream.destroyed && stream.writable) {
    stream.write(`${JSON.stringify(payload)}\n`);
  }
}

export function serveSecretScratchMcp(
  options: SecretScratchMcpOptions & {
    readonly input?: Readable;
    readonly output?: Writable;
  },
): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const handle = createSecretScratchMcpHandler(options);

  input.on('error', () => undefined);
  output.on('error', () => undefined);

  return new Promise((resolve) => {
    const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    const inflight = new Set<Promise<void>>();

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        writeLineSafe(output, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        });
        return;
      }
      const task = handle(parsed)
        .then((response) => {
          if (response) writeLineSafe(output, response);
        })
        .catch(() => {
          /* prevent unhandled rejection from terminating the server */
        })
        .finally(() => {
          inflight.delete(task);
        });
      inflight.add(task);
    });

    rl.on('close', () => {
      void Promise.allSettled([...inflight]).then(() => resolve());
    });
  });
}
