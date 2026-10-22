# Print Agent

Production Windows x64 Electron print agent for a restaurant SaaS. Receives print
jobs over outbound-only connections and drives 80mm ESC/POS thermal printers.
Contracts live in `docs/` (`api-contract.md` and the state machine in
`architecture.md` §5 are normative).

## Current status

Foundation phase (P0 + tray shell): hardened Electron skeleton, validated IPC,
redacted rotating logging, tray lifecycle, launch-at-login setting. **No printer
or cloud connectivity yet** — by design.

## Setup

```sh
pnpm install
pnpm dev            # dev run (Vite dev server + Electron)
pnpm build          # build main/preload/renderer to out/
pnpm test           # Vitest unit tests
pnpm lint           # ESLint (strictTypeChecked + security bans)
pnpm typecheck      # tsc -b (strict)
pnpm format         # Prettier
pnpm fuse:dev       # harden the dev Electron binary with security fuses
pnpm no-listen      # AC-4 smoke: launch built app, assert zero LISTEN sockets
```

Node 24+ and pnpm 10 required. Windows x64 is the only supported target.

## Toolchain (pinned, exact)

| Package              | Version | License    | Why                                                                                        |
| -------------------- | ------- | ---------- | ------------------------------------------------------------------------------------------ |
| electron             | 45.0.0  | MIT        | latest stable major (43/44/45 supported; 42 EOL 2026-10-20). Chromium 152, Node 24 runtime |
| electron-vite        | 6.0.0   | MIT        | three-target build orchestration                                                           |
| vite                 | 8.3.5   | MIT        | bundler                                                                                    |
| @vitejs/plugin-react | 6.1.2   | MIT        | renderer JSX/HMR                                                                           |
| @swc/core            | 1.16.20 | Apache-2.0 | electron-vite transform backend                                                            |
| react / react-dom    | 19.3.1  | MIT        | local-only tray UI                                                                         |
| typescript           | 5.9.3   | Apache-2.0 | strict; TS 7 not yet supported by typescript-eslint (<6.1.0)                               |
| vitest               | 5.0.5   | MIT        | unit tests                                                                                 |
| eslint               | 10.13.0 | MIT        | flat config                                                                                |
| typescript-eslint    | 8.72.0  | MIT        | strictTypeChecked                                                                          |
| prettier             | 3.9.10  | MIT        | formatting                                                                                 |
| zod                  | 4.6.7   | MIT        | boundary validation (IPC; WSS/REST/config later)                                           |
| electron-log         | 5.4.4   | MIT        | structured logging + 5 MiB rotation                                                        |
| @electron/fuses      | 2.1.3   | MIT        | binary hardening                                                                           |

Dependency admission follows CLAUDE.md rule 10 (MIT/Apache-2.0/BSD/ISC only;
`.research/dependency-research.md` documents vetting). Zero runtime deps beyond
zod/electron-log/react at this stage.

## Security posture (enforced by tests)

- `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`,
  `webSecurity: true`, devTools off in production
  (`tests/window-options.test.ts`).
- Restrictive CSP (`default-src 'self'`, no `unsafe-*`), enforced as meta tag
  plus header injection for dev-server responses.
- IPC: whitelisted channels, zod strict schemas, sender-frame URL allowlist per
  call (`tests/ipc-contract.test.ts`, `tests/sender-guard.test.ts`).
- No inbound listeners: runtime guard throws on any `net.Server.listen`, plus a
  process-level smoke test (`scripts/no-listen-smoke.mjs`, PRD AC-4).
- Navigation/`window.open` away from bundled content is blocked in the main
  process; the renderer never touches network, filesystem, or printers.
- Logs are redacted (credentials/PII) before reaching any transport
  (`tests/redact.test.ts`).

## Known limitations (current phase)

See the foundation handoff notes in the repo history; printer/cloud features are
P1–P5 per `docs/adr.md`.
