# Render Pipeline — Doc Model v1 → ESC/POS

**Version:** 1.0 (2026-10-24) · **Status:** implemented in `src/main/render/` (all layers
per ADR-10 tested in CI). This document describes the code as it exists — where it
diverges from earlier plan drafts, the code is the truth.

## 1. Scope

The `renderer` module of `docs/architecture.md` §3.3: a pure function that turns the
normative doc model v1 (`docs/api-contract.md` §2 "Document model v1 (common fields)")
into an ESC/POS byte stream plus a diagnostic summary. Covers `customer_receipt` and the
shared kitchen/bar/station ticket layout. No timers, no network, no ambient state — the
only I/O is the lazy font-file read in the raster fallback path.

## 2. Module map

| File | Responsibility |
| --- | --- |
| `src/main/render/doc.ts` | Doc model v1 zod schemas (strict, UTF-8 **byte** caps), `DOC_TYPES`, `PAYLOAD_MAX_BYTES` (32 KiB) |
| `src/main/render/errors.ts` | `RenderError` + `RenderErrorCode` (stable machine codes: `invalid_doc`, `payload_too_large`, `unsupported_doc_type`, `text_not_encodable`, `render_failed`) |
| `src/main/render/sanitize.ts` | Control-char stripping (0x00–0x1F, 0x7F — threat-model T2), `isAsciiPrintable` |
| `src/main/render/layout.ts` | `wrapText`, `splitTwoColumns`, `formatQty`, `formatMinorUnits` |
| `src/main/render/profile.ts` | `RenderProfile` (renderer-local view: paper width, dots, chars/line, codepage, capabilities, raster-fallback config), `DEFAULT_80MM_PROFILE`, `renderProfileFromPrinterConfig` |
| `src/main/render/encoder.ts` | `EscposEncoder` interface + `ThermalPrinterEncoder` adapter — the ESC/POS boundary (see §4) |
| `src/main/render/raster.ts` | `TextRasterizer` (canvas → mono bitmap), `packMonoToGsV0`, `createCanvasRasterizer` (see §7) |
| `src/main/render/context.ts` | `RenderSummary`, `RenderWarning`, `RenderContext`, shared writers (`writeText`, `writeWrapped`, `writeTwoColumns`, `separator`, `applyCut`, `writeQr`, `writeBarcode`) |
| `src/main/render/render-receipt.ts` | Customer receipt template |
| `src/main/render/render-kitchen.ts` | Kitchen/bar/station ticket template (all three doc types share it) |
| `src/main/render/render.ts` | `renderDoc` entry point, guard cascade, `RenderResult` union |
| `assets/fonts/NotoSansBengali-Regular.ttf` + `assets/fonts/OFL.txt` | Bundled raster-fallback font + license |
| `tests/helpers/escpos-decode.ts` | In-house ESC/POS decoder for the emitted subset + `decodeLines` physical-line helper |
| `tests/helpers/virtual-printer.ts` | Ephemeral loopback TCP byte-sink printer (127.0.0.1:0) |
| `tests/helpers/render.ts` | `makeDoc` / `makeRenderProfile` builders |
| `tests/render-*.test.ts` | 11 test files: schema, sanitize, layout, profile, encoder, core, receipt, kitchen, raster, fuzz, virtual-printer |

## 3. Encodability policy (normative)

`writeText` is the single text sink of both templates and emits **exactly one physical
text line** per call:

1. The string is sanitized (0x00–0x1F and 0x7F stripped) at the encoder boundary —
   defense in depth on top of the doc-model validation (threat T2).
2. If the string is printable ASCII (`0x20–0x7E`): text bytes + `LF` (the writer owns
   line termination).
3. Otherwise, if `rasterFallback.enabled`: the string is rasterized and emitted as a
   `GS v 0` bit image (see §7), followed by `LF`.
4. Otherwise: rendering fails with `RenderError('text_not_encodable')`.

**Raw UTF-8 is never sent as text.** On the dominant fleet (CP437/CP850 hardware) it
would print as mojibake; codepage round-trips for non-Latin text remain open risk
R-VAL-1 (`docs/printer-compatibility.md` §6).

Related policies:

- **Cut:** `applyCut` feeds **3 lines unconditionally** before any cut decision, so
  paper clears the head for manual tearing even when the printer has no cutter
  (`capabilities.cut = false` → `summary.cut = 'none'` + warning
  `cut_skipped_unsupported` if a cut was requested). When a cutter exists, `partial`
  is the default; `full`/`none` are explicit via `station_hints.cut`.
- **QR:** printable ASCII only after sanitization (library `GS ( k` length prefix is
  UTF-16-based; non-ASCII is skipped with `qr_skipped_invalid`), matching CODE128;
  skipped with a warning when unsupported or empty after sanitization.
- **Barcode (CODE128):** printable ASCII only; skipped with a warning otherwise.
- **Kitchen/bar/station tickets carry no money:** prices, totals, payments, QR and
  barcodes are deliberately omitted from the ticket layout (payload-supplied footer
  QR/barcode data is recorded as a warning, never rendered).

## 4. ESC/POS command baseline actually emitted

| Feature | Bytes emitted | How |
| --- | --- | --- |
| Init | `ESC @` immediately followed by `ESC t <table>` (contiguous 5 bytes) | Explicit prefix emitted by the adapter constructor after a clean `setBuffer` — cp437 selects table 0, cp850 table 2 |
| Text | printable ASCII bytes + `LF` | `append()`, never the library's `print()` (which folds lines at the configured width) |
| Emphasis / size | `ESC E n` **and** `GS ! n` on every entry | Both commands always emitted together so transitions never leak size state (e.g. `double_height` → `bold` drops back to normal size) |
| Alignment | `ESC a n` | left/center/right |
| Feed | `LF` repeats | `feed(n)` appends `n` newlines; `ESC d` is not used |
| Cut | `GS V 0` (full) / `GS V 1` (partial) | Explicit bytes — **not** the library's `cut()`/`partialCut()`, which would add `ESC d 4` feeds and a mid-stream `ESC @` re-init |
| QR | `GS ( k` model 2 (cell size 3, correction M) | Library `printQR` payload builder |
| Barcode CODE128 | `GS k` function B, type 73, with `GS H`/`GS f`/`GS W`/`GS h` parameters and a `{B` subset-designation prefix on the payload | Library `printBarcode(data, 73)` |
| Raster bit image | `GS v 0 m xL xH yL yH <data>` (mode 0) | Own `packMonoToGsV0` |

**Dependency role:** `node-thermal-printer` 4.6.1 is used **only** for QR payload
construction, CODE128 payload construction, and stream buffering
(`append`/`setBuffer`/`getBuffer`). The adapter never opens a connection
(`interface: 'buffer'`; the library's only I/O entry point, `execute()`, is never
called). License and maintenance verdict: `docs/printer-compatibility.md` §5.

## 5. Responsibility split

- **Exactly one copy.** The renderer never loops over `copies`; `summary.copies` merely
  echoes `station_hints.copies` so the job engine can loop (state machine §5 counts
  attempts per write).
- **No clock.** `created_at` is rendered verbatim from the doc (only `T` → space for
  readability). The renderer never reads the system clock — output is deterministic
  given the same doc + profile.
- **No physical-print claims.** The module produces bytes and a diagnostic summary;
  `completed` = hand-off succeeded is the job engine's wording
  (`docs/api-contract.md` §3.1). No code path in `src/main/render/` reports a print.

## 6. Diagnostic summary contract

`RenderSummary` is what the job engine logs and the support view shows.

| Field | Type | Meaning |
| --- | --- | --- |
| `docType` | `string` | Dispatched doc type |
| `charsPerLine` | `number` | From the render profile |
| `paperWidthMm` | `58 \| 80` | From the render profile |
| `codepage` | `'cp437' \| 'cp850'` | Selected character table |
| `textLines` | `number` | Physical text lines emitted |
| `rasterizedLines` | `number` | Physical lines emitted as `GS v 0` |
| `controlCharsStripped` | `number` | Total control chars removed by the sanitizer |
| `copies` | `number` | Echo of `station_hints.copies` (default 1) — renderer emits one copy |
| `cut` | `'full' \| 'partial' \| 'none'` | What the cut policy actually did |
| `features` | `{ qr, barcode }` | Whether QR / barcode bytes were emitted |
| `warnings` | `RenderWarning[]` | Closed token set below |
| `byteLength` | `number` | Final stream size in bytes |

Warnings are a closed string-literal union — eight tokens:

| Token | Condition |
| --- | --- |
| `cut_skipped_unsupported` | Cut requested, printer has no cutter (`capabilities.cut = false`) |
| `qr_skipped_unsupported` | Footer QR data present, `capabilities.qrCode = false` |
| `qr_skipped_invalid` | Footer QR data empty or not printable ASCII after sanitization |
| `barcode_skipped_unsupported` | Footer barcode data present, `capabilities.barcode128 = false` |
| `barcode_skipped_invalid` | Footer barcode data empty or not printable ASCII |
| `logo_skipped_no_asset_store` | `logo_asset_id` present; asset pipeline deferred (R-VAL-9) |
| `qr_skipped_kitchen` | Footer QR data present on a kitchen/bar/station ticket (deliberately not rendered) |
| `barcode_skipped_kitchen` | Footer barcode data present on a kitchen/bar/station ticket (deliberately not rendered) |

## 7. Raster fallback design

Non-ASCII text (Bangla etc.) is rasterized to a 1-bit-per-pixel mono bitmap and emitted
as `GS v 0`, instead of sending UTF-8 into a CP437/CP850 codepage (mojibake — R-VAL-1).

- **Stack:** `@napi-rs/canvas` (MIT, prebuilt N-API) with the bundled
  **Noto Sans Bengali** Regular (`assets/fonts/`), licensed **SIL OFL 1.1**
  (`assets/fonts/OFL.txt`). No system-font fallback: if a configured font path fails to
  register, `createCanvasRasterizer` returns `null` and non-ASCII text fails with
  `text_not_encodable` rather than silently rendering wrong glyphs. The module-level
  `registered` Set in `raster.ts` is a deliberate dedup cache over @napi-rs/canvas's
  process-global `GlobalFonts` registry — the renderer's only ambient state, documented
  as the exception to the injected-dependencies rule.
- **Sizing:** shrink-to-fit with a **12 px floor** — a string too wide for
  `profile.printableDots` is scaled down until it fits or hits 12 px, then **clips at
  the canvas edge**. An oversized string can never widen the stream beyond the
  printable area.
- **Packing:** `packMonoToGsV0` validates dimensions (positive integers) and that the
  data length matches `ceil(width/8) × height` before emitting the header — a malformed
  bitmap throws inside the rasterizer instead of producing a corrupt stream.
- **Gating:** the rasterizer is constructed only when `profile.rasterFallback.enabled`
  (dependency-injected in tests). Shaping fidelity on real hardware (complex-script
  ligatures, conjuncts) is hardware-validation territory — R-VAL-1 stays open until the
  hardware phase closes it.

## 8. Testing layers (ADR-10)

| Layer | Mechanism |
| --- | --- |
| Unit | Byte-level assertions (init prefix, style transitions, cut bytes) and decoded-stream assertions per test file: schema, sanitize, layout, profile, encoder, core, receipt, kitchen, raster |
| Decoding | In-house ESC/POS decoder for the exact subset this renderer emits (`tests/helpers/escpos-decode.ts`), plus `decodeLines` for physical-line assertions — unknown bytes surface as `<0xNN>` text events so sanitization gaps are visible |
| Fuzz | `tests/render-fuzz.test.ts` — 520 deterministic cases (mulberry32, seed 42042): 400 dispatched as `customer_receipt`, 120 as `kitchen_ticket`; command injection, oversize strings, unicode/zero-width/bidi input. Asserts `renderDoc` never throws, never emits injected control bytes, and stays under the 256 KiB output cap |
| Integration | `tests/render-virtual-printer.test.ts` — end-to-end receipt through a virtual TCP printer bound to ephemeral `127.0.0.1:0` (`tests/helpers/virtual-printer.ts`), byte-for-byte and semantic assertions on what the socket received |
| CI-optional | `escpos-emulator` (TCP :9100 + REST decoded-output assertions, `docs/printer-compatibility.md` §5) can be layered on in CI later; the in-house mock keeps `pnpm test` hermetic |

## 9. Guard cascade (`renderDoc`)

```
doc_type check ──▶ JSON-serializable? ──▶ 32 KiB payload cap (BEFORE zod parse)
      │                    │                        │
      ▼                    ▼                        ▼
unsupported_doc_type  invalid_doc          payload_too_large
                           │
                           ▼
                 strict zod parse (DocV1Schema) ──▶ invalid_doc
                           │
                           ▼
       rasterizer DI only when rasterFallback.enabled
                           │
                           ▼
        dispatch: customer_receipt → receipt template;
        kitchen / bar / station → shared ticket template
                           │
                           ▼
            256 KiB output cap ──▶ render_failed
                           │
                           ▼
              summary finalization (byteLength, controlCharsStripped)
```

`renderDoc` never throws: every failure path returns `{ ok: false, error: RenderError }`
with a stable machine code (fuzz-asserted). Raw printer bytes from any client are
structurally impossible — the input is the structured doc model, and every string passes
the sanitizer inside the encoder (threat T2, ADR-3/ADR-11).

## 10. Handoff notes for the packaging / job-engine phases

- **Packaging:** `@napi-rs/canvas` is a native N-API addon — the electron-vite main
  build must keep it external, and electron-builder needs `asarUnpack` for the
  platform binary. `assets/fonts/` must ship as an extra resource; the packaged-app
  `rasterFallback.fontPaths` is config-populated (default profile has the fallback
  disabled, so nothing exercises this path until the job-engine/config phase wires it).
- **Job-engine:** call `renderDoc(doc_type, payload, renderProfileFromPrinterConfig(p))`
  per §3.3; emit `summary.copies` transport writes; map `RenderError.code` to ack
  error codes; `doc_version` != 1 must be rejected upstream of the renderer.
