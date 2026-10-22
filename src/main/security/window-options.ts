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
  env: WindowEnv,
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
 * Restrictive CSP for the renderer. Lives in src/shared/csp.ts so the vite
 * config can bake the right variant (strict prod, dev-server variant for HMR)
 * into index.html.
 */
export { getCsp } from '../../shared/csp';
