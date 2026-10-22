import { describe, expect, it } from 'vitest';
import { getCsp, getWindowOptions } from '../src/main/security/window-options';

describe('getWindowOptions', () => {
  const preloadPath = 'C:/app/out/preload/index.cjs';

  function webPrefs(devServerUrl?: string) {
    const opts = getWindowOptions(preloadPath, devServerUrl ? { devServerUrl } : {});
    return opts.webPreferences!;
  }

  it('hardens the webPreferences', () => {
    const prefs = webPrefs();
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.nodeIntegrationInWorker).toBe(false);
    expect(prefs.webSecurity).toBe(true);
    expect(prefs.allowRunningInsecureContent).toBe(false);
    expect(prefs.experimentalFeatures).toBe(false);
    expect(prefs.preload).toBe(preloadPath);
  });

  it('disables devTools in production and enables them only in dev', () => {
    expect(webPrefs().devTools).toBe(false);
    expect(webPrefs('http://localhost:5173').devTools).toBe(true);
  });

  it('creates the window hidden (tray-first shell)', () => {
    const opts = getWindowOptions(preloadPath, {});
    expect(opts.show).toBe(false);
  });
});

describe('getCsp', () => {
  it('is a restrictive self-only CSP', () => {
    const csp = getCsp();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('*');
  });
});
