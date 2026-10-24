import { describe, expect, it } from 'vitest';
import { renderDoc } from '../src/main/render/render';
import { decodeEscpos } from './helpers/escpos-decode';
import { makeDoc, makeRenderProfile } from './helpers/render';

function texts(bytes: Uint8Array): string[] {
  return decodeEscpos(bytes)
    .filter((e) => e.kind === 'text')
    .map((e) => (e as { text: string }).text);
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
    const nameIdx = events.findIndex(
      (e) => e.kind === 'text' && (e as { text: string }).text === 'Test Cafe',
    );
    const alignBefore = events
      .slice(0, nameIdx)
      .filter((e) => e.kind === 'align')
      .at(-1);
    expect(alignBefore).toEqual({ kind: 'align', value: 1 });
    expect(texts(r.bytes)).toContain('12 Main St');
    expect(texts(r.bytes)).toContain('Tax ID: TIN-9');
  });

  it('warns when a logo is requested but no asset store exists', () => {
    const doc = makeDoc({
      header: {
        restaurant_name: 'T',
        address_lines: [],
        logo_asset_id: '018f0000-0000-7000-8000-000000000009',
      },
    });
    const r = renderDoc('customer_receipt', doc, makeRenderProfile());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.summary.warnings).toContain('logo_skipped_no_asset_store');
  });

  it('renders the meta block with order bold and the timestamp verbatim', () => {
    const doc = makeDoc({
      meta: {
        title: 'RECEIPT',
        order_ref: 'ORD-9',
        created_at: '2026-10-22T10:00:00.000Z',
        table: 'T7',
        server_name: 'Ana',
      },
    });
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
    if (line === undefined) throw new Error('expected a Coffee line');
    expect(line).toContain('2 x Coffee');
    expect(line.endsWith('12.00')).toBe(true);
  });

  it('wraps long item names onto continuation lines', () => {
    const doc = makeDoc({
      lines: [
        {
          text: 'Iced Caramel Macchiato With Extra Shot And Oat Milk',
          qty: 1,
          unit_price: 650,
          emphasis: 'none',
          align: 'left',
        },
      ],
    });
    const r = renderDoc('customer_receipt', doc, makeRenderProfile());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = texts(r.bytes);
    expect(t.some((x) => x.includes('Iced'))).toBe(true);
    expect(t.some((x) => x.includes('Macchiato'))).toBe(true);
    expect(t.some((x) => x.includes('6.50'))).toBe(true);
  });

  it('renders notes indented two spaces under their line', () => {
    const doc = makeDoc({
      lines: [{ text: 'Coffee', qty: 1, note: 'extra hot', emphasis: 'none', align: 'left' }],
    });
    const r = renderDoc('customer_receipt', doc, makeRenderProfile());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(texts(r.bytes)).toContain('  extra hot');
  });

  it('renders discounts as negative amounts', () => {
    const doc = makeDoc({
      totals: [
        { label: 'SUBTOTAL', amount_minor: 2400, emphasis: 'none' },
        { label: 'DISCOUNT', amount_minor: -500, emphasis: 'none' },
        { label: 'TOTAL', amount_minor: 1900, emphasis: 'bold' },
      ],
    });
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
    const totalIdx = events.findIndex(
      (e) => e.kind === 'text' && (e as { text: string }).text.includes('TOTAL'),
    );
    const boldBefore = events
      .slice(0, totalIdx)
      .filter((e) => e.kind === 'bold')
      .at(-1);
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
    const doc = makeDoc({
      footer: { text_lines: ['Thank you!'], qr_data: 'https://saas.example/r/ORD-1001' },
    });
    const r = renderDoc('customer_receipt', doc, makeRenderProfile());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const events = decodeEscpos(r.bytes);
    expect(
      events
        .filter((e) => e.kind === 'qr')
        .map((e) => (e as { data: string }).data)
        .join(''),
    ).toContain('https://saas.example/r/ORD-1001');
    expect(r.summary.features.qr).toBe(true);
    expect(texts(r.bytes)).toContain('Thank you!');
  });

  it('skips the QR with a warning when unsupported', () => {
    const doc = makeDoc({ footer: { text_lines: [], qr_data: 'https://x' } });
    const profile = makeRenderProfile({
      capabilities: { cut: true, qrCode: false, barcode128: true },
    });
    const r = renderDoc('customer_receipt', doc, profile);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.summary.warnings).toContain('qr_skipped_unsupported');
      expect(r.summary.features.qr).toBe(false);
      // No GS ( k (QR) sequence emitted; other GS commands (GS ! emphasis,
      // GS V cut) are part of the normal baseline stream.
      expect(Buffer.from(r.bytes).indexOf(Buffer.from([0x1d, 0x28, 0x6b]))).toBe(-1);
    }
  });

  it('skips non-ASCII QR data with a warning (library GS ( k length is UTF-16-based)', () => {
    const doc = makeDoc({ footer: { text_lines: [], qr_data: 'প্রিন্ট-পে-' + 'x'.repeat(40) } });
    const r = renderDoc('customer_receipt', doc, makeRenderProfile());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.summary.warnings).toContain('qr_skipped_invalid');
      expect(r.summary.features.qr).toBe(false);
      expect(Buffer.from(r.bytes).indexOf(Buffer.from([0x1d, 0x28, 0x6b]))).toBe(-1);
    }
  });

  it('round-trips ASCII QR data intact through the decoder', () => {
    const url = 'https://saas.example/r/ORD-1001?src=receipt';
    const doc = makeDoc({ footer: { text_lines: [], qr_data: url } });
    const r = renderDoc('customer_receipt', doc, makeRenderProfile());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const qrData = decodeEscpos(r.bytes)
      .filter((e) => e.kind === 'qr')
      .map((e) => (e as { data: string }).data)
      .join('');
    expect(qrData).toBe(url);
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
    if (partial.ok)
      expect(decodeEscpos(partial.bytes)).toContainEqual({ kind: 'cut', full: false });

    const full = renderDoc(
      'customer_receipt',
      makeDoc({ station_hints: { cut: 'full' } }),
      makeRenderProfile(),
    );
    if (full.ok) expect(decodeEscpos(full.bytes)).toContainEqual({ kind: 'cut', full: true });

    const none = renderDoc(
      'customer_receipt',
      makeDoc({ station_hints: { cut: 'none' } }),
      makeRenderProfile(),
    );
    if (none.ok) {
      expect(none.summary.cut).toBe('none');
      expect(decodeEscpos(none.bytes).some((e) => e.kind === 'cut')).toBe(false);
    }

    // No cutter hardware: skip with a warning
    const noCutter = renderDoc(
      'customer_receipt',
      makeDoc(),
      makeRenderProfile({ capabilities: { cut: false, qrCode: true, barcode128: true } }),
    );
    if (noCutter.ok) expect(noCutter.summary.warnings).toContain('cut_skipped_unsupported');
  });

  it('feeds at least 3 lines before the cut (safe-cut)', () => {
    const r = renderDoc('customer_receipt', makeDoc(), makeRenderProfile());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const events = decodeEscpos(r.bytes);
    const cutIdx = events.findIndex((e) => e.kind === 'cut');
    const lfsBefore = events.slice(0, cutIdx).filter((e) => e.kind === 'lf').length;
    const feedsBefore = events
      .slice(0, cutIdx)
      .filter((e) => e.kind === 'feed')
      .reduce((s, f) => s + (f as { n: number }).n, 0);
    expect(lfsBefore + feedsBefore).toBeGreaterThanOrEqual(3);
  });

  it('omits missing optional values cleanly (no prices, no totals block)', () => {
    const doc = makeDoc({
      lines: [{ text: 'Coffee', emphasis: 'none', align: 'left' }],
      totals: [],
      payments: [],
    });
    const r = renderDoc('customer_receipt', doc, makeRenderProfile());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = texts(r.bytes).join('\n');
    expect(t).toContain('Coffee');
    // No money anywhere: amounts always appear as the trailing token of a
    // line. (A bare /\d+\.\d\d/ scan would false-positive on the mandated
    // RFC 3339 timestamp — e.g. "10:00:00.000Z".)
    expect(t.split('\n').some((l) => /\d+\.\d\d$/.test(l))).toBe(false);
  });

  it('maps double_height emphasis through GS !', () => {
    const doc = makeDoc({
      lines: [{ text: 'HEADER ITEM', emphasis: 'double_height', align: 'left' }],
    });
    const r = renderDoc('customer_receipt', doc, makeRenderProfile());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const events = decodeEscpos(r.bytes);
    const idx = events.findIndex(
      (e) => e.kind === 'text' && (e as { text: string }).text.includes('HEADER ITEM'),
    );
    expect(events.slice(0, idx)).toContainEqual({
      kind: 'size',
      doubleWidth: false,
      doubleHeight: true,
    });
  });
});
