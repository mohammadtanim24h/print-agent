import { describe, expect, it } from 'vitest';
import {
  buildAllowlistViolations,
  check,
  exactPinViolations,
  licenseAllowed,
  licenseViolations,
} from '../scripts/check-deps.mjs';

const cleanPkg = {
  dependencies: { zod: '4.6.7' },
  devDependencies: { vitest: '5.0.5' },
  pnpm: { onlyBuiltDependencies: ['better-sqlite3', 'electron', 'esbuild'] },
};

const cleanLicenses = {
  MIT: [{ name: 'zod', versions: ['4.6.7'], license: 'MIT' }],
  ISC: [{ name: 'something', versions: ['1.0.0'], license: 'ISC' }],
};

describe('licenseAllowed', () => {
  it('accepts every allowlisted license', () => {
    for (const lic of ['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause']) {
      expect(licenseAllowed(lic)).toBe(true);
    }
  });

  it('accepts a dual license when one option is allowed', () => {
    expect(licenseAllowed('MIT or GPL-2.0')).toBe(true);
    expect(licenseAllowed('(MIT OR GPL-2.0)')).toBe(true);
  });

  it('rejects GPL/AGPL/SSPL and unknown strings (default-deny)', () => {
    expect(licenseAllowed('GPL-3.0')).toBe(false);
    expect(licenseAllowed('AGPL-3.0')).toBe(false);
    expect(licenseAllowed('SSPL-1.0')).toBe(false);
    expect(licenseAllowed('')).toBe(false);
    expect(licenseAllowed('SEE LICENSE IN LICENSE.md')).toBe(false);
  });

  it('rejects an AND-combination containing a disallowed option', () => {
    expect(licenseAllowed('MIT AND GPL-3.0')).toBe(false);
    expect(licenseAllowed('MIT AND ISC')).toBe(true);
  });
});

describe('exactPinViolations', () => {
  it('passes exact versions', () => {
    expect(exactPinViolations(cleanPkg)).toEqual([]);
  });

  it('flags ranges, carets, tildes, and tags', () => {
    const violations = exactPinViolations({
      dependencies: { a: '^1.0.0', b: '~2.0.0', c: '>=3.0.0', d: 'latest' },
      devDependencies: { e: 'github:user/repo' },
    });
    expect(violations).toHaveLength(5);
    expect(violations.every((v) => v.rule === 'exact-pin')).toBe(true);
  });
});

describe('buildAllowlistViolations', () => {
  it('passes the pinned allowlist in any order', () => {
    expect(
      buildAllowlistViolations({ onlyBuiltDependencies: ['esbuild', 'electron', 'better-sqlite3'] }),
    ).toEqual([]);
  });

  it('flags additions and removals', () => {
    expect(buildAllowlistViolations({ onlyBuiltDependencies: ['better-sqlite3', 'electron'] })).toHaveLength(1);
    expect(
      buildAllowlistViolations({ onlyBuiltDependencies: ['better-sqlite3', 'electron', 'esbuild', 'node-gyp'] }),
    ).toHaveLength(1);
    expect(buildAllowlistViolations(undefined)).toHaveLength(1);
  });
});

describe('licenseViolations', () => {
  it('passes an all-clean dependency tree', () => {
    expect(licenseViolations(cleanLicenses)).toEqual([]);
  });

  it('flags non-allowlisted and missing licenses', () => {
    const violations = licenseViolations({
      'GPL-3.0': [{ name: 'bad', versions: ['1.0.0'], license: 'GPL-3.0' }],
      UNKNOWN: [{ name: 'worse', versions: ['2.0.0'] }],
    });
    expect(violations).toHaveLength(2);
    expect(violations[0]?.item).toContain('bad@1.0.0');
  });
});

describe('check (combined)', () => {
  it('returns no violations for a clean tree', () => {
    expect(check({ pkg: cleanPkg, licenses: cleanLicenses })).toEqual([]);
  });

  it('aggregates violations from all three rules', () => {
    const violations = check({
      pkg: { dependencies: { a: '^1.0.0' }, devDependencies: {}, pnpm: {} },
      licenses: { 'GPL-3.0': [{ name: 'x', versions: ['1.0.0'], license: 'GPL-3.0' }] },
    });
    expect(violations.map((v) => v.rule).sort()).toEqual(['build-allowlist', 'exact-pin', 'license']);
  });
});
