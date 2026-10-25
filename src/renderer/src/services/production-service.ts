import type { AgentService } from './agent-service';

/**
 * Production composition: every call is one validated IPC round-trip; the
 * main process owns all privileged work (network, printers, SQLite, secrets).
 */
export function createProductionService(): AgentService {
  const bridge = window.printAgent;
  return {
    getSnapshot: () => bridge.getSnapshot(),
    pairWithCode: (code) => bridge.pairWithCode(code),
    unpair: () => bridge.unpair(),
    getPrinters: () => bridge.getPrinters(),
    addPrinter: (draft) => bridge.addPrinter(draft),
    updatePrinter: (printerId, draft) => bridge.updatePrinter(printerId, draft),
    removePrinter: (printerId) => bridge.removePrinter(printerId).then(() => undefined),
    testPrint: (printerId) => bridge.testPrint(printerId),
    getJobs: () => bridge.getJobs(),
    retryJob: (jobId) => bridge.retryJob(jobId),
    reprintJob: (jobId) => bridge.reprintJob(jobId),
    getSettings: async () => {
      const s = await bridge.getSettings();
      return { launchAtLogin: s.launchAtLogin, startMinimized: s.startMinimized, logLevel: s.logLevel };
    },
    updateSettings: async (patch) => {
      // launchAtLogin keeps its dedicated channel (it drives the OS autolaunch
      // registration, not just the stored value); the rest goes to settings:update.
      if (patch.launchAtLogin !== undefined) {
        const applied = await bridge.setLaunchAtLogin(patch.launchAtLogin);
        return { launchAtLogin: applied.launchAtLogin, startMinimized: applied.startMinimized, logLevel: applied.logLevel };
      }
      const applied = await bridge.updateSettings({
        ...(patch.startMinimized === undefined ? {} : { startMinimized: patch.startMinimized }),
        ...(patch.logLevel === undefined ? {} : { logLevel: patch.logLevel }),
      });
      return { launchAtLogin: applied.launchAtLogin, startMinimized: applied.startMinimized, logLevel: applied.logLevel };
    },
    getDiagnostics: () => bridge.getDiagnostics(),
    runConnectivityChecks: () => bridge.runConnectivityChecks(),
    getRecentLogs: () => bridge.getRecentLogs(),
  };
}
