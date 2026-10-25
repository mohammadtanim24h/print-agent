# CI Pipeline + Packaging (unsigned, manual distribution) — Design

**Date:** 2026-10-25
**Status:** Approved
**Decides:** GitHub Actions CI structure, dependency-admission enforcement,
electron-builder packaging config, release process, distribution-model docs.

## Context

The wiring/composition phase (5ca8f51..e6e8984) completed the runtime: AgentRuntime
composition root, 20 validated IPC channels, renderer off demo data, ~500 tests green,
typecheck/lint/build/no-listen gates pass locally. Missing: CI to protect the
codebase (PRD P0 exit test, ADR-13) and packaging into a distributable exe (P8).

**Decided by the owner:** no code signing, no auto-updater. Distribution is manual
installer files; restaurants reinstall to update. SmartScreen "unknown publisher"
warnings are an accepted operational cost. CLAUDE.md rule 11 is amended in this phase
to reflect the model while keeping the security intent (no RCE-via-feed).

Facts verified during design:

- `electronFuses` is a native top-level option in electron-builder 26 config
  (confirmed in `app-builder-lib@26.18.0/scheme.json`) — no afterPack hook needed.
- `pnpm sbom` does **not** exist in pnpm 10.33. SBOM comes from `anchore/sbom-action`
  (syft; reads `pnpm-lock.yaml`; Windows-runner compatible).
- The renderer fuzz corpus (`tests/render-fuzz.test.ts`) is part of the standard
  vitest suite — the regular test job covers it.
- Windows GitHub runners provide a desktop session, so `pnpm no-listen` (spawns
  Electron, asserts zero LISTEN sockets via netstat) runs on every PR, not scheduled.
- electron-builder is already vetted in `.research/dependency-research.md`
  (MIT, maintained, 26.x); this phase adds it exact-pinned and enforces it mechanically.

## 1. CI workflows (Approach A: two workflows, shared local gates)

All jobs run on `windows-latest`; Node 24 + pnpm via the `packageManager` field
(corepack). Concurrency group per ref cancels superseded runs.

### `.github/workflows/ci.yml` — triggers: `pull_request`, `push` to `main`

**Job `gate`:**

1. `pnpm install --frozen-lockfile` — pnpm 10 only runs postinstall scripts for
   `pnpm.onlyBuiltDependencies` (better-sqlite3, electron, esbuild); any other
   package attempting build scripts is blocked.
2. `node scripts/check-deps.mjs` — dependency admission (§2).
3. `anchore/sbom-action` → CycloneDX JSON, uploaded as a workflow artifact
   (per-commit SBOM record).
4. `pnpm lint`, `pnpm typecheck`, `pnpm test` — full suite including the fuzz corpus
   (zero-panic, bounded-output assertions included).

**Job `smoke`** (`needs: gate`):

1. `pnpm build`
2. `pnpm fuse:dev`
3. `pnpm no-listen` — every PR. If the runner proves flaky, the documented fallback
   is main-only; that is a fallback, not the design.

### `.github/workflows/release.yml` — trigger: push of tags `v*`

See §4.

## 2. Dependency admission — `scripts/check-deps.mjs`

One script, unit-tested (`tests/check-deps.test.ts`, fixture inputs — no shelling
out in tests). Violations exit non-zero with an offender → reason table.

1. **Exact-pinning:** every `dependencies`/`devDependencies` entry matches
   `^\d+\.\d+\.\d+$` — no `^`, `~`, ranges, or tags.
2. **License allowlist:** parses `pnpm licenses list --prod --json` output (accepted
   as a file/stdin so tests can pass fixtures). Default-deny: anything outside
   `MIT | Apache-2.0 | BSD-2-Clause | BSD-3-Clause | ISC` fails, including
   missing/unknown license strings.
3. **Build-script allowlist:** asserts `pnpm.onlyBuiltDependencies` deep-equals
   `["better-sqlite3", "electron", "esbuild"]`.
4. **New-dependency discipline:** electron-builder enters devDependencies in this
   phase, exact-pinned at current 26.x — MIT, maintained, vetted
   (`.research/dependency-research.md` row 2). The script enforces admission
   mechanically from here on.

## 3. Packaging — `electron-builder.yml`

New devDependency: `electron-builder` (exact full version, e.g. `26.18.0` — whatever
current is at install time).

```yaml
appId: com.saas.print-agent
productName: Print Agent
directories: { output: dist-release }
files:
  - out/**          # electron-vite build output only — never src/, tests/, docs/
  - package.json
asar: true
asarUnpack:
  - "**/node_modules/better-sqlite3/**/*.node"   # native module must live on disk
win:
  target:
    - target: nsis
      arch: [x64]
  signExecutable: false          # skip code signing only (unsigned by decision,
                                 # ADR-14) — keep exe metadata editing
nsis:
  oneClick: false                 # assisted wizard
  perMachine: false               # per-user, no admin (operations.md §1)
  allowToChangeInstallationDirectory: true
  artifactName: PrintAgent-Setup-${version}.${ext}
  deleteAppDataOnUninstall: false # wipe is a support decision, not a side effect
electronFuses:                    # native electron-builder 26 support
  runAsNode: false
  enableCookieEncryption: true
  enableNodeOptionsEnvironmentVariable: false
  enableNodeCliInspectArguments: false
  enableEmbeddedAsarIntegrityValidation: true   # now safe: asar is on
  onlyLoadAppFromAsar: true       # required with integrity validation: without it
                                  # a planted app/ dir next to the asar bypasses
                                  # validation (per-user install dir is writable)
  grantFileProtocolExtraPrivileges: false
npmRebuild: false                 # better-sqlite3 13 ships N-API prebuilds
                                  # (prebuilds/win32-x64.node) — ABI-stable across
                                  # Node/Electron; no Electron-ABI rebuild needed
```

`grantNetworkProtocolExtraPrivileges` is not listed: the fuse does not exist in
@electron/fuses 2.1.3 / Electron 45 — omitting.

Notes:

- `enableEmbeddedAsarIntegrityValidation: true` is packaging-only; the dev binary
  keeps integrity validation off (`scripts/flip-fuses.mjs` is dev-binary-only —
  running it against dist-release binaries would disable asar integrity).
- Renderer is packaged-files-only by construction (electron-vite bundles it; no
  dev-server origin exists in the packaged app; no debug ports introduced).
- Renderer is served over a privileged `app://` custom scheme (fs-level asar reads);
  the file-protocol fuse stays off.
- The release workflow runs the **no-listen smoke against the packaged exe**
  (`dist-release/win-unpacked/Print Agent.exe`, same netstat assertion) — the
  packaged binary must prove AC-4, not just `out/`.

## 4. Release process

**`scripts/release.mjs`** (`pnpm release patch|minor|major`):

1. Requires clean git tree, on `main`, up to date with origin.
2. Bumps `package.json` version → commits `chore(release): vX.Y.Z` → tags `vX.Y.Z`
   → pushes branch + tag.
3. Refuses to overwrite an existing tag.

**`release.yml`** (tag `v*` push), `windows-latest`:

1. Guard: fail unless tag equals `package.json` version.
2. Re-run the full gate (tags are pushable without a PR — never trust them).
3. `pnpm build` → electron-builder package (fuses via config) → **packaged
   no-listen smoke**.
4. SHA-256 checksum file alongside the exe.
5. Create the GitHub Release with `PrintAgent-Setup-X.Y.Z.exe` + `.sha256`; body
   carries the manual-checklist reminders (API base URL, pairing alphabet).
6. Concurrency: one release at a time; never cancel mid-publish.

**Manual steps (human, after the Release exists):** download exe, verify checksum,
upload to the SaaS download page. Codified in operations.md §6.

## 5. Docs changes (same change as the code)

**`CLAUDE.md` rule 11** — replaced verbatim with:

> **Updates**: no auto-updater. New versions are distributed as manually installed
> packages. Never add an update channel that is not signature-verified end to end —
> an unsigned auto-updater is forbidden.

No other rule is touched.

**`docs/operations.md`:**

- **§1:** installer name pattern; SmartScreen note — "Windows SmartScreen shows
  'Windows protected your PC / Unknown publisher' on first run of the unsigned
  installer. This is expected: 'More info' → 'Run anyway'. It appears on every
  install until code signing is adopted."
- **§3 (Updates):** rewritten — no feed, no staged rollout, no kill-switch table.
  Updates are manual reinstalls of `PrintAgent-Setup-X.Y.Z.exe`; downgrade is
  installing an older file (no guard — documented honestly as an accepted cost of
  the unsigned model). Electron-major-upgrade pre-req (contract-suite testing)
  retained.
- **§6 (Build & release checklist):** rewritten — CI gate green →
  `pnpm release <part>` → CI publishes the GitHub Release → human verifies checksum
  → confirm **production API base URL** (`src/main/main.ts` placeholder +
  `PRINT_AGENT_API_URL` override) → confirm pairing-code alphabet `^[A-Z0-9]{8}$`
  with the Laravel team → upload to the SaaS download page. Signing/feed/staging
  steps deleted.
- **New CI section:** what the workflows check, where artifacts live (GitHub
  Releases, per-commit SBOM artifacts), and that `check-deps.mjs` enforces
  CLAUDE.md rule 10 mechanically.

**`docs/adr.md`:** new ADR — unsigned distribution decision (no signing cert, no
updater; SmartScreen accepted; rule-11 amendment; revisit trigger: SmartScreen
support burden).

## 6. Testing & verification (honest notes)

- `check-deps.mjs` — unit tests: each violation class + a clean pass (fixtures).
- `release.mjs` — unit-test the pure guard logic (version/tag checks); the git
  operations are verified manually once.
- `electron-builder.yml` and the workflow YAMLs have no unit tests — **verified by
  the workflows actually running**. The implementation plan includes an explicit
  "watch and fix the first real CI run" task, and a one-time local packaged-build
  verification in this phase: `pnpm build` → electron-builder → packaged no-listen
  → launch → unpaired/pairing screen renders.
- The existing ~500-test suite stays green throughout; no test is removed or
  skipped.

## Out of scope (later phases)

Code signing (revisit if SmartScreen becomes an operational problem), WSS
transport, spooler transport, FR-16 config application, FR-14 duplicate banner,
hardware validation (R-VAL), live-updated UI state, physical pairing smoke against
the real Laravel API.
