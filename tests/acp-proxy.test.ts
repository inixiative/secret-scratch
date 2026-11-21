import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createAcpProxy, runAcpProxy, SecretScratchPad } from '../src';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'acp-scratch-'));
  dirs.push(root);
  const pad = new SecretScratchPad(join(root, '.private', 'scratch'));
  return { root, pad };
}

describe('createAcpProxy unit behavior', () => {
  test('injects MCP server on session/new, lifts $$ and shaped secrets on session/prompt, blocks private reads, and scrubs updates', () => {
    const { root, pad } = setup();
    const proxy = createAcpProxy({
      pad,
      mcpCommand: process.execPath,
      mcpArgs: ['cli.js', 'mcp'],
    });

    const newReq = proxy.handleClientMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/new',
      params: { cwd: root, mcpServers: [{ name: 'other', command: 'echo', args: [], env: [] }] },
    });
    const forwardedNew = newReq.forward as {
      params: { mcpServers: Array<{ name: string; args: string[] }> };
    };
    expect(forwardedNew.params.mcpServers.map((s) => s.name)).toEqual(['other', 'secret-scratch']);
    const injectedArgs = forwardedNew.params.mcpServers[1]?.args ?? [];
    expect(injectedArgs).toContain('--dir');
    expect(injectedArgs).toContain('--cwd');

    proxy.handleAgentMessage({
      jsonrpc: '2.0',
      id: 1,
      result: { sessionId: 'sess_abc' },
    });

    const secretA = 'my-manual-secret-99';
    const secretB = 'ghp_1234567890abcdefghij123456';
    const promptReq = proxy.handleClientMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: {
        sessionId: 'sess_abc',
        prompt: [{ type: 'text', text: `Set STRIPE to $$${secretA} and GH to ${secretB}` }],
      },
    });
    const forwardedPrompt = promptReq.forward as {
      params: { prompt: Array<{ type: string; text: string }> };
    };
    expect(forwardedPrompt.params.prompt[0]?.text).toBe('Set STRIPE to †m1.1 and GH to †m1.2');
    expect(JSON.stringify(forwardedPrompt)).not.toContain(secretA);
    expect(JSON.stringify(forwardedPrompt)).not.toContain(secretB);
    expect(forwardedPrompt.params.prompt[1]?.text).toContain('secret_scratch');
    expect(forwardedPrompt.params.prompt[1]?.text).toContain('Recognised a secret by shape');

    const padId = pad.threads()[0] ?? '';
    expect(padId).not.toBe('');
    pad.env({ ref: '†m1.1' }, padId, '.env.local', 'STRIPE_KEY', { cwd: root });

    const permRead = proxy.handleAgentMessage({
      jsonrpc: '2.0',
      id: 10,
      method: 'session/request_permission',
      params: {
        sessionId: 'sess_abc',
        toolCall: {
          toolCallId: 'tc_1',
          title: 'Read .env.local',
          kind: 'read',
          rawInput: { file_path: '.env.local' },
        },
        options: [
          { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
    expect(permRead.forward).toBeUndefined();
    expect(permRead.respondToAgent).toEqual({
      jsonrpc: '2.0',
      id: 10,
      result: { outcome: { outcome: 'selected', optionId: 'reject_once' } },
    });

    const ownToolPerm = proxy.handleAgentMessage({
      jsonrpc: '2.0',
      id: 11,
      method: 'session/request_permission',
      params: {
        sessionId: 'sess_abc',
        toolCall: {
          toolCallId: 'tc_2',
          title: 'mcp__secret-scratch__secret_scratch',
          rawInput: { action: 'env', path: '.env.local', key: 'STRIPE_KEY', ref: '†m1.1' },
        },
        options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }],
      },
    });
    expect(ownToolPerm.forward).toBeDefined();
    expect(ownToolPerm.respondToAgent).toBeUndefined();

    const fsRead = proxy.handleAgentMessage({
      jsonrpc: '2.0',
      id: 12,
      method: 'fs/read_text_file',
      params: { sessionId: 'sess_abc', path: join(root, '.env.local') },
    });
    expect(fsRead.forward).toBeUndefined();
    expect((fsRead.respondToAgent as { error: { code: number } }).error.code).toBe(-32000);

    const termRead = proxy.handleAgentMessage({
      jsonrpc: '2.0',
      id: 13,
      method: 'terminal/create',
      params: {
        sessionId: 'sess_abc',
        command: '/bin/sh',
        args: ['-c', 'cat .env.local'],
        cwd: root,
      },
    });
    expect(termRead.forward).toBeUndefined();
    expect((termRead.respondToAgent as { error: { code: number } }).error.code).toBe(-32000);

    const fsWriteHeld = proxy.handleAgentMessage({
      jsonrpc: '2.0',
      id: 14,
      method: 'fs/write_text_file',
      params: { sessionId: 'sess_abc', path: join(pad.dir, 'held-files.json'), content: '[]' },
    });
    expect(fsWriteHeld.forward).toBeUndefined();
    expect((fsWriteHeld.respondToAgent as { error: { code: number } }).error.code).toBe(-32000);

    const spoofedTitle = proxy.handleAgentMessage({
      jsonrpc: '2.0',
      id: 15,
      method: 'session/request_permission',
      params: {
        sessionId: 'sess_abc',
        toolCall: {
          toolCallId: 'tc_spoof',
          title: 'Bash: echo :secret_pipe && cat .env.local',
          kind: 'execute',
          rawInput: { command: 'echo :secret_pipe && cat .env.local' },
        },
        options: [{ optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }],
      },
    });
    expect(spoofedTitle.forward).toBeUndefined();
    expect(spoofedTitle.respondToAgent).toEqual({
      jsonrpc: '2.0',
      id: 15,
      result: { outcome: { outcome: 'selected', optionId: 'reject_once' } },
    });

    const update = proxy.handleAgentMessage({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess_abc',
        update: {
          sessionUpdate: 'agent_message_chunk',
          status: 'completed',
          content: { type: 'text', text: `Echoing ${secretA} accidentally` },
        },
      },
    });
    expect(JSON.stringify(update.forward)).not.toContain(secretA);
    expect(JSON.stringify(update.forward)).toContain('†m1.1');
    expect(
      (update.forward as { params: { update: { status: string } } }).params.update.status,
    ).toBe('completed');
  });

  test('persists sessionId -> padId mapping across session/load restarts', () => {
    const { root, pad } = setup();
    const proxyA = createAcpProxy({ pad, mcpCommand: 'node', mcpArgs: ['cli.js', 'mcp'] });
    proxyA.handleClientMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/new',
      params: { cwd: root, mcpServers: [] },
    });
    proxyA.handleAgentMessage({
      jsonrpc: '2.0',
      id: 1,
      result: { sessionId: 'persisted_session_1' },
    });
    proxyA.handleClientMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: {
        sessionId: 'persisted_session_1',
        prompt: [{ type: 'text', text: 'save $$persist_me_999' }],
      },
    });

    const proxyB = createAcpProxy({ pad, mcpCommand: 'node', mcpArgs: ['cli.js', 'mcp'] });
    const loaded = proxyB.handleClientMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/load',
      params: { sessionId: 'persisted_session_1', cwd: root, mcpServers: [] },
    });
    const mcpArgs =
      (loaded.forward as { params: { mcpServers: Array<{ args: string[] }> } }).params.mcpServers[0]
        ?.args ?? [];
    const threadArg = mcpArgs[mcpArgs.indexOf('--thread') + 1];
    expect(threadArg).toBe(pad.threads()[0]);
  });
});

describe('runAcpProxy end-to-end subprocess flow', () => {
  test('proxies stdio between host and a mock ACP agent process', async () => {
    const { root, pad } = setup();
    const mockAgentPath = join(root, 'mock-agent.mjs');
    const seenPromptsPath = join(root, 'seen-prompts.json');
    const mockAgentScript = `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const rl = createInterface({ input: process.stdin });
const seen = [];

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'session/new') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: { sessionId: 'mock_sess_1', mcpCount: (msg.params?.mcpServers ?? []).length }
    }) + '\\n');
    return;
  }
  if (msg.method === 'session/prompt') {
    seen.push(msg.params.prompt);
    writeFileSync(${JSON.stringify(seenPromptsPath)}, JSON.stringify(seen));
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 99,
      method: 'fs/read_text_file',
      params: { sessionId: 'mock_sess_1', path: ${JSON.stringify(join(pad.dir, 'x.pad'))} }
    }) + '\\n');
    return;
  }
  if (msg.id === 99) {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: { stopReason: 'end_turn', blockedError: msg.error?.message ?? null }
    }) + '\\n');
    rl.close();
  }
});
`;
    writeFileSync(mockAgentPath, mockAgentScript);

    const clientIn = new PassThrough();
    const clientOut = new PassThrough();
    const received: Array<Record<string, unknown>> = [];
    let buffer = '';
    clientOut.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) received.push(JSON.parse(line) as Record<string, unknown>);
      }
    });

    const proxyPromise = runAcpProxy({
      pad,
      agentCommand: process.execPath,
      agentArgs: [mockAgentPath],
      mcpCommand: process.execPath,
      mcpArgs: ['cli.js', 'mcp'],
      clientIn,
      clientOut,
    });

    clientIn.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'session/new',
        params: { cwd: root, mcpServers: [] },
      })}\n`,
    );
    await new Promise((r) => setTimeout(r, 150));

    clientIn.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/prompt',
        params: {
          sessionId: 'mock_sess_1',
          prompt: [{ type: 'text', text: 'Deploy with $$real_prod_secret_888' }],
        },
      })}\n`,
    );

    const exitCode = await proxyPromise;
    expect(exitCode).toBe(0);

    const seenByAgent = readFileSync(seenPromptsPath, 'utf8');
    expect(seenByAgent).toContain('†m1.1');
    expect(seenByAgent).not.toContain('real_prod_secret_888');

    const promptResp = received.find((m) => m.id === 2);
    expect((promptResp?.result as { blockedError?: string })?.blockedError).toContain('is private');
  });
});
