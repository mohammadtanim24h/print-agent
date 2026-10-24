/**
 * Raster primitives shared by the encoder and the canvas rasterizer.
 *
 * Unicode raster-text fallback (Bangla etc.). Policy: UTF-8 is never sent
 * directly to the printer (mojibake on the dominant fleet — R-VAL-1); instead
 * non-ASCII strings are rasterized with a bundled OFL font and emitted as
 * GS v 0 raster bit images. Shaping fidelity on real hardware is still
 * hardware-validation territory (R-VAL-1); this module guarantees the
 * pipeline: text → mono bitmap → GS v 0, bounded in size, deterministic
 * within an environment.
 */
import { createCanvas, GlobalFonts, type Canvas } from '@napi-rs/canvas';

export interface RasterBitmap {
  width: number;
  height: number;
  /** 1 bit per pixel, rows padded to whole bytes, MSB-first. */
  data: Uint8Array;
}

/** GS v 0 m xL xH yL yH <data> — raster bit image, mode 0 (normal). */
export function packMonoToGsV0(bmp: RasterBitmap): Uint8Array {
  const rowBytes = Math.ceil(bmp.width / 8);
  if (
    !Number.isInteger(bmp.width) ||
    !Number.isInteger(bmp.height) ||
    bmp.width < 1 ||
    bmp.height < 1
  ) {
    throw new TypeError('invalid bitmap dimensions');
  }
  if (bmp.data.length !== rowBytes * bmp.height) {
    throw new TypeError(
      `data length ${String(bmp.data.length)} does not match ${String(rowBytes * bmp.height)}`,
    );
  }
  const header = [
    0x1d,
    0x76,
    0x30,
    0x00,
    rowBytes & 0xff,
    (rowBytes >> 8) & 0xff,
    bmp.height & 0xff,
    (bmp.height >> 8) & 0xff,
  ];
  return Uint8Array.from([...header, ...bmp.data]);
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
      // @napi-rs/canvas returns null instead of throwing for an unusable
      // path; a null here must fail the rasterizer, not silently fall back
      // to a system font (mojibake risk — R-VAL-1).
      if (GlobalFonts.registerFromPath(p, FONT_ALIAS) === null) return null;
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
        ctx.font = `${String(size)}px "${FONT_ALIAS}"`;
        const measured = ctx.measureText(text).width;
        if (measured > maxWidthDots) {
          size = Math.max(12, Math.floor((size * maxWidthDots) / measured));
          ctx.font = `${String(size)}px "${FONT_ALIAS}"`;
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

function bitmapFromCanvas(canvas: Canvas): RasterBitmap {
  const ctx = canvas.getContext('2d');
  const { data: rgba, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const rowBytes = Math.ceil(width / 8);
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const luminance =
        (rgba[idx] ?? 255) * 0.299 +
        (rgba[idx + 1] ?? 255) * 0.587 +
        (rgba[idx + 2] ?? 255) * 0.114;
      const alpha = rgba[idx + 3] ?? 0;
      // Black text on a white fill: alpha is 255 everywhere, the luminance
      // test alone decides pixels; the alpha guard is belt-and-braces.
      if (alpha > 0 && luminance < 128) {
        const byteIdx = y * rowBytes + (x >> 3);
        out[byteIdx] = (out[byteIdx] ?? 0) | (0x80 >> (x & 7));
      }
    }
  }
  return { width, height, data: out };
}
