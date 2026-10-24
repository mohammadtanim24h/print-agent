import { describe, expect, it } from 'vitest';
import { MAX_OUTPUT_BYTES, renderDoc } from '../src/main/render/render';
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
  'Coffee',
  'প্রিন্ট',
  'キッチン',
  '🙂🎉',
  '\u200b\u200e', // zero-width marks
  'a\tb',
  'x\x1by\x1dz',
  '‮rtl‬', // bidi controls are 0x202E/0x200E — NOT C0, must pass through as text
  'A'.repeat(100),
];

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

const VALID_ERROR_CODES = [
  'invalid_doc',
  'payload_too_large',
  'text_not_encodable',
  'render_failed',
  'unsupported_doc_type',
] as const;

describe('renderer fuzz corpus (deterministic seeds)', () => {
  const rand = mulberry32(42_042);

  it('never throws, never emits injected control bytes, and bounds output size', () => {
    // Per-case doc + profile construction, shared by both dispatch passes so
    // the kitchen pass fuzzes the same kinds of mutated inputs as the receipt
    // pass (both loops run against the one seeded PRNG).
    const buildCase = () => {
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
      return { doc, profile };
    };

    for (let caseNo = 0; caseNo < 400; caseNo++) {
      // Vitest's second expect argument labels any failure with the fuzz case
      // number so a red run can be replayed from the seed.
      const where = `fuzz case ${String(caseNo)} (seed 42042)`;
      const { doc, profile } = buildCase();
      const result = renderDoc('customer_receipt', doc, profile);
      if (!result.ok) {
        // Errors must be typed and finite — never a crash.
        expect(VALID_ERROR_CODES, where).toContain(result.error.code);
        continue;
      }
      expect(result.bytes.byteLength, where).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
      // Decoded stream must contain no raw C0/DEL bytes: whatever the fuzzer
      // put into strings, the sanitizer kept it out of the stream. (0x0a is
      // the one intentional exception and decodes as an `lf` event, so any
      // `<0xNN>` text event at all is a sanitizer escape.)
      for (const event of decodeEscpos(result.bytes)) {
        if (event.kind === 'text') {
          expect(event.text, where).not.toMatch(/<0x(0[0-9a-f]|1[0-9a-f]|7f)>/);
        }
        if (event.kind === 'qr') {
          expect(/[\u0000-\u001F\u007F]/.test(event.data), where).toBe(false);
        }
        if (event.kind === 'barcode') {
          expect(/[\u0000-\u001F\u007F]/.test(event.data), where).toBe(false);
        }
      }
    }

    // Second pass over the same generator, dispatched as kitchen_ticket — the
    // receipt loop alone never exercised the shared ticket template.
    for (let caseNo = 0; caseNo < 120; caseNo++) {
      const where = `kitchen fuzz case ${String(caseNo)} (seed 42042)`;
      const { doc, profile } = buildCase();
      const result = renderDoc('kitchen_ticket', doc, profile);
      if (!result.ok) {
        expect(VALID_ERROR_CODES, where).toContain(result.error.code);
        continue;
      }
      expect(result.bytes.byteLength, where).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
      for (const event of decodeEscpos(result.bytes)) {
        if (event.kind === 'text') {
          expect(event.text, where).not.toMatch(/<0x(0[0-9a-f]|1[0-9a-f]|7f)>/);
        }
      }
    }
  });

  it('produces identical output for identical fuzz inputs (determinism)', () => {
    const r1 = mulberry32(99);
    const r2 = mulberry32(99);
    const doc1 = makeDoc({
      lines: [{ text: mutate(r1, 'Item'), emphasis: 'none', align: 'left' }],
    });
    const doc2 = makeDoc({
      lines: [{ text: mutate(r2, 'Item'), emphasis: 'none', align: 'left' }],
    });
    const a = renderDoc('customer_receipt', doc1, makeRenderProfile());
    const b = renderDoc('customer_receipt', doc2, makeRenderProfile());
    // Determinism = same input → same result. The mutated text may legitimately
    // be non-ASCII (→ text_not_encodable with raster fallback disabled), so the
    // result is compared in full rather than requiring ok:true.
    expect(a.ok).toBe(b.ok);
    if (a.ok && b.ok) expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    if (!a.ok && !b.ok) {
      expect(a.error.code).toBe(b.error.code);
      expect(a.error.message).toBe(b.error.message);
    }
  });

  it('classifies non-serializable payloads as invalid_doc (never throws)', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const withThrowingGetter: Record<string, unknown> = {};
    Object.defineProperty(withThrowingGetter, 'boom', {
      enumerable: true,
      get() {
        throw new Error('getter exploded');
      },
    });
    for (const evil of [10n, BigInt(1), circular, withThrowingGetter, Symbol('x') as unknown]) {
      const r = renderDoc('customer_receipt', evil);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(['invalid_doc', 'payload_too_large']).toContain(r.error.code);
        // no Node internals like "The \"string\" argument..." leaked
        expect(r.error.message).not.toMatch(/argument must be of type/);
      }
    }
  });
});
