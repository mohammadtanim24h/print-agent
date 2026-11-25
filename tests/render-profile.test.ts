import { describe, expect, it } from 'vitest';
import { DEFAULT_80MM_PROFILE, renderProfileFromPrinterConfig } from '../src/main/render/profile';
import { makeProfile } from './helpers/printers';

describe('DEFAULT_80MM_PROFILE', () => {
  it('carries sensible 80mm defaults', () => {
    expect(DEFAULT_80MM_PROFILE.paperWidthMm).toBe(80);
    expect(DEFAULT_80MM_PROFILE.printableDots).toBe(576);
    expect(DEFAULT_80MM_PROFILE.charsPerLine).toBe(48);
    expect(DEFAULT_80MM_PROFILE.codepage).toBe('cp437');
    expect(DEFAULT_80MM_PROFILE.capabilities).toEqual({
      cut: true,
      qrCode: true,
      barcode128: true,
    });
    // Safe default: reject non-ASCII unless the raster fallback is explicitly enabled.
    expect(DEFAULT_80MM_PROFILE.rasterFallback.enabled).toBe(false);
  });
});

describe('renderProfileFromPrinterConfig', () => {
  it('maps a stored printer profile onto a render profile', () => {
    const p = renderProfileFromPrinterConfig(
      makeProfile({ paperWidthMm: 58, printableDots: 384, charsPerLine: 32 }),
    );
    expect(p).toEqual({
      paperWidthMm: 58,
      printableDots: 384,
      charsPerLine: 32,
      codepage: 'cp437',
      capabilities: { cut: true, qrCode: false, barcode128: false },
      rasterFallback: { enabled: false, fontPaths: [] },
    });
  });

  it('honors disabled cutting', () => {
    const p = renderProfileFromPrinterConfig(
      makeProfile({
        capabilities: {
          cut: false,
          qrCode: true,
          barcode128: true,
          statusPolling: false,
          unicodeRaster: false,
        },
      }),
    );
    expect(p.capabilities.cut).toBe(false);
  });

  it('enables the raster fallback only with the unicodeRaster capability (R-VAL-1)', () => {
    const fontPaths = ['C:/resources/fonts/NotoSansBengali-Regular.ttf'];
    // Capability on: fonts flow into the render profile.
    const rasterOn = makeProfile({
      capabilities: {
        cut: true,
        qrCode: false,
        barcode128: false,
        statusPolling: false,
        unicodeRaster: true,
      },
    });
    const on = renderProfileFromPrinterConfig(rasterOn, fontPaths);
    expect(on.rasterFallback).toEqual({ enabled: true, fontPaths });
    // Capability on but no font paths injected: enabled with an empty set —
    // the rasterizer construction then fails and render reports
    // text_not_encodable (raster.ts), never mojibake.
    const onNoFonts = renderProfileFromPrinterConfig(rasterOn, []);
    expect(onNoFonts.rasterFallback).toEqual({ enabled: true, fontPaths: [] });
    // Capability off (default): fonts are never attached.
    const off = renderProfileFromPrinterConfig(
      makeProfile({
        capabilities: {
          cut: true,
          qrCode: false,
          barcode128: false,
          statusPolling: false,
          unicodeRaster: false,
        },
      }),
      fontPaths,
    );
    expect(off.rasterFallback).toEqual({ enabled: false, fontPaths: [] });
  });
});
