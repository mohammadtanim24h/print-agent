import type { PrinterStatus } from '../transport/types';

/** A print job as handed to the engine by the (future, P4) cloud client — already zod-validated at the WSS boundary. */
export interface PrintJobInput {
  readonly jobId: string; // uuidv7 from the server
  readonly idempotencyKey: string;
  readonly tenantId: string;
  readonly restaurantId: string;
  readonly printerId: string;
  readonly priority: number; // 1..9, 1 = highest
  readonly copies: number; // 1..4 (agent cap)
  readonly docType: string;
  readonly docVersion: number;
  /** Epoch ms, or null when the server sets no expiry. */
  readonly expiresAt: number | null;
  readonly payload: unknown; // validated against DocV1Schema at intake
}

/** Ack statuses per api-contract §3.1 — sending/printer_ack never appear. */
export const ACK_STATUSES = [
  'accepted',
  'rejected',
  'rendered',
  'sent_to_printer',
  'completed',
  'failed',
  'ambiguous',
] as const;
export type AckStatus = (typeof ACK_STATUSES)[number];

export interface JobAck {
  readonly jobId: string;
  readonly status: AckStatus;
  readonly printerStatus: PrinterStatus; // best-effort cached status (C1 poller); 'unknown' unless the printer opts in
  readonly printed: false; // security rule 8: no code path may claim a physical print
  readonly attempt: number;
  readonly at: string; // RFC 3339 UTC
  readonly error?: { readonly code: string; readonly message: string };
}

/** Transport-agnostic ack destination; P4 wires this to the WSS/REST ack path. */
export interface AckSink {
  submit(ack: JobAck): void;
}

export interface EngineLimits {
  /** Maximum number of non-terminal job rows (bounded queue). */
  readonly maxPending: number;
  /** Transport attempts per execution cycle before a job is failed. */
  readonly maxAttempts: number;
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
  /** Terminal rows older than this many days are eligible for cleanup. */
  readonly retentionDays: number;
  /** Hard cap on terminal rows kept. */
  readonly retentionMaxRows: number;
}

export const DEFAULT_LIMITS: EngineLimits = {
  maxPending: 500,
  maxAttempts: 3,
  retryBaseDelayMs: 2_000,
  retryMaxDelayMs: 60_000,
  retentionDays: 14,
  retentionMaxRows: 1_000,
};
