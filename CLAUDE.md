# CLAUDE.md — Print Agent

Permanent project instructions. Read alongside `docs/` (start: `docs/adr.md`,
`docs/architecture.md`, `docs/api-contract.md`).

## What this project is

A production Windows x64 Electron print agent for a restaurant SaaS (Laravel backend).
It receives print jobs over **outbound-only** connections and drives 80mm ESC/POS
thermal printers. Design contracts live in `docs/`; **`docs/api-contract.md` and the
state machine in `docs/architecture.md` §5 are normative** — code that diverges from
them is wrong, not the docs.

## Non-negotiable security rules

1. **No listening sockets. Ever.** No local HTTP server, no debug port in production,
   no remote-debugging args. A CI test asserts no LISTEN sockets (PRD AC-4).
2. **Renderer is sandboxed and isolated** (`contextIsolation: true`,
   `nodeIntegration: false`, packaged files only, CSP `default-src 'self'`).
   The renderer never touches the network, filesystem, or printers directly — IPC only,
   over a whitelisted, zod-validated bridge.
3. **Validate every boundary with zod strict schemas**: WSS in/out, REST, IPC, config
   files. Unknown fields inside payloads are rejected, not ignored. Size caps are part
   of every schema.
4. **Never execute dynamic code**: no `eval`, `new Function`, `vm`, remote code, or
   loading remote content. Lint-enforced.
5. **Strip/escape control characters** (0x00–0x1F, 0x7F) from all text before ESC/POS
   encoding (printer command injection — `docs/threat-model.md` T2).
6. **Secrets (device keys, tokens) live only in the `identity` store, DPAPI-protected.**
   Never in plain config files, never in logs, never sent to the renderer.
7. **Logs never contain PII or credentials.** Log bundling is redacted + user-confirmed.
8. **Never claim physical printing.** `completed` = hand-off to printer/driver
   succeeded. The UI, logs, and acks use the normative wording of `api-contract.md`
   §3.1. No code path may report `printed: true`.
9. **No silent reprints.** Ambiguous outcomes go to the `ambiguous` state and resolve
   only via operator action or the configured `duplicate_policy`.
10. **Dependency admission**: MIT/Apache-2.0/BSD/ISC only (no GPL/AGPL/SSPL in the
    distribution). Vet maintenance status and postinstall scripts before adding; prefer
    N-API prebuilds; `ignore-scripts` in CI; lockfile is exact-pinned. See
    `.research/dependency-research.md` for prior vetting.
11. **Updates**: only through the signed electron-updater feed. Never disable signature
    checks. Never allow version downgrades in shipped code.

## Coding conventions

- TypeScript, strict mode, no `any` at module boundaries.
- Module boundaries per `docs/architecture.md` §3 are enforced: modules import each
  other's public interface only; no reaching into internals; no ambient singletons —
  dependencies are injected (constructor/factory) so everything is unit-testable.
- `renderer` (ESC/POS) is a pure function: no timers, no I/O beyond logo assets.
- Errors: typed error classes with stable machine codes (these surface in acks).
- No feature flags/back-compat shims for unreleased code; delete dead code outright.
- Async: fail with timeouts on every network/transport operation; no unbounded awaits.
- Comments only where logic is non-obvious (quoting ESC/POS specs or threat-model
  refs is encouraged).

## Testing rules

- **Every phase ships with tests; a phase without passing tests is not done** (PRD AC-7).
- Layers (ADR-10):
  - Unit: mock/in-memory transport; state-machine transitions incl. crash recovery.
  - Integration/CI: `escpos-emulator` on TCP :9100 with REST-based decoded-output
    assertions (AC-1).
  - Contract: the full matrix in `api-contract.md` §6 against a mock server, plus
    Laravel-side fixtures — keep both in sync with the doc.
  - Renderer fuzz corpus must run in CI (zero panics, bounded output size).
- Crash/ambiguity tests are mandatory for any change to the job engine (AC-2, AC-3).
- Windows-version smoke (Win10 19045, Win11) before release trains.

## Workflow rules

- Do not overwrite or refactor unrelated existing work; small, atomic commits.
- Documentation in `docs/` is updated in the same change when behavior/contracts
  change; docs are the source of truth for cross-team (Laravel) alignment.
- Hardware-dependent behavior is always gated behind config and marked with the
  corresponding `R-VAL-*` risk from `docs/printer-compatibility.md` §6 until the
  hardware validation phase closes it.
- Escalate to the user rather than improvising when: a contract change is needed, a
  dependency's license/maintenance looks questionable, or security rule 1–10 would
  need an exception.
