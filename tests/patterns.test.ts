import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildShapedLiftPatterns,
  contextSecretHits,
  SecretScratchPad,
  SHAPED_SECRET_PATTERNS,
  scrubSecrets,
} from '../src';

describe('shaped secret patterns', () => {
  test('recognises standard API keys and tokens without lifting ordinary words', () => {
    const samples = [
      'sk-proj-abc12345678901234567890',
      'ghp_1234567890abcdefghij123456',
      'github_pat_1234567890abcdef123456',
      'AIzaSyD1234567890abcdefghijklmnopqrs',
      'xoxb-1234567890-abcdefghij',
      'AKIA1234567890ABCDEF',
      'pk_live_1234567890abcdef1234',
      'npm_1234567890abcdefghij1234',
    ];
    for (const token of samples) {
      const matched = SHAPED_SECRET_PATTERNS.some((re) => [...token.matchAll(re)].length > 0);
      expect(matched).toBe(true);
    }

    const prose = [
      'task-runner-sk-abcdefghijklmnopqrstuvwx',
      'sk-abcdefghijklmnopqrstuvwxyz',
      'app_live_abcdefghijklmnopqrstuv',
      'normal_identifier_name',
    ];
    for (const text of prose) {
      const matched = SHAPED_SECRET_PATTERNS.some((re) => [...text.matchAll(re)].length > 0);
      expect(matched).toBe(false);
    }
  });

  test('buildShapedLiftPatterns preserves global flag and prevents mid-word hits', () => {
    const patterns = buildShapedLiftPatterns();
    expect(patterns.every((re) => re.global)).toBe(true);
    const midWord = 'prefixsk-proj-1234567890abcdefghij';
    expect(patterns.some((re) => [...midWord.matchAll(re)].length > 0)).toBe(false);
  });

  test('contextSecretHits counts unmarked credentials left in text', () => {
    expect(contextSecretHits('Authorization: Bearer supersecretvalue123456')).toBe(1);
    expect(contextSecretHits('postgres://admin:p4ssw0rd123@db.internal:5432/app')).toBe(1);
    expect(contextSecretHits('API_KEY=not-lifted-yet')).toBe(1);
    expect(contextSecretHits('plain message with †m1.1 reference')).toBe(0);
  });

  test('scrubSecrets redacts both shaped and context secrets with typed labels', () => {
    const out = scrubSecrets('key sk-proj-abc12345678901234567890 and Bearer topsecrettoken12345');
    expect(out.hits).toBe(2);
    expect(out.text).toContain('[REDACTED:api-key]');
    expect(out.text).toContain('Bearer [REDACTED:credential]');
    expect(out.text).not.toContain('abc1234567890');
    expect(out.text).not.toContain('topsecrettoken12345');
  });

  const flyBody = `fm2_${'aB3+/_-='.repeat(5)},fm2_${'Zy9/+x'.repeat(6)}`;

  test('takes a whole Fly token, scheme word and every comma-joined part', () => {
    for (const token of [
      `FlyV1 ${flyBody}`,
      `FlyV1\n${flyBody}`,
      flyBody,
      `fo1_${'a1'.repeat(20)}`,
    ]) {
      const out = scrubSecrets(`use ${token} now`);
      expect(out).toEqual({ text: 'use [REDACTED:fly-token] now', hits: 1 });
    }
    expect(scrubSecrets('FlyV1 tokens start with fm2_ and then a body').hits).toBe(0);
  });

  test('`$$` before a Fly token lifts both words as one secret', () => {
    const root = mkdtempSync(join(tmpdir(), 'scratch-'));
    const pad = new SecretScratchPad(join(root, 'pad'));
    const out = pad.lift(
      `token $$FlyV1 ${flyBody} ok`,
      { thread: 't', message: 'm' },
      { patterns: SHAPED_SECRET_PATTERNS },
    );
    rmSync(root, { recursive: true, force: true });
    expect(out.text).toBe('token †m.1 ok');
  });
});
