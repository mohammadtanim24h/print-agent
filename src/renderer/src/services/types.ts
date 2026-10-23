/**
 * Domain types for the local UI. Naming and status wording follow
 * docs/api-contract.md §3.1 (normative): `completed` means "hand-off to
 * printer/driver succeeded" — the UI must never say or imply "printed".
 */

/** `disabled` = cloud link not configured yet (current phase). */
export type ConnectionState = 'disabled' | 'connecting' | 'online' | 'offline' | 'error';

export interface AgentIdentity {
  readonly deviceId: string;
  readonly agentName: string;
  readonly restaurantId: string;
  readonly restaurantName: string;
  /** RFC 3339 UTC, or null before pairing. */
  readonly pairedAt: string | null;
}

/** Best-effort transport-level health (api-contract §3.1 `printer_status`). */
export type PrinterHealth = 'ok' | 'unknown' | 'offline' | 'paper_out' | 'paper_low' | 'cover_open';

export type TransportConfig =
  | { readonly kind: 'tcp_raw'; readonly host: string; readonly port: number }
  | { readonly kind: 'spooler_raw'; readonly windowsPrinterName: string };

export type DuplicatePolicy = 'ask_operator' | 'auto_reprint' | 'never';
export type CutMode = 'full' | 'partial' | 'none';

export interface PrinterConfig {
  readonly printerId: string;
  readonly name: string;
  readonly station: string;
  readonly transport: TransportConfig;
  readonly copiesDefault: number;
  readonly codepage: string;
  readonly cutDefault: CutMode;
  readonly duplicatePolicy: DuplicatePolicy;
}

export interface PrinterInfo {
  readonly config: PrinterConfig;
  readonly health: PrinterHealth;
  readonly lastPrintAt: string | null;
}

/** Editable subset of a printer, used by the add/edit form. */
export interface PrinterDraft {
  readonly name: string;
  readonly station: string;
  readonly transport: TransportConfig;
  readonly copiesDefault: number;
  readonly codepage: string;
  readonly cutDefault: CutMode;
  readonly duplicatePolicy: DuplicatePolicy;
}

/** Job state machine states (architecture.md §5 — authoritative). */
export type JobStatus =
  | 'accepted'
  | 'rendered'
  | 'sending'
  | 'sent_to_printer'
  | 'printer_ack'
  | 'completed'
  | 'failed'
  | 'ambiguous'
  | 'rejected';

export type DocType = 'customer_receipt' | 'kitchen_ticket' | 'bar_ticket' | 'station_ticket';

export interface JobRecord {
  readonly jobId: string;
  readonly idempotencyKey: string;
  readonly docType: DocType;
  readonly destinationPrinterName: string;
  readonly status: JobStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly attempts: number;
  readonly lastError: string | null;
}

export interface AgentSnapshot {
  readonly version: string;
  readonly connection: ConnectionState;
  /** One-line human explainer; wording stays honest about what is known. */
  readonly connectionDetail: string;
  readonly identity: AgentIdentity | null;
  /** Jobs not yet in a terminal state (accepted/rendered/sending/sent_to_printer). */
  readonly pendingJobs: number;
  readonly ambiguousJobs: number;
  /** Last time a job reached a terminal state (any), RFC 3339 or null. */
  readonly lastActivityAt: string | null;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface UiSettings {
  readonly launchAtLogin: boolean;
  readonly startMinimized: boolean;
  readonly logLevel: LogLevel;
}

export type PairFailureReason = 'invalid_code' | 'expired' | 'already_paired' | 'network';

export type PairResult =
  | { readonly ok: true; readonly identity: AgentIdentity }
  | { readonly ok: false; readonly reason: PairFailureReason; readonly message: string };

export interface TestPrintResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly at: string;
}

export interface DbHealth {
  readonly ok: boolean;
  readonly sizeBytes: number;
  readonly queueDepth: number;
  readonly journalMode: string;
}

export interface DiagnosticsReport {
  readonly version: string;
  readonly electronVersion: string;
  readonly platform: string;
  readonly uptimeS: number;
  readonly db: DbHealth;
}

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface ConnectivityCheck {
  readonly id: string;
  readonly label: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface LogLine {
  readonly ts: string;
  readonly level: LogLevel;
  readonly module: string;
  readonly message: string;
}
