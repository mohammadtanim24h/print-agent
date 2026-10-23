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
    // Text padded past the 96-byte schema limit on purpose: the size guard
    // must fire BEFORE zod validation, so the oversized raw payload reaches
    // payload_too_large, not invalid_doc. (96-char lines serialize to only
    // ~16 KiB total — arithmetically under the cap.)
    const big = makeDoc({ lines: Array.from({ length: 150 }, (_, i) => ({ text: `Item number ${String(i)} with a reasonably long name for size padding`.padEnd(320, 'x') })) });
    const r = renderDoc('customer_receipt', big);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('payload_too_large');
  });

  it('fails with text_not_encodable for non-ASCII when raster fallback is off', () => {
    const doc = makeDoc({ header: { restaurant_name: 'প্রিন্ট ক্যাফে', address_lines: [] } });
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

  it('classifies a toJSON-undefined payload as payload_too_large, never leaking internals', () => {
    const evil = { toJSON: () => undefined };
    const r = renderDoc('customer_receipt', evil);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('payload_too_large');
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
      // exactly one init comes from the renderer itself
      expect(events.filter((e) => e.kind === 'init')).toHaveLength(1);
    }
  });
});
