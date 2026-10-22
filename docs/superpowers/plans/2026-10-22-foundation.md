# Print Agent Foundation (P0 + tray shell) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Electron tray application skeleton (main/preload/renderer/services) with hardened security defaults, validated IPC, structured redacted logging, and test/tooling rails — no printer or cloud connectivity.

**Architecture:** electron-vite orchestrates three build targets (main = Node/Electron, preload = sandboxed contextBridge, renderer = React SPA served locally only). All security-critical logic lives in pure, dependency-injected modules under `src/main/security` and `src/main/services` so Vitest can test them without importing `electron`. The renderer is UI-only: it reaches the main process exclusively through a whitelisted, zod-validated `contextBridge` API.

**Tech Stack:** Electron 45.0.0 · electron-vite 6.0.0 + Vite 8 + @vitejs/plugin-react · React 19.3 · TypeScript 5.9 (strict, no `any` at boundaries) · Vitest 5 · ESLint 10 flat config + typescript-eslint 8 · Prettier 3 · zod 4.6.7 · electron-log 5.4.4 · pnpm 10 (exact pins, `ignore-scripts` friendly).

---

## File structure

```
package.json                  exact-pinned deps, scripts (dev/build/test/lint/typecheck/format)
pnpm-workspace.yaml?          no (single package)
electron.vite.config.ts       three-target config
tsconfig.json / tsconfig.node.json / tsconfig.web.json   strict project refs
vitest.config.ts              node environment, include tests/
eslint.config.js              flat, TS strict + security rules (no-eval, no-new-func…)
.prettierrc.json
.gitignore
README.md                     setup + pinned version table

src/shared/ipc-contract.ts    channel names + zod schemas + request/response types (single source of truth)
src/main/main.ts              entry: single-instance lock, enableSandbox, no-listen guard, wiring
src/main/app-context.ts       DI container (injects paths, settings, logger)
src/main/security/window-options.ts   pure hardened BrowserWindow options + CSP string
src/main/security/sender-guard.ts     pure trusted-sender check (URL allowlist per env)
src/main/security/no-listen-guard.ts  patches net.Server#listen to throw; installable + removable
src/main/ipc/register.ts      maps channel -> {schema, handler}; validates sender + payload
src/main/services/settings.ts zod-strict persisted settings (launchAtLogin), injected fs adapter
src/main/services/autolaunch.ts  app.setLoginItemSettings wrapper (electron glue)
src/main/services/logger/redact.ts    pure secret/PII redaction
src/main/services/logger/logger.ts    electron-log wiring: JSON lines, rotation 5MB
src/main/tray.ts              tray icon + menu (Open, Launch at login ✓, Quit)
src/main/window.ts            createMainWindow using window-options; close→hide, quit-aware
src/preload/index.ts          contextBridge: explicit named methods only
src/renderer/index.html       CSP meta: default-src 'self'; …
src/renderer/src/main.tsx, App.tsx, app.css   status + launch-at-login toggle + quit button
assets/icon.png               16x16/32x32 tray+window icon (generated, committed)

tests/window-options.test.ts  AC assertions: contextIsolation, sandbox, nodeIntegration, webSecurity, CSP
tests/sender-guard.test.ts    rejects file:// strangers, dev-server allowlist, cross-frame
tests/ipc-contract.test.ts    every exposed channel has strict schema; unknown fields rejected; size caps
tests/no-listen-guard.test.ts listen() throws; restore works
tests/redact.test.ts          tokens/keys/emails redacted; normal text untouched
tests/settings.test.ts        round-trip, corrupt file rejected, unknown fields rejected, atomic write
scripts/no-listen-smoke.mjs   spawns built app, asserts zero LISTEN sockets via netstat (AC-4)
```

## Tasks

### Task 1 — Scaffold tooling
- `pnpm init`, add exact-pinned deps (below), set `packageManager`, scripts:
  `dev`, `build`, `start`, `test` (vitest run), `test:watch`, `lint`, `typecheck`, `format`, `no-listen`.
- tsconfigs: `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `isolatedModules`, `noEmit` (electron-vite transforms), separate node (main/preload/tests) and web (renderer) configs.
- eslint flat config: typescript-eslint recommended-strict + `no-restricted-properties`/`globals` bans on `eval`, `new Function`, `vm`, `ChildProcess.exec`-style patterns per CLAUDE.md rule 4.
- **Verify:** `pnpm exec tsc -b --dry`, `pnpm lint` on a stub file pass. Commit.

### Task 2 — Security core (TDD)
- `src/shared/ipc-contract.ts`: channel enum + zod v4 strict schemas (`.strict()`) with `maxSize`-style caps (`.max()` on strings/arrays), e.g. `settings.setLaunchAtLogin {enabled: boolean}`.
- `src/main/security/window-options.ts`: pure `getWindowOptions(preloadPath, {devServerUrl})` → `{sandbox:true, contextIsolation:true, nodeIntegration:false, webSecurity:true, ...}`; `getCsp()` → `'default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self''`.
- `src/main/security/sender-guard.ts`: `createSenderGuard({ allowedUrls, log })` → `assertTrusted(sender: {frame?: {url: string}, hostWebContents?: unknown})` throws `IpcAccessError` if URL not in allowlist.
- `src/main/security/no-listen-guard.ts`: `installNoListenGuard(target = net.Server.prototype)` wraps `listen` to throw `ListenForbiddenError`; returns uninstall fn.
- **Verify:** unit tests listed above, all green. Commit.

### Task 3 — Logger
- `redact.ts`: pure; pattern list (Bearer/JWT, hex/base64-ish `deviceKey`/`token`/`secret`/`password` JSON values, emails) → `[REDACTED:<kind>]`; deep-walks objects (depth-capped, 1 MiB input cap).
- `logger.ts`: electron-log main scope, JSON-lines format via `log.hooks`, `redact` in hook chain, `file.maxSize = 5*1024*1024` (electron-log rotates), no console transport in packaged builds.
- **Verify:** redact tests green; logger module typechecks (electron-glue kept thin). Commit.

### Task 4 — Settings + IPC + preload
- `settings.ts`: `createSettingsStore({ readJson, writeJson, defaults })` — zod strict parse, atomic write (tmp+rename), `get()`, `set(patch)`. Settings: `{ launchAtLogin: boolean }`.
- `autolaunch.ts`: thin `applyLaunchAtLogin(app, enabled)` via `app.setLoginItemSettings({openAtLogin})` (electron glue; not unit-tested).
- `ipc/register.ts`: `registerIpc(handlers)` — table-driven; for each channel: `assertTrusted(event)` → schema.parse(payload) → handler; unknown channel rejected. `ipcMain.handle` invoked from `main.ts`.
- `preload/index.ts`: `contextBridge.exposeInMainWorld('printAgent', { getAgentInfo, getSettings, setLaunchAtLogin, hideWindow, quitApp })` — named methods only, no raw `ipcRenderer` exposure.
- **Verify:** ipc-contract + settings tests green. Commit.

### Task 5 — Tray shell + renderer
- `window.ts`: create window from `getWindowOptions`; `close` → `preventDefault(); win.hide()` unless `app.isQuitting` (set in `before-quit`); minimize also hides (tray-only shell).
- `tray.ts`: tray icon (committed `assets/icon.png`), menu: Open Print Agent / Launch at login (checkbox, wired to settings) / Quit.
- `main.ts`: `app.enableSandbox()` before ready, `requestSingleInstanceLock` (second instance → show window), `window-all-closed` → no-op (keep running), install no-listen guard, register IPC, apply autolaunch from settings.
- Renderer: minimal React status view — agent version, connection state "Not configured (cloud disabled in this phase)", launch-at-login toggle, Quit button. CSP meta in `index.html`.
- **Verify:** `pnpm dev` launches; tray present; close keeps process alive; Quit exits. Commit.

### Task 6 — Checks + verification
- `pnpm lint && pnpm typecheck && pnpm test` green.
- `node scripts/no-listen-smoke.mjs` → builds, launches app, parses `netstat -ano` for app PIDs, asserts no LISTEN.
- Report remaining security limitations.

## Version pins (exact)

| Package | Version | License | Notes |
|---|---|---|---|
| electron | 45.0.0 | MIT | latest stable major (43/44/45 supported; 42 EOL'd 2026-10-20) |
| electron-vite | 6.0.0 | MIT | requires @swc/core peer |
| @swc/core | 1.16.20 | Apache-2.0 | electron-vite transform backend |
| vite | ^8.3.5 (locked) | MIT | |
| @vitejs/plugin-react | 6.1.2 | MIT | |
| react / react-dom | 19.3.1 | MIT | |
| typescript | ~5.9.x (locked) | Apache-2.0 | TS 7 not yet supported by typescript-eslint (<6.1.0) |
| vitest | 5.0.5 | MIT | |
| eslint | 10.13.0 | MIT | |
| typescript-eslint | 8.72.0 | MIT | |
| prettier | 3.9.10 | MIT | |
| zod | 4.6.7 | MIT | boundary validation |
| electron-log | 5.4.4 | MIT | rotation + JSON |
| @types/node / react / react-dom | latest matching | MIT | |

Zero runtime deps beyond zod/electron-log/react at this stage. No GPL/AGPL. No postinstall scripts required.
