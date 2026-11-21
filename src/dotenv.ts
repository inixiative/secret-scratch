import { SecretScratchError } from './types';

export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function envValue(value: string): string {
  if (/^[A-Za-z0-9_./:@+,=-]*$/.test(value)) return value;
  if (!/['\n\r]/.test(value)) return `'${value}'`;
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  return `"${escaped}"`;
}

export function envLineKey(line: string): string | undefined {
  return /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
}

export function envLineValue(line: string): string {
  const raw = line.slice(line.indexOf('=') + 1).trim();
  const double = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(raw);
  if (double) {
    return (double[1] ?? '').replace(/\\(.)/g, (_m, c: string) =>
      c === 'n' ? '\n' : c === 'r' ? '\r' : c,
    );
  }
  const single = /^'([^']*)'\s*(?:#.*)?$/.exec(raw);
  if (single) return single[1] ?? '';
  if (raw.startsWith('"') || raw.startsWith("'")) {
    throw new SecretScratchError(
      'The env value spans lines or is unterminated; it cannot be piped.',
    );
  }
  return raw.replace(/\s+#.*$/, '');
}
