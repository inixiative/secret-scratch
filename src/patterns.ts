import { SECRET_REFERENCE_PATTERN } from './refs';

export const SHAPED_SECRETS: ReadonlyArray<readonly [RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, '[REDACTED:anthropic-key]'],
  [/sk-[A-Za-z0-9_-]{20,}/g, '[REDACTED:api-key]'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED:github-token]'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED:github-token]'],
  [/AIza[A-Za-z0-9_-]{30,}/g, '[REDACTED:google-key]'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED:slack-token]'],
  [/AKIA[A-Z0-9]{16}/g, '[REDACTED:aws-key]'],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    '[REDACTED:private-key]',
  ],
  [/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED:jwt]'],
  [/\b[a-z]+_(?:live|test|prod|runtime)_[A-Za-z0-9]{16,}/g, '[REDACTED:token]'],
  [/\b(?:npm_|glpat-|hf_)[A-Za-z0-9_-]{20,}/g, '[REDACTED:token]'],
  [/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, '[REDACTED:slack-webhook]'],
  [/\bASIA[A-Z0-9]{16}/g, '[REDACTED:aws-key]'],
];

export const CONTEXT_SECRETS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(Bearer|Basic|DPoP)\s+[A-Za-z0-9._~+/=-]{16,}/g, '$1 [REDACTED:credential]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, '$1[REDACTED:password]@'],
  [
    /\b([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Z0-9_]*\s*[=:]\s*)["']?[^\s"']{8,}["']?/g,
    '$1[REDACTED:value]',
  ],
  [
    /(["']?)\b(password|passwd|api[_-]?key|secret|(?:access|auth|refresh)?[_-]?token)\1(\s*[:=]\s*)["']?[^\s"',}]{8,}["']?/gi,
    '$1$2$1$3[REDACTED:value]',
  ],
];

// why: loose prefixes like sk-... or foo_live_... require a digit so prose/identifiers are never lifted
export function buildShapedLiftPatterns(
  shapes: ReadonlyArray<readonly [RegExp, string]> = SHAPED_SECRETS,
): RegExp[] {
  return shapes.map(([pattern]) => {
    const loose =
      pattern.source.startsWith('sk-[') || pattern.source.includes('(?:live|test|prod|runtime)');
    const digit = loose ? '(?=[A-Za-z0-9_-]*\\d)' : '';
    return new RegExp(`(?<![A-Za-z0-9_-])${digit}(?:${pattern.source})`, pattern.flags);
  });
}

export const SHAPED_SECRET_PATTERNS: readonly RegExp[] = buildShapedLiftPatterns(SHAPED_SECRETS);

export function contextSecretHits(text: string): number {
  const withoutRefs = text.replace(SECRET_REFERENCE_PATTERN, '');
  const spans: Array<readonly [number, number]> = [];
  for (const [pattern] of CONTEXT_SECRETS) {
    for (const match of withoutRefs.matchAll(pattern)) {
      if (!match[0] || match[0].includes('[REDACTED:')) continue;
      const start = match.index ?? 0;
      spans.push([start, start + match[0].length]);
    }
  }
  if (!spans.length) return 0;
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let hits = 0;
  let cursor = -1;
  for (const [start, end] of spans) {
    if (start >= cursor) {
      hits += 1;
      cursor = end;
    }
  }
  return hits;
}

export function scrubSecrets(
  text: string,
  extraShapes: ReadonlyArray<readonly [RegExp, string]> = [],
): { text: string; hits: number } {
  let hits = 0;
  let out = text;
  // why: caller-supplied shapes run first so specific product prefixes win over generic rules
  const all = [...extraShapes, ...SHAPED_SECRETS, ...CONTEXT_SECRETS];
  for (const [pattern, replacement] of all) {
    out = out.replace(pattern, (...match: unknown[]) => {
      const full = typeof match[0] === 'string' ? match[0] : '';
      if (full.includes('[REDACTED:')) return full;
      hits += 1;
      return replacement.replace(/\$(\d)/g, (_, group: string) => {
        const value = match[Number(group)];
        return typeof value === 'string' ? value : '';
      });
    });
  }
  return { text: out, hits };
}
