export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileSegment(segment: string): string {
  let out = '';
  let index = 0;

  while (index < segment.length) {
    const ch = segment[index] ?? '';
    if (ch === '*') {
      if (segment[index + 1] === '*') {
        if (segment[index + 2] === '/') {
          out += '(?:.*/)?';
          index += 3;
          continue;
        }
        out += '.*';
        index += 2;
        continue;
      }
      out += '[^/]*';
      index += 1;
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      index += 1;
      continue;
    }
    if (ch === '{') {
      const close = segment.indexOf('}', index + 1);
      if (close > index) {
        const options = segment
          .slice(index + 1, close)
          .split(',')
          .map((part) => compileSegment(part));
        out += `(?:${options.join('|')})`;
        index = close + 1;
        continue;
      }
    }
    out += escapeRegExp(ch);
    index += 1;
  }

  return out;
}

export function compileGlob(pattern: string, caseInsensitive = false): RegExp {
  const normalized = pattern.replace(/\\/g, '/');
  return new RegExp(`^${compileSegment(normalized)}$`, caseInsensitive ? 'i' : '');
}

export function matchGlob(pattern: string, target: string, caseInsensitive = false): boolean {
  const normalized = target.replace(/\\/g, '/');
  return compileGlob(pattern, caseInsensitive).test(normalized);
}
