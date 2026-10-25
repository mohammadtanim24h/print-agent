import { BrowserWindow } from 'electron';
import { join } from 'node:path';
import { getCsp, getWindowOptions } from './security/window-options';
import type { Logger } from './services/logger/logger';

/**
 * The settings/status window. Closing it hides it — the agent keeps running
 * in the tray. Actual termination happens only through the explicit quit
 * action (tray menu or renderer quit button), which sets the quitting flag.
 */
export function createMainWindow(
  log: Logger,
  env: { readonly devServerUrl?: string },
  lifecycle: {
    readonly shouldCloseToTray: () => boolean;
    /** Tray-resident launch: skip the ready-to-show show() entirely. */
    readonly startMinimized: boolean;
  },
): BrowserWindow {
  const preloadPath = join(__dirname, '../preload/index.cjs');
  const window = new BrowserWindow(getWindowOptions(preloadPath, env));

  // Every privileged window gets the restrictive CSP header equivalent;
  // the renderer's index.html carries the same policy as a <meta> tag.
  window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [getCsp({ dev: env.devServerUrl !== undefined })],
      },
    });
  });

  // Navigation away from bundled content is forbidden (threat model T3):
  // any attempt is blocked, not merely warned about.
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = env.devServerUrl !== undefined && url.startsWith(env.devServerUrl);
    if (!allowed) {
      event.preventDefault();
      log.warn('blocked navigation attempt', { scheme: new URL(url).protocol });
    }
  });
  window.webContents.setWindowOpenHandler(() => {
    log.warn('blocked window.open attempt');
    return { action: 'deny' };
  });

  window.once('ready-to-show', () => {
    if (!lifecycle.startMinimized) {
      window.show();
    }
  });

  window.on('close', (event) => {
    // Minimize-to-tray: closing the window must not stop the core process.
    if (!lifecycle.shouldCloseToTray()) {
      event.preventDefault();
      window.hide();
    }
  });

  if (env.devServerUrl !== undefined) {
    void window.loadURL(env.devServerUrl);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return window;
}
