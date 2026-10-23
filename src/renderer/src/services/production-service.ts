import type { AgentService } from './agent-service';
import { MockAgentService } from './mock-agent-service';
import type { UiSettings } from './types';

/**
 * Production composition: everything that has no main-process service yet
 * (cloud, printers, jobs, diagnostics) is demo data, clearly flagged via
 * `demo`. Launch-at-login is real — it flows through the validated IPC
 * bridge to the settings store and OS login item.
 */
export function createProductionService(): AgentService {
  const mock = new MockAgentService();
  const bridge = window.printAgent;
  let realLaunchAtLogin: boolean | null = null;

  const readRealLaunchAtLogin = async (): Promise<boolean> => {
    const real = await bridge.getSettings();
    realLaunchAtLogin = real.launchAtLogin;
    return real.launchAtLogin;
  };

  return {
    demo: true,
    getSnapshot: () => mock.getSnapshot(),
    pairWithCode: (code) => mock.pairWithCode(code),
    unpair: () => mock.unpair(),
    getPrinters: () => mock.getPrinters(),
    addPrinter: (draft) => mock.addPrinter(draft),
    updatePrinter: (id, draft) => mock.updatePrinter(id, draft),
    removePrinter: (id) => mock.removePrinter(id),
    testPrint: (id) => mock.testPrint(id),
    getJobs: () => mock.getJobs(),
    retryJob: (id) => mock.retryJob(id),
    reprintJob: (id) => mock.reprintJob(id),
    getDiagnostics: () => mock.getDiagnostics(),
    runConnectivityChecks: () => mock.runConnectivityChecks(),
    getRecentLogs: () => mock.getRecentLogs(),

    async getSettings() {
      const [realLaunch, demo] = await Promise.all([readRealLaunchAtLogin(), mock.getSettings()]);
      return { ...demo, launchAtLogin: realLaunch };
    },

    async updateSettings(patch: Partial<UiSettings>) {
      let realLaunch = realLaunchAtLogin;
      if (patch.launchAtLogin !== undefined) {
        const applied = await bridge.setLaunchAtLogin(patch.launchAtLogin);
        realLaunch = applied.launchAtLogin;
        realLaunchAtLogin = applied.launchAtLogin;
      }
      const demoPatch: {
        startMinimized?: UiSettings['startMinimized'];
        logLevel?: UiSettings['logLevel'];
      } = {};
      if (patch.startMinimized !== undefined) {
        demoPatch.startMinimized = patch.startMinimized;
      }
      if (patch.logLevel !== undefined) {
        demoPatch.logLevel = patch.logLevel;
      }
      const demo = await mock.updateSettings(demoPatch);
      return { ...demo, launchAtLogin: realLaunch ?? demo.launchAtLogin };
    },
  };
}
