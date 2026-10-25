import { describe, expect, it } from 'vitest';
import { nextVersion, preflightFailures } from '../scripts/release.mjs';

describe('nextVersion', () => {
  it.each([
    ['0.1.0', 'patch', '0.1.1'],
    ['0.1.0', 'minor', '0.2.0'],
    ['0.1.0', 'major', '1.0.0'],
    ['1.9.9', 'minor', '1.10.0'],
  ])('%s %s -> %s', (current, part, expected) => {
    expect(nextVersion(current, part)).toBe(expected);
  });

  it.each(['1.0', 'v1.0.0', 'abc', ''])('%s is unparseable', (bad) => {
    expect(() => nextVersion(bad, 'patch')).toThrow(/unparseable/);
  });
});

describe('preflightFailures', () => {
  const good = {
    status: '',
    branch: 'main',
    behindCount: 0,
    existingTag: false,
    version: '0.1.0',
    part: 'patch',
  };

  it('passes a clean state', () => {
    expect(preflightFailures(good)).toEqual([]);
  });

  it.each([
    [{ status: ' M foo.ts' }, /not clean/],
    [{ branch: 'feature/x' }, /must run on main/],
    [{ behindCount: 2 }, /behind origin/],
    [{ existingTag: true }, /already exists/],
    [{ part: 'tiny' }, /usage/],
  ])('flags %j', (override, pattern) => {
    expect(preflightFailures({ ...good, ...override })).toEqual([expect.stringMatching(pattern)]);
  });
});
