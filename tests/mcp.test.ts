import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSecretScratchMcpHandler,
  SECRET_PIPE_TOOL_NAME,
  SECRET_SCRATCH_TOOL_NAME,
  SecretScratchPad,
} from '../src';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'mcp-scratch-'));
  dirs.push(root);
  const pad = new SecretScratchPad(join(root, '.private', 'scratch'));
  const handle = createSecretScratchMcpHandler({ pad, thread: 'thr_1', cwd: root });
  return { root, pad, handle };
}

function parseToolPayload(res: { result?: unknown } | undefined): Record<string, unknown> {
  const result = res?.result as { content?: Array<{ text?: string }>; isError?: boolean };
  return JSON.parse(result.content?.[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('MCP server handler', () => {
  test('responds to initialize, ping, and tools/list', async () => {
    const { handle } = setup();
    const init = await handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    });
    expect(init?.result).toMatchObject({
      protocolVersion: '2025-03-26',
      serverInfo: { name: 'secret-scratch' },
    });

    const ping = await handle({ jsonrpc: '2.0', id: 2, method: 'ping' });
    expect(ping).toEqual({ jsonrpc: '2.0', id: 2, result: {} });

    const list = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const names = ((list?.result as { tools: Array<{ name: string }> }).tools ?? []).map(
      (t) => t.name,
    );
    expect(names).toEqual([SECRET_SCRATCH_TOOL_NAME, SECRET_PIPE_TOOL_NAME]);
  });

  test('declares all four tool annotation hints as booleans on every tool', async () => {
    const { handle } = setup();
    const list = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools = (list?.result as { tools: Array<{ annotations?: Record<string, unknown> }> })
      .tools;
    for (const tool of tools) {
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        expect(typeof tool.annotations?.[hint]).toBe('boolean');
      }
    }
  });

  test('executes list, env, pipe, write, and consume without ever returning secret values', async () => {
    const { root, pad, handle } = setup();
    const secret = 'sk_live_never_show_this_987654';
    pad.lift(`deploy with $$${secret}`, { thread: 'thr_1', message: 'm1' });

    const listed = await handle({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: SECRET_SCRATCH_TOOL_NAME, arguments: { action: 'list' } },
    });
    expect(JSON.stringify(listed)).not.toContain(secret);
    const listedPayload = parseToolPayload(listed);
    expect((listedPayload.pads as Array<{ thread: string }>)[0]?.thread).toBe('thr_1');

    const envRes = await handle({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: {
        name: SECRET_SCRATCH_TOOL_NAME,
        arguments: { action: 'env', ref: '†m1.1', path: '.env.local', key: 'STRIPE_KEY' },
      },
    });
    expect(parseToolPayload(envRes)).toMatchObject({ ok: true, action: 'env', key: 'STRIPE_KEY' });
    expect(readFileSync(join(root, '.env.local'), 'utf8')).toBe(`STRIPE_KEY=${secret}\n`);

    const captured = join(root, 'piped.out');
    const pipeRes = await handle({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: {
        name: SECRET_PIPE_TOOL_NAME,
        arguments: {
          envFile: '.env.local',
          key: 'STRIPE_KEY',
          command: `cat > ${captured}; echo SHOULD_BE_DISCARDED`,
        },
      },
    });
    expect(parseToolPayload(pipeRes)).toEqual({ ok: true, exitCode: 0, consumed: false });
    expect(JSON.stringify(pipeRes)).not.toContain('SHOULD_BE_DISCARDED');
    expect(readFileSync(captured, 'utf8')).toBe(secret);

    const consumeRes = await handle({
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: { name: SECRET_SCRATCH_TOOL_NAME, arguments: { action: 'consume', ref: '†m1.1' } },
    });
    expect(parseToolPayload(consumeRes)).toEqual({ ok: true, consumed: '†m1.1' });
    expect(pad.list('thr_1')).toEqual([]);
  });

  test('blocks workspace escapes and guarded config writes', async () => {
    const { pad, handle } = setup();
    pad.lift('$$topsecret123', { thread: 'thr_1', message: 'm1' });

    const escapeRes = await handle({
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: {
        name: SECRET_SCRATCH_TOOL_NAME,
        arguments: { action: 'write', ref: '†m1.1', path: '../outside.txt' },
      },
    });
    expect((escapeRes?.result as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(escapeRes)).not.toContain('topsecret123');
    expect(String(parseToolPayload(escapeRes).error)).toContain('outside the working directory');

    const gitRes = await handle({
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: {
        name: SECRET_SCRATCH_TOOL_NAME,
        arguments: { action: 'write', ref: '†m1.1', path: '.git/hooks/post-checkout' },
      },
    });
    expect((gitRes?.result as { isError?: boolean }).isError).toBe(true);
  });

  test('enforces session isolation by default (blocks cross-thread list and ref access)', async () => {
    const { pad, handle } = setup();
    pad.lift('$$other_project_secret_999', { thread: 'other_thr', message: 'm1' });

    const crossList = await handle({
      jsonrpc: '2.0',
      id: 30,
      method: 'tools/call',
      params: {
        name: SECRET_SCRATCH_TOOL_NAME,
        arguments: { action: 'list', thread: 'other_thr' },
      },
    });
    expect((crossList?.result as { isError?: boolean }).isError).toBe(true);

    const crossWrite = await handle({
      jsonrpc: '2.0',
      id: 31,
      method: 'tools/call',
      params: {
        name: SECRET_SCRATCH_TOOL_NAME,
        arguments: { action: 'write', ref: '†other_thr/m1.1', path: 'leak.txt' },
      },
    });
    expect((crossWrite?.result as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(crossWrite)).not.toContain('other_project_secret_999');
  });
});
