import { describe, expect, it } from 'vitest';
import { createCanvasRasterizer, packMonoToGsV0 } from '../src/main/render/raster';
import { resolve } from 'node:path';

const FONT = resolve(__dirname, '../assets/fonts/NotoSansBengali-Regular.ttf');

/** Narrow `T | null` after a not-null expectation (lint: no non-null assertions). */
function must<T>(value: T | null): T {
  if (value === null) throw new Error('unexpected null');
  return value;
}

describe('createCanvasRasterizer', () => {
  it('loads the bundled OFL font and rasterizes ASCII', () => {
    const r = createCanvasRasterizer([FONT]);
    expect(r).not.toBeNull();
    const bmp = must(r).rasterize('TOTAL 12.00', 576);
    expect(bmp.width).toBeLessThanOrEqual(576);
    expect(bmp.data.length).toBe(Math.ceil(bmp.width / 8) * bmp.height);
    expect(bmp.data.some((b) => b !== 0)).toBe(true); // non-blank
  });

  it('rasterizes Bangla text non-blank and within the dot budget', () => {
    const r = must(createCanvasRasterizer([FONT]));
    const bmp = r.rasterize('প্রিন্ট এজেন্ট রসিদ', 576);
    expect(bmp.width).toBeLessThanOrEqual(576);
    expect(bmp.data.some((b) => b !== 0)).toBe(true);
  });

  it('is deterministic for identical input', () => {
    const r = must(createCanvasRasterizer([FONT]));
    expect(r.rasterize('Coffee x2', 576)).toEqual(r.rasterize('Coffee x2', 576));
  });

  it('shrinks oversized text to fit the dot width', () => {
    const r = must(createCanvasRasterizer([FONT]));
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
