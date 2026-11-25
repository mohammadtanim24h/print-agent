import { join } from 'node:path';

/**
 * Bundled Unicode raster-fallback fonts (OFL 1.1 — dependency rule 10).
 * All are registered under the rasterizer's family alias (raster.ts); any
 * non-ASCII line without glyph coverage in the enabled set still rasterizes
 * via the canvas fallback chain, and a font that fails to register fails the
 * rasterizer (text_not_encodable) rather than printing mojibake (R-VAL-1:
 * shaping fidelity is hardware-validation territory — the `unicodeRaster`
 * printer capability gates the whole path, default off).
 *
 * Packaged builds get the fonts from electron-builder `extraResources`
 * (`<resources>/fonts`); dev resolves `<repo>/assets/fonts`. The list is a
 * fixed constant — no directory scanning — so a build that drops a font is
 * caught by tests, not discovered at runtime.
 */
export const BUNDLED_FONT_FILES = [
  'NotoSansBengali-Regular.ttf',
  'NotoSansArabic-Regular.ttf',
  'NotoSansJP-Regular.ttf',
] as const;

export interface AppPathEnv {
  readonly isPackaged: boolean;
  /** Electron process.resourcesPath (packaged) / app.getAppPath() (dev). */
  readonly resourcesPath: string;
  readonly appPath: string;
}

export function resolveBundledFontPaths(env: AppPathEnv): string[] {
  const dir = env.isPackaged
    ? join(env.resourcesPath, 'fonts')
    : join(env.appPath, 'assets', 'fonts');
  return BUNDLED_FONT_FILES.map((f) => join(dir, f));
}
