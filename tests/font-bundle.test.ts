import { existsSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUNDLED_FONT_FILES, resolveBundledFontPaths } from '../src/main/render/font-bundle';

describe('resolveBundledFontPaths', () => {
  it('resolves the dev path into assets/fonts and every file exists in the repo', () => {
    const paths = resolveBundledFontPaths({
      isPackaged: false,
      resourcesPath: 'C:/unused',
      appPath: resolve(__dirname, '..'),
    });
    expect(paths).toHaveLength(BUNDLED_FONT_FILES.length);
    for (const p of paths) {
      expect(p).toContain(normalize(join('assets', 'fonts')));
      expect(existsSync(p), p).toBe(true); // a dropped font must fail CI, not a restaurant
    }
  });

  it('resolves the packaged path into <resourcesPath>/fonts (electron-builder extraResources)', () => {
    const resources = normalize(join('C:', 'Program Files', 'Print Agent', 'resources'));
    const paths = resolveBundledFontPaths({
      isPackaged: true,
      resourcesPath: resources,
      appPath: 'C:/unused',
    });
    for (const p of paths) {
      expect(p.startsWith(resources)).toBe(true);
      expect(p).toContain(normalize(join('fonts')));
    }
  });
});
