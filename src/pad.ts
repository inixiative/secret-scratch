import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { ENV_KEY_PATTERN, envLineKey, envLineValue, envValue } from './dotenv';
import { escapeRegExp } from './glob';
import {
  type Dagger,
  formatPad,
  parsePad,
  readText,
  runWithStdin,
  writePrivate,
  writeTarget,
} from './padFormat';
import { canonicalPath, expandHome } from './privacy';
import { checkId, clip, formatScratchRef, parseScratchRef, VALID_ID_PATTERN } from './refs';
import {
  type ScratchDagger,
  type ScratchPadSummary,
  type ScratchRef,
  type ScratchSource,
  type ScratchUse,
  SecretScratchError,
} from './types';

// why: allow $$ at start, after whitespace, or after delimiters (=, quotes, brackets) without lifting mid-word a$$b
const MARKED_PATTERN = /(^|[\s=("'[{,:;`])\$\$(\S+)/g;
const CLOSING_DELIM: Record<string, string> = {
  '"': '"',
  "'": "'",
  '`': '`',
  '(': ')',
  '[': ']',
  '{': '}',
};
const PAD_SUFFIX = '.pad';
const SCRUB_MIN_LENGTH = 6;

function summarizeDagger(dagger: Dagger): ScratchDagger {
  return {
    message: dagger.message,
    at: dagger.at,
    excerpt: dagger.excerpt,
    positions: [...dagger.blocks.keys()].sort((a, b) => a - b),
  };
}

export class SecretScratchPad {
  private readonly _dir: string;

  constructor(dir: string) {
    this._dir = resolve(expandHome(dir));
  }

  get dir(): string {
    return this._dir;
  }

  lift(
    text: string,
    at: { readonly thread: string; readonly message: string; readonly now?: Date },
    options: { readonly patterns?: readonly RegExp[] } = {},
  ): { text: string; refs: string[]; recognised: number } {
    const spans: Array<{
      start: number;
      end: number;
      value: string;
      marked: boolean;
    }> = [];
    for (const match of text.matchAll(MARKED_PATTERN)) {
      const lead = match[1] ?? '';
      let rawValue = match[2] ?? '';
      const start = (match.index ?? 0) + lead.length;
      let end = (match.index ?? 0) + match[0].length;
      const expectedClose = CLOSING_DELIM[lead];
      if (expectedClose && rawValue.endsWith(expectedClose) && rawValue.length > 1) {
        rawValue = rawValue.slice(0, -1);
        end -= 1;
      }
      if (!rawValue) continue;
      spans.push({
        start,
        end,
        value: rawValue,
        marked: true,
      });
    }
    for (const pattern of options.patterns ?? []) {
      if (!pattern.global) throw new SecretScratchError('A lift pattern must be global (/g).');
      for (const match of text.matchAll(pattern)) {
        if (!match[0]) continue;
        const start = match.index ?? 0;
        spans.push({
          start,
          end: start + match[0].length,
          value: match[0],
          marked: false,
        });
      }
    }
    if (!spans.length) return { text, refs: [], recognised: 0 };

    spans.sort((a, b) => a.start - b.start || b.end - a.end);
    const kept: typeof spans = [];
    for (const span of spans) {
      const prev = kept[kept.length - 1];
      if (!prev || span.start >= prev.end) {
        kept.push(span);
      } else if (
        prev.marked &&
        !span.marked &&
        span.start === prev.start + 2 &&
        span.end > prev.end
      ) {
        // why: $$-----BEGIN PRIVATE KEY-----... starts with a marked word then spans lines via shaped pattern
        kept[kept.length - 1] = {
          start: prev.start,
          end: span.end,
          value: span.value,
          marked: true,
        };
      }
    }

    checkId(at.thread, 'thread');
    checkId(at.message, 'message');
    const daggers = this._read(at.thread);
    let dagger = daggers.find((d) => d.message === at.message);
    const first = dagger ? Math.max(0, ...dagger.blocks.keys()) + 1 : 1;
    const refs = kept.map((_, i) =>
      formatScratchRef({ thread: at.thread, message: at.message, position: first + i }, at.thread),
    );
    let lifted = '';
    let cursor = 0;
    kept.forEach((span, i) => {
      lifted += text.slice(cursor, span.start) + refs[i];
      cursor = span.end;
    });
    lifted += text.slice(cursor);
    if (!dagger) {
      dagger = {
        message: at.message,
        at: (at.now ?? new Date()).toISOString(),
        excerpt: lifted.replace(/\s+/g, ' ').trim().slice(0, 80),
        blocks: new Map(),
      };
      daggers.push(dagger);
    }
    for (const [i, span] of kept.entries()) dagger.blocks.set(first + i, span.value);
    this._write(at.thread, daggers);
    return { text: lifted, refs, recognised: kept.filter((span) => !span.marked).length };
  }

  list(thread?: string): ScratchPadSummary[] {
    const threads = thread ? [checkId(thread, 'thread')] : this.threads();
    return threads
      .map((id) => ({ thread: id, daggers: this._read(id).map(summarizeDagger) }))
      .filter((pad) => pad.daggers.length > 0);
  }

  threads(): string[] {
    let names: string[];
    try {
      names = readdirSync(this._dir);
    } catch {
      return [];
    }
    return names
      .filter((name) => name.endsWith(PAD_SUFFIX))
      .map((name) => name.slice(0, -PAD_SUFFIX.length))
      .filter((id) => VALID_ID_PATTERN.test(id))
      .sort();
  }

  heldFiles(): string[] {
    const text = readText(this._heldPath());
    if (!text) return [];
    try {
      const files = JSON.parse(text) as unknown;
      return Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string') : [];
    } catch {
      throw new SecretScratchError('The held-files list is unreadable.');
    }
  }

  write(
    source: ScratchSource,
    from: string,
    path: string,
    options: ScratchUse & { readonly mode?: 'replace' | 'append'; readonly cwd?: string } = {},
  ): void {
    const { value, target } = this._source(source, from, options.cwd);
    const file = this._target(options.cwd, path);
    const before = options.mode === 'append' ? readText(file) : '';
    const lead = before && !before.endsWith('\n') ? '\n' : '';
    writeTarget(file, options.mode === 'append' ? `${before}${lead}${value}\n` : value);
    this._hold(file);
    if (options.consume && target) this._drop(target);
  }

  env(
    source: ScratchSource,
    from: string,
    path: string,
    key: string,
    options: ScratchUse & { readonly cwd?: string } = {},
  ): void {
    if (!ENV_KEY_PATTERN.test(key)) throw new SecretScratchError(`Not an env key: ${clip(key)}`);
    const { value, target } = this._source(source, from, options.cwd);
    const file = this._target(options.cwd, path);
    const text = readText(file);
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    const line = `${key}=${envValue(value)}`;
    const at = lines.findLastIndex((l) => envLineKey(l) === key);
    if (at >= 0) lines[at] = line;
    else lines.push(line);
    writeTarget(file, `${lines.join(newline)}${newline}`);
    this._hold(file);
    if (options.consume && target) this._drop(target);
  }

  async pipe(
    source: ScratchSource,
    from: string,
    command: string,
    options: ScratchUse & { readonly cwd?: string; readonly timeoutMs?: number } = {},
  ): Promise<{ exitCode: number }> {
    const { value, target } = this._source(source, from, options.cwd);
    const result = await runWithStdin(command, value, options);
    if (options.consume && target && result.exitCode === 0) this._drop(target);
    return result;
  }

  async use<T>(
    ref: string,
    from: string,
    fn: (value: string) => T | Promise<T>,
    options: ScratchUse = {},
  ): Promise<T> {
    const target = parseScratchRef(ref, from);
    const result = await fn(this._held(target));
    if (options.consume) this._drop(target);
    return result;
  }

  consume(ref: string, from: string): void {
    const target = parseScratchRef(ref, from);
    this._held(target);
    this._drop(target);
  }

  clear(thread: string): void {
    rmSync(this._path(checkId(thread, 'thread')), { force: true });
  }

  scrub(thread: string, text: string): string {
    const pairs = this._read(checkId(thread, 'thread'))
      .flatMap((d) =>
        [...d.blocks].map(([position, value]) => ({
          value,
          ref: formatScratchRef({ thread, message: d.message, position }, thread),
        })),
      )
      .filter((pair) => pair.value.length >= SCRUB_MIN_LENGTH)
      .sort((a, b) => b.value.length - a.value.length);
    if (!pairs.length) return text;
    const refs = new Map(pairs.map((pair) => [pair.value, pair.ref]));
    const pattern = new RegExp(pairs.map((pair) => escapeRegExp(pair.value)).join('|'), 'g');
    return text.replace(pattern, (value) => refs.get(value) ?? value);
  }

  private _source(
    source: ScratchSource,
    from: string,
    cwd: string | undefined,
  ): { value: string; target?: ScratchRef } {
    if ('ref' in source) {
      const target = parseScratchRef(source.ref, from);
      return { value: this._held(target), target };
    }
    if ('value' in source) return { value: source.value };
    if (!ENV_KEY_PATTERN.test(source.key)) {
      throw new SecretScratchError(`Not an env key: ${clip(source.key)}`);
    }
    const file = this._target(cwd, source.envFile);
    if (!existsSync(file)) throw new SecretScratchError(`No env file at ${clip(source.envFile)}`);
    const line = readText(file)
      .split(/\r?\n/)
      .findLast((l) => envLineKey(l) === source.key);
    if (line === undefined) {
      throw new SecretScratchError(`${source.key} is not set in ${clip(source.envFile)}`);
    }
    return { value: envLineValue(line) };
  }

  private _held(ref: ScratchRef): string {
    const value = this._read(ref.thread)
      .find((d) => d.message === ref.message)
      ?.blocks.get(ref.position);
    if (value === undefined) {
      throw new SecretScratchError(
        `Nothing is held at ${formatScratchRef(ref)}: it was consumed, or the reference is wrong. Call list to see what is pending.`,
      );
    }
    return value;
  }

  private _drop(ref: ScratchRef): void {
    const daggers = this._read(ref.thread);
    daggers.find((d) => d.message === ref.message)?.blocks.delete(ref.position);
    this._write(ref.thread, daggers);
  }

  private _target(cwd: string | undefined, path: string): string {
    const file = resolve(cwd ?? '.', expandHome(path, cwd));
    const padDir = canonicalPath(this._dir);
    const realFile = canonicalPath(file);
    if (
      file === this._dir ||
      file.startsWith(this._dir + sep) ||
      realFile === padDir ||
      realFile.startsWith(padDir + sep)
    ) {
      throw new SecretScratchError('The scratch pad directory is not a target.');
    }
    return file;
  }

  private _heldPath(): string {
    return join(this._dir, 'held-files.json');
  }

  private _hold(file: string): void {
    const files = new Set(this.heldFiles());
    const additions = [file];
    try {
      if (lstatSync(file).isSymbolicLink()) {
        const real = canonicalPath(file);
        if (real !== file) additions.push(real);
      }
    } catch {
      /* ignore */
    }
    let changed = false;
    for (const entry of additions) {
      if (!files.has(entry)) {
        files.add(entry);
        changed = true;
      }
    }
    if (!changed) return;
    writePrivate(this._heldPath(), JSON.stringify([...files].sort(), null, 2));
  }

  private _path(thread: string): string {
    return join(this._dir, `${thread}${PAD_SUFFIX}`);
  }

  private _read(thread: string): Dagger[] {
    try {
      return parsePad(readText(this._path(thread)));
    } catch (error) {
      if (error instanceof SecretScratchError) throw error;
      throw new SecretScratchError(`The pad for ${thread} is unreadable.`);
    }
  }

  private _write(thread: string, daggers: Dagger[]): void {
    const live = daggers.filter((d) => d.blocks.size > 0);
    if (!live.length) {
      rmSync(this._path(thread), { force: true });
      return;
    }
    writePrivate(this._path(thread), formatPad(thread, live));
  }
}
