# Transport Adapters — TCP limits & future transports

**Scope:** how the agent talks to printers. Companions: `architecture.md` §3.4
(module boundaries), `printer-compatibility.md` §3 (transport reliability
model), spec `docs/superpowers/specs/2026-10-23-printer-transport-design.md`.

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

## Adding a future transport adapter (`spooler_raw`, `usb`)

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
   endpoint variant (e.g. `spooler_raw` carries `windowsPrinterName`, not a
   host/port) under the same strict-validation + approved-destination policy.
   When `transport` becomes a multi-kind union, the registry's exhaustive
   `switch` enforces handling — remove its scoped eslint-disable in the same
   change.
4. **Register it** in `createTransportRegistry`.
5. **Gate hardware behavior.** Spooler RAW behind R-VAL-4 (driver RAW
   passthrough, buffering/reprint risk), USB behind R-VAL-5 (endpoint/claim
   quirks). No transport ships claims its validation phase hasn't closed.
6. **Update docs in the same change:** `printer-compatibility.md` §3/§5 and
   this file.

Transport-specific limits to respect:

- **spooler-raw:** success = job spooled by Windows; the vendor driver may
  buffer (R-VAL-4 duplicate risk — feeds the ambiguity/duplicate-policy flow).
- **usb (v1.1):** not promised in v1 — no UI, ack, or doc may claim USB
  support until that phase lands.
