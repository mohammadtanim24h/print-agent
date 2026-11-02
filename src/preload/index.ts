import { contextBridge, ipcRenderer } from 'electron';
import {
  Channel,
  PushEvent,
  PushSchemas,
  type AgentInfo,
  type AppSettings,
  type SettingsUpdatePayload,
  type SnapshotChangeReason,
} from '../shared/ipc-contract';
import type {
  AgentSnapshot,
  ConnectivityCheck,
  DiagnosticsReport,
  JobRecord,
  LogLine,
  PairResult,
  PrinterDraft,
  PrinterInfo,
  TestPrintResult,
} from '../renderer/src/services/types';

/**
 * The renderer's entire privileged surface. Named methods only — no raw
 * channel strings, no generic invoke passthrough, no ipcRenderer exposure.
 * Every call is re-validated in the main process (schema + sender guard);
 * this bridge is convenience + typing, not the security boundary.
 */
const api = {
  getAgentInfo: (): Promise<AgentInfo> => ipcRenderer.invoke(Channel.GetAgentInfo),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(Channel.GetSettings),
  setLaunchAtLogin: (enabled: boolean): Promise<AppSettings> =>
    ipcRenderer.invoke(Channel.SetLaunchAtLogin, { enabled }),
  updateSettings: (patch: SettingsUpdatePayload): Promise<AppSettings> =>
    ipcRenderer.invoke(Channel.SettingsUpdate, patch),
  hideWindow: (): Promise<void> => ipcRenderer.invoke(Channel.HideWindow),
  quitApp: (): Promise<void> => ipcRenderer.invoke(Channel.QuitApp),
  getSnapshot: (): Promise<AgentSnapshot> => ipcRenderer.invoke(Channel.AgentSnapshot),
  pairWithCode: (code: string): Promise<PairResult> =>
    ipcRenderer.invoke(Channel.PairWithCode, { code }),
  unpair: (): Promise<void> => ipcRenderer.invoke(Channel.AgentUnpair),
  getPrinters: (): Promise<readonly PrinterInfo[]> => ipcRenderer.invoke(Channel.PrintersList),
  addPrinter: (draft: PrinterDraft): Promise<PrinterInfo> =>
    ipcRenderer.invoke(Channel.PrintersAdd, { draft }),
  updatePrinter: (printerId: string, draft: PrinterDraft): Promise<PrinterInfo> =>
    ipcRenderer.invoke(Channel.PrintersUpdate, { printerId, draft }),
  removePrinter: (printerId: string): Promise<boolean> =>
    ipcRenderer.invoke(Channel.PrintersRemove, { printerId }),
  testPrint: (printerId: string): Promise<TestPrintResult> =>
    ipcRenderer.invoke(Channel.PrintersTest, { printerId }),
  listSystemPrinters: (): Promise<readonly string[]> =>
    ipcRenderer.invoke(Channel.PrintersListSystem),
  getJobs: (): Promise<readonly JobRecord[]> => ipcRenderer.invoke(Channel.JobsList),
  retryJob: (jobId: string): Promise<JobRecord> => ipcRenderer.invoke(Channel.JobsRetry, { jobId }),
  reprintJob: (jobId: string): Promise<JobRecord> =>
    ipcRenderer.invoke(Channel.JobsReprint, { jobId }),
  getDiagnostics: (): Promise<DiagnosticsReport> => ipcRenderer.invoke(Channel.DiagnosticsReport),
  runConnectivityChecks: (): Promise<readonly ConnectivityCheck[]> =>
    ipcRenderer.invoke(Channel.DiagnosticsChecks),
  getRecentLogs: (): Promise<readonly LogLine[]> => ipcRenderer.invoke(Channel.LogsRecent),
  /** Main → renderer signal: the snapshot changed (connection transition,
   *  pair/unpair). Payload is zod-validated here so a malformed main-side
   *  push can never reach renderer code; returns an unsubscribe function. */
  onSnapshotChanged: (listener: (reason: SnapshotChangeReason) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      const parsed = PushSchemas[PushEvent.SnapshotChanged].safeParse(payload);
      if (parsed.success) {
        listener(parsed.data.reason);
      }
    };
    ipcRenderer.on(PushEvent.SnapshotChanged, wrapped);
    return () => {
      ipcRenderer.removeListener(PushEvent.SnapshotChanged, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('printAgent', api);

export type PrintAgentApi = typeof api;
