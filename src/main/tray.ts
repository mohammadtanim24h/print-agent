import { Menu, Tray, nativeImage, type App } from 'electron';
import { join } from 'node:path';

export interface TrayController {
  /** Rebuild the menu (e.g. after the launch-at-login setting changed). */
  refresh(): void;
}

export function createTray(options: {
  app: App;
  launchAtLogin: () => boolean;
  setLaunchAtLogin: (enabled: boolean) => void;
  showWindow: () => void;
  log: (message: string) => void;
}): TrayController {
  const icon = nativeImage.createFromPath(join(__dirname, '../renderer/icon.png'));
  const tray = new Tray(icon);
  tray.setToolTip('Print Agent');

  const rebuild = () => {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Print Agent', click: () => options.showWindow() },
        { type: 'separator' },
        {
          label: 'Launch at login',
          type: 'checkbox',
          checked: options.launchAtLogin(),
          click: (item) => options.setLaunchAtLogin(item.checked),
        },
        { type: 'separator' },
        {
          label: 'Quit Print Agent',
          click: () => {
            options.log('quit requested from tray');
            options.app.quit();
          },
        },
      ])
    );
  };
  rebuild();

  tray.on('click', () => options.showWindow());
  return { refresh: rebuild };
}
