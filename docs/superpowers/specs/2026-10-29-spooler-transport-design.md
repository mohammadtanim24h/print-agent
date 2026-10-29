# A2 — Spooler RAW transport (`spooler_raw`, P7) — Design

Date: 2026-10-29
Status: approved (design)
Closes: `docs/production-readiness.md` A2 (partial — real-hardware evidence
stays with B1/R-VAL-4)

## Problem

The schema (cloud `schemas.ts`) accepts `spooler_raw` endpoints, but no
transport exists: `config-apply.ts` rejects any spooler entry (whole-config
reject per the A1 spec), the registry has no case for it, and the local UI
can only create `tcp_raw` printers. USB-only printers behind a Windows driver
— the fallback path of ADR-4 — are unreachable.

## Decisions (user-approved)

| Decision | Choice |
| --- | --- |
| Native vehicle | Own N-API C++ shim per ADR-4 (node-addon-api + node-gyp; **not** koffi/FFI — ADR-4's rationale stands, minimal supply-chain surface) |
| UI scope | Full local UI support: transport-type selector, Windows-printer dropdown via a new IPC enumeration channel |
| Capture-test evidence | Fake shim in CI everywhere; real-shim file-port capture test auto-skips unless the capture printer is installed (PowerShell setup script + runbook note); hardware evidence stays R-VAL-4/B1 |
| Packaging | New local package `native/spooler-raw/` wired as a `file:` dependency — pnpm/electron-builder treat it exactly like better-sqlite3 (`onlyBuiltDependencies` + `asarUnpack` of the `.node`) |

## 1. Native shim — `native/spooler-raw/`

New local package (own `package.json`, MIT, in-repo), C++ over winspool.drv
via **node-addon-api** (header-only, MIT), built by node-gyp.

API surface (two functions, stateless):

- **`spoolerWriteRaw(name: string, bytes: Uint8Array): Promise<void>`** —
  `OpenPrinterW → StartDocPrinterW(DOC_INFO_1W, pDatatype "RAW") →
  WritePrinter (chunked loop) → EndDocPrinter → ClosePrinter`. **One spooler
  job per call** — this is the correct mapping of the `PrinterTransport`
  job semantics (each `write()` = one document). Runs on an N-API
  `AsyncWorker` so the main-process event loop never blocks.
- **`enumeratePrinters(): { name: string }[]`** — `EnumPrintersW`, capped
  count (128). Powers the UI dropdown and capture-test skip detection.
- **`printerExists(name: string): boolean`** — `OpenPrinterW` +
  `ClosePrinter` probe. Powers `open()`/`healthCheck()` (cheaper than
  enumerating).

Load discipline: the JS wrapper lazily `require`s the `.node` binary only
when a spooler transport is actually constructed — no native load for
tcp_raw-only installs, and unit tests inject a fake instead of the binary.

Semantics per ADR-5/api-contract §3.1 (normative wording): `write()`
resolving means **Windows accepted (spooled) the job** — never "printed".
Vendor-driver buffering remains the documented R-VAL-4 duplicate risk,
feeding the existing ambiguity/duplicate-policy flow.

## 2. Error mapping (`src/main/transport/errors.ts`)

Existing codes are kept; exactly **one** new code is added — a documented,
contract-visible change per `transport-adapters.md`:

- `printer_not_found` — `OpenPrinterW` failed (printer not installed /
  not accessible by name).
- Everything else (StartDoc/Write/EndDoc failures incl. access denied) →
  existing `write_failed`, Windows error text carried in the message.
- Write-before-open → existing `not_open`.

## 3. Transport — `src/main/transport/spooler-raw.ts`

`createSpoolerRawTransport(options: { printerName, bridge: SpoolerBridge })`
implementing `PrinterTransport`:

- `open()` — `printerExists` probe; rejects `printer_not_found` when
  absent; idempotent like tcp-raw.
- `write(bytes)` — `spoolerWriteRaw` for the whole buffer (chunked at the
  shim, 64 KiB per `WritePrinter` call); serialized via a tail-promise like
  tcp-raw (one job at a time; ordering guarantee).
- `close()` — no-op resolve (stateless; no persistent handle).
- `healthCheck()` — `open()` probe.
- `status` — not implemented (spooler gives no media status; R-VAL-8
  wording applies).

The `SpoolerBridge` TypeScript interface (`enumerate`, `writeRaw`, probe)
is injected exactly like `SocketFactory` — unit tests run against fakes
with no hardware (ADR-10 layering).

## 4. Schema, registry, config-apply

- `profile.ts`: `transport` becomes `z.union([EndpointTcpRawSchema,
  EndpointSpoolerRawSchema])` where the spooler variant is
  `strictObject({ kind: 'spooler_raw', windowsPrinterName:
  z.string().min(1).max(128) })` (camelCase mirror of cloud
  `windows_printer_name` bytes(128)). No IP/host policy applies — existence
  is validated at open time by the shim.
- `registry.ts`: new `case 'spooler_raw'` wiring
  `createSpoolerRawTransport` with the injected bridge; **remove the
  scoped eslint-disable** — the exhaustive-switch compile-error guard
  becomes real.
- `config-apply.ts`: `spooler_raw` entries map through
  (`windows_printer_name → windowsPrinterName`); only `usb` remains
  rejected in v1 (error message updated accordingly). Closes the
  "spooler_raw becomes applicable with A2" note of the A1 spec.

## 5. UI — PrintersScreen + IPC

- New IPC channel **`printers:listSystem`**: main calls
  `enumeratePrinters()`, returns zod-validated capped list; joins the
  whitelisted, validated bridge like existing printer channels (security
  rule 2/3).
- `PrintersScreen`: transport-type selector (**TCP** / **Windows
  printer**). Spooler mode replaces the host/port fields with a dropdown of
  enumerated names. `transportLabel` renders `Spooler: <name>`.

## 6. Testing

**CI unit (every build, no hardware):**

- `tests/spooler-raw.test.ts` — fake-bridge lifecycle: open idempotence,
  printer_not_found on missing probe, write serialization/ordering,
  not_open-before-open, close idempotence, healthCheck; fake records bytes.
- Registry wiring test (spooler profile → spooler transport).
- `config-apply` tests: spooler mapping; `usb` still rejects; mixed
  tcp/spooler config applies.
- `printer-profile` schema tests: strict rejection of unknown fields in the
  spooler variant, name-length bounds, union acceptance.
- IPC contract test for `printers:listSystem` (zod-validated, capped).

**Opt-in capture (ADR-10, real shim):**

- `tests/spooler-raw-capture.test.ts` — writes a known byte pattern through
  the real shim to the `PrintAgentCapture` file-port printer; asserts the
  captured file bytes ≡ written bytes. **Auto-skips** when the printer is
  not installed (probed via `enumeratePrinters()`).
- `scripts/setup-capture-printer.ps1` — creates the capture printer
  (Generic/Text-Only driver is *not* used — per ADR-10 it mangles bytes;
  the script uses a redirected local-file port) and a runbook note in
  `docs/operations.md`. Run manually pre-release; hardware evidence stays
  flagged R-VAL-4 for B1.

**CI build wiring:**

- `package.json`: `native/spooler-raw` added as a `file:` dependency; its
  name added to `pnpm.onlyBuiltDependencies` so `pnpm install` runs
  node-gyp on windows runners (MSVC preinstalled) and dev machines.
- `electron-builder.yml`: `asarUnpack` gains the new `**/*.node` pattern
  (`npmRebuild: false` unchanged — N-API prebuilds are ABI-stable, same
  property as better-sqlite3).

## 7. Docs (same change)

- `api-contract.md` §4: `spooler_raw` now applicable agent-side (remove the
  "until P7" wording); §6 rows unchanged semantics.
- `transport-adapters.md`: new adapter section (job-per-write semantics,
  buffering/R-VAL-4 note) + the `printer_not_found` code addition.
- `printer-compatibility.md` §3/§5: spooler row updated (shim shipped,
  capture-tested, hardware pass/fail still open under R-VAL-4).
- `docs/production-readiness.md` A2 status update.
- P7's "driver inventory" deliverable (per-model vendor-driver catalog)
  stays with B1 hardware access; the enumeration surface ships in this
  change.

## Out of scope

- Real-hardware R-VAL-4 validation (B1).
- USB transport (v1.1).
- Spooler driver auto-install/detection.
- Cloud-side UI for spooler printers (Laravel's concern; the agent now
  accepts §4 `spooler_raw` entries).
