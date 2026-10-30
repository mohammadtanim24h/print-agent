# Production Readiness — Remaining Work

Working checklist for taking the agent from "feature-complete on paper" to
production. Work items top-to-bottom within each category; categories are
ordered by priority. Each item lists what to do, where, and how it closes.

Legend: `[ ]` open · `[x]` done · **Depends on** other items · **Closes with**
the acceptance evidence required before ticking.

---

## A. Blocking — functional gaps in the agent

### A1. Apply cloud config to printers (FR-16)

- **Status:** done (2026-10-28) — apply pipeline in `agent-runtime.ts`
  (`applyConfig`) + `printers/config-apply.ts` + `PrinterStore.replaceCloud`;
  source-tagged merge policy documented in api-contract §4. Evidence:
  `tests/config-apply.test.ts`, `tests/printer-store.test.ts` (replaceCloud),
  runtime wiring tests in `tests/agent-runtime.test.ts` ("AgentRuntime config
  application (FR-16)"), regression-ignored test at the runtime guard.
- **What:** server `config_update` / `GET /config` snapshots must drive the
  printer store atomically: create/update/remove printers from the
  `printers[]` array (§4 shape) on `config_version` increase, keyed by
  `printer_id`. Decide and document the merge policy with locally-added
  printers (local-only entries: keep? flag as unmanaged?).
- **Files:** `src/main/agent-runtime.ts`, `src/main/printers/store.ts`,
  `src/main/local-store/config-store.ts`.
- **Closes with:** unit tests for apply/rollback/partial-failure + a
  config-regression-ignored test (contract §6), runtime wiring test proving a
  `config_update` over the cloud client mutates the printer store.

### A2. Spooler transport — `spooler_raw` (P7)

- **Status:** done — agent side (2026-10-29). Own N-API shim in
  `native/spooler-raw/` + `transport/spooler-raw.ts` + registry/schema/
  config-apply support + UI dropdown + `printers:list-system` IPC. Evidence:
  `tests/spooler-raw.test.ts` (fake bridge), `tests/spooler-native.test.ts`,
  registry/schema/config-apply/IPC/UI tests, and the opt-in file-port capture
  `tests/spooler-raw-capture.test.ts` (`scripts/setup-capture-printer.ps1`).
  Byte-exact-vs-real-hardware evidence remains open as R-VAL-4 (B1); P7's
  "driver inventory" deliverable also stays with B1.
- **What:** N-API/FFI shim or `node-thermal-printer` spooler path sending RAW
  datatype to a named Windows printer (`windows_printer_name`), per ADR-4.
  File-port capture tests (ADR-10) instead of driver-dependent assertions.
- **Depends on:** nothing (parallel with A1).
- **Closes with:** byte-exact capture tests vs a local file-port printer,
  flagged R-VAL-4 pending hardware validation (B1).

### A3. Server-side WSS endpoint (servepro-api — cross-team)

- **Status:** descoped (2026-10-30). A WebSocket endpoint cannot run in
  php-fpm request workers — it requires a long-running daemon plus a
  WS-upgrade proxy, new deployment infrastructure the Laravel side declined.
  Polling at the amended ~3 s cadence (agent default, `poller.ts`) yields
  worst-case job latency ≈ 3 s — imperceptible for counter receipts, and
  there was no sub-second delivery requirement. ~40 req/min/device against
  the 120/min rate limit at 1–3 agents per single-restaurant deployment is
  negligible load. The agent is **polling-first**: the runtime constructs no
  WSS channel and never dials `wss://`; the ADR-15 client stays in-tree
  unwired (revival = server endpoint + re-wiring the agent's channel). Spec
  and acceptance criteria (§1, §6 WSS rows) retained there for that
  eventuality. Nothing left to do on either side for v1.
- **What (retained for a future revival):** implement
  `wss://<host>/agent/v1/ws` per `docs/api-contract.md` §1 as amended
  2026-10-30: token auth on upgrade (401 on bad token), close `4401` for auth
  failures, claim-on-send job delivery mirroring the pull-claim lease (§7
  note 6), ingest §3.2 heartbeats with `connection: "wss"`, respond to ws
  pings (RFC 6455 default), push revoke/config envelopes.
- **Closes with (if revived):** Laravel feature tests mirroring the §6 WSS
  matrix rows; a live agent (dev build) holding a socket > 24 h against
  staging.

---

## B. Blocking — validation (no new code, real evidence)

### B1. Hardware validation matrix (P9) — R-VAL-1…10

- **Status:** all open — `docs/printer-compatibility.md` §6.
- **What:** physical fleet pass/fail per item: R-VAL-1 codepage round-trip,
  R-VAL-2 cut variants, R-VAL-3 DLE EOT status, R-VAL-4 spooler RAW,
  R-VAL-5 USB (v1.1 — may stay deferred), R-VAL-6 throughput burst,
  R-VAL-7 autoreconnect, R-VAL-8 paper-out/cover-open mid-stream,
  R-VAL-9 cash drawer, R-VAL-10 logo pipeline. Produce the per-model
  config preset catalog.
- **Depends on:** A2 for R-VAL-4.
- **Closes with:** results recorded in `printer-compatibility.md` §6 with
  pass/fail per model; presets shipped in config defaults.

### B2. Windows release smoke train

- **Status:** open — v0.1.1 predates A1 (config apply), A2 (spooler
  transport) and the polling-first / 3 s cadence changes (A3 descope).
- **What:** package the current main (electron-builder NSIS, unsigned manual
  distribution per ADR-14), install/upgrade smoke on Win10 19045 and Win11;
  verify pairing → cloud poll → test print (tcp_raw + spooler_raw) → revoke
  wipe. Run the ops §6 checklist and the no-listen smoke on the packaged
  build.
- **Closes with:** checklist results recorded in `docs/operations.md` §6 for
  this release train.

---

## C. Should-have before pilot (P10)

### C1. Printer status polling in heartbeats (R-VAL-3 dependent)

- **Status:** open — `heartbeatSample()` reports `health: 'unknown'` for
  every printer.
- **What:** best-effort DLE EOT / ASB status poll per printer feeding the
  §3.2 heartbeat `printers[].health` and the ack `printer_status` field.
  Hardware-gated: only enable per model after B1/R-VAL-3 confirms which
  fleet models actually answer; gate behind config, marked R-VAL-3.
- **Depends on:** B1 (R-VAL-3 evidence).
- **Closes with:** heartbeat integration test asserting real status values
  from the escpos-emulator's status simulation; config gate default `off`
  until validated.

### C2. Load burst test (R-VAL-6)

- **Status:** open.
- **What:** 10 jobs in 5 s through the engine over the poll delivery path:
  no ordering regressions, ack buffer drains, ambiguous-rate stays zero.
  (WSS push path descoped with A3; if WSS is ever revived, add its burst
  leg then.)
- **Depends on:** nothing.
- **Closes with:** CI-able burst test green + a recorded run against staging.

### C3. Staged pilot with monitoring

- **Status:** open — final P10 exit.
- **What:** 2–3 restaurants on a packaged build; watch `last_seen_at`
  online-staleness alerts, ack result distribution (`applied|duplicate|
  stale|not_found|rejected`), ambiguous-job rate, poll backoff churn
  (REST cycle failure rate). Define abort/rollback criteria before
  starting.
- **Depends on:** A1, A2, B1, B2, C1, C2.
- **Closes with:** PRD §8 success metrics met during the pilot window.

---

## D. Deferred (tracked, not blocking)

| Item | Reference | Note |
| ---- | --------- | ---- |
| `/diagnostics` log-bundle upload | api-contract §7 note 4 | Blocked on support tooling existing; additive endpoint later |
| USB transport | ADR-4, R-VAL-5 | v1.1 scope |
| Cash drawer pulse | R-VAL-9 | Verify during B1 hardware access |
| WSS proxy support | — | Polling fallback covers proxied networks; revisit on pilot feedback |
| Reconnect/dial counters in diagnostics UI | — | Nice-to-have observability; no contract surface yet |
| Concurrent-write hardening for `writeAtomic` | settings-fs.ts fixed `.tmp` path | Bounded, recoverable (failed rename logged; next apply self-heals); revisit before pilot if concurrent-writer count grows |

---

## Suggested order

B2 → B1 → C1 → C2 → C3. (A3 descoped 2026-10-30 — polling is the v1 delivery
path; see A3 for the rationale and revival criteria.)
