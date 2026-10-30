# C2 Load Burst Test (R-VAL-6) — Design

Date: 2026-10-30
Status: approved
Source item: `docs/production-readiness.md` §C2

## Goal

A CI-able burst test proving the poll delivery path survives a kitchen-rush
burst: **10 jobs in 5 s** arriving as **one `pollJobs` response** (worst-case
intake depth), split **5+5 across two printers**, with:

1. **No ordering regressions** — per-printer FIFO completion order matches
   submission order.
2. **Ack buffer drains** — all 10 acks reach the wire, every wire result
   `applied`, ack buffer empties.
3. **Ambiguous-rate stays zero** — no job lands in `ambiguous` (and none in
   `failed`/`rejected`); all 10 reach `completed`.

The "5 s" window is virtual: the runtime schedule seam clamps delays (~5 ms),
so the stress is queue depth and interleaving, not wall clock. Deterministic —
no sleeps, no real network, no real printers.

Explicitly out of scope (deferred with the item's second closure half): the
**recorded run against staging** — blocked on the staging backend existing
(same blocker as B2). `production-readiness.md` C2 is updated to note the
split: CI test done in this change, staging leg recorded later.

## Approach

Full **AgentRuntime in-process** test (chosen over engine-harness-only, which
bypasses the poll path, and over a real HTTP mock server + virtual printer,
which is slow/flaky and stresses layers R-VAL-6 doesn't care about).

New file **`tests/burst-load.test.ts`** (vitest, node project) exercising the
real chain end to end:

`FakeTransport.pollJobs` (10 signed envelopes, one response) → poller
`handleJobEnvelope` (scope check + ed25519 verify) → engine intake →
per-printer FIFO drain → `FakeTransport` (printer writes) → ack buffer →
`FakeTransport.sendAcks` (recorded batches).

## Harness

Extract the `makeRuntime` harness from `tests/agent-runtime.test.ts:283`
(in-memory SQLite, `memoryAdapter` settings, clamped schedule, `fakeKv`,
`fakeSafeStorage`, `env.transportOverride`/`transportsOverride`) into
**`tests/helpers/runtime-harness.ts`**, exported for both test files.
`agent-runtime.test.ts` imports it instead of its local copy — a targeted,
mechanical extraction, no behavior change. The `manualSchedule` helper stays
in `agent-runtime.test.ts` (only used there).

## Scenario setup

- **Pair → online:** `runtime.pair(PAIRING_CODE)`; the pair response's
  `server_signing_pubkey` must be the public key used to sign the envelopes
  (same pattern as the existing "a polled signed job becomes an engine row"
  test).
- **Config:** `makeConfig(1, { printers: [printerA, printerB] })` — two
  `tcp_raw` printers, `status_polling: 'off'`.
- **Jobs:** 10 signed envelopes via `makeSignedEnvelope`, unique `job_id`s,
  alternating `printer_id` (A/B), payload line embedding the per-printer
  sequence number (e.g. `JOB-A-1`…`JOB-A-5`) for order decoding.
- **Cloud transport script:** `poll` returns all 10 envelopes once
  (`makePollResponse(jobs)`), then empty; `acks` returns `applied` for each
  acked job; `getConfig` returns the two-printer config.
- **Printer transport:** default `fakeTransport()` from
  `tests/helpers/fake-transport.ts` (records writes, no failures).

## Assertions (single test, ordered)

Wait with `vi.waitFor` (no sleeps), then:

1. **Completion:** all 10 jobs `completed` (runtime jobs snapshot / db rows).
2. **Per-printer FIFO:** for each printer, the printer-transport write log —
   decoded via the payload sequence markers — is strictly in submission
   order 1→5.
3. **Ack wire drain:** the union of recorded `sendAcks` batches covers
   exactly the 10 job ids; every scripted wire result is `applied`; ack
   buffer `pendingCount()` is 0 at quiescence (drains via batch/delay timers
   under the clamped schedule, plus the online-transition `flushNow`).
4. **Ambiguous-rate zero:** snapshot `ambiguousJobs === 0`, no row in
   `failed`/`rejected`, `pendingJobs === 0` at quiescence.

## Error handling

No new production code, so no new failure modes. If the test surfaces a real
ordering/drain bug in the engine, poller, or ack buffer, that is a product
bug to fix under the existing crash/ambiguity test rules (AC-2/AC-3) — not
something the burst test should paper over.

## Docs

`docs/production-readiness.md` C2 status updated in the same change:
agent burst test implemented (evidence: `tests/burst-load.test.ts`), staging
run deferred behind the staging-backend blocker shared with B2.
