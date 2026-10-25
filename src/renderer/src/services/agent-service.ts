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
  UiSettings,
} from './types';

/**
 * The renderer's entire view of the agent. Privileged work (network, printers,
 * SQLite) happens in the main process; every method is one validated IPC
 * round-trip onto the preload bridge.
 */
export interface AgentService {
  getSnapshot(): Promise<AgentSnapshot>;

  pairWithCode(code: string): Promise<PairResult>;
  /** Wipes pairing credentials, queued jobs and cached printers (PRD FR-4). */
  unpair(): Promise<void>;

  getPrinters(): Promise<readonly PrinterInfo[]>;
  addPrinter(draft: PrinterDraft): Promise<PrinterInfo>;
  updatePrinter(printerId: string, draft: PrinterDraft): Promise<PrinterInfo>;
  removePrinter(printerId: string): Promise<void>;
  /** Transport-level test print; resolves with hand-off semantics, never "printed". */
  testPrint(printerId: string): Promise<TestPrintResult>;

  getJobs(): Promise<readonly JobRecord[]>;
  /** Failed jobs only. Explicit operator action — never automatic (no silent reprints). */
  retryJob(jobId: string): Promise<JobRecord>;
  /** Completed or ambiguous jobs. Reprints carry a DUPLICATE banner (PRD FR-14). */
  reprintJob(jobId: string): Promise<JobRecord>;

  getSettings(): Promise<UiSettings>;
  updateSettings(patch: Partial<UiSettings>): Promise<UiSettings>;

  getDiagnostics(): Promise<DiagnosticsReport>;
  runConnectivityChecks(): Promise<readonly ConnectivityCheck[]>;
  /** Sanitized (redacted) recent log lines; never contains credentials or PII. */
  getRecentLogs(): Promise<readonly LogLine[]>;
}
