# Printer Compatibility — 80mm ESC/POS Thermal

**Version:** 1.0 (2026-10-22) · **Evidence status:** dialect knowledge verified against
maintained libraries + vendor docs; _hardware-specific claims marked §6 require
physical validation._

## 1. Scope

80mm (≈ 576-dot / 48-char default @ 12×24 font A) ESC/POS thermal receipt printers
commonly used in restaurants: Epson TM-T20/TM-T88/TM-m30, Xprinter XP-N160/XP-58/80
series, Rongta RP326/RP80, Goojprt, Posiflex AURA, plus generic "ESC/POS-compatible"
OEM units — the dominant fleet in target markets.

## 2. Command baseline implemented by the renderer

| Feature              | ESC/POS commands                      | Notes                                            |
| -------------------- | ------------------------------------- | ------------------------------------------------ |
| Init                 | `ESC @`                               | Sent at stream start                             |
| Text / codepage      | `ESC t n` + `ESC R n`                 | Per-printer codepage config; ASCII-safe fallback |
| Emphasis             | `ESC E n`, `GS ! n`                   | bold / double-height / double-size               |
| Alignment            | `ESC a n`                             | left/center/right                                |
| Feed / cut           | `ESC d n`, `GS V n`                   | partial cut default; `none` option               |
| Pulse (cash drawer)  | `ESC p m t1 t2`                       | shipped, flagged untested-against-hardware       |
| QR                   | `GS ( k`                              | model 2; data ≤ 512 B validated                  |
| Barcode (CODE128)    | `GS ( B` / `GS h w k`                 | optional footer                                  |
| Bit image (logo)     | `GS v 0` (raster) or NV logo `GS ( L` | NV logo preferred if uploaded; raster fallback   |
| Status (best-effort) | `DLE EOT n`                           | off by default; `status_polling: auto`           |

Generated via `node-thermal-printer` (MIT, active — verified 2026-08 release) with a
thin wrapper so we can swap/patch dialect quirks without forking.

## 3. Transports and where each is safe to promise

| Transport                                                | How                                                                                                                                                             | Reliability model                                                                          | v1 status                                            |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| **TCP raw :9100** (primary)                              | Node `net`, outbound LAN                                                                                                                                        | Fire-and-forget; success = socket accepted + bytes flushed. **No application ack exists.** | v1                                                   |
| **Windows spooler RAW** (fallback for USB-only printers) | Own N-API shim: `OpenPrinterW → StartDocPrinter(DATATYPE:"RAW") → WritePrinter → EndDocPrinter`; requires a vendor ESC/POS driver installed on a shared printer | Success = spooled by Windows. Driver may buffer (risk R4)                                  | shipped A2 — capture-tested; hardware open (R-VAL-4) |
| USB direct                                               | `usb` 3.x, claim printer-class interface, BULK OUT                                                                                                              | Vendor endpoint quirks possible                                                            | v1.1                                                 |
| Mock / virtual                                           | In-memory buffer (unit) + `escpos-emulator` TCP :9100 (integration/CI)                                                                                          | Byte-exact assertion via REST                                                              | v1                                                   |

Explicitly rejected: `webContents.print()` (Chromium rasterizes — no ESC/POS
passthrough), `pdf-to-printer` (rasterizes AND bundles GPLv3 SumatraPDF — license +
mechanism both wrong).

## 4. Known dialect / compatibility matrix (verified knowledge)

| Capability                                | Epson TM series           | Xprinter | Rongta  | Generic OEM                      | Risk                        |
| ----------------------------------------- | ------------------------- | -------- | ------- | -------------------------------- | --------------------------- |
| ESC/POS core (text, emphasis, align, cut) | Yes                       | Yes      | Yes     | "Mostly" — clone firmware varies | Med                         |
| `GS V` cut variants (`V 0/1`, `V 65/66`)  | Yes                       | Yes      | Yes     | Sometimes only one form          | Med                         |
| QR `GS ( k` model 2                       | Yes                       | Yes      | Yes     | Occasionally model 1 only        | Low-Med                     |
| Raster bit image `GS v 0`                 | Yes                       | Yes      | Yes     | Yes (scale/format quirks)        | Low                         |
| NV logo upload                            | Yes (Epson utility)       | Varies   | Varies  | Rare                             | High → use raster fallback  |
| DLE EOT status                            | Yes (with ASB config)     | Partial  | Partial | Rare                             | High → treat as best-effort |
| Codepages                                 | CP437/850/852/858, custom | Similar  | Similar | Varies wildly                    | High for non-Latin text     |
| 2-byte UTF-8 mode (`FS &`)                | Yes                       | Yes      | Yes     | Unreliable                       | High → per-printer config   |

**Policy:** the renderer emits the _conservative intersection_ by default
(core text/emphasis/align/cut + model-2 QR + raster images), with per-printer config
opting into advanced features. Non-ASCII text without a configured codepage is
rejected at render time rather than printed as mojibake.

## 5. Dependency choices & licenses (verified 2026-10-22, see `.research/dependency-research.md`)

| Package                                  | Role                          | License        | Maintenance verdict                                                                                                          |
| ---------------------------------------- | ----------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `node-thermal-printer` 4.6.1             | ESC/POS generation            | MIT            | Active (2026-08). No automated test suite upstream → our own contract tests mandatory                                        |
| `usb` 3.2.1                              | USB transport (v1.1)          | MIT            | Active; N-API, no electron-rebuild                                                                                           |
| `serialport` 13                          | future kitchen display/serial | MIT            | Active; prebuilt                                                                                                             |
| `escpos`, `escpos-usb`, `escpos-network` | —                             | MIT            | **Rejected: abandoned (alphas, ~2020)**                                                                                      |
| `pdf-to-printer`                         | —                             | MIT wrapper    | **Rejected: bundles GPLv3 SumatraPDF binary — not commercially distributable**                                               |
| `escpos-emulator` 0.3.0                  | Virtual printer for tests/CI  | MIT            | Maintained (2026-09); TCP :9100 + REST assertions                                                                            |
| Win32 spooler shim                       | spooler transport             | Own code (MIT) | ~100 lines; no maintained npm equivalent exists (verified); shipped as `native/spooler-raw` (node-addon-api + node-gyp, MIT) |

CI license gate (threat T5) re-verifies this table on every release; this document is
updated whenever a dependency is added or bumped.

## 6. Risks requiring physical-printer validation (blocking hardware phase)

1. **R-VAL-1 Codepage round-trip:** render sample receipts with accented/non-Latin
   restaurant names per codepage config on each real model; assert correct glyphs.
2. **R-VAL-2 Cut command variants:** full/partial cut behavior and noise on generic
   OEM firmware; pick per-model defaults.
3. **R-VAL-3 DLE EOT reality check:** which fleet models actually answer status polls
   (and under ASB config); determines whether `printer_status` can ever graduate from
   "unknown".
4. **R-VAL-4 Spooler RAW end-to-end:** vendor driver install, datatype "RAW"
   passthrough byte-exactness, driver buffering/reprint-on-reboot behavior (duplicate
   risk T4), behavior under driver "pause printer".
5. **R-VAL-5 USB (v1.1):** endpoint/claim quirks on Xprinter/Rongta; USB print + Linux
   gadget board (Pi Zero) manual smoke test since USB cannot be CI-simulated.
6. **R-VAL-6 Throughput & timing:** kitchen-rush burst (10 jobs in 5 s) — socket
   backpressure, print density/heat speed, retry timeout tuning.
7. **R-VAL-7 Autoreconnect semantics:** power-cycle printer mid-job; socket close vs
   silent drop; validate retry policy produces at-most-once-per-attempt.
8. **R-VAL-8 Paper-out / cover-open mid-stream:** bytes lost with TCP success —
   confirms that "sent ≠ printed" wording is required in operator UI.
9. **R-VAL-9 Cash drawer pulse:** untested command; verify per popular drawers.
10. **R-VAL-10 Logo pipeline:** NV upload vs raster path fidelity + speed on low-end
    58mm-vs-80mm configurations.

Exit criteria for the hardware phase: a matrix (model × transport × sample documents)
with pass/fail per R-VAL item, stored in this folder, driving per-model config presets
shipped in the SaaS printer catalog.
