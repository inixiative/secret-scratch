import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { clip } from './refs';
import { SecretScratchError } from './types';

export interface Dagger {
  message: string;
  at: string;
  excerpt: string;
  blocks: Map<number, string>;
}

export function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? 'error';
}

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

export function formatPad(thread: string, daggers: readonly Dagger[]): string {
  const body = daggers.map((d) =>
    [
      `†${d.message} (${d.at}, ${JSON.stringify(d.excerpt)})`,
      ...[...d.blocks]
        .sort(([a], [b]) => a - b)
        .map(([position, value]) => `[${position}] ${JSON.stringify(value)}`),
    ].join('\n'),
  );
  return `# secret scratch pad: thread ${thread}\n\n${body.join('\n\n')}\n`;
}

export function parsePad(text: string): Dagger[] {
  const daggers: Dagger[] = [];
  let current: Dagger | undefined;
  for (const line of text.split(/\r?\n/)) {
    const dagger = /^†(\S+) \((\S+), (".*")\)$/.exec(line);
    if (dagger?.[1] && dagger[2] && dagger[3]) {
      current = {
        message: dagger[1],
        at: dagger[2],
        excerpt: JSON.parse(dagger[3]) as string,
        blocks: new Map(),
      };
      daggers.push(current);
      continue;
    }
    const block = /^\[(\d+)\] (".*")$/.exec(line);
    if (block?.[1] && block[2] && current) {
      current.blocks.set(Number(block[1]), JSON.parse(block[2]) as string);
      continue;
    }
    // why: any unexpected line signals corruption; fail closed rather than silently dropping entries
    if (line !== '' && !line.startsWith('# ')) {
      throw new SecretScratchError('The pad is unreadable.');
    }
  }
  return daggers;
}

export function writePrivate(path: string, text: string): void {
  ensurePrivateDir(dirname(path));
  const nonce = randomBytes(6).toString('hex');
  const temp = `${path}.${process.pid}.${nonce}.tmp`;
  try {
    writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } catch (error) {
    rmSync(temp, { force: true });
    throw new SecretScratchError(`Could not write ${clip(path)}: ${errorCode(error)}`);
  }
}

export function writeTarget(path: string, text: string): void {
  try {
    writeFileSync(path, text, { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch (error) {
    throw new SecretScratchError(`Could not write ${clip(path)}: ${errorCode(error)}`);
  }
}

export function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return '';
    throw new SecretScratchError(`Could not read ${clip(path)}: ${errorCode(error)}`);
  }
}

export function runWithStdin(
  command: string,
  value: string,
  options: { readonly cwd?: string; readonly timeoutMs?: number },
): Promise<{ exitCode: number }> {
  return new Promise((done, fail) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: options.cwd,
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
    });
    // why: kill the entire process group on timeout so no backgrounded child retains the secret
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, options.timeoutMs ?? 120_000);
    child.on('error', () => {
      clearTimeout(timer);
      fail(new SecretScratchError('The command could not start.'));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      done({ exitCode: code ?? (signal ? 128 : 1) });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(value);
  });
}
