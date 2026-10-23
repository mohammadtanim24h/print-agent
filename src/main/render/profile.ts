export interface RenderProfile {
  paperWidthMm: 58 | 80;
  printableDots: number;
  charsPerLine: number;
  codepage: 'cp437' | 'cp850';
  capabilities: { cut: boolean; qrCode: boolean; barcode128: boolean };
  rasterFallback: { enabled: boolean; fontPaths: string[] };
}

export const DEFAULT_80MM_PROFILE: RenderProfile = {
  paperWidthMm: 80,
  printableDots: 576,
  charsPerLine: 48,
  codepage: 'cp437',
  capabilities: { cut: true, qrCode: true, barcode128: true },
  rasterFallback: { enabled: false, fontPaths: [] },
};
