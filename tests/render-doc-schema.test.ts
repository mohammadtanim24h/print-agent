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
    const doc = makeDoc({
      header: { restaurant_name: 'X', address_lines: [], sneaky: 1 } as never,
    });
    expect(DocV1Schema.safeParse(doc).success).toBe(false);
  });

  it('accepts header.phone present or absent, capping at 24 UTF-8 bytes', () => {
    // Absent (server strips nulls — never an explicit null on the wire).
    expect(DocV1Schema.safeParse(makeDoc()).success).toBe(true);
    // Present.
    const withPhone = makeDoc({
      header: { restaurant_name: 'Test Cafe', address_lines: [], phone: '+8801712345678' },
    });
    expect(DocV1Schema.safeParse(withPhone).success).toBe(true);
    // 24 ASCII bytes is the cap.
    const atCap = makeDoc({
      header: { restaurant_name: 'T', address_lines: [], phone: 'a'.repeat(24) },
    });
    expect(DocV1Schema.safeParse(atCap).success).toBe(true);
    // 25 bytes is over the cap.
    const overCap = makeDoc({
      header: { restaurant_name: 'T', address_lines: [], phone: 'a'.repeat(25) },
    });
    expect(DocV1Schema.safeParse(overCap).success).toBe(false);
    // Byte cap, not char cap: 12 Bengali chars = 36 UTF-8 bytes.
    const bangla = makeDoc({
      header: { restaurant_name: 'T', address_lines: [], phone: 'ফোন'.repeat(12) },
    });
    expect(DocV1Schema.safeParse(bangla).success).toBe(false);
    // Non-string phone.
    const nonString = makeDoc({
      header: { restaurant_name: 'T', address_lines: [], phone: 123 } as never,
    });
    expect(DocV1Schema.safeParse(nonString).success).toBe(false);
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
    expect(
      DocV1Schema.safeParse(makeDoc({ lines: [{ text: 'a', unit_price: 10.5 }] })).success,
    ).toBe(false);
    expect(DocV1Schema.safeParse(makeDoc({ lines: [{ text: 'a', qty: -1 }] })).success).toBe(false);
    expect(DocV1Schema.safeParse(makeDoc({ lines: [{ text: 'a', qty: 9999 }] })).success).toBe(
      true,
    );
  });

  it('rejects invalid emphasis/align and bad created_at', () => {
    expect(
      DocV1Schema.safeParse(makeDoc({ lines: [{ text: 'a', emphasis: 'italic' as never }] }))
        .success,
    ).toBe(false);
    const bad = makeDoc();
    bad.meta.created_at = 'not-a-date';
    expect(DocV1Schema.safeParse(bad).success).toBe(false);
  });

  it('accepts negative amounts (discounts) and station_hints bounds', () => {
    const doc = makeDoc({
      totals: [{ label: 'DISCOUNT', amount_minor: -500, emphasis: 'none' }],
      station_hints: { copies: 4, cut: 'partial' },
    });
    expect(DocV1Schema.safeParse(doc).success).toBe(true);
    const bad = makeDoc({ station_hints: { copies: 5 } });
    expect(DocV1Schema.safeParse(bad).success).toBe(false);
  });

  it('accepts totals currency up to 8 UTF-8 bytes and rejects over-cap/unknown keys', () => {
    // Omitted (server strips nulls — never an explicit null on the wire).
    expect(DocV1Schema.safeParse(makeDoc()).success).toBe(true);
    // At the cap: 8 ASCII bytes.
    const atCap = makeDoc({
      totals: [{ label: 'TOTAL', amount_minor: 1, currency: 'ABCDEFGH', emphasis: 'bold' }],
    });
    expect(DocV1Schema.safeParse(atCap).success).toBe(true);
    // 9 bytes is over the cap.
    const overCap = makeDoc({
      totals: [{ label: 'TOTAL', amount_minor: 1, currency: 'ABCDEFGHI', emphasis: 'bold' }],
    });
    expect(DocV1Schema.safeParse(overCap).success).toBe(false);
    // Byte cap, not char cap: 3 Bengali chars = 9 UTF-8 bytes.
    const bangla = makeDoc({
      totals: [{ label: 'TOTAL', amount_minor: 1, currency: 'টাকা', emphasis: 'bold' }],
    });
    expect(DocV1Schema.safeParse(bangla).success).toBe(false);
    // Unknown sibling key still rejected (strict).
    const unknown = makeDoc({
      totals: [{ label: 'TOTAL', amount_minor: 1, emphasis: 'bold', symbol: '$' } as never],
    });
    expect(DocV1Schema.safeParse(unknown).success).toBe(false);
  });

  it('enforces the 2026-11-25 cap raises: order_time 64, totals label 64, footer 96 bytes', () => {
    // order_time: 45-byte Bangla server format is accepted; 65 bytes rejected.
    const bnTime = '07 মার্চ 2026, 3:45 দুপুর';
    expect(Buffer.byteLength(bnTime, 'utf8')).toBe(45);
    expect(
      DocV1Schema.safeParse(makeDoc({ meta: { ...makeDoc().meta, order_time: bnTime } })).success,
    ).toBe(true);
    expect(
      DocV1Schema.safeParse(
        makeDoc({ meta: { ...makeDoc().meta, order_time: 'x'.repeat(65) } }),
      ).success,
    ).toBe(false);
    // totals label: ~50-byte Bangla VAT-included label accepted; 65 rejected.
    const bnLabel = 'ভ্যাট সহ সর্বমোট';
    expect(Buffer.byteLength(bnLabel, 'utf8')).toBeLessThanOrEqual(64);
    expect(
      DocV1Schema.safeParse(makeDoc({ totals: [{ label: bnLabel, amount_minor: 1 }] })).success,
    ).toBe(true);
    expect(
      DocV1Schema.safeParse(makeDoc({ totals: [{ label: 'x'.repeat(65), amount_minor: 1 }] }))
        .success,
    ).toBe(false);
    // footer.text_lines: 96 bytes accepted, 97 rejected.
    expect(
      DocV1Schema.safeParse(makeDoc({ footer: { text_lines: ['x'.repeat(96)] } })).success,
    ).toBe(true);
    expect(
      DocV1Schema.safeParse(makeDoc({ footer: { text_lines: ['x'.repeat(97)] } })).success,
    ).toBe(false);
  });

  it('exposes the normative constants', () => {
    expect(DOC_TYPES).toEqual([
      'customer_receipt',
      'kitchen_ticket',
      'bar_ticket',
      'station_ticket',
    ]);
    expect(PAYLOAD_MAX_BYTES).toBe(32 * 1024);
  });
});
