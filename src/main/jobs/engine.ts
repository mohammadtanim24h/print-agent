import { DocV1Schema } from '../render/doc';
import type { PrinterStore } from '../printers/store';
import type { TransportRegistry } from '../transport/registry';
import { StoreError } from '../local-store/errors';
import type { JobRow, JobStatus, JobStore } from '../local-store/job-store';
import type { AckSink, EngineLimits, JobAck, PrintJobInput } from './types';
import { DEFAULT_LIMITS } from './types';
import type { AckStatus } from './types';
import { JobEngineError } from './errors';

const NON_TERMINAL: readonly JobStatus[] = ['accepted', 'rendered', 'sending'];

export interface JobEngineDeps {
  readonly store: JobStore;
  readonly printers: PrinterStore;
  readonly transports: TransportRegistry;
  readonly acks: AckSink;
  readonly now?: () => number;
  readonly newId?: () => string;
  /** Replaceable timer for deterministic tests; default setTimeout. */
  readonly schedule?: (fn: () => void, delayMs: number) => void;
  readonly limits?: Partial<EngineLimits>;
}

export interface JobEngine {
  /** Durable intake. Returns the accepted/rejected ack. Throws JobEngineError('store_unavailable') on DB failure (no ack — server re-delivers). */
  submit(job: PrintJobInput): JobAck;
  /** Startup recovery: sending → ambiguous; accepted/rendered re-enqueued. (Task 9) */
  recover(): void;
  /** Read one job row (for UI/diagnostics). */
  getJob(jobId: string): JobRow | null;
  /** Operator: re-run a failed job. (Task 10) */
  retryJob(jobId: string): void;
  /** Operator: print a copy of a terminal job as a NEW row with reprint_of set. (Task 10) */
  reprintJob(jobId: string): string;
  /** Operator: cancel before transmission only. (Task 10) */
  cancel(jobId: string): boolean;
  /** Retention: delete terminal rows past the limits. (Task 11) */
  cleanup(): number;
  /** Non-terminal row count (queue depth). */
  pendingCount(): number;
}

export function createJobEngine(deps: JobEngineDeps): JobEngine {
  const now = deps.now ?? Date.now;
  const limits: EngineLimits = { ...DEFAULT_LIMITS, ...deps.limits };
  const { store, printers, acks } = deps;

  function emit(row: JobRow, status: AckStatus, error?: JobAck['error']): JobAck {
    const ack: JobAck = {
      jobId: row.id,
      status,
      printerStatus: 'unknown',
      printed: false,
      attempt: Math.max(row.attempts, 1),
      at: new Date(now()).toISOString(),
      ...(error === undefined ? {} : { error }),
    };
    acks.submit(ack);
    return ack;
  }

  function rejectAck(job: PrintJobInput, code: string, message: string): JobAck {
    return {
      jobId: job.jobId,
      status: 'rejected',
      printerStatus: 'unknown',
      printed: false,
      attempt: 1,
      at: new Date(now()).toISOString(),
      error: { code, message },
    };
  }

  function ackFromStoredError(row: JobRow, status: AckStatus): JobAck {
    const stored = row.lastError ?? '';
    const sep = stored.indexOf(': ');
    const code = sep > 0 ? stored.slice(0, sep) : 'failed';
    const message = sep > 0 ? stored.slice(sep + 2) : stored;
    return {
      jobId: row.id,
      status,
      printerStatus: 'unknown',
      printed: false,
      attempt: Math.max(row.attempts, 1),
      at: new Date(now()).toISOString(),
      error: { code, message },
    };
  }

  /** Map an internal status to an ack status for duplicate re-delivery (api-contract §3.1 excludes sending/printer_ack). */
  function duplicateAck(row: JobRow): JobAck {
    const plain = (status: AckStatus): JobAck => ({
      jobId: row.id,
      status,
      printerStatus: 'unknown',
      printed: false,
      attempt: Math.max(row.attempts, 1),
      at: new Date(now()).toISOString(),
    });
    switch (row.status) {
      case 'accepted':
        return plain('accepted');
      case 'rendered':
        return plain('rendered');
      case 'sending':
        return plain('accepted'); // still in flight; nothing about the outcome is knowable
      case 'printer_ack':
        return plain('completed');
      case 'rejected':
        return ackFromStoredError(row, 'rejected');
      case 'failed':
        return ackFromStoredError(row, 'failed');
      default:
        return plain(row.status); // completed | ambiguous
    }
  }

  function submit(job: PrintJobInput): JobAck {
    if (printers.get(job.printerId) === null) {
      return rejectAck(job, 'unknown_printer', `printer ${job.printerId} is not configured`);
    }
    if (job.docVersion !== 1) {
      return rejectAck(job, 'unsupported_doc_version', `doc_version ${String(job.docVersion)} is not supported`);
    }
    if (job.expiresAt !== null && job.expiresAt <= now()) {
      return rejectAck(job, 'job_expired', 'job expired before intake');
    }
    if (!DocV1Schema.safeParse(job.payload).success) {
      return rejectAck(job, 'invalid_doc', 'payload does not satisfy doc model v1');
    }
    const existing = store.findByIdempotency(job.restaurantId, job.idempotencyKey);
    if (existing !== null) {
      return duplicateAck(existing);
    }
    if (store.countByStatus(...NON_TERMINAL) >= limits.maxPending) {
      return rejectAck(job, 'queue_full', 'local queue is at capacity');
    }
    const row: JobRow = {
      id: job.jobId,
      idempotencyKey: job.idempotencyKey,
      tenantId: job.tenantId,
      restaurantId: job.restaurantId,
      printerId: job.printerId,
      docType: job.docType,
      docVersion: job.docVersion,
      payloadJson: JSON.stringify(job.payload),
      priority: job.priority,
      copies: job.copies,
      status: 'accepted',
      attempts: 0,
      reprintOf: null,
      createdAt: now(),
      expiresAt: job.expiresAt,
      sentAt: null,
      completedAt: null,
      updatedAt: now(),
      lastError: null,
    };
    try {
      store.insert(row);
    } catch (err) {
      if (err instanceof StoreError && err.code === 'unique_violation') {
        const raced = store.findByIdempotency(job.restaurantId, job.idempotencyKey);
        if (raced !== null) return duplicateAck(raced);
      }
      throw new JobEngineError('store_unavailable', `intake persist failed: ${String(err)}`);
    }
    enqueueExecution(); // no-op until Task 6
    return emit(row, 'accepted');
  }

  // ---- scheduling (Task 6) -----------------------------------------------
  function enqueueExecution(): void {
    // replaced in Task 6 with the per-printer scheduler
  }

  function getJob(jobId: string): JobRow | null {
    return store.get(jobId);
  }

  function pendingCount(): number {
    return store.countByStatus(...NON_TERMINAL);
  }

  return {
    submit,
    getJob,
    pendingCount,
    recover: (): void => {
      throw new Error('recover: implemented in Task 9');
    },
    retryJob: (): void => {
      throw new Error('retryJob: implemented in Task 10');
    },
    reprintJob: (): string => {
      throw new Error('reprintJob: implemented in Task 10');
    },
    cancel: (): boolean => {
      throw new Error('cancel: implemented in Task 10');
    },
    cleanup: (): number => {
      throw new Error('cleanup: implemented in Task 11');
    },
  };
}
