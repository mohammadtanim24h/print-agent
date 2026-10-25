// Dependency-admission gate (CLAUDE.md rule 10, ADR-13). Exit 0 = clean,
// exit 1 = violations printed as an offender -> reason table.
// Usage: node scripts/check-deps.mjs [--licenses <licenses.json>]
//   --licenses: JSON from `pnpm licenses list --prod --json`. When omitted the
//   script runs pnpm itself (the CI and local-dev path).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Licenses we distribute (CLAUDE.md rule 10). Default-deny beyond this set. */
const ALLOWED_LICENSES = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
]);
// better-sqlite3 is deliberately NOT here: its tarball ships prebuilds/ and
// lib/binding.js loads them at runtime — no build script is needed, and
// allowing one would run node-gyp (needs Visual Studio) for nothing.
const BUILD_SCRIPT_ALLOWLIST = ['electron', 'esbuild'];
const EXACT_PIN = /^\d+\.\d+\.\d+$/;

/** SPDX expression check: an OR passes if any branch is fully allowed; every
 *  part of an AND branch must be allowed. Parentheses are ignored. */
export function licenseAllowed(license) {
  const expr = String(license).replace(/[()]/g, '');
  if (expr.trim() === '') return false;
  return expr
    .split(/\s+OR\s+/i)
    .some((branch) =>
      branch
        .split(/\s+AND\s+/i)
        .every((part) => ALLOWED_LICENSES.has(part.trim())),
    );
}

export function exactPinViolations(pkg) {
  const violations = [];
  for (const section of ['dependencies', 'devDependencies']) {
    for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
      if (!EXACT_PIN.test(spec)) {
        violations.push({
          rule: 'exact-pin',
          item: `${name}@${spec}`,
          reason: 'not exact-pinned (x.y.z only)',
        });
      }
    }
  }
  return violations;
}

export function buildAllowlistViolations(pnpmSection) {
  const actual = [...(pnpmSection?.onlyBuiltDependencies ?? [])].sort();
  const expected = [...BUILD_SCRIPT_ALLOWLIST].sort();
  const matches =
    actual.length === expected.length && actual.every((v, i) => v === expected[i]);
  return matches
    ? []
    : [
        {
          rule: 'build-allowlist',
          item: JSON.stringify(actual),
          reason: `pnpm.onlyBuiltDependencies must equal ${JSON.stringify(BUILD_SCRIPT_ALLOWLIST)}`,
        },
      ];
}

export function licenseViolations(licensesJson) {
  const violations = [];
  for (const [key, entries] of Object.entries(licensesJson)) {
    for (const entry of entries) {
      const lic = entry.license ?? key;
      if (!licenseAllowed(lic)) {
        violations.push({
          rule: 'license',
          item: `${entry.name}@${(entry.versions ?? []).join(',')}`,
          reason: `license "${lic}" not in allowlist`,
        });
      }
    }
  }
  return violations;
}

export function check({ pkg, licenses }) {
  return [
    ...exactPinViolations(pkg),
    ...buildAllowlistViolations(pkg.pnpm),
    ...licenseViolations(licenses),
  ];
}

// --- CLI (only when executed directly; importing this module must stay
// side-effect free so the test suite can unit-test the exported rules) ---
const argv = process.argv.slice(2);
const li = argv.indexOf('--licenses');
const licenseFile = li !== -1 ? argv[li + 1] : undefined;
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (argv.includes('--licenses') && !licenseFile) {
    console.error('--licenses requires a file argument');
    process.exit(2);
  }

  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const licenses = licenseFile
    ? JSON.parse(readFileSync(licenseFile, 'utf8'))
    : JSON.parse(
        // Static command string, run under a shell only on Windows where pnpm
        // is a .cmd shim that Node cannot spawn directly (avoids DEP0190);
        // non-Windows callers must pass --licenses instead.
        execFileSync('pnpm licenses list --prod --json', {
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          timeout: 120_000,
          shell: process.platform === 'win32',
        }),
      );

  const violations = check({ pkg, licenses });
  if (violations.length > 0) {
    console.error('Dependency-admission violations (CLAUDE.md rule 10):');
    for (const v of violations) console.error(`  [${v.rule}] ${v.item} — ${v.reason}`);
    process.exit(1);
  }
  const count = Object.values(licenses).flat().length;
  console.log(`Dependency admission OK (${count} production packages checked).`);
}
