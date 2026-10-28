# Production Readiness — Remaining Work

Working checklist for taking the agent from "feature-complete on paper" to
production. Work items top-to-bottom within each category; categories are
ordered by priority. Each item lists what to do, where, and how it closes.

Legend: `[ ]` open · `[x]` done · **Depends on** other items · **Closes with**
the acceptance evidence required before ticking.

---

## A. Blocking — functional gaps in the agent

### A1. Apply cloud config to printers (FR-16)

- **Status:** open — `agent-runtime.ts` persists config only
  (`configStore.save(config)`, comment: "Persist-only this phase; FR-16 is a
  later phase").
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

- **Status:** open — `transport/registry.ts` implements `tcp_raw` only; the
  schema accepts `spooler_raw` but no transport exists.
- **What:** N-API/FFI shim or `node-thermal-printer` spooler path sending RAW
  datatype to a named Windows printer (`windows_printer_name`), per ADR-4.
  File-port capture tests (ADR-10) instead of driver-dependent assertions.
- **Depends on:** nothing (parallel with A1).
- **Closes with:** byte-exact capture tests vs a local file-port printer,
  flagged R-VAL-4 pending hardware validation (B1).

### A3. Server-side WSS endpoint (servepro-api — cross-team)

- **Status:** open on the Laravel side; agent side is done and degrades to
  polling until this lands.
- **What:** implement `wss://<host>/agent/v1/ws` per `docs/api-contract.md`
  §1 as amended 2026-10-27: token auth on upgrade (401 on bad token), close
  `4401` for auth failures, claim-on-send job delivery mirroring the
  pull-claim lease (§7 note 6), ingest §3.2 heartbeats with
  `connection: "wss"`, respond to ws pings (RFC 6455 default), push
  revoke/config envelopes.
- **Closes with:** Laravel feature tests mirroring the §6 WSS matrix rows;
  a live agent (dev build) holding a socket > 24 h against staging.

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
- **Depends on:** A2 for R-VAL-4; A3 for realistic burst conditions (R-VAL-6).
- **Closes with:** results recorded in `printer-compatibility.md` §6 with
  pass/fail per model; presets shipped in config defaults.

### B2. Windows release smoke train

- **Status:** open for the WSS changes (v0.1.1 predates them).
- **What:** package the current main (electron-builder NSIS, unsigned manual
  distribution per ADR-14), install/upgrade smoke on Win10 19045 and Win11;
  verify pairing → WSS connect → test print → revoke wipe. Run the ops §6
  checklist and the no-listen smoke on the packaged build.
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
- **What:** 10 jobs in 5 s through the engine over both delivery paths
  (WSS push and poll batch): no ordering regressions, ack buffer drains,
  no socket starvation, ambiguous-rate stays zero.
- **Depends on:** A3 for the WSS path under load (or scripted frames in CI).
- **Closes with:** CI-able burst test green + a recorded run against staging.

### C3. Staged pilot with monitoring

- **Status:** open — final P10 exit.
- **What:** 2–3 restaurants on a packaged build; watch `last_seen_at`
  online-staleness alerts, ack result distribution (`applied|duplicate|
  stale|not_found|rejected`), ambiguous-job rate, WSS reconnect churn.
  Define abort/rollback criteria before starting.
- **Depends on:** A1–A3, B1, B2, C1, C2.
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

---

## Suggested order

A1 → A3 (parallel with A2) → B2 → B1 → C1 → C2 → C3. A1 is first: pure
agent work, no hardware or cross-team dependency, and it converts "receives
jobs" into "prints what the SaaS configures."
