# Rendering Subsystem (Doc Model → ESC/POS) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `renderer` module of `docs/architecture.md` §3.3 — a pure function that turns the normative doc model v1 (`docs/api-contract.md` §2/§4) into an ESC/POS byte stream plus a diagnostic summary, for customer receipts and kitchen/station tickets, with sanitizer, layout engine, printer profiles, a minimal Unicode raster fallback, and a virtual-printer integration test.

**Architecture:** New module `src/main/render/` with six focused files plus two templates: zod doc-model schema (`doc.ts`), control-char sanitizer (`sanitize.ts`), pure text layout (`layout.ts`), render profile (`profile.ts`), a thin adapter over `node-thermal-printer` (`encoder.ts` — the library is used only for the genuinely fiddly commands: QR, barcode, cut, buffering; styles/alignment are emitted as explicit ESC/POS sequences so output is deterministic and decoder-testable), raster fallback (`raster.ts` via `@napi-rs/canvas` + bundled OFL font), dispatch/result (`render.ts`), shared context/writers (`context.ts`), typed errors (`errors.ts`). The renderer never executes raw printer bytes: input is always the validated structured doc; every string is sanitized (0x00–0x1F, 0x7F stripped) before encoding (threat T2).

**Tech Stack:** TypeScript strict (ES2023, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zod 4 (`z.strictObject`), `node-thermal-printer@4.6.1` (ISC, active 2026-08 — selection rationale in `docs/printer-compatibility.md` §5 and `.research/dependency-research.md` #4; escpos* rejected as abandoned, pdf-to-printer rejected as GPLv3-bundling), `@napi-rs/canvas@1.0.13` (MIT, prebuilt N-API) for the raster path, Noto Sans Bengali (SIL OFL 1.1) bundled font, Vitest (`tests/**/*.test.ts`, node project).

**Repo conventions that matter here:**

- `TypedError` (`src/shared/errors.ts`): every error carries a stable machine `code`.
- Renderer (ESC/POS) is a **pure function**: no timers, no `Date.now()`, no network. The only I/O is the lazy font-file read in the raster path.
- **Never claim physical printing.** This module only produces bytes; the wording in `docs/api-contract.md` §3.1 is normative and appears in warnings/diagnostics.
- No listening sockets in the app; the test-only virtual printer binds an ephemeral loopback port inside `tests/` (the app runtime no-listen smoke is unaffected).
- Run tools via pnpm from repo root: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format`, `pnpm format:check`.
- Dependency admission (CLAUDE.md rule 10): exact pins only; licenses recorded in `.research/dependency-research.md`.

**Key design decisions (binding):**

1. **Encodability policy** (`docs/printer-compatibility.md` §4): unless the profile has the raster fallback enabled, any text containing characters outside printable ASCII (`0x20–0x7E`) fails rendering with `RenderError('text_not_encodable')` — non-Latin text is never sent as raw UTF-8 (mojibake risk; codepage round-trips are R-VAL-1, still open). With the fallback enabled, non-ASCII strings are rasterized and emitted as `GS v 0` bit images.
2. **Styles/alignment are explicit bytes** emitted by our adapter (`ESC E n`, `GS ! n`, `ESC a n`) rather than via library style helpers — deterministic, conservative-intersection dialect per printer-compatibility §2, and directly decodable by the test helper.
3. **QR data**: sanitized (control chars stripped) but non-ASCII allowed (QR is byte-native). **Barcode (CODE128)**: printable ASCII only; otherwise skipped with a warning.
4. **`copies` is not the renderer's job**: the renderer emits exactly one copy and reports `summary.copies` (from `station_hints`) for the job engine to loop over (state machine §5 counts attempts per write).
5. **Logos**: `logo_asset_id` is accepted but no asset store exists yet → warning `logo_skipped_no_asset_store` in the summary. NV/raster logo pipeline is deferred (R-VAL-10).
6. **Amounts** are integer minor units formatted with a plain `-1,234.56` style (no currency symbol — the doc model carries none). Discounts render as negative amounts.
7. **Timestamps** render the RFC 3339 string from the doc as-is (deterministic; no local-timezone conversion).
8. **Output cap**: a rendered stream larger than 256 KiB fails with `render_failed` (blast-radius guard for the raster path).

**File structure:**

| File | Responsibility |
| --- | --- |
| `src/main/render/doc.ts` | Doc model v1 zod schemas (strict, byte-length caps), `DOC_TYPES`, `PAYLOAD_MAX_BYTES` |
| `src/main/render/errors.ts` | `RenderError`, `RenderErrorCode` |
| `src/main/render/sanitize.ts` | Control-char stripping, `isAsciiPrintable` |
| `src/main/render/layout.ts` | `wrapText`, `splitTwoColumns`, `formatQty`, `formatMinorUnits` |
| `src/main/render/profile.ts` | `RenderProfile`, `DEFAULT_80MM_PROFILE`, `renderProfileFromPrinterConfig` |
| `src/main/render/encoder.ts` | `EscposEncoder` interface + `ThermalPrinterEncoder` adapter (node-thermal-printer behind it) |
| `src/main/render/raster.ts` | `TextRasterizer` (canvas→mono bitmap), `packMonoToGsV0`, `createCanvasRasterizer` |
| `src/main/render/context.ts` | `RenderSummary`, `RenderContext`, `createContext`, `writeText`, `writeWrapped`, `writeTwoColumns`, `separator`, `applyCut`, `writeQr`, `writeBarcode` |
| `src/main/render/render-receipt.ts` | Customer receipt template |
| `src/main/render/render-kitchen.ts` | Kitchen/bar/station ticket template |
| `src/main/render/render.ts` | `renderDoc` dispatch → `RenderResult { bytes, summary }` |
| `assets/fonts/NotoSansBengali-Regular.ttf` + `assets/fonts/OFL.txt` | Bundled fallback font + license |
| `tests/helpers/render.ts` | `makeDoc`, `makeRenderProfile` builders |
| `tests/helpers/escpos-decode.ts` | Minimal ESC/POS decoder for assertions |
| `tests/helpers/virtual-printer.ts` | Ephemeral loopback TCP byte-sink printer |
| `tests/render-doc-schema.test.ts`, `render-sanitize.test.ts`, `render-layout.test.ts`, `render-profile.test.ts`, `render-encoder.test.ts`, `render-core.test.ts`, `render-receipt.test.ts`, `render-kitchen.test.ts`, `render-raster.test.ts`, `render-fuzz.test.ts`, `render-virtual-printer.test.ts` | Unit + fuzz + integration tests |
| `docs/render-pipeline.md` | New doc: module map, encodability policy, raster fallback design, font licenses, responsibility split |
| `.research/dependency-research.md`, `docs/architecture.md` | License-table entries + §3.3 pointer |

**Out of scope (do not build):** job-engine integration (renderDoc is called by the engine in a later phase), IPC/renderer wiring, logo asset store, DLE EOT status, spooler/USB transports, cloud client, full complex-script shaping validation (Bangla shaping on real hardware is R-VAL-1; the raster path here is the minimal, tested pipeline).

---

### Task 1: Dependencies, bundled font, license records

No app code; dependency admission (CLAUDE.md rule 10) and the font asset. Gate: install succeeds, licenses recorded.

**Files:**
- Modify: `package.json` (via pnpm)
- Create: `assets/fonts/NotoSansBengali-Regular.ttf`, `assets/fonts/OFL.txt`
- Modify: `.research/dependency-research.md`

- [ ] **Step 1: Install exact-pinned dependencies**

```bash
pnpm add -E node-thermal-printer@4.6.1 @napi-rs/canvas@1.0.13
```

Expected: both land in `dependencies` with exact versions (`"node-thermal-printer": "4.6.1"`, `"@napi-rs/canvas": "1.0.13"`). `@napi-rs/canvas` uses prebuilt optional-dep binaries — no postinstall build step needed; do NOT add it to `pnpm.onlyBuiltDependencies`.

- [ ] **Step 2: Verify licenses against the admission policy**

```bash
npm view node-thermal-printer@4.6.1 license dist-tags.latest
npm view @napi-rs/canvas@1.0.13 license
node -e "console.log(Object.keys(require('node-thermal-printer')))"
```

Expected: `ISC` for node-thermal-printer (repo LICENSE.md says MIT — either is admissible), `MIT` for @napi-rs/canvas. Note the actual runtime export names from the `node -e` output (they are needed in Task 6: expected `ThermalPrinter`, `Types`, `CharacterSet`, `BarcodeType`; if any differs, adjust the import in Task 6 only).

- [ ] **Step 3: Bundle the fallback font (SIL OFL 1.1 — admissible, permits redistribution and commercial bundling)**

```bash
mkdir -p assets/fonts
curl -L -o assets/fonts/NotoSansBengali-Regular.ttf \
  https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/NotoSansBengali/hinted/ttf/NotoSansBengali-Regular.ttf
curl -L -o assets/fonts/OFL.txt \
  https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/NotoSansBengali/LICENSE
```

Expected: the TTF is a TrueType file of several hundred KB (verify size > 100 000 bytes; if the LICENSE path 404s, take the OFL text from the notofonts repo root and record where it came from). Record the pinned source URL and download date in the doc step.

- [ ] **Step 4: Record the additions in `.research/dependency-research.md`**

Append to the summary table (same columns as existing rows):

```markdown
| 13  | node-thermal-printer                 | 4.6.1 (pinned exact)     | 2026-08-18        | ISC (npm) / MIT (repo LICENSE.md) | Yes (repo pushed 2026-08-24)                    | Used for command generation ONLY (QR `GS ( k`, CODE128, cut, buffer); transports and style commands bypassed — see `src/main/render/encoder.ts`                                                                                                                                            | Use — rendering subsystem (2026-10-23)                                                              |
| 14  | @napi-rs/canvas                      | 1.0.13 (pinned exact)    | 2026-10-21        | MIT                               | Yes (very active)                               | Prebuilt N-API; raster text fallback only (`src/main/render/raster.ts`), lazily loaded                                                                                                                                                     | Use — raster fallback (2026-10-23)                                                                  |
| 15  | Noto Sans Bengali (bundled font)     | pinned download 2026-10-23 | n/a             | SIL OFL 1.1                       | Yes (Google Noto)                               | `assets/fonts/`, license file bundled alongside; OFL permits redistribution + commercial bundling; reserved-font-name rules respected by not renaming                                                                                       | Use — Bangla/Unicode raster fallback (2026-10-23)                                                   |
```

- [ ] **Step 5: Verify install + existing tests still green**

Run: `pnpm install && pnpm test && pnpm typecheck`
Expected: all pre-existing tests pass; no type errors.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml assets/fonts .research/dependency-research.md
git commit -m "deps: node-thermal-printer 4.6.1 + @napi-rs/canvas 1.0.13 + Noto Sans Bengali (OFL) for render subsystem"
```

---

### Task 2: Doc model v1 schema (`doc.ts`)

**Files:**
- Create: `src/main/render/doc.ts`
- Test: `tests/render-doc-schema.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/render-doc-schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DOC_TYPES, DocV1Schema, PAYLOAD_MAX_BYTES } from '../src/main/render/doc';
import { makeDoc } from './helpers/render';

describe('doc model v1 schema', () => {
  it('accepts a valid receipt doc and applies defaults', () => {
    const doc = makeDoc();
    const parsed = DocV1Schema.parse(doc);
    expect(parsed.lines[0]?.emphasis).toBe('none');
    expect(parsed.totals).toHaveLength(1);
  });

  it('rejects unknown fields (strict)', () => {
    const doc = makeDoc({ header: { restaurant_name: 'X', address_lines: [], sneaky: 1 } as never });
    expect(DocV1Schema.safeParse(doc).success).toBe(false);
  });

  it('rejects more than 200 lines', () => {
    const doc = makeDoc({
      lines: Array.from({ length: 201 }, () => ({ text: 'x' })),
    });
    expect(DocV1Schema.safeParse(doc).success).toBe(false);
  });

  it('enforces byte-length caps, not char counts (Bangla)', () => {
    // 40 Bengali chars = 120 UTF-8 bytes > the 96-byte cap on line.text
    const bangla = 'প্রিন্ট এজেন্ট টেস্ট লাইন বড় নাম';
    const ok = makeDoc({ lines: [{ text: 'Bangla'.repeat(16) }] }); // 96 ASCII bytes — OK
    expect(DocV1Schema.safeParse(ok).success).toBe(true);
    const bad = makeDoc({ lines: [{ text: bangla.repeat(10) }] });
    expect(DocV1Schema.safeParse(bad).success).toBe(false);
  });

  it('rejects non-integer unit_price and negative qty', () => {
    expect(DocV1Schema.safeParse(makeDoc({ lines: [{ text: 'a', unit_price: 10.5 }] })).success).toBe(false);
    expect(DocV1Schema.safeParse(makeDoc({ lines: [{ text: 'a', qty: -1 }] })).success).toBe(false);
    expect(DocV1Schema.safeParse(makeDoc({ lines: [{ text: 'a', qty: 9999 }] })).success).toBe(true);
  });

  it('rejects invalid emphasis/align and bad created_at', () => {
    expect(DocV1Schema.safeParse(makeDoc({ lines: [{ text: 'a', emphasis: 'italic' as never }] })).success).toBe(false);
    const bad = makeDoc();
    bad.meta.created_at = 'not-a-date';
    expect(DocV1Schema.safeParse(bad).success).toBe(false);
  });

  it('accepts negative amounts (discounts) and station_hints bounds', () => {
    const doc = makeDoc({ totals: [{ label: 'DISCOUNT', amount_minor: -500, emphasis: 'none' }], station_hints: { copies: 4, cut: 'partial' } });
    expect(DocV1Schema.safeParse(doc).success).toBe(true);
    const bad = makeDoc({ station_hints: { copies: 5 } });
    expect(DocV1Schema.safeParse(bad).success).toBe(false);
  });

  it('exposes the normative constants', () => {
    expect(DOC_TYPES).toEqual(['customer_receipt', 'kitchen_ticket', 'bar_ticket', 'station_ticket']);
    expect(PAYLOAD_MAX_BYTES).toBe(32 * 1024);
  });
});
```

Create `tests/helpers/render.ts` (used by every later test file):

```ts
import type { DocV1 } from '../../src/main/render/doc';
import { DEFAULT_80MM_PROFILE, type RenderProfile } from '../../src/main/render/profile';

export function makeDoc(overrides: Partial<DocV1> = {}): DocV1 {
  return {
    header: {
      restaurant_name: 'Test Cafe',
      address_lines: ['12 Main St'],
    },
    meta: {
      title: 'RECEIPT',
      order_ref: 'ORD-1001',
      created_at: '2026-10-22T10:00:00.000Z',
    },
    lines: [{ text: 'Coffee', qty: 2, unit_price: 1200, emphasis: 'none', align: 'left' }],
    totals: [{ label: 'TOTAL', amount_minor: 2400, emphasis: 'bold' }],
    payments: [],
    footer: { text_lines: [] },
    station_hints: {},
    ...overrides,
  };
}

export function makeRenderProfile(overrides: Partial<RenderProfile> = {}): RenderProfile {
  return { ...DEFAULT_80MM_PROFILE, ...overrides };
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/render-doc-schema.test.ts`
Expected: FAIL — module `../src/main/render/doc` not found.

- [ ] **Step 3: Implement `src/main/render/doc.ts`**

```ts
import { z } from 'zod';

/**
 * Doc model v1 — the normative payload of `docs/api-contract.md` §4. Strict
 * schemas: unknown fields inside payloads are rejected, not ignored (ADR-11).
 * String limits are BYTES of UTF-8 per the contract's "hard limits", so a
 * helper is used instead of zod's UTF-16-code-unit `max()`.
 */
export const PAYLOAD_MAX_BYTES = 32 * 1024;

const bytes = (max: number) =>
  z
    .string()
    .refine((s) => Buffer.byteLength(s, 'utf8') <= max, `must be at most ${max} UTF-8 bytes`);

export const EMPHASIS = ['none', 'bold', 'double_height', 'double'] as const;
export const ALIGN = ['left', 'center', 'right'] as const;
export type Emphasis = (typeof EMPHASIS)[number];
export type Align = (typeof ALIGN)[number];

export const DocLineSchema = z.strictObject({
  text: bytes(96),
  qty: z.number().min(0).optional(),
  unit_price: z.number().int().optional(), // integer minor units; negative = discount
  note: bytes(64).optional(),
  emphasis: z.enum(EMPHASIS).default('none'),
  align: z.enum(ALIGN).default('left'),
});

export const DocV1Schema = z.strictObject({
  header: z.strictObject({
    restaurant_name: bytes(64),
    address_lines: z.array(bytes(48)).max(6),
    tax_id: bytes(32).optional(),
    logo_asset_id: z.uuid().optional(),
  }),
  meta: z.strictObject({
    title: bytes(24),
    order_ref: bytes(24),
    created_at: z.iso.datetime(),
    server_name: bytes(32).optional(),
    table: bytes(16).optional(),
  }),
  lines: z.array(DocLineSchema).max(200),
  totals: z
    .array(
      z.strictObject({
        label: bytes(24),
        amount_minor: z.number().int(),
        emphasis: z.enum(['none', 'bold']).default('none'),
      }),
    )
    .default([]),
  payments: z
    .array(
      z.strictObject({
        method: bytes(16),
        amount_minor: z.number().int(),
        change_minor: z.number().int().optional(),
      }),
    )
    .default([]),
  footer: z
    .strictObject({
      text_lines: z.array(bytes(48)).max(8),
      qr_data: bytes(512).optional(),
      barcode_data: bytes(48).optional(),
    })
    .default({ text_lines: [] }),
  station_hints: z
    .strictObject({
      copies: z.number().int().min(1).max(4).optional(),
      cut: z.enum(['full', 'partial', 'none']).optional(),
    })
    .default({}),
});

export type DocV1 = z.output<typeof DocV1Schema>;

export const DOC_TYPES = ['customer_receipt', 'kitchen_ticket', 'bar_ticket', 'station_ticket'] as const;
export type DocType = (typeof DOC_TYPES)[number];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/render-doc-schema.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/render/doc.ts tests/render-doc-schema.test.ts tests/helpers/render.ts
git commit -m "feat(render): doc model v1 strict zod schema with UTF-8 byte caps"
```

---

### Task 3: Sanitizer (`sanitize.ts`)

**Files:**
- Create: `src/main/render/sanitize.ts`
- Test: `tests/render-sanitize.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/render-sanitize.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isAsciiPrintable, sanitizeText } from '../src/main/render/sanitize';

describe('sanitizeText', () => {
  it('strips all C0 control bytes and DEL, counting them', () => {
    const input = `A\x1bB\tC\nD\x00E\x7fF`;
    expect(sanitizeText(input)).toEqual({ text: 'ABCDEF', stripped: 5 });
  });

  it('leaves an attempted ESC/POS injection inert (introducers stripped)', () => {
    const evil = 'x\x1b@y\x1dV0z'; // ESC @ init + GS V cut injection attempt
    const { text, stripped } = sanitizeText(evil);
    // Only the control-char introducers are stripped; the orphaned printable
    // bytes print as text and carry no command semantics.
    expect(text).toBe('x@yV0z');
    expect(stripped).toBe(2);
  });

  it('leaves printable ASCII untouched', () => {
    expect(sanitizeText('Coffee 2x — 12.00')).toEqual({ text: 'Coffee 2x — 12.00', stripped: 0 });
  });

  it('leaves non-Latin printable text (Bangla) untouched', () => {
    const b = 'প্রিন্ট';
    expect(sanitizeText(b)).toEqual({ text: b, stripped: 0 });
  });

  it('handles empty strings', () => {
    expect(sanitizeText('')).toEqual({ text: '', stripped: 0 });
  });
});

describe('isAsciiPrintable', () => {
  it('accepts printable ASCII only', () => {
    expect(isAsciiPrintable('OK 123')).toBe(true);
    expect(isAsciiPrintable('café')).toBe(false);
    expect(isAsciiPrintable('প্রিন্ট')).toBe(false);
    expect(isAsciiPrintable('tab\tchar')).toBe(false);
    expect(isAsciiPrintable('')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/render-sanitize.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/main/render/sanitize.ts`**

```ts
/**
 * Threat-model T2 boundary: every string is stripped of 0x00–0x1F and 0x7F
 * before ESC/POS encoding, so content can never inject printer commands
 * (api-contract.md §2 "hard limits" is normative). Stripping (not escaping)
 * keeps column layout math correct.
 */
const CONTROL_RE = /[\u0000-\u001F\u007F]/g;

export function sanitizeText(text: string): { text: string; stripped: number } {
  let stripped = 0;
  const clean = text.replace(CONTROL_RE, () => {
    stripped += 1;
    return '';
  });
  return { text: clean, stripped };
}

export function isAsciiPrintable(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\u0020-\u007E]*$/.test(text);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/render-sanitize.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/render/sanitize.ts tests/render-sanitize.test.ts
git commit -m "feat(render): control-char sanitizer (threat T2 boundary)"
```

---

### Task 4: Layout helpers (`layout.ts`)

**Files:**
- Create: `src/main/render/layout.ts`
- Test: `tests/render-layout.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/render-layout.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatMinorUnits, formatQty, splitTwoColumns, wrapText } from '../src/main/render/layout';

describe('wrapText', () => {
  it('wraps greedily on spaces within the width', () => {
    expect(wrapText('one two three four', 7)).toEqual(['one two', 'three', 'four']);
  });
  it('hard-breaks words longer than the width', () => {
    expect(wrapText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });
  it('collapses runs of spaces', () => {
    expect(wrapText('a   b', 4)).toEqual(['a b']);
  });
  it('returns one empty line for empty input', () => {
    expect(wrapText('', 10)).toEqual(['']);
  });
  it('handles very long Bangla words by hard-breaking', () => {
    const word = 'প্রিন্ট'.repeat(10);
    const lines = wrapText(word, 10);
    expect(lines.every((l) => l.length <= 10)).toBe(true);
    expect(lines.join('')).toBe(word);
  });
});

describe('splitTwoColumns', () => {
  it('puts the right column flush right on the first line', () => {
    expect(splitTwoColumns('Coffee', '12.00', 20)).toEqual(['Coffee'.padEnd(15) + '12.00']);
  });
  it('wraps the left column while the right stays put', () => {
    const lines = splitTwoColumns('Iced Caramel Macchiato Extra Shot', '6.50', 20);
    expect(lines[0]).toBe('Iced Caramel'.padEnd(16) + '6.50');
    expect(lines.slice(1)).toEqual(['Macchiato', 'Extra Shot']);
  });
  it('falls back to plain wrapping when the right column would not fit', () => {
    const lines = splitTwoColumns('Item', '1,234,567.89', 12);
    expect(lines.join(' ')).toContain('Item');
    expect(lines.every((l) => l.length <= 12)).toBe(true);
  });
});

describe('formatQty', () => {
  it('renders integers plainly', () => {
    expect(formatQty(2)).toBe('2');
    expect(formatQty(9999)).toBe('9999');
  });
  it('renders fractional quantities compactly', () => {
    expect(formatQty(0.5)).toBe('0.5');
    expect(formatQty(1.25)).toBe('1.25');
  });
});

describe('formatMinorUnits', () => {
  it('formats integer minor units with grouping', () => {
    expect(formatMinorUnits(0)).toBe('0.00');
    expect(formatMinorUnits(5)).toBe('0.05');
    expect(formatMinorUnits(1200)).toBe('12.00');
    expect(formatMinorUnits(123456789)).toBe('1,234,567.89');
  });
  it('formats negatives (discounts) with a minus sign', () => {
    expect(formatMinorUnits(-500)).toBe('-5.00');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/render-layout.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/main/render/layout.ts`**

```ts
/**
 * Pure text layout for fixed-width receipt columns. All inputs are already
 * sanitized (control chars stripped), so `length` is a safe width proxy.
 */

export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const words = text.split(' ').filter((word) => word !== '');
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let current = '';
  for (let word of words) {
    if (word.length > w) {
      if (current !== '') {
        lines.push(current);
        current = '';
      }
      while (word.length > w) {
        lines.push(word.slice(0, w));
        word = word.slice(w);
      }
      current = word;
      continue;
    }
    if (current === '') current = word;
    else if (current.length + 1 + word.length <= w) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

export function splitTwoColumns(left: string, right: string, width: number, gap = 2): string[] {
  if (right.length >= width - 1) return wrapText(`${left} ${right}`, width);
  const leftWidth = Math.max(1, width - right.length - gap);
  const leftLines = wrapText(left, leftWidth);
  const first = leftLines[0] ?? '';
  return [first.padEnd(width - right.length, ' ') + right, ...leftLines.slice(1)];
}

export function formatQty(qty: number): string {
  return Number.isInteger(qty) ? String(qty) : String(Number(qty.toFixed(3)));
}

export function formatMinorUnits(amountMinor: number): string {
  const sign = amountMinor < 0 ? '-' : '';
  const abs = Math.abs(amountMinor);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${grouped}.${frac}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/render-layout.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/render/layout.ts tests/render-layout.test.ts
git commit -m "feat(render): pure layout helpers — wrap, two-column, qty/money formatting"
```

---

### Task 5: Render profile (`profile.ts`)

**Files:**
- Create: `src/main/render/profile.ts`
- Test: `tests/render-profile.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/render-profile.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_80MM_PROFILE, renderProfileFromPrinterConfig } from '../src/main/render/profile';
import { makeProfile } from './helpers/printers';

describe('DEFAULT_80MM_PROFILE', () => {
  it('carries sensible 80mm defaults', () => {
    expect(DEFAULT_80MM_PROFILE.paperWidthMm).toBe(80);
    expect(DEFAULT_80MM_PROFILE.printableDots).toBe(576);
    expect(DEFAULT_80MM_PROFILE.charsPerLine).toBe(48);
    expect(DEFAULT_80MM_PROFILE.codepage).toBe('cp437');
    expect(DEFAULT_80MM_PROFILE.capabilities).toEqual({ cut: true, qrCode: true, barcode128: true });
    // Safe default: reject non-ASCII unless the raster fallback is explicitly enabled.
    expect(DEFAULT_80MM_PROFILE.rasterFallback.enabled).toBe(false);
  });
});

describe('renderProfileFromPrinterConfig', () => {
  it('maps a stored printer profile onto a render profile', () => {
    const p = renderProfileFromPrinterConfig(
      makeProfile({ paperWidthMm: 58, printableDots: 384, charsPerLine: 32 }),
    );
    expect(p).toEqual({
      paperWidthMm: 58,
      printableDots: 384,
      charsPerLine: 32,
      codepage: 'cp437',
      capabilities: { cut: true, qrCode: false, barcode128: false },
      rasterFallback: { enabled: false, fontPaths: [] },
    });
  });

  it('honors disabled cutting', () => {
    const p = renderProfileFromPrinterConfig(
      makeProfile({ capabilities: { cut: false, qrCode: true, barcode128: true, statusPolling: false, cashDrawer: false } }),
    );
    expect(p.capabilities.cut).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/render-profile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/main/render/profile.ts`**

```ts
import type { PrinterProfile } from '../printers/profile';

/**
 * Layout + capability inputs for the renderer. This is deliberately a
 * renderer-local view: the stored printer profile carries transport/config
 * concerns (endpoints, status polling, cash drawer) that never leak into
 * ESC/POS generation. Per-printer physical values are never derived from
 * paper width (printer-compatibility.md; spec §4).
 */
export interface RenderProfile {
  paperWidthMm: 58 | 80;
  printableDots: number;
  charsPerLine: number;
  /** v1 codepage table (ESC t). Wider codepage support is R-VAL-1. */
  codepage: 'cp437' | 'cp850';
  capabilities: { cut: boolean; qrCode: boolean; barcode128: boolean };
  /**
   * Unicode raster fallback: when enabled, non-ASCII text is rasterized and
   * emitted as GS v 0 bit images instead of failing with text_not_encodable.
   * fontPaths are bundled TTFs (see assets/fonts/, SIL OFL 1.1).
   */
  rasterFallback: { enabled: boolean; fontPaths: string[] };
}

export const DEFAULT_80MM_PROFILE: RenderProfile = {
  paperWidthMm: 80,
  printableDots: 576, // 80mm @ 203 dpi, font A
  charsPerLine: 48,
  codepage: 'cp437',
  capabilities: { cut: true, qrCode: true, barcode128: true },
  rasterFallback: { enabled: false, fontPaths: [] },
};

export function renderProfileFromPrinterConfig(p: PrinterProfile): RenderProfile {
  return {
    paperWidthMm: p.paperWidthMm,
    printableDots: p.printableDots,
    charsPerLine: p.charsPerLine,
    codepage: 'cp437',
    capabilities: {
      cut: p.capabilities.cut,
      qrCode: p.capabilities.qrCode,
      barcode128: p.capabilities.barcode128,
    },
    rasterFallback: { enabled: false, fontPaths: [] },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/render-profile.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/render/profile.ts tests/render-profile.test.ts
git commit -m "feat(render): render profile with 80mm defaults + printer-config mapping"
```

---

### Task 6: ESC/POS encoder adapter (`encoder.ts`)

This is the local adapter behind which `node-thermal-printer` lives (`docs/printer-compatibility.md` §5: "thin wrapper so we can swap/patch dialect quirks without forking"). The library is used **only** for QR, CODE128, cut, and buffer management; styles, alignment, feeds, init, and codepage are explicit bytes we control, so output is deterministic and decoder-testable.

**Files:**
- Create: `src/main/render/encoder.ts`
- Test: `tests/render-encoder.test.ts`

- [ ] **Step 1: Verify the library surface before writing code**

```bash
node -e "const m = require('node-thermal-printer'); console.log(Object.keys(m))"
```

Expected keys: `ThermalPrinter`, `Types`, `CharacterSet`, `BarcodeType` (names confirmed in Task 1). Then confirm in `node_modules/node-thermal-printer` typings/source that: the config object accepts `{ type, interface, characterSet, removeSpecialCharacters }`; methods `clear()`, `printRaw(...)`, `printText(...)`, `printQR(...)`, `printBarcode(...)`, `partialCut()`, `cut()`, `getBuffer()` exist and **no constructor/open() performs I/O** with `interface: 'buffer'`. If a name differs, adjust the imports and method calls inside this adapter only — the `EscposEncoder` interface and the tests below are the contract. (If `interface: 'buffer'` is rejected by the constructor, use `interface: 'tcp://127.0.0.1:9100'` — the adapter never calls `open()`, so no connection is ever attempted; `getBuffer()` works without one.)

- [ ] **Step 2: Write the failing tests**

Create `tests/render-encoder.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ThermalPrinterEncoder } from '../src/main/render/encoder';
import { decodeEscpos } from './helpers/escpos-decode';
import { makeRenderProfile } from './helpers/render';

describe('ThermalPrinterEncoder', () => {
  it('starts the stream with ESC @ init and the configured codepage (ESC t 0 for cp437)', () => {
    const enc = new ThermalPrinterEncoder(makeRenderProfile());
    const b = enc.bytes();
    expect(b[0]).toBe(0x1b);
    expect(b[1]).toBe(0x40);
    // ESC t n immediately after init
    expect(b[2]).toBe(0x1b);
    expect(b[3]).toBe(0x74);
    expect(b[4]).toBe(0x00);
  });

  it('emits ESC t 2 for cp850', () => {
    const enc = new ThermalPrinterEncoder(makeRenderProfile({ codepage: 'cp850' }));
    expect(enc.bytes()[4]).toBe(0x02);
  });

  it('setAlign emits ESC a n once per change', () => {
    const enc = new ThermalPrinterEncoder(makeRenderProfile());
    enc.setAlign('center');
    enc.setAlign('center'); // no duplicate
    enc.setAlign('left');
    const b = [...enc.bytes()];
    expect(b.filter((x) => x === 0x61)).toHaveLength(2); // two ESC a sequences total
  });

  it('setEmphasis emits explicit ESC E / GS ! sequences', () => {
    const enc = new ThermalPrinterEncoder(makeRenderProfile());
    enc.setEmphasis('bold');
    let b = enc.bytes();
    expect(decodeEscpos(b)).toContainEqual({ kind: 'bold', on: true });
    enc.setEmphasis('double');
    b = enc.bytes();
    expect(decodeEscpos(b)).toContainEqual({ kind: 'size', doubleWidth: true, doubleHeight: true });
    enc.setEmphasis('none');
    b = enc.bytes();
    const events = decodeEscpos(b);
    expect(events).toContainEqual({ kind: 'bold', on: false });
  });

  it('text() strips control chars as defense in depth and counts them', () => {
    const enc = new ThermalPrinterEncoder(makeRenderProfile());
    enc.text('A\x1bB');
    expect(enc.strippedCount).toBe(1);
    const events = decodeEscpos(enc.bytes());
    expect(events).toContainEqual({ kind: 'text', text: 'AB' });
  });

  it('newline and feed emit LF bytes', () => {
    const enc = new ThermalPrinterEncoder(makeRenderProfile());
    enc.newline();
    enc.feed(3);
    expect(decodeEscpos(enc.bytes()).filter((e) => e.kind === 'lf')).toHaveLength(4);
  });

  it('separator emits a dash rule plus newline', () => {
    const enc = new ThermalPrinterEncoder(makeRenderProfile({ charsPerLine: 10 }));
    enc.separator(10);
    expect(decodeEscpos(enc.bytes())).toContainEqual({ kind: 'text', text: '----------' });
  });

  it('qr() emits GS ( k with the data', () => {
    const enc = new ThermalPrinterEncoder(makeRenderProfile());
    enc.qr('XY');
    enc.qr('https://saas.example/r/ORD-1');
    const b = enc.bytes();
    expect(b).toContain(0x1d);
    expect(Buffer.from(b).toString('latin1')).toContain('https://saas.example/r/ORD-1');
    // Decoded data must be exact (guards against slice-bound drift).
    const qrData = decodeEscpos(b).filter((e) => e.kind === 'qr').map((e) => (e as { data: string }).data);
    expect(qrData).toContain('XY');
    expect(qrData.join('')).toContain('https://saas.example/r/ORD-1');
  });

  it('barcode128() emits GS k with the data', () => {
    const enc = new ThermalPrinterEncoder(makeRenderProfile());
    enc.barcode128('ABC-123');
    const b = enc.bytes();
    expect(b).toContain(0x1d);
    expect(b).toContain(0x6b);
    expect(Buffer.from(b).toString('latin1')).toContain('ABC-123');
  });

  it('cutFull and cutPartial emit GS V', () => {
    const enc = new ThermalPrinterEncoder(makeRenderProfile());
    enc.cutFull();
    expect(decodeEscpos(enc.bytes())).toContainEqual({ kind: 'cut', full: true });
    const enc2 = new ThermalPrinterEncoder(makeRenderProfile());
    enc2.cutPartial();
    expect(decodeEscpos(enc2.bytes())).toContainEqual({ kind: 'cut', full: false });
  });

  it('raster() emits a GS v 0 bit image with a correct header', () => {
    const enc = new ThermalPrinterEncoder(makeRenderProfile());
    const rowBytes = 72; // 576 dots
    enc.raster({ width: 576, height: 4, data: new Uint8Array(rowBytes * 4) });
    const b = enc.bytes();
    const idx = Buffer.from(b).indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00]));
    expect(idx).toBeGreaterThan(0);
    expect(b[idx + 4]).toBe(72); // xL
    expect(b[idx + 5]).toBe(0); // xH
    expect(b[idx + 6]).toBe(4); // yL
  });

  it('bytes() returns a copy; encoders are independent', () => {
    const a = new ThermalPrinterEncoder(makeRenderProfile());
    const c = new ThermalPrinterEncoder(makeRenderProfile());
    a.text('X');
    expect(c.bytes().byteLength).toBe(a.bytes().byteLength - 1);
    const before = a.bytes();
    before.fill(0);
    expect(a.bytes().at(-1)).toBe('X'.charCodeAt(0));
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run tests/render-encoder.test.ts`
Expected: FAIL — module not found (create the decoder helper first, next step, then re-run).

- [ ] **Step 4: Create `tests/helpers/escpos-decode.ts`** (needed by the tests; also used by the fuzz + virtual-printer tests)

```ts
/**
 * Minimal ESC/POS decoder for the subset this renderer emits. Used to make
 * semantic assertions on byte streams in tests (research: in-house decoder
 * for the emitted subset — .research/virtual-printer-research.md §4).
 *
 * Non-control bytes outside 0x20–0x7E that are not part of a recognized
 * command surface as `<0xNN>` text events — fuzz/sanitization assertions
 * rely on this.
 */
export type DecodedEvent =
  | { kind: 'init' }
  | { kind: 'align'; value: number }
  | { kind: 'bold'; on: boolean }
  | { kind: 'size'; doubleWidth: boolean; doubleHeight: boolean }
  | { kind: 'text'; text: string }
  | { kind: 'lf' }
  | { kind: 'feed'; n: number }
  | { kind: 'cut'; full: boolean }
  | { kind: 'qr'; data: string }
  | { kind: 'barcode'; data: string }
  | { kind: 'image'; dataBytes: number }
  | { kind: 'codepage'; table: number };

export function decodeEscpos(bytes: Uint8Array): DecodedEvent[] {
  const events: DecodedEvent[] = [];
  let text = '';
  const flush = () => {
    if (text !== '') {
      events.push({ kind: 'text', text });
      text = '';
    }
  };
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i] ?? -1;
    if (b === 0x1b) {
      const cmd = bytes[i + 1];
      flush();
      if (cmd === 0x40) {
        events.push({ kind: 'init' });
        i += 2;
        continue;
      }
      if (cmd === 0x61) {
        events.push({ kind: 'align', value: bytes[i + 2] ?? -1 });
        i += 3;
        continue;
      }
      if (cmd === 0x45) {
        events.push({ kind: 'bold', on: (bytes[i + 2] ?? 0) !== 0 });
        i += 3;
        continue;
      }
      if (cmd === 0x64) {
        events.push({ kind: 'feed', n: bytes[i + 2] ?? 0 });
        i += 3;
        continue;
      }
      if (cmd === 0x74) {
        events.push({ kind: 'codepage', table: bytes[i + 2] ?? -1 });
        i += 3;
        continue;
      }
      i += 2; // unknown ESC x — skip both bytes
      continue;
    }
    if (b === 0x1d) {
      const cmd = bytes[i + 1];
      flush();
      if (cmd === 0x56) {
        // GS V [0|1] (3 bytes) or GS V [65|66] (3 bytes); GS V (2 bytes) = auto-feed full cut
        const p = bytes[i + 2];
        if (p === 0 || p === 1 || p === 65 || p === 66) {
          events.push({ kind: 'cut', full: p === 0 || p === 65 });
          i += 3;
        } else {
          events.push({ kind: 'cut', full: true });
          i += 2;
        }
        continue;
      }
      if (cmd === 0x76 && bytes[i + 2] === 0x30) {
        // GS v 0 m xL xH yL yH <data>
        const rowBytes = (bytes[i + 4] ?? 0) + (bytes[i + 5] ?? 0) * 256;
        const height = (bytes[i + 6] ?? 0) + (bytes[i + 7] ?? 0) * 256;
        events.push({ kind: 'image', dataBytes: rowBytes * height });
        i += 8 + rowBytes * height;
        continue;
      }
      if (cmd === 0x28 && bytes[i + 2] === 0x6b) {
        // GS ( k — QR function segments: 1d 28 6b pL pH cn fn [m] <payload>;
        // segLen counts bytes AFTER pH (cn..last). fn 80 (store) adds an m
        // byte before the data (verified live: 1d 28 6b 05 00 31 50 30 58 59).
        const segLen = (bytes[i + 3] ?? 0) + (bytes[i + 4] ?? 0) * 256;
        const fn = bytes[i + 6];
        if (fn === 0x50) {
          events.push({
            kind: 'qr',
            data: Buffer.from(bytes.slice(i + 8, i + 5 + segLen)).toString('latin1'),
          });
        }
        i += 5 + segLen;
        continue;
      }
      if (cmd === 0x21) {
        const n = bytes[i + 2] ?? 0;
        events.push({ kind: 'size', doubleWidth: (n & 0x10) !== 0, doubleHeight: (n & 0x01) !== 0 });
        i += 3;
        continue;
      }
      i += 2;
      continue;
    }
    if (b === 0x0a) {
      flush();
      events.push({ kind: 'lf' });
      i += 1;
      continue;
    }
    if (b >= 0x20 && b <= 0x7e) {
      text += String.fromCharCode(b);
      i += 1;
      continue;
    }
    flush();
    events.push({ kind: 'text', text: `<0x${b.toString(16).padStart(2, '0')}>` });
    i += 1;
  }
  flush();
  return events;
}
```

- [ ] **Step 5: Implement `src/main/render/encoder.ts`**

```ts
import { CharacterSet, BarcodeType, ThermalPrinter, Types } from 'node-thermal-printer';
import type { Align, Emphasis } from './doc';
import { sanitizeText } from './sanitize';
import type { RasterBitmap } from './raster';
import { packMonoToGsV0 } from './raster';
import type { RenderProfile } from './profile';

/**
 * The ESC/POS boundary of the renderer (architecture.md §3.3). Everything the
 * printer-compatibility.md §2 baseline calls "conservative intersection" is
 * emitted here as explicit bytes (ESC @, ESC t, ESC a, ESC E, GS !, LF);
 * node-thermal-printer (MIT/ISC, active 2026-08) is used only where dialect
 * payload construction is genuinely fiddly: QR (GS ( k model 2), CODE128,
 * cut variants, and stream buffering. It never opens a connection:
 * interface 'buffer' + getBuffer(). Swapping/patching a dialect quirk means
 * editing this file only.
 */

/**
 * Styles as explicit command bytes (decoder-testable, deterministic). Every
 * entry sets BOTH ESC E (emphasis) and GS ! (size) so transitions never leak
 * state — e.g. double_height → bold must drop back to normal size.
 */
const EMPHASIS_BYTES: Record<Emphasis, readonly number[]> = {
  none: [0x1b, 0x45, 0x00, 0x1d, 0x21, 0x00], // ESC E 0 + GS ! 0
  bold: [0x1b, 0x45, 0x01, 0x1d, 0x21, 0x00], // ESC E 1 + GS ! 0 (normal size)
  double_height: [0x1b, 0x45, 0x00, 0x1d, 0x21, 0x01], // GS ! 1 (double height only)
  double: [0x1b, 0x45, 0x01, 0x1d, 0x21, 0x11], // ESC E 1 + GS ! 0x11 (quad)
};

const ALIGN_BYTES: Record<Align, readonly number[]> = {
  left: [0x1b, 0x61, 0x00], // ESC a 0
  center: [0x1b, 0x61, 0x01], // ESC a 1
  right: [0x1b, 0x61, 0x02], // ESC a 2
};

export interface EscposEncoder {
  setAlign(align: Align): void;
  setEmphasis(emphasis: Emphasis): void;
  /** Appends sanitized text without a newline; layout is the caller's job. */
  text(s: string): void;
  newline(): void;
  feed(lines: number): void;
  separator(width: number): void;
  qr(data: string): void;
  barcode128(data: string): void;
  raster(bitmap: RasterBitmap): void;
  cutFull(): void;
  cutPartial(): void;
  readonly bytes: () => Uint8Array;
  /** Control chars stripped inside text() (defense in depth). */
  readonly strippedCount: number;
}

export class ThermalPrinterEncoder implements EscposEncoder {
  private printer: ThermalPrinter;
  private _stripped = 0;
  private lastAlign: Align | null = null;
  private lastEmphasis: Emphasis | null = null;

  constructor(profile: RenderProfile) {
    this.printer = new ThermalPrinter({
      type: Types.EPSON,
      interface: 'buffer', // never opened — pure stream construction
      characterSet:
        profile.codepage === 'cp850' ? CharacterSet.PC850_MULTILINGUAL : CharacterSet.PC437_USA,
      removeSpecialCharacters: false,
    });
    this.printer.clear();
    // ESC @ init, then ESC t codepage table (Epson character tables: 0 = CP437, 2 = CP850).
    this.printer.printRaw(Buffer.from([0x1b, 0x40, 0x1b, 0x74, profile.codepage === 'cp850' ? 0x02 : 0x00]));
  }

  get strippedCount(): number {
    return this._stripped;
  }

  setAlign(align: Align): void {
    if (align === this.lastAlign) return;
    this.lastAlign = align;
    this.printer.printRaw(Buffer.from(ALIGN_BYTES[align]));
  }

  setEmphasis(emphasis: Emphasis): void {
    if (emphasis === this.lastEmphasis) return;
    this.lastEmphasis = emphasis;
    this.printer.printRaw(Buffer.from(EMPHASIS_BYTES[emphasis]));
  }

  text(s: string): void {
    const { text, stripped } = sanitizeText(s);
    this._stripped += stripped;
    this.printer.printText(text);
  }

  newline(): void {
    this.printer.printText('\n');
  }

  feed(lines: number): void {
    this.printer.printText('\n'.repeat(Math.max(0, lines)));
  }

  separator(width: number): void {
    this.printer.printText(`${'-'.repeat(Math.max(1, width))}\n`);
  }

  qr(data: string): void {
    this.printer.printQR(data); // GS ( k model 2 via library payload builder
  }

  barcode128(data: string): void {
    this.printer.printBarcode(data, BarcodeType.CODE128);
  }

  raster(bitmap: RasterBitmap): void {
    this.printer.printRaw(Buffer.from(packMonoToGsV0(bitmap)));
  }

  cutFull(): void {
    this.printer.cut();
  }

  cutPartial(): void {
    this.printer.partialCut();
  }

  bytes = (): Uint8Array => new Uint8Array(this.printer.getBuffer());
}
```

- [ ] **Step 6: Run tests, adjust adapter internals only if the library surface differs**

Run: `pnpm vitest run tests/render-encoder.test.ts`
Expected: PASS (12 tests). If a library export/method name differs from Task 1's verification, fix `encoder.ts` internals — do not change the interface or tests.

- [ ] **Step 7: Commit**

```bash
git add src/main/render/encoder.ts tests/render-encoder.test.ts tests/helpers/escpos-decode.ts
git commit -m "feat(render): ESC/POS encoder adapter — explicit dialect-conservative commands, thermal-printer behind it"
```

---

### Task 7: Raster fallback primitives (`raster.ts`)

Built before the render core so `context.ts` can reference the types; canvas rendering is exercised here structurally (pixel-exact assertions are environment-dependent and deliberately avoided).

**Files:**
- Create: `src/main/render/raster.ts`
- Test: `tests/render-raster.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/render-raster.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createCanvasRasterizer, packMonoToGsV0 } from '../src/main/render/raster';
import { resolve } from 'node:path';

const FONT = resolve(__dirname, '../assets/fonts/NotoSansBengali-Regular.ttf');

describe('createCanvasRasterizer', () => {
  it('loads the bundled OFL font and rasterizes ASCII', () => {
    const r = createCanvasRasterizer([FONT]);
    expect(r).not.toBeNull();
    const bmp = r!.rasterize('TOTAL 12.00', 576);
    expect(bmp.width).toBeLessThanOrEqual(576);
    expect(bmp.data.length).toBe(Math.ceil(bmp.width / 8) * bmp.height);
    expect(bmp.data.some((b) => b !== 0)).toBe(true); // non-blank
  });

  it('rasterizes Bangla text non-blank and within the dot budget', () => {
    const r = createCanvasRasterizer([FONT])!;
    const bmp = r.rasterize('প্রিন্ট এজেন্ট রসিদ', 576);
    expect(bmp.width).toBeLessThanOrEqual(576);
    expect(bmp.data.some((b) => b !== 0)).toBe(true);
  });

  it('is deterministic for identical input', () => {
    const r = createCanvasRasterizer([FONT])!;
    expect(r.rasterize('Coffee x2', 576)).toEqual(r.rasterize('Coffee x2', 576));
  });

  it('shrinks oversized text to fit the dot width', () => {
    const r = createCanvasRasterizer([FONT])!;
    const long = 'W'.repeat(96);
    const bmp = r.rasterize(long, 576);
    expect(bmp.width).toBeLessThanOrEqual(576);
    expect(bmp.data.some((b) => b !== 0)).toBe(true);
  });

  it('returns null when a font path is unusable (caller decides policy)', () => {
    expect(createCanvasRasterizer(['Z:/definitely/not/a/font.ttf'])).toBeNull();
  });
});

describe('packMonoToGsV0', () => {
  it('emits the GS v 0 header with row-bytes and height', () => {
    const buf = packMonoToGsV0({ width: 576, height: 300, data: new Uint8Array(72 * 300) });
    expect([...buf.slice(0, 8)]).toEqual([0x1d, 0x76, 0x30, 0x00, 72, 0, 300 & 0xff, 300 >> 8]);
    expect(buf.length).toBe(8 + 72 * 300);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/render-raster.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/main/render/raster.ts`**

```ts
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

/**
 * Unicode raster-text fallback (Bangla etc.). Policy: UTF-8 is never sent
 * directly to the printer (mojibake on the dominant fleet — R-VAL-1); instead
 * non-ASCII strings are rasterized with a bundled OFL font and emitted as
 * GS v 0 raster bit images. Shaping fidelity on real hardware is still
 * hardware-validation territory (R-VAL-1); this module guarantees the
 * pipeline: text → mono bitmap → GS v 0, bounded in size, deterministic
 * within an environment.
 */
export interface RasterBitmap {
  width: number;
  height: number;
  /** 1 bit per pixel, rows padded to whole bytes, MSB-first. */
  data: Uint8Array;
}

export interface TextRasterizer {
  rasterize(text: string, maxWidthDots: number, fontPx?: number): RasterBitmap;
}

const FONT_ALIAS = 'PrintAgentFallback';
const registered = new Set<string>();

export function createCanvasRasterizer(fontPaths: string[]): TextRasterizer | null {
  try {
    for (const p of fontPaths) {
      if (registered.has(p)) continue;
      GlobalFonts.registerFromPath(p, FONT_ALIAS);
      registered.add(p);
    }
    return {
      rasterize(text, maxWidthDots, fontPx = 24) {
        const lineH = Math.ceil(fontPx * 1.45);
        const canvas = createCanvas(Math.max(1, maxWidthDots), lineH);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'black';
        ctx.textBaseline = 'top';
        let size = fontPx;
        ctx.font = `${size}px "${FONT_ALIAS}"`;
        const measured = ctx.measureText(text).width;
        if (measured > maxWidthDots) {
          size = Math.max(12, Math.floor((size * maxWidthDots) / measured));
          ctx.font = `${size}px "${FONT_ALIAS}"`;
        }
        ctx.fillText(text, 0, 0);
        return bitmapFromCanvas(canvas);
      },
    };
  } catch {
    // Missing/unreadable font or canvas backend — caller decides policy
    // (render fails with text_not_encodable rather than printing mojibake).
    return null;
  }
}

function bitmapFromCanvas(canvas: ReturnType<typeof createCanvas>): RasterBitmap {
  const ctx = canvas.getContext('2d');
  const { data: rgba, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const rowBytes = Math.ceil(width / 8);
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const luminance = (rgba[idx] ?? 255) * 0.299 + ((rgba[idx + 1] ?? 255) * 0.587) + ((rgba[idx + 2] ?? 255) * 0.114);
      const alpha = rgba[idx + 3] ?? 0;
      if (alpha > 0 && luminance < 128) out[y * rowBytes + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  }
  return { width, height, data: out };
}

/** GS v 0 m xL xH yL yH <data> — raster bit image, mode 0 (normal). */
export function packMonoToGsV0(bmp: RasterBitmap): Uint8Array {
  const rowBytes = Math.ceil(bmp.width / 8);
  const header = [
    0x1d, 0x76, 0x30, 0x00,
    rowBytes & 0xff, (rowBytes >> 8) & 0xff,
    bmp.height & 0xff, (bmp.height >> 8) & 0xff,
  ];
  return Uint8Array.from([...header, ...bmp.data]);
}
```

Note: `bitmapFromCanvas` draws **black text on a white fill**, so the alpha channel is 255 everywhere; the luminance test alone decides pixels. The `alpha > 0` guard is belt-and-braces and keeps the function correct if the fill changes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/render-raster.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/render/raster.ts tests/render-raster.test.ts
git commit -m "feat(render): Unicode raster fallback — canvas to GS v 0 mono bitmap, bundled OFL font"
```

---

### Task 8: Render context + core dispatch (`context.ts`, `errors.ts`, `render.ts`)

Receipt/kitchen templates come next; this task lands the shared writers, typed errors, `renderDoc` dispatch, and the no-raster encodability failure so templates only add presentation.

**Files:**
- Create: `src/main/render/errors.ts`, `src/main/render/context.ts`, `src/main/render/render.ts`
- Create (stub): `src/main/render/render-receipt.ts`, `src/main/render/render-kitchen.ts`
- Test: `tests/render-core.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/render-core.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { renderDoc } from '../src/main/render/render';
import { decodeEscpos } from './helpers/escpos-decode';
import { makeDoc, makeRenderProfile } from './helpers/render';

describe('renderDoc dispatch + guards', () => {
  it('rejects unknown doc types', () => {
    const r = renderDoc('label_ticket', makeDoc());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('unsupported_doc_type');
  });

  it('rejects invalid docs with invalid_doc (never throws)', () => {
    const r = renderDoc('customer_receipt', { header: { restaurant_name: 'X', nope: true } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_doc');
  });

  it('rejects payloads over 32 KiB with payload_too_large', () => {
    const big = makeDoc({ lines: Array.from({ length: 150 }, (_, i) => ({ text: `Item number ${i} with a reasonably long name for size padding`.padEnd(96, 'x') })) });
    const r = renderDoc('customer_receipt', big);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('payload_too_large');
  });

  it('fails with text_not_encodable for non-ASCII when raster fallback is off', () => {
    const doc = makeDoc({ header: { ...makeDoc().header, restaurant_name: 'প্রিন্ট ক্যাফে' } });
    const r = renderDoc('customer_receipt', doc, makeRenderProfile());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('text_not_encodable');
  });

  it('renders a minimal doc deterministically', () => {
    const a = renderDoc('customer_receipt', makeDoc(), makeRenderProfile());
    const b = renderDoc('customer_receipt', makeDoc(), makeRenderProfile());
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
      expect([...a.bytes.slice(0, 2)]).toEqual([0x1b, 0x40]);
      expect(a.summary.docType).toBe('customer_receipt');
      expect(a.summary.charsPerLine).toBe(48);
      expect(a.summary.copies).toBe(1);
      expect(a.summary.byteLength).toBe(a.bytes.byteLength);
    }
  });

  it('surfaces copies from station_hints without emitting them', () => {
    const doc = makeDoc({ station_hints: { copies: 3 } });
    const r = renderDoc('customer_receipt', doc, makeRenderProfile());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.summary.copies).toBe(3);
  });

  it('never returns raw injected commands even if the payload smuggles control chars', () => {
    const doc = makeDoc({ lines: [{ text: 'x\x1b@y\x1dV0z', emphasis: 'none', align: 'left' }] });
    const r = renderDoc('customer_receipt', doc, makeRenderProfile());
    expect(r.ok).toBe(true);
    if (r.ok) {
      const events = decodeEscpos(r.bytes);
      const text = events.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text).join('|');
      expect(text).not.toContain('<0x1b>');
      expect(text).not.toContain('<0x1d>');
      // exactly one init and one cut come from the renderer itself
      expect(events.filter((e) => e.kind === 'init')).toHaveLength(1);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/render-core.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/main/render/errors.ts`**

```ts
import type { TypedError } from '../../shared/errors';

export type RenderErrorCode =
  | 'invalid_doc'
  | 'payload_too_large'
  | 'unsupported_doc_type'
  | 'text_not_encodable'
  | 'render_failed';

export class RenderError extends Error implements TypedError {
  readonly code: RenderErrorCode;
  constructor(code: RenderErrorCode, message: string, readonly detail?: string) {
    super(message);
    this.name = 'RenderError';
    this.code = code;
  }
}
```

- [ ] **Step 4: Implement `src/main/render/context.ts`**

```ts
import type { Align, DocV1, Emphasis } from './doc';
import type { EscposEncoder } from './encoder';
import { RenderError } from './errors';
import { splitTwoColumns, wrapText } from './layout';
import type { RenderProfile } from './profile';
import type { TextRasterizer } from './raster';
import { isAsciiPrintable, sanitizeText } from './sanitize';

/**
 * Diagnostic summary of a render — what the job engine logs and what the
 * support view shows. Wording never claims a physical print.
 */
export interface RenderSummary {
  docType: string;
  charsPerLine: number;
  paperWidthMm: 58 | 80;
  codepage: 'cp437' | 'cp850';
  textLines: number;
  rasterizedLines: number;
  controlCharsStripped: number;
  /** Echoed for the job engine — the renderer emits exactly one copy. */
  copies: number;
  cut: 'full' | 'partial' | 'none';
  features: { qr: boolean; barcode: boolean };
  warnings: string[];
  byteLength: number;
}

export interface RenderContext {
  enc: EscposEncoder;
  profile: RenderProfile;
  raster: TextRasterizer | null;
  summary: RenderSummary;
}

export function createContext(
  docType: string,
  doc: DocV1,
  profile: RenderProfile,
  enc: EscposEncoder,
  raster: TextRasterizer | null,
): RenderContext {
  return {
    enc,
    profile,
    raster,
    summary: {
      docType,
      charsPerLine: profile.charsPerLine,
      paperWidthMm: profile.paperWidthMm,
      codepage: profile.codepage,
      textLines: 0,
      rasterizedLines: 0,
      controlCharsStripped: 0,
      copies: doc.station_hints.copies ?? 1,
      cut: 'none',
      features: { qr: false, barcode: false },
      warnings: [],
      byteLength: 0,
    },
  };
}

/**
 * The single text sink of both templates. ASCII goes out as text; anything
 * else is rasterized when the fallback is configured, or fails rendering —
 * it is never sent as raw UTF-8 (mojibake; R-VAL-1).
 */
export function writeText(ctx: RenderContext, s: string, align: Align, emphasis: Emphasis): void {
  if (s === '') return;
  ctx.enc.setAlign(align);
  ctx.enc.setEmphasis(emphasis);
  if (isAsciiPrintable(s)) {
    ctx.enc.text(s);
    ctx.enc.newline(); // writeText owns line layout: one call = one physical line
    ctx.summary.textLines += 1;
    return;
  }
  if (ctx.raster) {
    ctx.enc.raster(ctx.raster.rasterize(s, ctx.profile.printableDots));
    ctx.enc.newline();
    ctx.summary.rasterizedLines += 1;
    return;
  }
  throw new RenderError(
    'text_not_encodable',
    `text is not printable in codepage ${ctx.profile.codepage} and the raster fallback is disabled`,
    s.slice(0, 32),
  );
}

export function writeWrapped(ctx: RenderContext, s: string, emphasis: Emphasis, align: Align = 'left'): void {
  for (const line of wrapText(s, ctx.profile.charsPerLine)) {
    writeText(ctx, line, align, emphasis);
  }
}

export function writeTwoColumns(ctx: RenderContext, left: string, right: string, emphasis: Emphasis): void {
  for (const line of splitTwoColumns(left, right, ctx.profile.charsPerLine)) {
    writeText(ctx, line, 'left', emphasis);
  }
}

export function separator(ctx: RenderContext): void {
  ctx.enc.setAlign('left');
  ctx.enc.setEmphasis('none');
  ctx.enc.separator(ctx.profile.charsPerLine);
  ctx.summary.textLines += 1;
}

/**
 * Safe-cut policy (printer-compatibility.md §2): feed first so the paper
 * clears the cutter, then cut only if the printer has a cutter and the doc
 * allows it. Partial is the default; full/none are explicit.
 */
export function applyCut(ctx: RenderContext, requested?: 'full' | 'partial' | 'none'): void {
  const want = requested ?? 'partial';
  ctx.enc.feed(3);
  if (!ctx.profile.capabilities.cut) {
    ctx.summary.cut = 'none';
    if (want !== 'none') ctx.summary.warnings.push('cut_skipped_unsupported');
    return;
  }
  ctx.summary.cut = want;
  if (want === 'full') ctx.enc.cutFull();
  else if (want === 'partial') ctx.enc.cutPartial();
}

export function writeQr(ctx: RenderContext, data: string | undefined): void {
  if (data === undefined || data === '') return;
  if (!ctx.profile.capabilities.qrCode) {
    ctx.summary.warnings.push('qr_skipped_unsupported');
    return;
  }
  const clean = sanitizeText(data).text;
  if (clean === '') {
    ctx.summary.warnings.push('qr_skipped_invalid');
    return;
  }
  ctx.enc.setAlign('center');
  ctx.enc.qr(clean);
  ctx.summary.features.qr = true;
}

export function writeBarcode(ctx: RenderContext, data: string | undefined): void {
  if (data === undefined || data === '') return;
  if (!ctx.profile.capabilities.barcode128) {
    ctx.summary.warnings.push('barcode_skipped_unsupported');
    return;
  }
  const clean = sanitizeText(data).text;
  // CODE128 payload must survive as printable ASCII.
  if (clean === '' || !isAsciiPrintable(clean)) {
    ctx.summary.warnings.push('barcode_skipped_invalid');
    return;
  }
  ctx.enc.setAlign('center');
  ctx.enc.barcode128(clean);
  ctx.summary.features.barcode = true;
}
```

- [ ] **Step 5: Create template stubs (filled by Tasks 9–10)**

`src/main/render/render-receipt.ts`:

```ts
import type { DocV1 } from './doc';
import type { RenderContext } from './context';

export function renderReceipt(doc: DocV1, ctx: RenderContext): void {
  doc; // satisfied by Task 9
  ctx;
}
```

`src/main/render/render-kitchen.ts`:

```ts
import type { DocV1 } from './doc';
import type { RenderContext } from './context';

export function renderKitchen(doc: DocV1, ctx: RenderContext): void {
  doc; // satisfied by Task 10
  ctx;
}
```

- [ ] **Step 6: Implement `src/main/render/render.ts`**

```ts
import { createContext } from './context';
import { DOC_TYPES, DocV1Schema, PAYLOAD_MAX_BYTES } from './doc';
import { ThermalPrinterEncoder } from './encoder';
import { RenderError } from './errors';
import { DEFAULT_80MM_PROFILE, type RenderProfile } from './profile';
import { createCanvasRasterizer, type TextRasterizer } from './raster';
import { renderKitchen } from './render-kitchen';
import { renderReceipt } from './render-receipt';
import type { RenderSummary } from './context';

/**
 * The renderer entry point (architecture.md §3.3): validated doc JSON →
 * ESC/POS stream + diagnostic summary. Pure: no timers, no network, no
 * ambient state; never throws (returns an error result — fuzz-asserted).
 * Raw printer bytes from any client are structurally impossible here: the
 * input is the structured doc model, and every string passes the sanitizer
 * inside the encoder (threat T2, ADR-3/ADR-11).
 */
export type RenderResult =
  | { ok: true; bytes: Uint8Array; summary: RenderSummary }
  | { ok: false; error: RenderError };

export const MAX_OUTPUT_BYTES = 256 * 1024;

export function renderDoc(
  docType: string,
  payload: unknown,
  profile: RenderProfile = DEFAULT_80MM_PROFILE,
  deps: { rasterizer?: TextRasterizer | null } = {},
): RenderResult {
  try {
    if (!(DOC_TYPES as readonly string[]).includes(docType)) {
      throw new RenderError('unsupported_doc_type', `doc_type "${docType}" is not supported`);
    }
    let json: string;
    try {
      json = JSON.stringify(payload);
    } catch {
      throw new RenderError('invalid_doc', 'payload is not JSON-serializable');
    }
    if (json === undefined || Buffer.byteLength(json, 'utf8') > PAYLOAD_MAX_BYTES) {
      throw new RenderError('payload_too_large', `payload exceeds ${PAYLOAD_MAX_BYTES} bytes`);
    }
    const parsed = DocV1Schema.safeParse(payload);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')
        .slice(0, 512);
      throw new RenderError('invalid_doc', 'payload failed doc model v1 validation', detail);
    }
    const doc = parsed.data;
    const raster = profile.rasterFallback.enabled
      ? deps.rasterizer !== undefined
        ? deps.rasterizer
        : createCanvasRasterizer(profile.rasterFallback.fontPaths)
      : null;
    const enc = new ThermalPrinterEncoder(profile);
    const ctx = createContext(docType, doc, profile, enc, raster);
    if (docType === 'customer_receipt') renderReceipt(doc, ctx);
    else renderKitchen(doc, ctx); // kitchen/bar/station share the ticket layout
    const bytes = enc.bytes();
    if (bytes.byteLength > MAX_OUTPUT_BYTES) {
      throw new RenderError('render_failed', `rendered stream of ${bytes.byteLength} bytes exceeds the safety cap`);
    }
    ctx.summary.byteLength = bytes.byteLength;
    ctx.summary.controlCharsStripped = enc.strippedCount;
    return { ok: true, bytes, summary: ctx.summary };
  } catch (e) {
    if (e instanceof RenderError) return { ok: false, error: e };
    return {
      ok: false,
      error: new RenderError('render_failed', e instanceof Error ? e.message : 'unknown render failure'),
    };
  }
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run tests/render-core.test.ts`
Expected: PASS (7 tests). (The templates are stubs, so stream content beyond init is minimal — these tests assert dispatch/guards/determinism only.)

- [ ] **Step 8: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/main/render/errors.ts src/main/render/context.ts src/main/render/render.ts src/main/render/render-receipt.ts src/main/render/render-kitchen.ts tests/render-core.test.ts
git commit -m "feat(render): renderDoc dispatch, typed errors, shared writers, encodability policy"
```

---

### Task 9: Customer receipt template (`render-receipt.ts`)

**Files:**
- Modify: `src/main/render/render-receipt.ts` (replace stub)
- Test: `tests/render-receipt.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/render-receipt.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { renderDoc } from '../src/main/render/render';
import { decodeEscpos } from './helpers/escpos-decode';
import { makeDoc, makeRenderProfile } from './helpers/render';

function texts(bytes: Uint8Array): string[] {
  return decodeEscpos(bytes).filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text);
}

describe('customer receipt template', () => {
  it('centers the header, address and tax id', () => {
    const doc = makeDoc({
      header: { restaurant_name: 'Test Cafe', address_lines: ['12 Main St'], tax_id: 'TIN-9' },
    });
    const r = renderDoc('customer_receipt', doc, makeRenderProfile());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const events = decodeEscpos(r.bytes);
    const nameIdx = events.findIndex((e) => e.kind === 'text' && (e as { text: string }).text === 'Test Cafe');
    const alignBefore = events.slice(0, nameIdx).filter((e) => e.kind === 'align').at(-1);
    expect(alignBefore).toEqual({ kind: 'align', value: 1 });
    expect(texts(r.bytes)).toContain('12 Main St');
    expect(texts(r.bytes)).toContain('Tax ID: TIN-9');
  });

  it('warns when a logo is requested but no asset store exists', () => {
    const doc = makeDoc({
      header: { restaurant_name: 'T', address_lines: [], logo_asset_id: '018f0000-0000-7000-8000-000000000009' },
    });
    const r = renderDoc('customer_receipt', doc, makeRenderProfile());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.summary.warnings).toContain('logo_skipped_no_asset_store');
  });

  it('renders the meta block with order bold and the timestamp verbatim', () => {
    const doc = makeDoc({ meta: { title: 'RECEIPT', order_ref: 'ORD-9', created_at: '2026-10-22T10:00:00.000Z', table: 'T7', server_name: 'Ana' } });
    const r = renderDoc('customer_receipt', doc, makeRenderProfile());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = texts(r.bytes).join('\n');
    expect(t).toContain('Order: ORD-9');
    expect(t).toContain('Table: T7');
    expect(t).toContain('Server: Ana');
    expect(t).toContain('2026-10-22 10:00:00.000Z');
  });

  it('puts item text and price on one physical line (two columns)', () => {
    const r = renderDoc('customer_receipt', makeDoc(), makeRenderProfile());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const line = texts(r.bytes).find((t) => t.includes('Coffee'));
    expect(line).toBeDefined();
    expect(line).toContain('2 x Coffee');
    expect(line!.endsWith('12.00')).toBe(true);
  });

  it('wraps long item names onto continuation lines', () => {
    const doc = makeDoc({ lines: [{ text: 'Iced Caramel Macchiato With Extra Shot And Oat Milk', qty: 1, unit_price: 650, emphasis: 'none', align: 'left' }] });
    const r = renderDoc('customer_receipt', doc, makeRenderProfile());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = texts(r.bytes);
    expect(t.some((x) => x.includes('Iced'))).toBe(true);
    expect(t.some((x) => x.includes('Macchiato'))).toBe(true);
    expect(t.some((x) => x.includes('6.50'))).toBe(true);
  });

  it('renders notes indented under their line', () => {
    const doc = makeDoc({ lines: [{ text: 'Coffee', qty: 1, note: 'extra hot', emphasis: 'none', align: 'left' }] });
    const r = renderDoc('customer_receipt', doc, makeRenderProfile());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(texts(r.bytes).join('\n')).toContain('extra hot');
  });

  it('renders discounts as negative amounts', () => {
    const doc = makeDoc({ totals: [
      { label: 'SUBTOTAL', amount_minor: 2400, emphasis: 'none' },
      { label: 'DISCOUNT', amount_minor: -500, emphasis: 'none' },
      { label: 'TOTAL', amount_minor: 1900, emphasis: 'bold' },
    ] });
    const r = renderDoc('customer_receipt', doc, makeRenderProfile());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = texts(r.bytes).join('\n');
    expect(t).toContain('-5.00');
    expect(t).toContain('19.00');
  });

  it('bolds totals marked bold (ESC E 1 precedes the total text)', () => {
    const r = renderDoc('customer_receipt', makeDoc(), makeRenderProfile());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const events = decodeEscpos(r.bytes);
    const totalIdx = events.findIndex((e) => e.kind === 'text' && (e as { text: string }).text.includes('TOTAL'));
    const boldBefore = events.slice(0, totalIdx).filter((e) => e.kind === 'bold').at(-1);
    expect(boldBefore).toEqual({ kind: 'bold', on: true });
  });

  it('renders payments and change', () => {
    const doc = makeDoc({ payments: [{ method: 'CASH', amount_minor: 5000, change_minor: 2600 }] });
    const r = renderDoc('customer_receipt', doc, makeRenderProfile());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = texts(r.bytes).join('\n');
    expect(t).toContain('CASH');
    expect(t).toContain('50.00');
    expect(t).toContain('Change');
    expect(t).toContain('26.00');
  });

  it('emits a QR when present and supported, with the data intact', () => {
    const doc = makeDoc({ footer: { text_lines: ['Thank you!'], qr_data: 'https://saas.example/r/ORD-1001' } });
    const r = renderDoc('customer_receipt', doc, makeRenderProfile());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const events = decodeEscpos(r.bytes);
    expect(events.filter((e) => e.kind === 'qr').map((e) => (e as { data: string }).data).join('')).toContain('https://saas.example/r/ORD-1001');
    expect(r.summary.features.qr).toBe(true);
    expect(texts(r.bytes)).toContain('Thank you!');
  });

  it('skips the QR with a warning when unsupported', () => {
    const doc = makeDoc({ footer: { text_lines: [], qr_data: 'https://x' } });
    const profile = makeRenderProfile({ capabilities: { cut: true, qrCode: false, barcode128: true } });
    const r = renderDoc('customer_receipt', doc, profile);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.summary.warnings).toContain('qr_skipped_unsupported');
      expect(r.summary.features.qr).toBe(false);
      // No GS ( k QR sequence anywhere (GS itself is expected — cuts and GS ! styles use it).
      expect(Buffer.from(r.bytes).indexOf(Buffer.from([0x1d, 0x28, 0x6b]))).toBe(-1);
    }
  });

  it('emits a CODE128 barcode when present and supported', () => {
    const doc = makeDoc({ footer: { text_lines: [], barcode_data: 'ORD-1001-X' } });
    const r = renderDoc('customer_receipt', doc, makeRenderProfile());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Buffer.from(r.bytes).toString('latin1')).toContain('ORD-1001-X');
    expect(r.summary.features.barcode).toBe(true);
  });

  it('partial-cuts by default after feeding, and honors full/none', () => {
    const partial = renderDoc('customer_receipt', makeDoc(), makeRenderProfile());
    expect(partial.ok && partial.summary.cut === 'partial').toBe(true);
    if (partial.ok) expect(decodeEscpos(partial.bytes)).toContainEqual({ kind: 'cut', full: false });

    const full = renderDoc('customer_receipt', makeDoc({ station_hints: { cut: 'full' } }), makeRenderProfile());
    if (full.ok) expect(decodeEscpos(full.bytes)).toContainEqual({ kind: 'cut', full: true });

    const none = renderDoc('customer_receipt', makeDoc({ station_hints: { cut: 'none' } }), makeRenderProfile());
    if (none.ok) {
      expect(none.summary.cut).toBe('none');
      expect(decodeEscpos(none.bytes).some((e) => e.kind === 'cut')).toBe(false);
    }

    // No cutter hardware: skip with a warning
    const noCutter = renderDoc('customer_receipt', makeDoc(), makeRenderProfile({ capabilities: { cut: false, qrCode: true, barcode128: true } }));
    if (noCutter.ok) expect(noCutter.summary.warnings).toContain('cut_skipped_unsupported');
  });

  it('feeds at least 3 lines before the cut (safe-cut)', () => {
    const r = renderDoc('customer_receipt', makeDoc(), makeRenderProfile());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const events = decodeEscpos(r.bytes);
    const cutIdx = events.findIndex((e) => e.kind === 'cut');
    const lfsBefore = events.slice(0, cutIdx).filter((e) => e.kind === 'lf').length;
    const feedsBefore = events.slice(0, cutIdx).filter((e) => e.kind === 'feed').reduce((s, f) => s + (f as { n: number }).n, 0);
    expect(lfsBefore + feedsBefore).toBeGreaterThanOrEqual(3);
  });

  it('omits missing optional values cleanly (no prices, no totals block)', () => {
    const doc = makeDoc({ lines: [{ text: 'Coffee', emphasis: 'none', align: 'left' }], totals: [], payments: [] });
    const r = renderDoc('customer_receipt', doc, makeRenderProfile());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = texts(r.bytes);
    expect(t.join('\n')).toContain('Coffee');
    // No line ENDS with a money amount (timestamps contain \d\d.\d\d mid-string).
    expect(t.some((line) => /\d+\.\d\d$/.test(line))).toBe(false);
  });

  it('maps double_height emphasis through GS !', () => {
    const doc = makeDoc({ lines: [{ text: 'HEADER ITEM', emphasis: 'double_height', align: 'left' }] });
    const r = renderDoc('customer_receipt', doc, makeRenderProfile());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const events = decodeEscpos(r.bytes);
    const idx = events.findIndex((e) => e.kind === 'text' && (e as { text: string }).text.includes('HEADER ITEM'));
    expect(events.slice(0, idx)).toContainEqual({ kind: 'size', doubleWidth: false, doubleHeight: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/render-receipt.test.ts`
Expected: FAIL — the stub emits no content.

- [ ] **Step 3: Implement the template (replace the stub)**

Replace the contents of `src/main/render/render-receipt.ts`:

```ts
import {
  applyCut,
  separator,
  writeBarcode,
  writeQr,
  writeText,
  writeTwoColumns,
  writeWrapped,
  type RenderContext,
} from './context';
import type { DocV1 } from './doc';
import { formatMinorUnits, formatQty, wrapText } from './layout';
import { sanitizeText } from './sanitize';

/**
 * Customer receipt. Presentation decisions: header centered (name double
 * height), items as qty-name/price two-column rows with wrapped names and
 * indented notes, totals with negative amounts (discounts), payments with
 * change, centered footer + QR + barcode, then safe cut. The RFC 3339
 * timestamp is rendered verbatim — the renderer never reads the clock.
 */
export function renderReceipt(doc: DocV1, ctx: RenderContext): void {
  const { enc } = ctx;

  enc.setAlign('center');
  for (const line of wrapText(sanitizeText(doc.header.restaurant_name).text, ctx.profile.charsPerLine)) {
    writeText(ctx, line, 'center', 'double_height');
  }
  for (const address of doc.header.address_lines) {
    writeText(ctx, sanitizeText(address).text, 'center', 'none');
  }
  if (doc.header.tax_id !== undefined) {
    writeText(ctx, `Tax ID: ${sanitizeText(doc.header.tax_id).text}`, 'center', 'none');
  }
  if (doc.header.logo_asset_id !== undefined) {
    ctx.summary.warnings.push('logo_skipped_no_asset_store'); // asset pipeline deferred (R-VAL-10)
  }
  separator(ctx);

  enc.setAlign('left');
  writeText(ctx, `Order: ${sanitizeText(doc.meta.order_ref).text}`, 'left', 'bold');
  if (doc.meta.table !== undefined) writeText(ctx, `Table: ${sanitizeText(doc.meta.table).text}`, 'left', 'none');
  if (doc.meta.server_name !== undefined) writeText(ctx, `Server: ${sanitizeText(doc.meta.server_name).text}`, 'left', 'none');
  writeText(ctx, doc.meta.created_at.replace('T', ' '), 'left', 'none');
  separator(ctx);

  for (const line of doc.lines) {
    const text = sanitizeText(line.text).text;
    const qty = line.qty !== undefined ? `${formatQty(line.qty)} x ` : '';
    const price = line.unit_price !== undefined ? formatMinorUnits(line.unit_price) : undefined;
    if (price !== undefined && line.align === 'left') {
      writeTwoColumns(ctx, qty + text, price, line.emphasis);
    } else {
      writeWrapped(ctx, qty + text, line.emphasis, line.align);
    }
    if (line.note !== undefined) {
      // Post-wrap indentation — wrapText splits on spaces, so a prepended
      // indent would be dropped.
      for (const noteLine of wrapText(sanitizeText(line.note).text, ctx.profile.charsPerLine - 2)) {
        writeText(ctx, `  ${noteLine}`, 'left', 'none');
      }
    }
  }

  if (doc.totals.length > 0) {
    separator(ctx);
    for (const total of doc.totals) {
      writeTwoColumns(ctx, sanitizeText(total.label).text, formatMinorUnits(total.amount_minor), total.emphasis === 'bold' ? 'bold' : 'none');
    }
  }

  if (doc.payments.length > 0) {
    separator(ctx);
    for (const payment of doc.payments) {
      writeTwoColumns(ctx, sanitizeText(payment.method).text, formatMinorUnits(payment.amount_minor), 'none');
      if (payment.change_minor !== undefined) {
        writeTwoColumns(ctx, 'Change', formatMinorUnits(payment.change_minor), 'none');
      }
    }
  }

  if (doc.footer.text_lines.length > 0) {
    separator(ctx);
    enc.setAlign('center');
    for (const footer of doc.footer.text_lines) {
      writeText(ctx, sanitizeText(footer).text, 'center', 'none');
    }
  }
  writeQr(ctx, doc.footer.qr_data);
  writeBarcode(ctx, doc.footer.barcode_data);

  applyCut(ctx, doc.station_hints.cut);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/render-receipt.test.ts`
Expected: PASS (17 tests).

- [ ] **Step 5: Run the whole suite (core tests must still pass with the real template)**

Run: `pnpm vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/render/render-receipt.ts tests/render-receipt.test.ts
git commit -m "feat(render): customer receipt template — columns, discounts, QR/barcode, safe cut"
```

---

### Task 10: Kitchen ticket template (`render-kitchen.ts`)

**Files:**
- Modify: `src/main/render/render-kitchen.ts` (replace stub)
- Test: `tests/render-kitchen.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/render-kitchen.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { renderDoc } from '../src/main/render/render';
import { decodeEscpos } from './helpers/escpos-decode';
import { makeDoc, makeRenderProfile } from './helpers/render';

function texts(bytes: Uint8Array): string[] {
  return decodeEscpos(bytes).filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text);
}

describe('kitchen ticket template', () => {
  it('renders the title double-size and the order ref double-height', () => {
    const doc = makeDoc({ meta: { title: 'KITCHEN', order_ref: 'ORD-77', created_at: '2026-10-22T10:00:00.000Z' } });
    const r = renderDoc('kitchen_ticket', doc, makeRenderProfile());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const events = decodeEscpos(r.bytes);
    const titleIdx = events.findIndex((e) => e.kind === 'text' && (e as { text: string }).text === 'KITCHEN');
    expect(events.slice(0, titleIdx)).toContainEqual({ kind: 'size', doubleWidth: true, doubleHeight: true });
    const refIdx = events.findIndex((e) => e.kind === 'text' && (e as { text: string }).text === 'ORD-77');
    expect(events.slice(0, refIdx)).toContainEqual({ kind: 'size', doubleWidth: false, doubleHeight: true });
  });

  it('shows quantities prominently and item names, but never prices', () => {
    const doc = makeDoc({
      lines: [
        { text: 'Margherita Pizza', qty: 2, unit_price: 1200, note: 'no basil', emphasis: 'none', align: 'left' },
        { text: 'Sparkling Water', qty: 9999, unit_price: 300, emphasis: 'none', align: 'left' },
      ],
    });
    const r = renderDoc('kitchen_ticket', doc, makeRenderProfile());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = texts(r.bytes).join('\n');
    expect(t).toContain('2x');
    expect(t).toContain('9999x');
    expect(t).toContain('Margherita Pizza');
    expect(t).not.toMatch(/\d+\.\d\d/); // no money on a kitchen ticket
  });

  it('renders notes in bold with a * marker', () => {
    const doc = makeDoc({ lines: [{ text: 'Coffee', qty: 1, note: 'extra hot', emphasis: 'none', align: 'left' }] });
    const r = renderDoc('kitchen_ticket', doc, makeRenderProfile());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const events = decodeEscpos(r.bytes);
    const noteIdx = events.findIndex((e) => e.kind === 'text' && (e as { text: string }).text.includes('extra hot'));
    expect(noteIdx).toBeGreaterThan(0);
    const boldBefore = events.slice(0, noteIdx).filter((e) => e.kind === 'bold').at(-1);
    expect(boldBefore).toEqual({ kind: 'bold', on: true });
  });

  it('bar/station tickets reuse the kitchen layout with the doc title', () => {
    const doc = makeDoc({ meta: { title: 'BAR', order_ref: 'ORD-5', created_at: '2026-10-22T10:00:00.000Z' }, lines: [{ text: 'Espresso', qty: 1, emphasis: 'none', align: 'left' }] });
    const r = renderDoc('bar_ticket', doc, makeRenderProfile());
    expect(r.ok).toBe(true);
    if (r.ok) expect(texts(r.bytes)).toContain('BAR');
  });

  it('skips QR/barcode with warnings and renders footer text only', () => {
    const doc = makeDoc({
      footer: { text_lines: ['Table 7'], qr_data: 'https://x', barcode_data: 'X1' },
      totals: [{ label: 'TOTAL', amount_minor: 100, emphasis: 'bold' }],
      payments: [{ method: 'CASH', amount_minor: 100 }],
    });
    const r = renderDoc('kitchen_ticket', doc, makeRenderProfile());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.warnings).toContain('qr_skipped_kitchen');
    expect(r.summary.warnings).toContain('barcode_skipped_kitchen');
    expect(r.summary.features.qr).toBe(false);
    expect(texts(r.bytes)).toContain('Table 7');
    // totals/payments are not part of a kitchen ticket
    expect(texts(r.bytes).join('\n')).not.toContain('TOTAL');
    expect(decodeEscpos(r.bytes).some((e) => e.kind === 'qr')).toBe(false);
  });

  it('partial-cuts by default', () => {
    const r = renderDoc('kitchen_ticket', makeDoc(), makeRenderProfile());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.cut).toBe('partial');
    expect(decodeEscpos(r.bytes)).toContainEqual({ kind: 'cut', full: false });
  });

  it('still honors text_not_encodable when raster is off (non-ASCII qty line)', () => {
    const doc = makeDoc({ lines: [{ text: 'প্রিন্ট', qty: 1, emphasis: 'none', align: 'left' }] });
    const r = renderDoc('kitchen_ticket', doc, makeRenderProfile());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('text_not_encodable');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/render-kitchen.test.ts`
Expected: FAIL — stub emits no content.

- [ ] **Step 3: Implement the template (replace the stub)**

Replace the contents of `src/main/render/render-kitchen.ts`:

```ts
import { applyCut, separator, writeText, type RenderContext } from './context';
import type { DocV1 } from './doc';
import { formatQty, wrapText } from './layout';
import { sanitizeText } from './sanitize';

/**
 * Kitchen/bar/station ticket. Presentation decisions: title + order ref +
 * table big and centered (rush readability), quantities as prominent `2x`
 * tokens, item names wrapped under the quantity indent, notes bold with a
 * `*` marker. Prices, totals, payments, QR and barcodes are deliberately
 * omitted from tickets (warnings recorded when the payload carries them) —
 * a kitchen ticket carries no money.
 */
export function renderKitchen(doc: DocV1, ctx: RenderContext): void {
  const { enc } = ctx;
  const width = ctx.profile.charsPerLine;

  enc.setAlign('center');
  writeText(ctx, sanitizeText(doc.meta.title).text, 'center', 'double');
  writeText(ctx, sanitizeText(doc.meta.order_ref).text, 'center', 'double_height');
  if (doc.meta.table !== undefined) {
    writeText(ctx, `Table: ${sanitizeText(doc.meta.table).text}`, 'center', 'double_height');
  }
  writeText(ctx, doc.meta.created_at.replace('T', ' '), 'center', 'none');
  separator(ctx);

  enc.setAlign('left');
  for (const line of doc.lines) {
    const text = sanitizeText(line.text).text;
    const qtyToken = line.qty !== undefined ? `${formatQty(line.qty)}x` : '';
    const indent = qtyToken === '' ? 0 : qtyToken.length + 1;
    const bodyWidth = Math.max(8, width - indent);
    if (qtyToken !== '') {
      // Quantity token: biggest readable thing on the ticket.
      enc.setEmphasis('double_height');
      enc.text(`${qtyToken} `);
    }
    const nameLines = wrapText(text, bodyWidth);
    if (nameLines.length === 1 && nameLines[0] === '') {
      enc.newline(); // empty-after-sanitize name: terminate the pending qty line
    }
    nameLines.forEach((nameLine, i) => {
      if (nameLine === '') return;
      if (i > 0) enc.text(' '.repeat(indent));
      writeText(ctx, nameLine, 'left', line.emphasis);
    });
    if (line.note !== undefined) {
      for (const noteLine of wrapText(`* ${sanitizeText(line.note).text}`, Math.max(8, width - 2))) {
        writeText(ctx, `  ${noteLine}`, 'left', 'bold');
      }
    }
  }

  if (doc.footer.text_lines.length > 0) {
    separator(ctx);
    for (const footer of doc.footer.text_lines) {
      writeText(ctx, sanitizeText(footer).text, 'center', 'none');
    }
  }
  if (doc.footer.qr_data !== undefined) ctx.summary.warnings.push('qr_skipped_kitchen');
  if (doc.footer.barcode_data !== undefined) ctx.summary.warnings.push('barcode_skipped_kitchen');

  applyCut(ctx, doc.station_hints.cut);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/render-kitchen.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/render/render-kitchen.ts tests/render-kitchen.test.ts
git commit -m "feat(render): kitchen/bar/station ticket template — prominent qty, bold notes, no money"
```

---

### Task 11: Wire the raster fallback into rendering (`render-raster` end-to-end)

**Files:**
- Modify: `tests/render-raster.test.ts` (append end-to-end cases)
- Test: `tests/render-raster.test.ts`

(The production code path already exists: `writeText` rasterizes when `profile.rasterFallback.enabled` and a rasterizer is available. This task proves the end-to-end behavior.)

- [ ] **Step 1: Append the failing tests to `tests/render-raster.test.ts`**

```ts
import { renderDoc } from '../src/main/render/render';
import { decodeEscpos } from './helpers/escpos-decode';
import { makeDoc } from './helpers/render';

describe('raster fallback end-to-end', () => {
  const rasterProfile = {
    ...makeRenderProfile(),
    rasterFallback: { enabled: true, fontPaths: [FONT] },
  };

  it('renders a Bangla receipt name as a GS v 0 image when enabled', () => {
    const doc = makeDoc({ header: { restaurant_name: 'প্রিন্ট ক্যাফে', address_lines: [] } });
    const r = renderDoc('customer_receipt', doc, rasterProfile);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.rasterizedLines).toBeGreaterThanOrEqual(1);
    const events = decodeEscpos(r.bytes);
    const images = events.filter((e) => e.kind === 'image');
    expect(images.length).toBeGreaterThanOrEqual(1);
    expect(images.every((e) => (e as { dataBytes: number }).dataBytes > 0)).toBe(true);
  });

  it('fails with text_not_encodable when enabled but the font is unusable', () => {
    const doc = makeDoc({ header: { restaurant_name: 'প্রিন্ট', address_lines: [] } });
    const badProfile = { ...makeRenderProfile(), rasterFallback: { enabled: true, fontPaths: ['Z:/nope.ttf'] } };
    const r = renderDoc('customer_receipt', doc, badProfile);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('text_not_encodable');
  });

  it('keeps mixed-language docs printable: ASCII as text, Bangla as image', () => {
    const doc = makeDoc({
      header: { restaurant_name: 'প্রিন্ট ক্যাফে', address_lines: ['12 Main St'] },
      lines: [{ text: 'Coffee', qty: 2, unit_price: 1200, emphasis: 'none', align: 'left' }],
    });
    const r = renderDoc('customer_receipt', doc, rasterProfile);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const events = decodeEscpos(r.bytes);
    expect(events.some((e) => e.kind === 'image')).toBe(true);
    expect(events.some((e) => e.kind === 'text' && (e as { text: string }).text.includes('Coffee'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass (or fail for the right reason)**

Run: `pnpm vitest run tests/render-raster.test.ts`
Expected: PASS. If the `text_not_encodable` case fails, check `createCanvasRasterizer` null-propagation in `render.ts` (`deps.rasterizer` defaults to `createCanvasRasterizer(...)` → `null` → `writeText` throws). Do not add new production code.

- [ ] **Step 3: Commit**

```bash
git add tests/render-raster.test.ts
git commit -m "test(render): end-to-end raster fallback — Bangla via GS v 0, null-font policy"
```

---

### Task 12: Fuzz corpus (`render-fuzz.test.ts`)

Mandatory for the renderer per CLAUDE.md testing rules (ADR-11: "renderer fuzzed") and runs in CI as part of `pnpm test`.

**Files:**
- Test: `tests/render-fuzz.test.ts`

- [ ] **Step 1: Write the fuzz test**

```ts
import { describe, expect, it } from 'vitest';
import { renderDoc } from '../src/main/render/render';
import { decodeEscpos } from './helpers/escpos-decode';
import { makeDoc, makeRenderProfile } from './helpers/render';

/** Deterministic PRNG (mulberry32) — a fuzz run is reproducible from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POOL = [
  'Coffee', 'প্রিন্ট', 'キッチン', '🙂🎉', '\u200b\u200e', // zero-width marks
  'a\tb', 'x\x1by\x1dz', '‮rtl‬', // bidi controls are 0x202E/0x200E — NOT C0, must pass through as text
  'A'.repeat(100), ''.padEnd(0),
];
const CONTROL_BYTES = /[\u0000-\u001F\u007F]/;

function mutate(rand: () => number, s: string): string {
  let out = s;
  const n = Math.floor(rand() * 4);
  for (let i = 0; i < n; i++) {
    const at = Math.floor(rand() * (out.length + 1));
    const pick = POOL[Math.floor(rand() * POOL.length)] ?? '';
    const piece = rand() < 0.5 ? String.fromCharCode(Math.floor(rand() * 0x20)) : pick;
    out = out.slice(0, at) + piece + out.slice(at);
  }
  return out;
}

describe('renderer fuzz corpus (deterministic seeds)', () => {
  const seeds = [1, 2, 3, 7, 42, 1337, 20_261_023];
  const rand = mulberry32(seeds.reduce((a, s) => a + s, 0));

  it('never throws, never emits injected control bytes, and bounds output size', () => {
    for (let caseNo = 0; caseNo < 400; caseNo++) {
      const doc = makeDoc({
        header: {
          restaurant_name: mutate(rand, 'Fuzz Cafe'),
          address_lines: [mutate(rand, '12 Main St'), mutate(rand, 'Floor 2')],
          ...(rand() < 0.5 ? { tax_id: mutate(rand, 'TIN-1') } : {}),
        },
        meta: {
          title: mutate(rand, 'RECEIPT'),
          order_ref: mutate(rand, 'ORD-1'),
          created_at: '2026-10-22T10:00:00.000Z',
          ...(rand() < 0.5 ? { table: mutate(rand, 'T9') } : {}),
        },
        lines: Array.from({ length: 1 + Math.floor(rand() * 5) }, () => ({
          text: mutate(rand, 'Item name'),
          ...(rand() < 0.7 ? { qty: Math.floor(rand() * 12000) } : {}),
          ...(rand() < 0.7 ? { unit_price: Math.floor(rand() * 2_000_000) - 1000 } : {}),
          ...(rand() < 0.4 ? { note: mutate(rand, 'note') } : {}),
          emphasis: 'none' as const,
          align: 'left' as const,
        })),
        footer: {
          text_lines: [mutate(rand, 'Thanks')],
          ...(rand() < 0.5 ? { qr_data: mutate(rand, 'https://x/1') } : {}),
          ...(rand() < 0.3 ? { barcode_data: mutate(rand, 'BC-1') } : {}),
        },
      });
      const profile = makeRenderProfile(
        rand() < 0.3 ? { capabilities: { cut: false, qrCode: false, barcode128: false } } : {},
      );

      const result = renderDoc('customer_receipt', doc, profile);
      if (!result.ok) {
        // Errors must be typed and finite — never a crash.
        expect(['invalid_doc', 'payload_too_large', 'text_not_encodable', 'render_failed', 'unsupported_doc_type']).toContain(result.error.code);
        continue;
      }
      expect(result.bytes.byteLength).toBeLessThanOrEqual(256 * 1024);
      // Decoded text region must contain no raw control bytes: whatever the
      // fuzzer put into strings, the sanitizer kept it out of the stream.
      for (const event of decodeEscpos(result.bytes)) {
        if (event.kind === 'text') {
          expect(event.text).not.toMatch(/<0x0[0-8]>/);
          expect(event.text).not.toMatch(/<0x1[0-8a-f]>/);
          expect(event.text).not.toContain('<0x7f>');
        }
      }
      // QR data, when rendered, is sanitized.
      for (const event of decodeEscpos(result.bytes)) {
        if (event.kind === 'qr') expect(CONTROL_BYTES.test(event.data)).toBe(false);
      }
    }
  });

  it('produces identical output for identical fuzz inputs (determinism)', () => {
    const r1 = mulberry32(99);
    const r2 = mulberry32(99);
    const doc1 = makeDoc({ lines: [{ text: mutate(r1, 'Item'), emphasis: 'none', align: 'left' }] });
    const doc2 = makeDoc({ lines: [{ text: mutate(r2, 'Item'), emphasis: 'none', align: 'left' }] });
    const a = renderDoc('customer_receipt', doc1, makeRenderProfile());
    const b = renderDoc('customer_receipt', doc2, makeRenderProfile());
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the fuzz test**

Run: `pnpm vitest run tests/render-fuzz.test.ts`
Expected: PASS. If a case emits control bytes, that is a real sanitizer/layout bug — fix the production code, never weaken the assertion.

- [ ] **Step 3: Commit**

```bash
git add tests/render-fuzz.test.ts
git commit -m "test(render): deterministic fuzz corpus — injection, oversize, unicode, bounded output"
```

---

### Task 13: Virtual printer integration (`render-virtual-printer.test.ts`)

The generated stream travels a real TCP socket (ADR-10 layer 2): an ephemeral loopback byte-sink printer (the in-house mock recommended by `.research/virtual-printer-research.md` §1) collects the bytes; the test then decodes them and asserts on the receipt semantics. Port 9100 is not used (avoids dev-machine conflicts); the app-runtime no-listen smoke is unaffected since this binds only inside the test process.

**Files:**
- Create: `tests/helpers/virtual-printer.ts`
- Test: `tests/render-virtual-printer.test.ts`

- [ ] **Step 1: Create the virtual printer helper**

`tests/helpers/virtual-printer.ts`:

```ts
import net from 'node:net';

/**
 * Test-only virtual ESC/POS printer: an ephemeral loopback TCP listener that
 * silently collects a print stream (port 9100 semantics: plain socket, no
 * protocol). Binds 127.0.0.1:0 — never shipped, never port 9100.
 */
export interface VirtualPrinter {
  port: number;
  /** Resolves with everything received once the client half-closes. */
  received: Promise<Uint8Array>;
  close(): Promise<void>;
}

export function startVirtualPrinter(): Promise<VirtualPrinter> {
  const chunks: Buffer[] = [];
  let resolve!: (bytes: Uint8Array) => void;
  const received = new Promise<Uint8Array>((res) => {
    resolve = res;
  });
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => chunks.push(chunk));
    const finish = () => resolve(Uint8Array.from(Buffer.concat(chunks)));
    socket.on('end', finish);
    socket.on('close', finish);
  });
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolveServer({
        port,
        received,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}
```

- [ ] **Step 2: Write the failing test**

`tests/render-virtual-printer.test.ts`:

```ts
import net from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { renderDoc } from '../src/main/render/render';
import { decodeEscpos } from './helpers/escpos-decode';
import { makeDoc, makeRenderProfile } from './helpers/render';
import { startVirtualPrinter, type VirtualPrinter } from './helpers/virtual-printer';

const printer: VirtualPrinter[] = [];

async function send(bytes: Uint8Array, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.write(Buffer.from(bytes), () => socket.end());
    });
    socket.on('end', () => resolve());
    socket.on('error', reject);
  });
}

afterAll(async () => {
  await Promise.all(printer.map((p) => p.close()));
});

describe('render output through a virtual ESC/POS printer (TCP)', () => {
  it('delivers a decodable customer receipt end to end', async () => {
    const vp = await startVirtualPrinter();
    printer.push(vp);

    const doc = makeDoc({
      header: { restaurant_name: 'Test Cafe', address_lines: ['12 Main St'] },
      totals: [{ label: 'TOTAL', amount_minor: 2400, emphasis: 'bold' }],
      footer: { text_lines: ['Thank you!'], qr_data: 'https://saas.example/r/ORD-1001' },
    });
    const rendered = renderDoc('customer_receipt', doc, makeRenderProfile());
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;

    await send(rendered.bytes, vp.port);
    const received = await vp.received;

    // Byte-for-byte survival across the socket.
    expect(Buffer.from(received).equals(Buffer.from(rendered.bytes))).toBe(true);

    // Semantic assertions on the decoded stream.
    const events = decodeEscpos(received);
    expect(events[0]).toEqual({ kind: 'init' });
    const text = events.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text).join('\n');
    expect(text).toContain('Test Cafe');
    expect(text).toContain('2 x Coffee');
    expect(text).toContain('TOTAL');
    expect(text).toContain('24.00');
    expect(text).toContain('Thank you!');
    expect(events.filter((e) => e.kind === 'qr').map((e) => (e as { data: string }).data).join('')).toContain('https://saas.example/r/ORD-1001');
    expect(events.some((e) => e.kind === 'cut')).toBe(true);
    // No control bytes leaked into text positions anywhere on the wire.
    for (const event of events) {
      if (event.kind === 'text') {
        expect(event.text).not.toMatch(/<0x0[0-8]>/);
        expect(event.text).not.toMatch(/<0x1[0-8a-f]>/);
      }
    }
  });

  it('delivers a kitchen ticket end to end', async () => {
    const vp = await startVirtualPrinter();
    printer.push(vp);
    const doc = makeDoc({ meta: { title: 'KITCHEN', order_ref: 'ORD-77', created_at: '2026-10-22T10:00:00.000Z' } });
    const rendered = renderDoc('kitchen_ticket', doc, makeRenderProfile());
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    await send(rendered.bytes, vp.port);
    const events = decodeEscpos(await vp.received);
    const text = events.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text).join('\n');
    expect(text).toContain('KITCHEN');
    expect(text).toContain('ORD-77');
    expect(events.at(-1)?.kind === 'cut' || events.some((e) => e.kind === 'cut')).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test**

Run: `pnpm vitest run tests/render-virtual-printer.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 4: Commit**

```bash
git add tests/helpers/virtual-printer.ts tests/render-virtual-printer.test.ts
git commit -m "test(render): end-to-end receipt through virtual TCP ESC/POS printer"
```

---

### Task 14: Documentation + full gate

**Files:**
- Create: `docs/render-pipeline.md`
- Modify: `docs/architecture.md` (§3.3 pointer)
- Modify: `CLAUDE.md`? No — docs only where behavior/contracts changed.

- [ ] **Step 1: Write `docs/render-pipeline.md`**

```markdown
# Rendering Pipeline — Doc Model v1 → ESC/POS

**Status:** Implemented (2026-10-23) · Normative refs: `api-contract.md` §2/§4 (doc model),
`architecture.md` §3.3/§5, `printer-compatibility.md` §2/§4/§5, `threat-model.md` T2.

## Module map (`src/main/render/`)

| File | Role |
| --- | --- |
| `doc.ts` | Doc model v1, strict zod, UTF-8 **byte** caps (contract "hard limits") |
| `sanitize.ts` | Strips 0x00–0x1F + 0x7F from every string (threat T2; injection-proof by construction) |
| `layout.ts` | Greedy wrap, two-column rows, qty/money formatting (integer minor units) |
| `profile.ts` | `RenderProfile`; 80mm defaults (576 dots / 48 cols / cp437); mapping from printer config |
| `encoder.ts` | `EscposEncoder`; explicit ESC @ / ESC t / ESC a / ESC E / GS ! / LF; node-thermal-printer only for QR (GS ( k), CODE128, cut, buffering; never a connection (`interface: 'buffer'`) |
| `raster.ts` | Unicode fallback: canvas → 1-bpp bitmap → GS v 0 |
| `context.ts` | Shared writers (text/wrap/columns/separator/cut/QR/barcode) + `RenderSummary` |
| `render-receipt.ts` | Customer receipt template |
| `render-kitchen.ts` | Kitchen/bar/station ticket template (no money by design) |
| `render.ts` | `renderDoc(docType, payload, profile) → { ok, bytes, summary }`; never throws |

## Encodability policy (normative)

- All text must be printable ASCII (`0x20–0x7E`) after sanitization, **or**
- the profile must have `rasterFallback.enabled` with bundled font paths, in
  which case non-ASCII strings render as `GS v 0` raster rows; **or**
- rendering fails with `text_not_encodable`.
Raw UTF-8 is **never** sent as text (fleet codepage behavior is unreliable —
R-VAL-1; mojibake is worse than a failed render). QR data may be any
sanitized bytes ≤ 512 B (QR is byte-native); CODE128 data must be printable ASCII.

## Raster fallback

- `@napi-rs/canvas` (MIT, prebuilt N-API) renders text with the bundled
  **Noto Sans Bengali** (`assets/fonts/`, SIL OFL 1.1 — redistribution and
  commercial bundling permitted; license file shipped alongside; source URL +
  pin date recorded in `.research/dependency-research.md`).
- Oversized strings shrink to fit `printableDots` (floor 12 px), so no line
  can widen the stream unboundedly; output is capped at 256 KiB total.
- Bangla complex-script shaping through Skia is correct for common text but
  is **hardware-validated separately** (R-VAL-1 exit criteria).

## Responsibility split

- The renderer emits **exactly one copy**; `summary.copies` (from
  `station_hints`) tells the job engine how many transport writes to make
  (state machine §5 counts attempts per write).
- The renderer **never reads the clock** — timestamps come verbatim from the
  doc (deterministic output; unit-testable).
- `completed`/`sent_to_printer` semantics live in the job engine; nothing in
  this module claims a physical print.

## Diagnostic summary (`RenderSummary`)

`docType`, `charsPerLine`, `paperWidthMm`, `codepage`, `textLines`,
`rasterizedLines`, `controlCharsStripped`, `copies`, `cut`
(full/partial/none), `features.qr/barcode`, `warnings[]`
(`logo_skipped_no_asset_store`, `qr_skipped_unsupported`,
`qr_skipped_invalid`, `qr_skipped_kitchen`, `barcode_skipped_unsupported`,
`barcode_skipped_invalid`, `barcode_skipped_kitchen`,
`cut_skipped_unsupported`), `byteLength`.

## Testing (ADR-10 layers)

1. **Unit** — byte + decoded-stream assertions on every template/feature
   (`tests/render-*.test.ts`), in-house ESC/POS subset decoder
   (`tests/helpers/escpos-decode.ts`).
2. **Fuzz (CI)** — deterministic seeded corpus (injection, oversize, mixed
   scripts): never throws, never emits injected control bytes, output bounded
   (`tests/render-fuzz.test.ts`).
3. **Integration (CI)** — rendered streams travel a real TCP socket to the
   in-house virtual printer and are decoded for semantic assertions
   (`tests/render-virtual-printer.test.ts`). `escpos-emulator` (TCP :9100 +
   REST) can be layered on in CI later; the in-house mock keeps `pnpm test`
   hermetic.
4. **Hardware (pending phase)** — R-VAL-1 codepage/raster fidelity, R-VAL-2
   cut variants, R-VAL-10 logo pipeline.
```

- [ ] **Step 2: Add the pointer in `docs/architecture.md` §3.3**

Append to the end of the `### 3.3 \`renderer\`` section:

```markdown
Implementation: `src/main/render/` — see `docs/render-pipeline.md` (module map,
encodability policy, raster fallback design, diagnostic summary contract).
```

- [ ] **Step 3: Full gate**

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm format:check && pnpm no-listen
```

Expected: all green. If prettier reformats, run `pnpm format` and re-run the gate.

- [ ] **Step 4: Commit**

```bash
git add docs/render-pipeline.md docs/architecture.md
git commit -m "docs: render pipeline — module map, encodability policy, raster fallback, testing layers"
```

---

## Self-review notes

- **Spec coverage:** templates (Tasks 9–10), capabilities + 80mm profiles (Task 5), wrapping/columns/qty/modifiers/notes (Tasks 4, 9, 10), bold/align/feed/QR/barcode/cut (Tasks 6, 8, 9, 10), configurable profile with defaults (Task 5), result with bytes + diagnostic summary (Task 8), library selection + license + local adapter (Tasks 1, 6), sanitization + size limits (Tasks 2, 3, 8, 12), raster fallback plan + bundled licensed font + raster tests (Tasks 7, 11), deterministic tests for all named cases incl. safe-cut (Tasks 9–13), virtual-printer run (Task 13), templates independent from UI/cloud (module map).
- **Type consistency:** `EscposEncoder` consumed by `context.ts` writers; `RenderContext` built by `createContext` in Task 8 and consumed by both templates; `RasterBitmap` defined in Task 7 before use in Tasks 6/8; decoder event names (`init/align/bold/size/text/lf/feed/cut/qr/barcode/image/codepage`) used identically across Tasks 6, 9–13.
- **Known intentional simplifications** (documented, not gaps): kitchen quantity token is not re-counted in `summary.textLines`; raster lines render as single shrunk rows rather than pixel-wrapped paragraphs (design note in `docs/render-pipeline.md`); logo assets deferred with an explicit warning.
