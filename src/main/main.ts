import { app, ipcMain, safeStorage } from 'electron';
import electronLog from 'electron-log/main';
import net from 'node:net';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { Channel, RequestSchemas } from '../shared/ipc-contract';
import { createAgentRuntime } from './agent-runtime';
import { closeDatabase, openDatabase } from './local-store/db';
import { migrate } from './local-store/migrations';
import { createSenderGuard } from './security/sender-guard';
import { installNoListenGuard } from './security/no-listen-guard';
import { createIpcRouter } from './ipc/register';
import { createLogger, getRecentLogLines, setupLogging } from './services/logger/logger';
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
  electronLog.transports.file.level = settings.get().logLevel;
  applyLaunchAtLogin(app, settings.get().launchAtLogin);

  // The database is owned here (main), not by the runtime: opened + migrated
  // before the runtime, closed on quit (before-quit below).
  const dbFile = join(app.getPath('userData'), 'print-agent.db');
  const db = openDatabase({ file: dbFile });
  migrate(db);

  // TODO(release): the Laravel team owns the production API URL — confirm this
  // value on the release checklist before shipping.
  const API_BASE_URL =
    process.env['PRINT_AGENT_API_URL'] ?? 'https://print-api.example-saas.test';

  const runtime = await createAgentRuntime({
    db,
    settings,
    paths: {
      dbFile,
      identityKvFile: join(app.getPath('userData'), 'identity-kv.json'),
      printersFile: join(app.getPath('userData'), 'printers.json'),
    },
    log,
    agentVersion: app.getVersion(),
    deviceName: hostname(),
    safeStorage,
    cloud: { baseUrl: API_BASE_URL },
  });
  // Crash recovery + first poll cycle; no-op while unpaired.
  runtime.start();

  const window = createMainWindow(log, devServerUrl !== undefined ? { devServerUrl } : {}, {
    shouldCloseToTray: () => !quitting,
    // Dev workflow always shows the window; production honors the setting.
    startMinimized: settings.get().startMinimized && devServerUrl === undefined,
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

  // Record<Channel, ...> (not Record<string, ...>) so the compiler rejects the
  // map if a contract channel is added without a handler.
  const handlers: Record<Channel, (payload: never) => unknown> = {
    [Channel.GetAgentInfo]: () => runtime.agentInfo(),
    [Channel.GetSettings]: () => settings.get(),
    [Channel.SetLaunchAtLogin]: async ({ enabled }: { enabled: boolean }) => {
      const next = await settings.set({ launchAtLogin: enabled });
      applyLaunchAtLogin(app, enabled);
      tray.refresh();
      log.info('launch-at-login changed', { enabled });
      return next;
    },
    [Channel.SettingsUpdate]: async (patch: {
      startMinimized?: boolean;
      logLevel?: 'debug' | 'info' | 'warn' | 'error';
    }) => {
      // Empty patches (e.g. launchAtLogin-only updates from the renderer)
      // return current settings without a redundant disk write.
      const next = Object.keys(patch).length === 0 ? settings.get() : await settings.set(patch);
      if (patch.logLevel !== undefined) {
        electronLog.transports.file.level = next.logLevel;
        log.info('log level changed', { level: next.logLevel });
      }
      return next;
    },
    [Channel.HideWindow]: () => {
      window.hide();
    },
    [Channel.QuitApp]: () => {
      log.info('quit requested from renderer');
      app.quit();
    },
    [Channel.AgentSnapshot]: () => runtime.snapshot(),
    [Channel.PairWithCode]: ({ code }: { code: string }) => runtime.pair(code),
    [Channel.AgentUnpair]: async () => {
      await runtime.unpair();
    },
    [Channel.PrintersList]: () => runtime.printers.list(),
    [Channel.PrintersAdd]: ({ draft }: { draft: unknown }) => runtime.printers.add(draft),
    [Channel.PrintersUpdate]: ({ printerId, draft }: { printerId: string; draft: unknown }) =>
      runtime.printers.update(printerId, draft),
    [Channel.PrintersRemove]: ({ printerId }: { printerId: string }) =>
      runtime.printers.remove(printerId),
    [Channel.PrintersTest]: ({ printerId }: { printerId: string }) =>
      runtime.printers.testPrint(printerId),
    [Channel.JobsList]: () => runtime.jobs.list(),
    [Channel.JobsRetry]: ({ jobId }: { jobId: string }) => runtime.jobs.retry(jobId),
    [Channel.JobsReprint]: ({ jobId }: { jobId: string }) => runtime.jobs.reprint(jobId),
    [Channel.DiagnosticsReport]: () => runtime.diagnostics.report(),
    [Channel.DiagnosticsChecks]: () => runtime.diagnostics.checks(),
    [Channel.LogsRecent]: () => getRecentLogLines(),
  };

  const router = createIpcRouter({
    guard,
    schemas: RequestSchemas,
    handlers,
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
    // Runtime owns no db handle; main closes the store after the final ack
    // flush. finally() guarantees the close even if stop() rejects.
    void runtime
      .stop()
      .catch((error: unknown) => {
        log.error('shutdown failed', error);
      })
      .finally(() => {
        try {
          closeDatabase(db);
        } catch (error: unknown) {
          log.error('db close failed', error);
        }
      });
  });

  // Tray application: closing the window keeps the core process alive.
  app.on('window-all-closed', () => undefined);

  log.info('started', {
    version: app.getVersion(),
    dev: devServerUrl !== undefined,
    launchAtLogin: settings.get().launchAtLogin,
  });
}
