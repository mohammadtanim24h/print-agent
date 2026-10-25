import type { AgentService } from './agent-service';

/**
 * Production composition: every call is one validated IPC round-trip; the
 * main process owns all privileged work (network, printers, SQLite, secrets).
 * Known gap: only `launchAtLogin` has a write channel today — `startMinimized`
 * and `logLevel` are read-only until the main side grows a settings write
 * channel (wiring-composition Task 10/11).
 */
export function createProductionService(): AgentService {
  const bridge = window.printAgent;
  return {
    demo: false,
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
      if (patch.launchAtLogin !== undefined) {
        const applied = await bridge.setLaunchAtLogin(patch.launchAtLogin);
        return { launchAtLogin: applied.launchAtLogin, startMinimized: applied.startMinimized, logLevel: applied.logLevel };
      }
      // No write channel for startMinimized/logLevel yet: persist nothing and
      // return the current values so the UI reflects reality.
      const s = await bridge.getSettings();
      return { launchAtLogin: s.launchAtLogin, startMinimized: s.startMinimized, logLevel: s.logLevel };
    },
    getDiagnostics: () => bridge.getDiagnostics(),
    runConnectivityChecks: () => bridge.runConnectivityChecks(),
    getRecentLogs: () => bridge.getRecentLogs(),
  };
}
