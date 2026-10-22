import type { BrowserWindowConstructorOptions } from 'electron';

/**
 * Hardened BrowserWindow options. Pure and electron-free at runtime (type-only
 * import) so unit tests can assert the security posture without Electron.
 */
export interface WindowEnv {
  /** Vite dev server origin, e.g. http://localhost:5173. Undefined = production. */
  readonly devServerUrl?: string;
}

export function getWindowOptions(
  preloadPath: string,
  env: WindowEnv
): BrowserWindowConstructorOptions {
  const isDev = env.devServerUrl !== undefined;
  return {
    width: 420,
    height: 520,
    show: false, // tray-first shell; window shown on tray click
    autoHideMenuBar: true,
    backgroundColor: '#101418',
    webPreferences: {
      preload: preloadPath,
      // Security posture — enforced by tests/security/window-options.test.ts.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      devTools: isDev,
      spellcheck: false,
    },
  };
}

/**
 * Restrictive CSP, used as a <meta> in index.html. `frame-ancestors` is
 * ignored in meta tags (kept for documentation value); the sandboxed,
 * isolated window is the actual defense there.
 */
export function getCsp(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}
