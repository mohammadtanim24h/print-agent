import { DocV1Schema } from '../render/doc';
import { renderDoc } from '../render/render';
import { renderProfileFromPrinterConfig } from '../render/profile';
import type { PrinterStore } from '../printers/store';
import type { TransportRegistry } from '../transport/registry';
import { StoreError } from '../local-store/errors';
import {
  isTerminal,
  type JobAttemptRow,
  type JobRow,
  type JobStatus,
  type JobStore,
} from '../local-store/job-store';
import type { AckSink, EngineLimits, JobAck, PrintJobInput } from './types';
import { DEFAULT_LIMITS } from './types';
import type { AckStatus } from './types';
import { JobEngineError } from './errors';

const NON_TERMINAL: readonly JobStatus[] = ['accepted', 'rendered', 'sending'];

/** Durable lastError encoding: `"<code>: <message>"`. All writers must go
 *  through this so ackFromStoredError can reconstruct the typed error. */
export function encodeStoredError(code: string, message: string): string {
  return `${code}: ${message}`;
}

/** Inverse of encodeStoredError; tolerant of empty/legacy garbage. */
export function decodeStoredError(stored: string): { code: string; message: string } {
  if (stored === '') return { code: 'failed', message: 'unknown error' };
  const sep = stored.indexOf(': ');
  if (sep <= 0) return { code: 'failed', message: stored };
  return { code: stored.slice(0, sep), message: stored.slice(sep + 2) };
}

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
  /** Attempt-history rows for one job, ordered by attempt (for UI/diagnostics). */
  listAttempts(jobId: string): JobAttemptRow[];
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
  const schedule =
    deps.schedule ??
    ((fn: () => void, delayMs: number): void => {
      setTimeout(fn, delayMs);
    });
  const { store, printers, acks } = deps;
  const transports = deps.transports;

  /** Per-printer FIFO of queued job ids (priority-ordered). */
  const pending = new Map<string, string[]>();
  const draining = new Set<string>();
  /** Job ids with an execution in flight (cancel/retry coordination, Task 10). */
  const executing = new Set<string>();

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
    const { code, message } = decodeStoredError(row.lastError ?? '');
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
      case 'sent_to_printer':
        return plain('sent_to_printer');
      case 'printer_ack':
        return plain('completed');
      case 'completed':
        return plain('completed');
      case 'ambiguous':
        return plain('ambiguous');
      case 'rejected':
        return ackFromStoredError(row, 'rejected');
      case 'failed':
        return ackFromStoredError(row, 'failed');
      default: {
        // Compile-time exhaustiveness over all JobStatus values.
        const unreachable: never = row.status;
        return unreachable;
      }
    }
  }

  function submit(job: PrintJobInput): JobAck {
    // T4/ADR-6: idempotency lookup FIRST — a re-delivery whose row exists is
    // acked from stored state and never re-evaluated against current
    // printer/expiry/schema state (which may have drifted since acceptance).
    const existing = store.findByIdempotency(job.restaurantId, job.idempotencyKey);
    if (existing !== null) {
      return duplicateAck(existing);
    }
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
    // Deferred to a microtask so the accepted ack is emitted (and submit
    // returns) before any execution-driven acks.
    enqueueExecution(row.printerId, row.id);
    return emit(row, 'accepted');
  }

  // ---- scheduling ----------------------------------------------------------

  /** Queue one job for execution on its printer. Jobs on the same printer run strictly one at a time (R-VAL-6). */
  function enqueueExecution(printerId: string, jobId: string): void {
    const queue = pending.get(printerId) ?? [];
    queue.push(jobId);
    queue.sort(byRank);
    pending.set(printerId, queue);
    drain(printerId);
  }

  function byRank(a: string, b: string): number {
    const ra = store.get(a);
    const rb = store.get(b);
    if (ra === null || rb === null) return 0;
    return ra.priority - rb.priority || ra.createdAt - rb.createdAt || (a < b ? -1 : 1);
  }

  function drain(printerId: string): void {
    if (draining.has(printerId)) return;
    const queue = pending.get(printerId);
    if (queue === undefined || queue.length === 0) return;
    const jobId = queue.shift();
    if (jobId === undefined) return;
    draining.add(printerId);
    executing.add(jobId);
    void Promise.resolve()
      .then(() => runJob(jobId))
      .catch((err: unknown) => {
        // Engine bug or store failure mid-flight. The row keeps its last durable status
        // ('sending' → recovered to ambiguous on next start). Never crash the process.
        report(`job engine: unhandled error executing ${jobId}: ${String(err)}`);
        // Pre-transmission stranding guard: a transient StoreError before 'sending'
        // would leave the row durable but queued nowhere. Re-enqueue unless terminal or
        // already mid-transmission ('sending' stays restart-recovery territory). This
        // loop is unbounded only if the store fails persistently — acceptable for P1,
        // because each cycle re-runs the failing store call synchronously and reports.
        try {
          const stranded = store.get(jobId);
          if (stranded !== null && !isTerminal(stranded.status) && stranded.status !== 'sending') {
            enqueueExecution(printerId, jobId);
          }
        } catch (requeueErr) {
          // Store unreadable (e.g. DB closed) — requeueing is impossible; report and stop.
          report(`job engine: stranding check for ${jobId} failed: ${String(requeueErr)}`);
        }
      })
      .finally(() => {
        executing.delete(jobId);
        draining.delete(printerId);
        drain(printerId);
      });
  }

  function report(message: string): void {
    // P1 reporting seam; the logger module takes this over when the engine is wired in P4.
    console.error(message);
  }

  // ---- execution -----------------------------------------------------------

  function codeOf(err: unknown): string {
    return err instanceof Error && 'code' in err && typeof (err as { code: unknown }).code === 'string'
      ? (err as { code: string }).code
      : 'internal_error';
  }

  function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  function safeClose(transport: { close(): Promise<void> }): void {
    void transport.close().catch((err: unknown): void => {
      report(`job engine: close failed (hand-off already done): ${String(err)}`);
    });
  }

  /** Deterministic failure (render/unknown-printer): terminal, not retried. */
  function failJob(jobId: string, code: string, message: string, attempt: number): void {
    const outcome =
      code === 'invalid_doc' || code === 'unsupported_doc_version'
        ? 'render_error'
        : code === 'unknown_printer'
          ? 'unknown_printer'
          : code;
    store.recordAttempt(jobId, attempt, { outcome, errorCode: code, errorMessage: message }, now());
    store.updateStatus(jobId, 'failed', { lastError: encodeStoredError(code, message) });
    const row = store.get(jobId);
    if (row !== null) emit(row, 'failed', { code, message });
  }

  async function runJob(jobId: string): Promise<void> {
    let row = store.get(jobId);
    if (row === null || isTerminal(row.status)) return; // cancelled/re-executed while queued
    const profile = printers.get(row.printerId);
    if (profile === null) {
      failJob(jobId, 'unknown_printer', `printer ${row.printerId} disappeared before execution`, row.attempts + 1);
      return;
    }

    // -- render (bytes live only in memory; payload persists for re-render on retry) --
    if (row.status === 'accepted') store.updateStatus(jobId, 'rendered');
    let payload: unknown;
    try {
      payload = JSON.parse(row.payloadJson) as unknown;
    } catch {
      failJob(jobId, 'invalid_doc', 'stored payload is not valid JSON', row.attempts + 1);
      return;
    }
    const parsed = DocV1Schema.safeParse(payload);
    if (!parsed.success) {
      failJob(jobId, 'invalid_doc', 'stored payload failed re-validation', row.attempts + 1);
      return;
    }
    const result = renderDoc(row.docType, parsed.data, renderProfileFromPrinterConfig(profile));
    if (!result.ok) {
      failJob(jobId, result.error.code, result.error.message, row.attempts + 1);
      return;
    }
    row = store.get(jobId);
    if (row === null) return;
    emit(row, 'rendered');

    // -- transmit ----------------------------------------------------------
    const attempt = store.incrementAttempts(jobId);
    // Crash between these two writes leaves attempts incremented with no
    // attempt-history row (audit-trail-only gap; see Task 12 matrix).
    store.updateStatus(jobId, 'sending'); // durable in-flight marker: crash after this ⇒ ambiguous
    const transport = transports.forPrinter(profile);
    try {
      await transport.open();
    } catch (err) {
      onConnectFailure(jobId, attempt, codeOf(err), messageOf(err));
      return;
    }
    try {
      for (let copy = 0; copy < row.copies; copy += 1) {
        await transport.write(result.bytes);
      }
    } catch (err) {
      // Bytes may have partially reached the printer — outcome unknown. Never auto-retry (T4/ADR-5).
      safeClose(transport);
      onAmbiguous(jobId, attempt, codeOf(err), messageOf(err));
      return;
    }
    safeClose(transport);
    store.recordAttempt(jobId, attempt, { outcome: 'completed' }, now());
    store.updateStatus(jobId, 'sent_to_printer');
    store.updateStatus(jobId, 'completed');
    const done = store.get(jobId);
    if (done !== null) {
      emit(done, 'sent_to_printer');
      emit(done, 'completed');
    }
  }

  /** Pre-transmission failure: nothing was written, so retrying is safe (ADR-6 at-most-once per attempt). */
  function onConnectFailure(jobId: string, attempt: number, code: string, message: string): void {
    store.recordAttempt(jobId, attempt, { outcome: 'connect_error', errorCode: code, errorMessage: message }, now());
    const row = store.get(jobId);
    if (row === null) return;
    if (row.attempts >= limits.maxAttempts) {
      store.updateStatus(jobId, 'failed', { lastError: encodeStoredError(code, message) });
      const failed = store.get(jobId);
      if (failed !== null) emit(failed, 'failed', { code, message });
      return;
    }
    store.updateStatus(jobId, 'rendered', { lastError: encodeStoredError(code, message) });
    const backoff = Math.min(limits.retryBaseDelayMs * 2 ** (row.attempts - 1), limits.retryMaxDelayMs);
    schedule(() => {
      enqueueExecution(row.printerId, jobId);
    }, backoff);
  }

  function onAmbiguous(jobId: string, attempt: number, code: string, message: string): void {
    store.recordAttempt(jobId, attempt, { outcome: 'write_ambiguous', errorCode: code, errorMessage: message }, now());
    store.updateStatus(jobId, 'ambiguous', { lastError: encodeStoredError(code, message) });
    const row = store.get(jobId);
    if (row !== null) emit(row, 'ambiguous', { code, message });
  }

  function getJob(jobId: string): JobRow | null {
    return store.get(jobId);
  }

  function listAttempts(jobId: string): JobAttemptRow[] {
    return store.listAttempts(jobId);
  }

  function pendingCount(): number {
    return store.countByStatus(...NON_TERMINAL);
  }

  return {
    submit,
    getJob,
    listAttempts,
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
