# Job engine & local persistence (P1)

**Status:** implemented in `src/main/local-store/` and `src/main/jobs/` (2026-10-24).
This document describes the code as it exists — where it diverges from earlier plan
drafts, the code is the truth.

Implementation of `docs/architecture.md` §5 (state machine, **normative**) and
ADR-5/6/9. Modules: `src/main/local-store/` (SQLite: connection, versioned migrations,
job repository — single owner of disk I/O for jobs) and `src/main/jobs/` (state machine
+ scheduling). Cross-team ack contract: `docs/api-contract.md` §3.1.

## The three milestones this system distinguishes (and never conflates)

1. **Local persistence (`accepted`)** — job envelope validated + committed to SQLite
   (WAL, `synchronous = FULL` — `src/main/local-store/db.ts`; the `accepted` ack is
   emitted only after the row is durably on disk). A durable local record only; says
   nothing about any printer.
2. **Printer/driver acceptance (`sent_to_printer`)** — the ESC/POS stream was written
   to the transport and accepted by the OS/driver (for tcp_raw: the kernel buffer).
   This is **not** evidence that paper moved.
3. **Confirmation of physical printing — DOES NOT EXIST.** There is no `printed`
   state and no `printed: true` anywhere (api-contract §3.1, ADR-5, security rule 8;
   `JobAck.printed` is literally typed `false`). `completed` means hand-off to
   printer/driver succeeded; UI wording per api-contract §3.1 ("Sent to printer"
   (✓ hand-off) — never "Printed").

## Lifecycle

pushed → validated → accepted (persisted) → rendered → sending → sent_to_printer →
completed; branches: rejected (intake checks, never prints), failed (terminal, manual
retry), ambiguous (outcome unknown; operator resolution). Internal-only states:
`sending` (durable in-flight marker, crash-recovery observable) and `printer_ack`
(reserved for DLE EOT status polling, R-VAL-3). `sending`/`printer_ack` never appear
in acks (api-contract §3.1 excludes them; `duplicateAck` maps `sending` → `accepted`
and `printer_ack` → `completed` for re-delivery).

- **Intake rejection codes:** `unknown_printer`, `unsupported_doc_version`,
  `job_expired`, `invalid_doc`, `invalid_envelope`, `queue_full` (bounded queue:
  non-terminal row count against `maxPending`, default 500). The engine enforces the
  api-contract §2 agent caps as a last line of defense regardless of what the WSS
  boundary already validated: `copies` must be an integer 1..4 and `priority` an
  integer 1..9 (`invalid_envelope`), and the serialized payload must not exceed the
  32 KiB `PAYLOAD_MAX_BYTES` cap (`invalid_doc` — measured on the same serialized
  JSON the renderer later guards, so the render-stage `payload_too_large` is not
  reachable through intake). Tenant/restaurant scope is enforced upstream
  (architecture §7 — the device token bounds what the server may send); the engine
  keys idempotency per `(restaurant_id, idempotency_key)`. Rejected jobs (including
  `queue_full`) are never persisted — the `duplicateAck` rejected branch exists for
  forward-compatibility; re-delivery of a previously queue-full job simply retries
  intake.
- **Expiry is enforced at intake only:** a job that expires while already queued still
  executes (stale-ticket semantics are a deliberate P1 simplification — revisit with
  the duplicate-policy/config phase if the restaurant use case requires expiry
  re-checks).
- **Intake DB failure:** `submit` throws `JobEngineError('store_unavailable')` with
  **no ack** — the server re-delivers (at-least-once delivery to the agent).
- **Duplicate re-delivery** per `(restaurant_id, idempotency_key)` is answered from
  the stored row (idempotency lookup happens **before** printer/expiry/schema checks,
  which may have drifted since acceptance) and never re-executed: a completed job
  re-delivered yields a `completed` ack and zero prints. The duplicate ack is the
  return value of `submit` — it is not duplicated into the ack stream. A unique-index
  race on insert is resolved the same way.
- **Retries:** connect-phase transport failures only (nothing written yet — ADR-6
  at-most-once print attempt per execution). Exponential backoff (base 2 s, cap 60 s,
  `retryBaseDelayMs`/`retryMaxDelayMs`), `maxAttempts` default 3, then terminal
  `failed`. Each retry re-renders from the stored payload and re-emits a `rendered`
  ack — **the backend must accept multiple `rendered` acks per job**.
- **Engine-error requeues:** if a store operation or other unexpected error fails
  mid-execution, only rows still in a **pre-transmission** state (`accepted`/
  `rendered`) are requeued, through the same backoff scheduler (via the injected
  `schedule`, never synchronously); after 4 consecutive engine-error requeues the
  engine gives up until restart (startup `recover()` re-enqueues pre-transmission
  rows). Rows past the transmission boundary — `sending`, `sent_to_printer`,
  `printer_ack` — are **never** requeued: a re-run would re-render and re-write
  every copy (a silent duplicate print, ADR-5/T4), so they strand durably in their
  last state until restart recovery resolves them. Reaching a fresh render + the
  durable `sending` marker resets the cap counter.
- **Write-phase failures:** `ambiguous` immediately (bytes may have partially reached
  the printer — outcome unknowable). Never retried automatically (ADR-6).
- **Crash in the transmission/completion window:** `recover()` at startup resolves
  both mid-transmission rows (`sending`) and rows stranded **between** the
  `sent_to_printer`/`printer_ack` write and the `completed` write (a crash in that
  window leaves bytes already handed off but no durable completion) to `ambiguous`
  (`restarted_in_flight`, with an `ambiguous_crash` attempt-history row and an
  `ambiguous` ack; the stranded attempt already has its history row, so the crash
  record uses `attempts + 1` — `(job_id, attempt)` is the primary key). Never re-sent
  automatically. `recover()` never throws; per-row recovery failures are reported and
  skipped (they remain in their current status until the next restart). Pre-transmission
  rows (`accepted`/`rendered`) are re-enqueued for execution; rows whose printer is
  currently unconfigured stay put (config may restore the printer later) but still
  count against the queue bound.

## Operator actions (explicit, never automatic — threat-model T4, no silent reprints)

- `retryJob(id)` — `failed` only; resets the attempt budget **and** clears the prior
  attempt cycle's local history (`resetAttempts` deletes the cycle's `job_attempts`
  rows in one transaction — the `(job_id, attempt)` primary key would collide
  otherwise). The failure record survives server-side: the `failed` ack (with error
  code + attempt) was already reported before the job became terminal.
- `reprintJob(id)` — `completed`/`failed`/`ambiguous` only; creates a **NEW** row with
  `reprint_of` set and a fresh idempotency key (`<original-key>#reprint-<new-id>` —
  the original key stays unique and the server-side duplicate ledger is never
  disturbed), full audit chain (T4). Respects the pending-queue bound (typed
  `JobEngineError` when full — no silent override).
- `cancel(id)` — only while `accepted`/`rendered` and not currently executing;
  refused (returns `false`) once `sending`/executing or terminal — an operator must
  never manufacture an ambiguous outcome (ADR-5). Cancelled jobs become `failed` with
  error code `cancelled` (this code exists for the backend; api-contract error codes
  are open-ended).
- Note: retention treats `ambiguous` as terminal — an unresolved ambiguous job (and
  its attempt history) is deleted once it ages past `retentionDays` (default 14) or
  the row cap (`retentionMaxRows`, default 1000) is reached. Operator resolution is
  expected within that window. `cleanup()` only ever selects TERMINAL rows
  (`rejected`/`completed`/`failed`/`ambiguous`), so a job whose final state is not
  durably recorded is never eligible; deletion removes attempts with the job in a
  single transaction.

## Attempt history

Every attempt is recorded in `job_attempts` (PK `(job_id, attempt)`): outcomes
`render_error` (any render-stage failure — the specific code rides in `error_code`),
`unknown_printer`, `connect_error`, `write_ambiguous`, `ambiguous_crash`, `completed`,
`cancelled`. This is the audit surface for duplicate-print investigations. Known gap
(audit-trail-only): a crash between the attempts-counter increment and the attempt
insert leaves the counter ahead of the history (Task 12 matrix); persistence of the
state itself is unaffected.

## Storage

- `better-sqlite3` 13.x (N-API prebuilds bundled in-package — no electron-rebuild;
  MIT). Note: v13 dropped bundled TypeScript types — `@types/better-sqlite3` 9.x is
  an exact-pinned devDependency.
- Migrations are versioned and append-only (`schema_migrations`); the applied set must
  be an exact contiguous prefix of this build's list, and a database from a newer
  build is refused (`db_version_newer`) — never downgraded (CLAUDE.md rule 11).
- Job rows contain doc payload + metadata only. No credentials, tokens, or PII in job
  rows or logs (threat model T7; identity/DPAPI is a separate store, later phase).
- The engine depends on the injected `JobStore` interface, never on better-sqlite3
  directly — module boundary per architecture §3.
- Packaging TODO (P8): `better-sqlite3` needs `asarUnpack`; `@napi-rs/canvas` external
  (render-pipeline.md §10).

## Test coverage map (fault injection)

| Fault                                          | Test                                                            |
| ---------------------------------------------- | --------------------------------------------------------------- |
| Process restart mid-write                      | tests/job-engine-recovery.test.ts (hang transport + dispose + re-boot) |
| Transient db failure between hand-off and completion (C1 window) | tests/job-engine-db-failures.test.ts (strand + no requeue), tests/job-engine-recovery.test.ts (restart resolves to ambiguous) |
| Process restart pre-transmission               | tests/job-engine-recovery.test.ts                                |
| Repeated delivery after completion             | tests/job-engine-recovery.test.ts, tests/job-engine-execution.test.ts |
| Ambiguous outcome (write failure)              | tests/job-engine-failures.test.ts                                |
| Database failure at intake / mid-execution / persistent | tests/job-engine-db-failures.test.ts                    |
| Printer disconnect (connect-phase, mid-stream) | tests/job-engine-failures.test.ts                                |
| Per-printer interleaving / priority            | tests/job-engine-serialization.test.ts                           |
| Retention vs unresolved jobs                   | tests/job-engine-retention.test.ts                               |
