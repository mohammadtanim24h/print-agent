/**
 * Raster primitives shared by the encoder and the (upcoming) canvas
 * rasterizer. Only the byte-format contract lives here; monochrome
 * conversion from vector text/logo is Task 7's job.
 */
export interface RasterBitmap {
  width: number;
  height: number;
  /** 1 bit per pixel, rows padded to whole bytes, MSB-first. */
  data: Uint8Array;
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
