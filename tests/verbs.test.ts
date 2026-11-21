import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as api from '../src';

describe('vocabulary and exports', () => {
  test('every exported function and class is documented in docs/VERBS.md', () => {
    const verbsDoc = readFileSync(join(import.meta.dir, '..', 'docs', 'VERBS.md'), 'utf8');
    const undocumented = Object.entries(api)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .filter((name) => !verbsDoc.includes(`\`${name}\``));
    expect(undocumented).toEqual([]);
  });

  test('src/index.ts uses explicit named exports only (no export *)', () => {
    const indexSource = readFileSync(join(import.meta.dir, '..', 'src', 'index.ts'), 'utf8');
    expect(indexSource).not.toMatch(/export\s+\*\s+from/);
  });
});
