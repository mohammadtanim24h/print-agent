# Transport Adapters — TCP limits & future transports

**Scope:** how the agent talks to printers. Companions: `architecture.md` §3.4
(module boundaries), `printer-compatibility.md` §3 (transport reliability
model), specs `docs/superpowers/specs/2026-10-23-printer-transport-design.md`
and `docs/superpowers/specs/2026-10-29-spooler-transport-design.md`.

## v1 shipped transport: TCP raw (:9100)

- **Fire-and-forget.** ESC/POS over TCP has no application-level ack. A
  resolved `write()` means the kernel accepted the bytes — nothing more.
- **"Sent to printer" ≠ "printed".** `completed` means hand-off to the
  socket/driver succeeded (api-contract.md §3.1 wording is normative). No code
  path, log, or ack may claim a physical print.
- **Invisible failures.** Paper-out, cover-open, or power loss mid-stream are
  undetectable over TCP (R-VAL-8) — this is why the UI wording exists.
- **Status polling not implemented (v1).** DLE EOT stays deferred until the
  hardware-validation phase closes R-VAL-3; the `PrinterTransport.status?()`
  hook is reserved.
- **Approved destinations only.** Hosts are IPv4/IPv6 literals validated by
  `isApprovedEndpointHost` (loopback/unspecified/multicast rejected in every
  notation — the whole `::/80` IPv6 prefix covers `::1` and all
  IPv4-mapped/compatible spellings; zone-scoped forms like `::1%eth0` are
  rejected outright, so a Windows-scoped link-local address must be entered
  without its `%zone` suffix), ports 1–65535 (default 9100), persisted
  exclusively in the printer store. No DNS resolution, no network scanning,
  and no code path from a cloud job payload to a host/port — jobs reference
  `printerId`, the store supplies the endpoint.
- **Outbound only.** The transport never listens; the existing AC-4 no-listen
  guard stays in force.

## v1 (A2) shipped transport: Windows spooler RAW

- **Own N-API shim** (`native/spooler-raw/`, ADR-4): `OpenPrinterW →
  StartDocPrinterW(DATATYPE "RAW") → WritePrinter → EndDocPrinter`. One RAW
  spooler job per `write()`; runs on an N-API AsyncWorker (main thread never
  blocks for writes). The addon is dlopen'd lazily — tcp_raw-only installs
  never load it.
- **Semantics.** A resolved `write()` means **Windows accepted (spooled) the
  job** — never "printed". The vendor driver may buffer or hold the job
  (R-VAL-4 duplicate risk); this feeds the existing ambiguity/duplicate-policy
  flow. Media errors (paper-out, cover-open) are invisible, same as TCP.
- **Partial-job safety.** A mid-write spooler failure deletes the job
  (`SetJob` JOB_CONTROL_DELETE) — a truncated document never reaches the
  port. Downstream driver buffering remains the R-VAL-4 risk.
- **Endpoint.** `windowsPrinterName` (1–128 chars) lives in the printer store
  like any approved destination. Existence is validated at open/healthCheck
  time by an `OpenPrinterW` probe — printers can be installed/uninstalled
  after pairing, so the schema does not freeze machine state.
- **Error mapping.** Existing codes kept; one documented addition:
  - `printer_not_found` — the probe found no such printer (Windows errors
    ERROR_FILE_NOT_FOUND / ERROR_INVALID_PRINTER_NAME only).
  - everything else (access denied, spooler stopped, StartDoc/Write/EndDoc
    failures) → `write_failed` with the Windows error in the message.
  - Awaiting the spooler is deliberately unbounded: the call is in-process,
    a timeout could not un-spool a job, and inventing one would create
    ambiguity semantics. The job engine's own timeouts govern the workflow.
- **Evidence.** Unit tests run against an injected fake bridge (ADR-10);
  byte-exact output is proven by the opt-in file-port capture test
  (`tests/spooler-raw-capture.test.ts`, `scripts/setup-capture-printer.ps1`;
  operations.md §6). Real-hardware validation stays open under R-VAL-4 (§6).
- **Deferred:** printer enumeration is currently a synchronous native call
  (a stalled spooler service would block the main-process event loop; an
  AsyncWorker migration is the follow-up) and enumeration failures surface
  under `write_failed` (a dedicated code would be a contract-visible change).

## Adding a future transport adapter (`usb`)

Follow this checklist; do not fork the interface.

1. **Implement `PrinterTransport`** in `src/main/transport/<kind>.ts`
   (`open`/`write`/`close`/`healthCheck`; `status?` only if the transport can
   actually answer it). Inject the OS handle factory (socket, printer handle,
   USB device) the same way `SocketFactory` is injected — unit tests run
   against fakes with no hardware.
2. **Map OS errors to `TransportErrorCode`.** Keep the existing codes; add a
   new one only when no existing code fits — codes are contract-visible (logs,
   future acks), so additions are a documented change.
3. **Extend the profile schema** (`src/main/printers/profile.ts`): add the
   endpoint variant under the same strict-validation + approved-destination
   policy — the shipped `spooler_raw` variant (`windowsPrinterName`, not a
   host/port) is the pattern to follow. `transport` is already a multi-kind
   union, so the registry's exhaustive `switch` enforces handling of the new
   kind at compile time.
4. **Register it** in `createTransportRegistry`.
5. **Gate hardware behavior** behind the matching R-VAL item until the
   hardware-validation phase closes it (spooler RAW = R-VAL-4, USB =
   R-VAL-5). No transport ships claims its validation phase hasn't closed.
6. **Update docs in the same change:** `printer-compatibility.md` §3/§5 and
   this file.

Transport-specific limits to respect:

- **usb (v1.1):** not promised in v1 — no UI, ack, or doc may claim USB
  support until that phase lands.
