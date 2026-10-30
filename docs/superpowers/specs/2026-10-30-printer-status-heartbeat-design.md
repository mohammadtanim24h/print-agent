# Printer Status Polling in Heartbeats — Design

Date: 2026-10-30 · Item: production-readiness C1 · Risk: R-VAL-3
Status: approved (brainstorming session, same day)

## Goal

Replace the hardcoded `health: 'unknown'` in heartbeats and
`printer_status: 'unknown'` in acks with real, best-effort DLE EOT status for
printers that opt in — strictly observationally. The print path's behavior is
unchanged: no pre-print gating, no holds, no reprints driven by status.

## Decisions (from the brainstorming session)

| Question | Decision |
| -------- | -------- |
| Use of status data | Heartbeat `printers[].health` + ack `printer_status` reporting only; no print-path gating |
| Mechanism | DLE EOT on a short-lived connection per poll (no ASB, no persistent sockets) |
| Gate | Per-printer `profile.statusPolling === 'auto'` (field already in `PrinterProfileSchema`); default off until B1/R-VAL-3 |
| Cadence | Slow background poll (~30 s, injected) + TTL cache; heartbeat/acks read the cache |
| Failure semantics | Connect-class failure → `'offline'`; no-answer/garbage → `'unknown'` |

## Architecture

Three independently testable pieces:

1. **`transport/tcp-raw.ts` — `status()`**: opens a *separate ephemeral socket*
   via the injected `SocketFactory` (never the job socket — poll bytes cannot
   interleave with job bytes; `writeTail` ordering untouched), sends
   `0x10 0x04 0x01` + `0x10 0x04 0x02`, collects the two response bytes, and
   destroys the socket. The whole exchange is timeout-bounded (~2 s default,
   injectable). Job-path code is unchanged.
2. **New `printers/status-poller.ts`**: owns the TTL cache
   (`printer_id → { status, at }`), the injected timer, and per-printer
   gating. Deps are constructor-injected: `TransportRegistry`, printer store,
   clock/scheduler, interval. Public surface: `get(printerId): PrinterStatus`
   (expired or never-polled → `'unknown'`), `start()`, `stop()`.
3. **`agent-runtime.ts` wiring**: constructs the poller;
   `heartbeatSample()` reads the cache instead of hardcoding `'unknown'`;
   the job engine receives an injected `printerStatus(printerId)` lookup used
   when building acks (default `() => 'unknown'` so the engine stays inert
   without it).

`TransportSocket` gains one optional `on('data', listener)` overload so
poll responses can be read; the production `createNetSocketFactory` wires it
to `node:net`'s data event. Spooler transports are untouched — **spooler_raw
printers always report `'unknown'`** (the spooler is a one-way pipe; this is a
documented physical limit, not a gap).

## Protocol & parsing

Per poll: ephemeral connect → `DLE EOT 1` → read 1 byte → `DLE EOT 2` →
read 1 byte → destroy. Pure exported parser
`parseDleEotStatus(printerByte, paperByte): PrinterStatus`:

- printer byte bit 5 (0x20, error) → `'offline'`; bit 2 (0x04, cover) →
  `'cover_open'`
- paper byte: out bits (bits 3–5, mask 0x38) → `'paper_out'`; near-end bits
  (bits 0–2, mask 0x07) → `'paper_low'`
- severity precedence: `paper_out > cover_open > paper_low > ok`

Bit semantics follow the ESC/POS R&P spec; exact fleet behavior is precisely
what R-VAL-3 must confirm on hardware, hence the gate stays default-off.

## Gating (R-VAL-3)

Effective enable condition per printer:
`profile.statusPolling === 'auto'` **and** transport kind `tcp_raw`.
The `statusPolling: 'auto' | 'off'` field already exists in
`PrinterProfileSchema`; nothing new to add. Default (undefined) is off until
B1 validates models; the cloud config stream can flip individual printers to
`'auto'` later with no agent release. No renderer/UI change in this phase.

## Error handling

- Ephemeral connect fails (refused / unreachable / timeout / disconnected) →
  cache `'offline'`.
- Connect succeeds but the response is missing, garbage, truncated, or late →
  cache `'unknown'` — a model that silently ignores DLE EOT is never declared
  offline (the core R-VAL-3 uncertainty).
- Poll errors are logged (no PII) and never propagate; a poller fault cannot
  crash the runtime. Polls serialize per printer; one slow printer cannot
  stack up cycles.

## Contract & docs

No api-contract change — §3.2 `health` and ack `printer_status` already exist.
Same-change doc updates: architecture.md §3 module table (status-poller),
printer-compatibility.md §6 R-VAL-3 row (agent side implemented, gate `off`),
production-readiness.md C1 note.

## Testing

- **Unit:** parser table-driven + bounded fuzz corpus (zero-panic, bounded
  output — same precedent as the renderer fuzz); tcp-raw `status()` against
  mock sockets (respond / no-answer / garbage / connect-fail); poller
  scheduling, TTL expiry, gating, per-printer serialization; runtime
  heartbeat test asserting cache-derived values; engine ack test with the
  injected lookup.
- **Integration:** hermetic in-house DLE EOT responder via injected
  `SocketFactory` (no real listener — mock-socket precedent). The readiness
  C1 closes-with names the escpos-emulator's status simulation; the emulator
  is not yet in the tree, so this hermetic integration test is the CI-able
  equivalent now, and the emulator-based assertion rides along when emulator
  integration (AC-1) lands — or folds in immediately if the emulator turns
  out to answer DLE EOT.

## Out of scope (explicit)

- Pre-print gating / job holds driven by status (future, post-B1).
- ASB persistent streaming.
- Renderer/diagnostics UI exposure of live health.
- spooler_raw status (physically impossible over the spooler).
