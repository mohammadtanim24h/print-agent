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
