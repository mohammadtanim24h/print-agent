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
    // No line ends with a money amount (timestamps contain \d\d.\d\d mid-string).
    expect(texts(r.bytes).some((line) => /\d+\.\d\d$/.test(line))).toBe(false);
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
