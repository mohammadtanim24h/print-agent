import { app, ipcMain } from 'electron';
import net from 'node:net';
import { join } from 'node:path';
import { Channel, RequestSchemas } from '../shared/ipc-contract';
import { createSenderGuard } from './security/sender-guard';
import { installNoListenGuard } from './security/no-listen-guard';
import { createIpcRouter } from './ipc/register';
import { createLogger, setupLogging } from './services/logger/logger';
import { createSettingsStore } from './services/settings';
import { createNodeSettingsAdapter } from './services/settings-fs';
import { applyLaunchAtLogin } from './services/autolaunch';
import { createMainWindow } from './window';
import { createTray, type TrayController } from './tray';

// PRD AC-4, threat model T3: any inbound server socket throws immediately.
installNoListenGuard(net.Server.prototype);
// Sandboxed renderers, process-wide, before app.ready.
app.enableSandbox();

let quitting = false;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // A second copy is already running; the OS hands the launch over to it.
  app.quit();
} else {
  void start();
}

async function start(): Promise<void> {
  setupLogging();
  const log = createLogger('main');

  await app.whenReady();

  const devServerUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined;
  if (!app.isPackaged && devServerUrl === undefined) {
    log.warn('dev mode without ELECTRON_RENDERER_URL; loading bundled files');
  }

  const settings = await createSettingsStore({
    filePath: join(app.getPath('userData'), 'settings.json'),
    adapter: createNodeSettingsAdapter(),
    report: (message) => {
      log.warn(message);
    },
  });
  applyLaunchAtLogin(app, settings.get().launchAtLogin);

  const window = createMainWindow(log, devServerUrl !== undefined ? { devServerUrl } : {}, {
    shouldCloseToTray: () => !quitting,
  });

  const tray: TrayController = createTray({
    app,
    launchAtLogin: () => settings.get().launchAtLogin,
    setLaunchAtLogin: (enabled) => {
      void settings
        .set({ launchAtLogin: enabled })
        .then(() => {
          applyLaunchAtLogin(app, enabled);
        })
        .catch((error: unknown) => {
          log.error('failed to persist launch-at-login', error);
        });
    },
    showWindow: () => {
      window.show();
      window.focus();
    },
    log: (message) => {
      log.info(message);
    },
  });

  // Trust boundary: only our own bundled/dev-server renderer may call IPC.
  const filePrefix = `file:///${app.getAppPath().replace(/\\/g, '/').replace(/\/+$/, '')}/`;
  const guard = createSenderGuard({
    allowedUrlPrefixes:
      devServerUrl !== undefined
        ? [`${devServerUrl.replace(/\/+$/, '')}/`, filePrefix]
        : [filePrefix],
    log: (message) => {
      log.warn(message);
    },
  });

  const router = createIpcRouter({
    guard,
    schemas: RequestSchemas,
    handlers: {
      [Channel.GetAgentInfo]: () => ({
        name: 'print-agent',
        version: app.getVersion(),
        connectionState: 'unpaired' as const,
      }),
      [Channel.GetSettings]: () => settings.get(),
      [Channel.SetLaunchAtLogin]: async ({ enabled }: { enabled: boolean }) => {
        const next = await settings.set({ launchAtLogin: enabled });
        applyLaunchAtLogin(app, enabled);
        tray.refresh();
        log.info('launch-at-login changed', { enabled });
        return next;
      },
      [Channel.HideWindow]: () => {
        window.hide();
      },
      [Channel.QuitApp]: () => {
        log.info('quit requested from renderer');
        app.quit();
      },
    },
    log: (message) => {
      log.warn(message);
    },
  });

  for (const channel of Object.values(Channel)) {
    ipcMain.handle(channel, (event, payload: unknown) =>
      router.dispatch(channel, payload, {
        senderFrame: event.senderFrame ? { url: event.senderFrame.url } : null,
      }),
    );
  }

  app.on('second-instance', () => {
    window.show();
    window.focus();
  });

  app.on('before-quit', () => {
    quitting = true;
  });

  // Tray application: closing the window keeps the core process alive.
  app.on('window-all-closed', () => undefined);

  log.info('started', {
    version: app.getVersion(),
    dev: devServerUrl !== undefined,
    launchAtLogin: settings.get().launchAtLogin,
  });
}
