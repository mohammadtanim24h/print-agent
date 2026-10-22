import type { App } from 'electron';

/**
 * Launch-at-login via the platform registry (Windows: Run key through
 * app.setLoginItemSettings). Thin electron glue — behavior is covered by the
 * settings store tests plus manual smoke, not unit tests.
 */
export function applyLaunchAtLogin(app: App, enabled: boolean): void {
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
}
