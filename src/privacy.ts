import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { matchGlob } from './glob';
import { clip } from './refs';
import {
  type PrivatePathOptions,
  SecretScratchError,
  type ToolGate,
  type ToolRequest,
} from './types';

const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';
const MAX_SYMLINK_DEPTH = 40;

const PATH_KEYS = [
  'file_path',
  'filePath',
  'filepath',
  'path',
  'paths',
  'notebook_path',
  'pattern',
  'glob',
  'include',
  'cwd',
  'target',
  'file',
  'envFile',
  'env_file',
  'old_path',
  'new_path',
] as const;

const COMMAND_KEYS = ['command', 'cmd', 'script'] as const;

const GUARDED_SEGMENTS = new Set([
  '.git',
  '.claude',
  '.codex',
  '.foundry',
  '.agents',
  '.ssh',
  '.gnupg',
  '.aws',
]);

const GUARDED_NAMES = new Set(['.mcp.json', 'settings.json', 'settings.local.json']);

export function expandHome(input: string, cwd?: string): string {
  const home = homedir();
  let out = input.replace(/^~(?=[\\/]|$)/, home).replace(/^\$(?:HOME|\{HOME\})(?=[\\/]|$)/, home);
  if (cwd) {
    out = out.replace(/^\$(?:PWD|\{PWD\})(?=[\\/]|$)/, cwd);
  }
  return out;
}

function normalizeForCompare(path: string): string {
  return CASE_INSENSITIVE_FS ? path.toLowerCase() : path;
}

function safeLstat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

export function canonicalPath(filePath: string): string {
  let current = resolve(expandHome(filePath));
  for (let depth = 0; depth < MAX_SYMLINK_DEPTH; depth += 1) {
    try {
      return realpathSync(current);
    } catch {
      /* path or ancestor does not exist or is a dangling symlink */
    }
    let probe = current;
    let stat = safeLstat(probe);
    while (!stat) {
      const parent = dirname(probe);
      if (parent === probe) return current;
      probe = parent;
      stat = safeLstat(probe);
    }
    const remainder = relative(probe, current);
    if (stat.isSymbolicLink()) {
      const linkTarget = readlinkSync(probe);
      const nextBase = resolve(dirname(probe), linkTarget);
      current = remainder ? resolve(nextBase, remainder) : nextBase;
      continue;
    }
    try {
      const realProbe = realpathSync(probe);
      return remainder ? resolve(realProbe, remainder) : realProbe;
    } catch {
      return current;
    }
  }
  throw new SecretScratchError(`Too many symbolic links while resolving ${clip(filePath)}.`);
}

function isInsideDir(candidate: string, dir: string): boolean {
  const normCandidate = normalizeForCompare(candidate);
  const normDir = normalizeForCompare(dir);
  return normCandidate === normDir || normCandidate.startsWith(normDir + sep);
}

export function isPrivatePath(path: string, extra: readonly string[] = []): boolean {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  if (
    segments.some((raw) => {
      const segment = raw.toLowerCase();
      return (
        segment === '.private' || segment.endsWith('.private') || segment.includes('.private.')
      );
    })
  ) {
    return true;
  }
  return extra.some(
    (pattern) =>
      matchGlob(pattern, path, CASE_INSENSITIVE_FS) ||
      matchGlob(pattern, basename(path), CASE_INSENSITIVE_FS),
  );
}

function tokenizeShellText(text: string): string[] {
  const out: string[] = [];
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    const unquoted = word.replace(/['"\\]/g, '');
    if (unquoted) out.push(unquoted);
  }
  for (const part of text.replace(/\\/g, '').split(/[\s'"`;|&<>()=]+/)) {
    if (part) out.push(part);
  }
  return out;
}

function normalizeCandidateToken(token: string, cwd?: string): string {
  let clean = token.trim();
  if (clean.startsWith('file://')) {
    try {
      clean = decodeURIComponent(clean.slice(7));
    } catch {
      clean = clean.slice(7);
    }
  }
  if (clean.startsWith('@') && clean.length > 1) clean = clean.slice(1);
  return expandHome(clean, cwd);
}

function collectNestedPaths(value: unknown, out: string[], depth = 0): void {
  if (depth > 4 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectNestedPaths(item, out, depth + 1);
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' && entry.length > 0) {
      if ((PATH_KEYS as readonly string[]).includes(key) || key === 'movePath') {
        out.push(entry);
      } else if ((COMMAND_KEYS as readonly string[]).includes(key)) {
        out.push(...tokenizeShellText(entry));
      }
    } else if (Array.isArray(entry)) {
      if (key === 'args') {
        for (const item of entry) {
          if (typeof item === 'string' && item.length > 0) {
            out.push(item, ...tokenizeShellText(item));
          }
        }
      } else if (key === 'command') {
        const joined = entry.filter((part): part is string => typeof part === 'string').join(' ');
        if (joined) out.push(...tokenizeShellText(joined));
      } else if ((PATH_KEYS as readonly string[]).includes(key)) {
        for (const item of entry) {
          if (typeof item === 'string' && item.length > 0) out.push(item);
        }
      } else {
        collectNestedPaths(entry, out, depth + 1);
      }
    } else if (entry && typeof entry === 'object') {
      if (key === 'changes') {
        for (const [changeKey, changeVal] of Object.entries(entry as Record<string, unknown>)) {
          if (changeKey) out.push(changeKey);
          collectNestedPaths(changeVal, out, depth + 1);
        }
      } else if (key === 'env') {
        for (const envVal of Object.values(entry as Record<string, unknown>)) {
          if (typeof envVal === 'string' && envVal.length > 0) {
            out.push(envVal, ...tokenizeShellText(envVal));
          }
        }
      } else {
        collectNestedPaths(entry, out, depth + 1);
      }
    }
  }
}

function namedTargets(request: Pick<ToolRequest, 'toolInput' | 'blockedPath'>): string[] {
  const out: string[] = [];
  if (request.blockedPath) out.push(request.blockedPath);
  collectNestedPaths(request.toolInput, out);
  return [...new Set(out.filter((value) => value.length > 0))];
}

function globMatchesPath(pattern: string, targetPath: string): boolean {
  const normPat = pattern.replace(/\\/g, '/');
  const normTarget = targetPath.replace(/\\/g, '/');
  // why: POSIX shell globs do not match leading dotfiles unless the pattern segment begins with '.'
  const patBase = basename(normPat);
  const targetBase = basename(normTarget);
  if (targetBase.startsWith('.') && !patBase.startsWith('.')) return false;
  return matchGlob(normPat, normTarget, CASE_INSENSITIVE_FS);
}

function namesHeldFile(target: string, held: readonly string[], cwd?: string): boolean {
  if (held.length === 0) return false;
  const normalizedHeld = held.map(normalizeForCompare);

  const checkResolved = (candidate: string): boolean => {
    if (normalizedHeld.includes(normalizeForCompare(candidate))) return true;
    try {
      const real = canonicalPath(candidate);
      if (normalizedHeld.includes(normalizeForCompare(real))) return true;
    } catch {
      /* ignore broken symlink loops */
    }
    return false;
  };

  if (target.includes('*') || target.includes('?')) {
    const absPattern = isAbsolute(target) ? resolve(target) : cwd ? resolve(cwd, target) : target;
    return held.some((file) => {
      if (globMatchesPath(absPattern, file)) return true;
      if (cwd) {
        const rel = relative(cwd, file);
        if (!rel.startsWith('..') && globMatchesPath(target, rel)) return true;
      }
      return globMatchesPath(target, basename(file));
    });
  }

  if (isAbsolute(target)) return checkResolved(resolve(target));
  if (cwd && checkResolved(resolve(cwd, target))) return true;

  const tail = target.replace(/^(\.\/)+/, '');
  if (!tail || tail === '.' || tail.startsWith('..')) return false;
  const normTail = normalizeForCompare(`${sep}${tail}`);
  return normalizedHeld.some((file) => file.endsWith(normTail));
}

function hitsScratchDir(target: string, scratchDirs: readonly string[], cwd?: string): boolean {
  if (target.includes('*') || target.includes('?')) {
    const absPattern = isAbsolute(target) ? resolve(target) : cwd ? resolve(cwd, target) : target;
    return scratchDirs.some(
      (dir) =>
        isInsideDir(dirname(absPattern), dir) ||
        globMatchesPath(absPattern, dir) ||
        globMatchesPath(absPattern, `${dir}${sep}x.pad`),
    );
  }
  const candidate = isAbsolute(target) ? resolve(target) : cwd ? resolve(cwd, target) : undefined;
  if (!candidate) return false;
  if (scratchDirs.some((dir) => isInsideDir(candidate, dir))) return true;
  try {
    const real = canonicalPath(candidate);
    if (scratchDirs.some((dir) => isInsideDir(real, dir))) return true;
  } catch {
    /* ignore broken symlink loops */
  }
  return false;
}

export function privatePathDenial(
  request: Pick<
    ToolRequest,
    'toolInput' | 'blockedPath' | 'toolMethod' | 'toolName' | 'toolServer'
  >,
  options: PrivatePathOptions & { readonly cwd?: string } = {},
): string | undefined {
  if (options.isOwnTool?.(request)) return undefined;

  const baseCwd = options.cwd ? resolve(expandHome(options.cwd)) : undefined;
  const inputCwd = typeof request.toolInput.cwd === 'string' ? request.toolInput.cwd : undefined;
  const cwd = inputCwd
    ? isAbsolute(expandHome(inputCwd))
      ? resolve(expandHome(inputCwd))
      : baseCwd
        ? resolve(baseCwd, inputCwd)
        : resolve(inputCwd)
    : baseCwd;

  const scratchDirs: string[] = [];
  if (options.scratchDir) {
    const raw = resolve(expandHome(options.scratchDir));
    scratchDirs.push(raw);
    try {
      const real = canonicalPath(raw);
      if (real !== raw) scratchDirs.push(real);
    } catch {
      /* ignore */
    }
  }

  const held = (options.heldFiles ?? []).flatMap((file) => {
    const expanded = expandHome(file, baseCwd);
    const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(baseCwd ?? '.', expanded);
    try {
      const real = canonicalPath(abs);
      return real === abs ? [abs] : [abs, real];
    } catch {
      return [abs];
    }
  });

  const hit = namedTargets(request)
    .map((raw) => normalizeCandidateToken(raw, cwd))
    .find(
      (target) =>
        isPrivatePath(target, options.privatePaths) ||
        namesHeldFile(target, held, cwd) ||
        (scratchDirs.length > 0 && hitsScratchDir(target, scratchDirs, cwd)),
    );
  if (!hit) return undefined;
  return `${clip(hit)} is private: it is never read, searched or printed. Use the scratch pad's tools instead: pipe from an env file, or env, pipe or write a held reference. They never show a value.`;
}

export function privatePathGate(
  options: PrivatePathOptions & { readonly cwd?: string } = {},
): ToolGate {
  return (request) => {
    const message = privatePathDenial(request, options);
    return message ? { behavior: 'deny', message } : { behavior: 'allow' };
  };
}

export function scratchTarget(cwd: string | undefined, path: string): string {
  if (!cwd) throw new SecretScratchError('No working directory is set to write into.');
  const root = canonicalPath(cwd);
  const expanded = expandHome(path, root);
  const target = resolve(root, expanded);
  const real = canonicalPath(target);
  const inside = relative(root, real);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new SecretScratchError(
      `${path} is outside the working directory; use secret_pipe for that.`,
    );
  }
  const parts = inside.split(sep).map((part) => part.toLowerCase());
  const targetParts = relative(root, target)
    .split(sep)
    .map((part) => part.toLowerCase());
  const hasGuarded = (segments: readonly string[]): boolean =>
    segments.some((part) => GUARDED_SEGMENTS.has(part)) ||
    GUARDED_NAMES.has(segments[segments.length - 1] ?? '');

  if (hasGuarded(parts) || hasGuarded(targetParts)) {
    throw new SecretScratchError(
      `${path} is version-control or agent configuration; use secret_pipe for that.`,
    );
  }
  return real;
}
