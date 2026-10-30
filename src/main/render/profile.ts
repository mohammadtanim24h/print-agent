import type { PrinterProfile } from '../printers/profile';

/**
 * Layout + capability inputs for the renderer. This is deliberately a
 * renderer-local view: the stored printer profile carries transport/config
 * concerns (endpoints, status polling) that never leak into
 * ESC/POS generation. Per-printer physical values are never derived from
 * paper width (printer-compatibility.md; spec §4).
 */
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

export function renderProfileFromPrinterConfig(p: PrinterProfile): RenderProfile {
  return {
    paperWidthMm: p.paperWidthMm,
    printableDots: p.printableDots,
    charsPerLine: p.charsPerLine,
    codepage: 'cp437',
    capabilities: {
      cut: p.capabilities.cut,
      qrCode: p.capabilities.qrCode,
      barcode128: p.capabilities.barcode128,
    },
    rasterFallback: { enabled: false, fontPaths: [] },
  };
}
