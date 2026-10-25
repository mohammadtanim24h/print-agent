# CI Pipeline + Packaging (unsigned) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GitHub Actions CI (gate + no-listen smoke), unsigned electron-builder NSIS packaging, a `pnpm release` driver, and docs amended to the manual-distribution model.

**Architecture:** Two workflows (`ci.yml` on PRs/main, `release.yml` on `v*` tags), a unit-tested `scripts/check-deps.mjs` dependency-admission gate, electron-builder 26 config with native `electronFuses`, and a release script that bumps/commits/tags/pushes. Spec: `docs/superpowers/specs/2026-10-25-ci-packaging-design.md` (normative).

**Tech Stack:** GitHub Actions (windows-latest), pnpm 10 / Node 24, electron-builder 26.18.0 (new devDep), plain ESM `.mjs` scripts + vitest.

**Notes for the executor:**
- Shell is bash on Windows (git-bash); paths in commands use forward slashes.
- `package.json` is 2-space indented — `JSON.stringify(pkg, null, 2) + '\n'` in `release.mjs` matches the existing formatting (verified against the current file).
- Importing `.mjs` scripts from TS tests requires `"allowJs": true` in `tsconfig.node.json` (Task 1 adds it; without `checkJs`, the `.mjs` files are parsed for inference but not type-checked).
- CI workflow YAMLs and the electron-builder config have **no unit tests** — they are verified by running (Task 8). Do not pretend otherwise in commits.

---

### Task 1: Dependency-admission gate (`scripts/check-deps.mjs`)

**Files:**
- Create: `scripts/check-deps.mjs`
- Create: `tests/check-deps.test.ts`
- Modify: `tsconfig.node.json` (allowJs + include scripts)

- [ ] **Step 1: Add `allowJs` to tsconfig so tests can import the script**

In `tsconfig.node.json`, add to `compilerOptions`:

```json
    "allowJs": true,
```

and add `"scripts/**/*.mjs"` to the `include` array (after the `tests/` entries).

- [ ] **Step 2: Write the failing test**

Create `tests/check-deps.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run tests/check-deps.test.ts`
Expected: FAIL — `Cannot find module '../scripts/check-deps.mjs'`.

- [ ] **Step 4: Implement `scripts/check-deps.mjs`**

```js
// Dependency-admission gate (CLAUDE.md rule 10, ADR-13). Exit 0 = clean,
// exit 1 = violations printed as an offender -> reason table.
// Usage: node scripts/check-deps.mjs [--licenses <licenses.json>]
//   --licenses: JSON from `pnpm licenses list --prod --json`. When omitted the
//   script runs pnpm itself (the CI and local-dev path).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Licenses we distribute (CLAUDE.md rule 10). Default-deny beyond this set. */
const ALLOWED_LICENSES = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
]);
const BUILD_SCRIPT_ALLOWLIST = ['better-sqlite3', 'electron', 'esbuild'];
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

// --- CLI ---
const argv = process.argv.slice(2);
const li = argv.indexOf('--licenses');
const licenseFile = li !== -1 ? argv[li + 1] : undefined;
if (argv.includes('--licenses') && !licenseFile) {
  console.error('--licenses requires a file argument');
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const licenses = licenseFile
  ? JSON.parse(readFileSync(licenseFile, 'utf8'))
  : JSON.parse(
      execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run tests/check-deps.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Run the real gate against this repo**

Run: `node scripts/check-deps.mjs`
Expected: exit 0, "Dependency admission OK". Note: pnpm currently reports one
package as `MIT or GPL-2.0` — `licenseAllowed` handles it. If a genuine
violation appears (e.g. a new transitive GPL dep), STOP and escalate to the
user (CLAUDE.md workflow rule: license concerns are escalated, never ignored).

- [ ] **Step 7: Run typecheck + full suite + lint**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green. (The tsconfig change affects the whole typecheck — catch
any allowJs fallout here.)

- [ ] **Step 8: Commit**

```bash
git add scripts/check-deps.mjs tests/check-deps.test.ts tsconfig.node.json
git commit -m "feat(ci): dependency-admission gate — licenses, exact pins, build allowlist (rule 10)"
```

---

### Task 2: Parameterize the no-listen smoke for packaged builds

The release workflow must smoke-test **the packaged exe**, not dev electron.
`scripts/no-listen-smoke.mjs` currently hardcodes both.

**Files:**
- Modify: `scripts/no-listen-smoke.mjs` (full rewrite below — file is 65 lines)

- [ ] **Step 1: Rewrite `scripts/no-listen-smoke.mjs`**

```js
// AC-4 smoke: launch the app and assert it opens zero LISTEN sockets.
// Windows-only (project target).
//   pnpm no-listen                             — dev electron against out/main
//   node scripts/no-listen-smoke.mjs <exe>     — a packaged build (release gate)
// Note: PIDs are matched by image name, so quit any running instance of the
// same binary before running this (local dev machines may have one in the tray).
import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = dirname(fileURLToPath(import.meta.url));
const electronExe = process.argv[2] ?? require('electron'); // electron.exe path or packaged exe
const isDevElectron = basename(electronExe).toLowerCase() === 'electron.exe';
const imageName = basename(electronExe);

const SETTLE_MS = 7000;

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function appPids() {
  const out = execSync(`tasklist /FI "IMAGENAME eq ${imageName}" /FO CSV /NH`, {
    encoding: 'utf8',
  });
  return new Set(
    out
      .split(/\r?\n/)
      .filter((l) => l.startsWith(`"${imageName}"`))
      .map((l) => l.split('","')[1])
      .filter(Boolean),
  );
}

function listeningLines() {
  return execSync('netstat -ano -p tcp', { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((l) => l.includes('LISTENING'));
}

const child = spawn(
  electronExe,
  // The packaged exe boots its own embedded app; only dev electron needs the
  // entry script passed explicitly.
  isDevElectron ? [join(root, '../out/main/main.js')] : [],
  {
    cwd: join(root, '..'),
    stdio: 'ignore',
    windowsHide: true,
  },
);

await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

try {
  const pids = appPids();
  if (pids.size === 0) fail(`no ${imageName} processes found — app did not start`);

  const offenders = listeningLines().filter((line) => {
    const pid = line.trim().split(/\s+/).at(-1);
    return pid !== undefined && pids.has(pid);
  });

  if (offenders.length > 0) {
    fail(`LISTEN sockets found:\n${offenders.join('\n')}`);
  }
  console.log(`OK: ${pids.size} ${imageName} process(es), zero LISTEN sockets (AC-4).`);
} finally {
  // /T kills the whole process tree (gpu/renderer helpers included).
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}
```

- [ ] **Step 2: Verify the dev path still works**

Run: `pnpm build && pnpm no-listen`
Expected: `OK: N electron process(es), zero LISTEN sockets (AC-4).`

- [ ] **Step 3: Run the existing guard test suite (no regression)**

Run: `pnpm vitest run tests/no-listen-guard.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/no-listen-smoke.mjs
git commit -m "feat(ci): no-listen smoke accepts a packaged exe target"
```

---

### Task 3: electron-builder packaging config

**Files:**
- Modify: `package.json` (new devDependency only — via pnpm, not by hand)
- Create: `electron-builder.yml`
- Modify: `scripts/flip-fuses.mjs:16-18` (comment only)

- [ ] **Step 1: Install electron-builder (admission: MIT, maintained, vetted in `.research/dependency-research.md` row 2; exact-pinned)**

```bash
pnpm add -D --save-exact electron-builder@26.18.0
```

Verify: `node scripts/check-deps.mjs` still exits 0 (its license won't appear in
`--prod` — it is a devDependency — but the exact-pin check covers it).

- [ ] **Step 2: Create `electron-builder.yml`**

```yaml
# Unsigned manual-distribution packaging (ADR-14). Published via the Release
# workflow; see docs/operations.md §6 for the human checklist.
appId: com.saas.print-agent
productName: Print Agent
directories:
  output: dist-release
files:
  - out/**        # electron-vite build output only — never src/, tests/, docs/
  - package.json
asar: true
asarUnpack:
  - '**/node_modules/better-sqlite3/**/*.node' # native module must live on disk
win:
  target:
    - target: nsis
      arch:
        - x64
  signAndEditExecutable: false # unsigned by decision (ADR-14)
nsis:
  oneClick: false              # assisted wizard (operations.md §1)
  perMachine: false            # per-user install, no admin
  allowToChangeInstallationDirectory: true
  artifactName: PrintAgent-Setup-${version}.${ext}
  deleteAppDataOnUninstall: false # local wipe is a support decision, not a side effect
# Production fuse set — must stay in sync with scripts/flip-fuses.mjs (dev).
# enableEmbeddedAsarIntegrityValidation is only safe here (asar is on).
electronFuses:
  runAsNode: false
  enableCookieEncryption: true
  enableNodeOptionsEnvironmentVariable: false
  enableNodeCliInspectArguments: false
  enableEmbeddedAsarIntegrityValidation: true
  grantFileProtocolExtraPrivileges: false
  grantNetworkProtocolExtraPrivileges: false
npmRebuild: true # rebuild better-sqlite3 against the Electron ABI
```

- [ ] **Step 3: Update the stale comment in `scripts/flip-fuses.mjs`**

Replace lines 16–18:

```js
  // Requires asar + embedded integrity headers, i.e. the packaged app
  // (electron-builder enables it at P8). Turning it on unpackaged breaks startup.
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
```

with:

```js
  // Requires asar + embedded integrity headers. Packaged builds set this via
  // `electronFuses` in electron-builder.yml (keep the two sets in sync).
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
```

- [ ] **Step 4: Package locally and verify the artifact**

```bash
pnpm build
pnpm exec electron-builder --win nsis --x64
```

Expected: `dist-release/PrintAgent-Setup-0.1.0.exe` plus `dist-release/win-unpacked/`.
First run downloads the Electron dist + NSIS tooling (network needed).

- [ ] **Step 5: Run the no-listen smoke against the packaged exe**

```bash
node scripts/no-listen-smoke.mjs "dist-release/win-unpacked/Print Agent.exe"
```

Expected: `OK: N Print Agent.exe process(es), zero LISTEN sockets (AC-4).`
If it fails: check that no `Print Agent.exe` instance is already running (Task 2's note), then investigate — a LISTEN socket in the packaged build is a **release blocker**, not a CI nuisance.

- [ ] **Step 6: Launch the packaged app once and confirm the unpaired screen renders**

Run `dist-release/win-unpacked/Print Agent.exe` by hand. Expected: window/tray
appears showing the unpaired/pairing state (no demo data, no devtools). Close it.

- [ ] **Step 7: Full suite still green, then commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
git add package.json pnpm-lock.yaml electron-builder.yml scripts/flip-fuses.mjs
git commit -m "feat(packaging): electron-builder NSIS config — unsigned, per-user, production fuses"
```

(`dist-release/` must NOT be committed — check `git status`; if it appears as
untracked, add `dist-release/` to `.gitignore` in the same commit.)

---

### Task 4: Distribution-model docs (CLAUDE.md rule 11, ADR, operations §1/§3)

**Files:**
- Modify: `CLAUDE.md` (rule 11 only)
- Modify: `docs/adr.md` (ADR-12 status, new ADR-14 row)
- Modify: `docs/operations.md` (§1, §3)

- [ ] **Step 1: Amend CLAUDE.md rule 11 — replace the line**

```text
11. **Updates**: only through the signed electron-updater feed. Never disable signature
    checks. Never allow version downgrades in shipped code.
```

with:

```text
11. **Updates**: no auto-updater. New versions are distributed as manually installed
    packages. Never add an update channel that is not signature-verified end to end —
    an unsigned auto-updater is forbidden.
```

Touch nothing else in CLAUDE.md.

- [ ] **Step 2: Mark ADR-12 superseded in `docs/adr.md`**

In the ADR-12 row, change the status cell from `accepted` to `superseded by ADR-14`.

- [ ] **Step 3: Add the ADR-14 row to the table in `docs/adr.md`** (match the existing table format)

```markdown
| ADR-14 | **Unsigned manual distribution: no code signing, no auto-updater; installers published as GitHub Release artifacts, restaurants reinstall to update**                                                                                                          | accepted | Owner decision: cert cost + feed infra not justified today; an unsigned auto-updater is forbidden (RCE-via-feed, T6); SmartScreen "unknown publisher" on every install accepted operationally; rule 11 amended to match | Signed feed + electron-updater (ADR-12 — superseded); unsigned auto-updater (explicitly forbidden, CLAUDE.md rule 11)                                                       |
```

- [ ] **Step 4: Update `docs/operations.md` §1 step 1**

Replace:

```markdown
1. Download installer (`PrintAgent-Setup-x.y.z.exe`) from the SaaS download page
   (Authenticode-signed; verify signature before run).
```

with:

```markdown
1. Download installer (`PrintAgent-Setup-x.y.z.exe`) from the SaaS download page
   (unsigned — verify the SHA-256 checksum from the GitHub Release before run).
   **SmartScreen note:** Windows shows "Windows protected your PC / Unknown
   publisher" on first run. This is expected for our unsigned installer
   (ADR-14): choose **More info → Run anyway**. It appears on every install
   until code signing is adopted.
```

- [ ] **Step 5: Rewrite `docs/operations.md` §3**

Replace the entire §3 (table + rollback paragraph) with:

```markdown
## 3. Updates

There is **no auto-updater** (ADR-14). New versions ship as
`PrintAgent-Setup-x.y.z.exe` on the SaaS download page (built by the Release
workflow from a `vX.Y.Z` tag); updating means running the new installer.

Consequences of the unsigned manual model, accepted by ADR-14:

- SmartScreen warns "unknown publisher" on every install (§1) — expected.
- Downgrades are not refused: installing an older installer file simply reverts
  the version.
- There is no kill switch or staged rollout. A broken release is pulled from the
  download page and restaurants reinstall the previous installer.
- Electron major upgrades are still tested against the contract test suite
  before entering a release (§6).
```

- [ ] **Step 6: Lint docs formatting (prettier covers markdown) and commit**

```bash
pnpm format:check || pnpm format
git add CLAUDE.md docs/adr.md docs/operations.md
git commit -m "docs: unsigned manual distribution model — rule 11 amendment, ADR-14, ops §1/§3"
```

---

### Task 5: Release driver (`scripts/release.mjs`)

**Files:**
- Create: `scripts/release.mjs`
- Create: `tests/release-script.test.ts`
- Modify: `package.json` (add `release` script)

- [ ] **Step 1: Write the failing test — `tests/release-script.test.ts`**

```ts
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
```

- [ ] **Step 2: Run it to verify failure**

Run: `pnpm vitest run tests/release-script.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement `scripts/release.mjs`**

```js
// Release driver: bump version, commit, tag, push. The Release workflow does
// the rest (build, package, smoke, GitHub Release). Refuses to overwrite an
// existing tag. Usage: pnpm release patch|minor|major
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PARTS = ['patch', 'minor', 'major'];

/** Pure semver bump. Throws on unparseable input. */
export function nextVersion(version, part) {
  const parts = version.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) {
    throw new Error(`unparseable version: ${version}`);
  }
  const [major, minor, patch] = parts.map(Number);
  switch (part) {
    case 'major':
      return `${(major ?? 0) + 1}.0.0`;
    case 'minor':
      return `${major ?? 0}.${(minor ?? 0) + 1}.0`;
    case 'patch':
      return `${major ?? 0}.${minor ?? 0}.${(patch ?? 0) + 1}`;
    default:
      throw new Error(`unknown part: ${part}`);
  }
}

/** Pure preflight over captured git state. Returns failure strings (empty = go). */
export function preflightFailures({ status, branch, behindCount, existingTag, part }) {
  const failures = [];
  if (!PARTS.includes(part)) failures.push(`usage: pnpm release ${PARTS.join('|')} (got "${part}")`);
  if (status.trim() !== '') failures.push('working tree not clean — commit or stash first');
  if (branch !== 'main') failures.push(`must run on main (currently on "${branch}")`);
  if (behindCount > 0) failures.push(`main is ${behindCount} commit(s) behind origin — pull first`);
  if (existingTag) failures.push(`tag already exists — refusing to overwrite`);
  return failures;
}

// --- CLI ---
const run = (args) => execFileSync('git', args, { encoding: 'utf8' });
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const part = process.argv[2];
const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

let existingTag = false;
if (PARTS.includes(part)) {
  const tag = `v${nextVersion(pkg.version, part)}`;
  try {
    run(['rev-parse', '-q', '--verify', `refs/tags/${tag}`]);
    existingTag = true;
  } catch {
    // tag absent — the good case
  }
}

const status = run(['status', '--porcelain']);
const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
execFileSync('git', ['fetch', 'origin', 'main'], { stdio: 'ignore' });
const behindCount = Number.parseInt(run(['rev-list', '--count', 'HEAD..origin/main']).trim(), 10);

const failures = preflightFailures({ status, branch, behindCount, existingTag, part });
if (failures.length > 0) {
  for (const f of failures) console.error(`REFUSED: ${f}`);
  process.exit(1);
}

const tag = `v${nextVersion(pkg.version, part)}`;
const version = nextVersion(pkg.version, part);
pkg.version = version;
// package.json is 2-space indented; this preserves the existing formatting.
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

execFileSync('git', ['add', 'package.json']);
execFileSync('git', ['commit', '-m', `chore(release): ${tag}`], { stdio: 'inherit' });
execFileSync('git', ['tag', tag]);
execFileSync('git', ['push', 'origin', 'main'], { stdio: 'inherit' });
execFileSync('git', ['push', 'origin', tag], { stdio: 'inherit' });
console.log(`Pushed ${tag} — the Release workflow builds and publishes the GitHub Release.`);
```

- [ ] **Step 4: Run tests, add the package.json script, run gates**

```bash
pnpm vitest run tests/release-script.test.ts   # PASS
```

Add to `package.json` `scripts` (alphabetical position, after `no-listen`):

```json
    "release": "node scripts/release.mjs"
```

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Do NOT run `pnpm release` now (it would tag main).

- [ ] **Step 5: Commit**

```bash
git add scripts/release.mjs tests/release-script.test.ts package.json
git commit -m "feat(release): pnpm release driver — version bump, tag guard, push"
```

---

### Task 6: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `docs/operations.md` (new §9)

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  gate:
    name: deps · lint · typecheck · test
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Dependency admission (CLAUDE.md rule 10)
        run: node scripts/check-deps.mjs
      - name: SBOM (CycloneDX, uploaded per run)
        uses: anchore/sbom-action@v0
        with:
          format: cyclonedx-json
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test

  smoke:
    name: build · fuses · no-listen (AC-4)
    needs: gate
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm fuse:dev
      - run: pnpm no-listen
```

- [ ] **Step 2: Add new §9 to `docs/operations.md`** (after §8)

```markdown
## 9. CI

Two GitHub Actions workflows (`.github/workflows/`), both on Windows runners:

- **CI** — every PR and every push to `main`: dependency-admission gate
  (`check-deps.mjs`: license allowlist MIT/Apache-2.0/BSD/ISC, exact pins,
  build-script allowlist — CLAUDE.md rule 10), CycloneDX SBOM (uploaded as a
  workflow artifact per run), lint, typecheck, full test suite (renderer fuzz
  corpus included), then build + dev fuses + the `no-listen` smoke
  (zero LISTEN sockets, AC-4).
- **Release** — a pushed `vX.Y.Z` tag: full gate again, electron-builder NSIS
  package with production fuses, `no-listen` smoke against the packaged exe,
  SHA-256 checksum, GitHub Release with installer + checksum (§6).

Artifacts: installers live on GitHub Releases; every CI run keeps a CycloneDX
SBOM artifact (90-day default retention).
```

- [ ] **Step 3: Validate YAML syntax locally**

```bash
node -e "const yaml=require('js-yaml')"
```

If `js-yaml` is not available, do a careful visual pass instead (indentation is
2 spaces; the guard step in release.yml uses `shell: bash`). Do NOT add a YAML
parser dependency for this.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml docs/operations.md
git commit -m "feat(ci): GitHub Actions gate + no-listen smoke on Windows runners"
```

---

### Task 7: Release workflow + operations §6 rewrite

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `docs/operations.md` §6

- [ ] **Step 1: Create `.github/workflows/release.yml`**

```yaml
name: Release

on:
  push:
    tags: ['v*']

permissions:
  contents: write

concurrency:
  group: release
  cancel-in-progress: false # never cancel a publish mid-flight

jobs:
  release:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - name: Tag must match package.json version
        shell: bash
        run: |
          tag="${GITHUB_REF_NAME#v}"
          pkg="$(node -p "require('./package.json').version")"
          if [ "$tag" != "$pkg" ]; then
            echo "REFUSED: tag v$tag does not match package.json version $pkg" >&2
            exit 1
          fi
      - run: pnpm install --frozen-lockfile
      - name: Dependency admission (CLAUDE.md rule 10)
        run: node scripts/check-deps.mjs
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
      - name: Package (NSIS, unsigned, production fuses)
        run: pnpm exec electron-builder --win nsis --x64
      - name: no-listen smoke against the packaged exe (AC-4)
        run: node scripts/no-listen-smoke.mjs "dist-release/win-unpacked/Print Agent.exe"
      - name: SHA-256 checksums
        shell: bash
        run: |
          cd dist-release
          for f in PrintAgent-Setup-*.exe; do
            sha256sum "$f" > "$f.sha256"
          done
      - name: Publish GitHub Release
        shell: bash
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          cat > release-notes.md <<'EOF'
          Unsigned manual-distribution build (ADR-14). Restaurants install or
          upgrade by running this installer.

          Release-engineer checklist before distributing (operations.md §6):
          - Verify the SHA-256 checksum of the installer.
          - Confirm the production API base URL is compiled in (no placeholder).
          - Confirm the pairing-code alphabet ^[A-Z0-9]{8}$ with the Laravel team.
          - Upload the installer to the SaaS download page.
          EOF
          gh release create "$GITHUB_REF_NAME" \
            dist-release/PrintAgent-Setup-*.exe \
            dist-release/PrintAgent-Setup-*.sha256 \
            --title "Print Agent $GITHUB_REF_NAME" \
            --notes-file release-notes.md
```

- [ ] **Step 2: Rewrite `docs/operations.md` §6**

Replace §6 entirely with:

```markdown
## 6. Build & release checklist

1. CI green on `main` (gate + smoke — §9).
2. `pnpm release patch|minor|major` from a clean, up-to-date `main` — bumps the
   version, tags, and pushes; the Release workflow builds, packages, smokes the
   packaged exe, and publishes the GitHub Release with
   `PrintAgent-Setup-x.y.z.exe` + `.sha256`.
3. Download the installer and verify the SHA-256 checksum against the Release.
4. **Confirm the production API base URL is compiled in** — `src/main/main.ts`
   still defaults to the placeholder `print-api.example-saas.test`; a release
   build must carry the real Laravel URL (`PRINT_AGENT_API_URL` is a dev-only
   override, §8).
5. **Confirm the pairing-code alphabet** `^[A-Z0-9]{8}$` with the Laravel team
   (the agent pins this regex).
6. Upload the installer to the SaaS download page. SmartScreen warnings at
   restaurants are expected (§1, ADR-14).
7. Before any Electron major bump enters a release: upgrade smoke on
   Win10 19045 and Win11 23H2, clean profile + upgrade path.
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml docs/operations.md
git commit -m "feat(release): tag-triggered packaging workflow + ops §6 rewrite"
```

Honesty note for the commit/PR description: `release.yml` is verified by review
only until the first real tag is pushed (a dry-run would create a public
GitHub Release). `ci.yml` is verified live in Task 8.

---

### Task 8: End-to-end verification — first CI run

**Files:** none created; fixes as needed anywhere.

- [ ] **Step 1: Full local gate one last time**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm no-listen
```

Expected: all green.

- [ ] **Step 2: Push the branch and open the PR** (confirm with the user before pushing/opening)

Push to origin, open a PR against `main`.

- [ ] **Step 3: Watch the first CI run (`gh run watch` or the Actions tab) and fix fallout**

Expected failure classes and first moves:
- `pnpm/action-setup` version mismatch → confirm `packageManager` field is read; do not pin a second version.
- `check-deps.mjs` fails in CI but not locally → likely pnpm version drift; compare `pnpm licenses list --prod --json` output between local and runner.
- `no-listen` fails on the runner with "no electron processes found" → the desktop session may need `windowsHide` adjustments or the app failed to boot; check by removing `stdio: 'ignore'` temporarily.
- SBOM step slow/failing → `anchore/sbom-action` `dependency-graph`/network issues; retry once before changing tools.

Do not weaken gates to make CI green (no `continue-on-error`, no skipped steps). Every fix is a normal commit on the PR branch.

- [ ] **Step 4: Confirm the packaged-artifact path once on CI**

If the PR run is green, merge is authorized. The release path's first live
verification happens at the first real `pnpm release` — recorded as a known
limitation in the PR description (per Task 7's honesty note).

- [ ] **Step 5: Final commit if any fixes were needed**

```bash
git status   # must be clean after PR merge
```

---

## Verification summary

| What | How verified |
| --- | --- |
| `check-deps.mjs` | Unit tests (fixtures per violation class) + real run against repo |
| `no-listen-smoke.mjs` parameterization | Real dev run + existing guard tests |
| electron-builder config | Local package + packaged no-listen + manual launch (Task 3) |
| `release.mjs` | Unit tests (pure logic); git flow exercised at first real release |
| `ci.yml` | First real PR run (Task 8) |
| `release.yml` | Review only until first tag — stated honestly in PR description |
| Docs | Prettier check; content reviewed against spec §5 |
