# Printer Transport Layer (TCP ESC/POS) — Design

**Date:** 2026-10-23 · **Status:** Approved
**Scope:** Main-process printer transport phase — `transport-registry` + `tcp-raw`
per `docs/architecture.md` §3.4. UI wiring, cloud integration, and SQLite
`local-store` are explicitly out of scope.

## Goals

- A `PrinterTransport` interface independent of the UI.
- A TCP transport (Node `net`) with configurable host/port, default port 9100.
- Printer configuration: unique local ID, friendly name, role, paper width,
  printable dot width, character columns, capability flags.
- Roles: `kitchen`, `receipt`, `bar`, `custom`.
- Connection tests, test-print payloads, connect/write timeouts, classified errors.
- 80mm (and 58mm) support without assuming identical printable widths or
  character columns — those are per-printer configured values.
- Approved-destination-only printing; no network scan; no listening sockets.

## Non-goals

- No Windows spooler or USB transport (interface documented for future adapters —
  see `docs/transport-adapters.md`). No USB claims of any kind.
- No cloud/WSS integration; no job engine changes.
- No renderer/IPC wiring; the existing mock AgentService UI stays untouched.
- No SQLite — printer configs persist as an atomic JSON file (same pattern as
  `settings.ts`), migrating to the `printers` table when `local-store` lands.
- No DLE EOT status polling (`R-VAL-3`); the interface reserves an optional
  `status?()` but TCP does not implement it in this phase.

## 1. Transport interface (`src/main/transport/`)

```ts
interface PrinterTransport {
  /** Resolves when the connection is established; rejects with TransportError. */
  open(): Promise<void>;
  /** Resolves on kernel/driver acceptance of the bytes — by definition
   *  "sent to printer", NEVER "physically printed" (architecture §3.4/§5). */
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  /** Cheap connect(+close) probe; rejects with TransportError on failure. */
  healthCheck(): Promise<void>;
  /** Reserved for best-effort printer status (DLE EOT). Not implemented by
   *  tcp-raw in this phase (R-VAL-3). */
  status?(): Promise<PrinterHealth>;
}
```

- `TcpRawTransport` is constructed with an injected `SocketFactory` returning a
  minimal typed socket surface (`connect`, `write`, `destroy`, event
  subscription). Production factory wraps `node:net`; unit tests inject mock
  sockets — no real network in tests.
- Timeouts: connect 3 000 ms, write 5 000 ms by default; overridable at
  construction. Every async operation is bounded (CLAUDE.md async rule).
- Port defaults to 9100 when a draft omits it.

## 2. Error classification (`src/main/transport/errors.ts`)

`TransportError` implements the existing `TypedError` contract (stable machine
code in `code`, human `message`, `cause` preserved for logs):

| Code                 | Mapped from                                   |
| -------------------- | --------------------------------------------- |
| `connect_refused`    | `ECONNREFUSED`                                |
| `connect_timeout`    | connect timer expiry                          |
| `host_unreachable`   | `EHOSTUNREACH`, `ENETUNREACH`                 |
| `write_timeout`      | write timer expiry (no drain/ack)             |
| `write_failed`       | `EPIPE`, `ECONNRESET`, write callback error   |
| `disconnected`       | socket closed while an operation was in flight|
| `not_open`           | `write`/`close` without a successful `open`   |
| `dns_unsupported`    | non-IP hostname supplied (see §3)             |

Unknown OS errors map to `write_failed` (post-open) or `connect_refused`
pre-open only when truly unmatched — otherwise the specific code wins.

## 3. Endpoint policy (security core of this phase)

Validation lives in `src/main/printers/`, never inside the transport:

- `host` must be an **IPv4/IPv6 literal** (`net.isIP`). No hostnames in v1 —
  there is no DNS resolution surface. Rejected at save time: loopback
  (127/8, ::1), unspecified (0.0.0.0, ::), and multicast/reserved ranges.
- `port`: integer 1–65535; omitted → 9100.
- **The persisted store is the only source of transport endpoints.** Transports
  are created exclusively from approved configs via `TransportRegistry.forPrinter(profile)`.
  Cloud job payloads reference `printerId` only — no code path exists from a
  job payload to a host/port. This invariant is asserted in unit tests.
- No network scanning of any kind; nothing listens (existing AC-4 guard covers).
- Printer config contains no secrets (host/port/role/widths only) → plain
  atomic JSON file is sufficient; the DPAPI-protected `identity` store is
  untouched.

## 4. Printer profile + store (`src/main/printers/`)

Zod **strict** schemas (unknown fields rejected — CLAUDE.md rule 3):

```ts
type PrinterRole = 'kitchen' | 'receipt' | 'bar' | 'custom';

interface PrinterProfile {
  printerId: string;      // crypto.randomUUID(), immutable after creation
  name: string;           // friendly name, 1–64 chars after trim
  role: PrinterRole;
  paperWidthMm: 58 | 80;
  printableDots: number;  // configured per printer (e.g. 576), never derived
  charsPerLine: number;   // configured per printer (font-dependent)
  capabilities: {         // conservative defaults: all false
    cut: boolean; qrCode: boolean; barcode128: boolean;
    statusPolling: boolean; cashDrawer: boolean;
  };
  transport: { kind: 'tcp_raw'; host: string; port: number };
}
```

- Validation ranges: `printableDots` 192–800, `charsPerLine` 16–96
  (rejected, not clamped, outside range).
- `PrinterStore` mirrors `settings.ts`: injected `read`/`writeAtomic` adapter,
  zod re-validation on load, corrupt/invalid file → report + start empty,
  `add(draft)` (assigns `printerId` via injected UUID factory) / `update(id, patch)`
  / `remove(id)` / `list()` / `get(id)`.
- `printerId` uniqueness enforced by the store.

## 5. Service + test print (`src/main/printers/service.ts`)

`PrinterService` owns the operations other modules (and later IPC) call:

- `savePrinter(draft)` — validate (zod + §3 policy) then persist.
- `testConnection(id)` — build transport from stored config, `healthCheck()`,
  return `{ ok, code?, detail }` with the §2 classification.
- `testPrint(id)` — build transport, write a ~20-line hand-built ESC/POS
  connectivity page (`ESC @` init, printer name/role/timestamp as ASCII,
  `GS V` partial cut respecting `capabilities.cut`), close. Documented as a
  **connectivity payload, not the document pipeline** — the real doc→ESC/POS
  renderer is a separate future module. No control characters can be injected:
  the payload is fully constructed from validated fields.

## 6. Testing (vitest, existing harness)

- **TCP transport vs mock socket factory:** success + byte ordering; connect
  refused; connect timeout; host unreachable; reset mid-write → `write_failed`;
  no-drain → `write_timeout`; close while open in flight → `disconnected`;
  `write` before `open` → `not_open`; `close()` is idempotent.
- **Store:** save/load round-trip; corrupt file → report + empty; every §3/§4
  validation rejection (loopback, port 0, port 65536, bad role, dots/chars out
  of range, unknown fields, duplicate ID, name length); atomic write used.
- **Service:** error-code mapping; `testPrint` writes expected ESC/POS bytes
  through a `MockTransport`; endpoint-policy: arbitrary cloud-style endpoints
  cannot reach a transport (store-only endpoint invariant).
- `escpos-emulator` integration tests remain a later phase per the existing plan.

## 7. Documentation

- New `docs/transport-adapters.md`: TCP transport limits (fire-and-forget, no
  application ack, "sent ≠ printed", paper-out/cover-open invisible to TCP —
  R-VAL-8) and the checklist for future `spooler-raw` / `usb` adapters
  (implement `PrinterTransport`, register in the registry, per-transport error
  code table, validation additions, R-VAL-4 / R-VAL-5 gates).
- No changes to normative docs; this design implements architecture §3.4 as
  written.

## Dependencies

None added — `node:net` and `node:crypto` are built-in.
