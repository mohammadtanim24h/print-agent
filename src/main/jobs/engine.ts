import { DocV1Schema, PAYLOAD_MAX_BYTES } from '../render/doc';
import { renderDoc } from '../render/render';
import { renderProfileFromPrinterConfig } from '../render/profile';
import type { PrinterStore } from '../printers/store';
import type { TransportRegistry } from '../transport/registry';
import type { PrinterStatus } from '../transport/types';
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
  /** C1: best-effort cached printer status for acks; omitted → always 'unknown'. */
  readonly printerStatus?: (printerId: string) => PrinterStatus;
}

export interface JobEngine {
  /** Durable intake. Returns the accepted/rejected ack. Throws JobEngineError('store_unavailable') on DB failure (no ack — server re-delivers). */
  submit(job: PrintJobInput): JobAck;
  /** Startup recovery: resolves transmission-window rows to ambiguous — both
   *  mid-transmission (`sending`) and post-write rows stranded between
   *  `sent_to_printer`/`printer_ack` and `completed` by a crash — and
   *  re-enqueues pre-transmission rows (`accepted`/`rendered`) for execution
   *  (rows with an unknown printer are left as-is — config may restore the
   *  printer later; they still count against the queue bound). Never re-sends
   *  a job whose bytes may have reached the printer. Never throws; per-row
   *  failures are reported and skipped. */
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
  const newId = deps.newId ?? ((): string => crypto.randomUUID());
  const limits: EngineLimits = { ...DEFAULT_LIMITS, ...deps.limits };
  const schedule =
    deps.schedule ??
    ((fn: () => void, delayMs: number): void => {
      setTimeout(fn, delayMs);
    });
  const { store, printers, acks } = deps;
  const transports = deps.transports;
  const statusFor: (printerId: string) => PrinterStatus =
    deps.printerStatus ?? ((): PrinterStatus => 'unknown');

  /** Per-printer FIFO of queued job ids (priority-ordered). */
  const pending = new Map<string, string[]>();
  const draining = new Set<string>();
  /** Job ids with an execution in flight (cancel/retry coordination, Task 10). */
  const executing = new Set<string>();
  /** Consecutive engine-error requeues per job (drain-catch path only). Cap
   *  semantics: counters 1..3 schedule a backoff requeue; the 4th consecutive
   *  engine-error requeue gives up and leaves the job in its last durable
   *  state for restart recovery instead of retrying forever. */
  const engineErrorRequeues = new Map<string, number>();

  function emit(row: JobRow, status: AckStatus, error?: JobAck['error']): JobAck {
    const ack: JobAck = {
      jobId: row.id,
      status,
      printerStatus: statusFor(row.printerId),
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
      printerStatus: statusFor(job.printerId),
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
      printerStatus: statusFor(row.printerId),
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
      printerStatus: statusFor(row.printerId),
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
      return rejectAck(
        job,
        'unsupported_doc_version',
        `doc_version ${String(job.docVersion)} is not supported`,
      );
    }
    if (job.expiresAt !== null && job.expiresAt <= now()) {
      return rejectAck(job, 'expired_job', 'job expired before intake');
    }
    // Agent-enforced envelope caps (api-contract §2): the WSS boundary schema
    // also bounds these, but the engine is the last line of defense and must
    // not trust its caller.
    if (!Number.isInteger(job.copies) || job.copies < 1 || job.copies > 4) {
      return rejectAck(job, 'invalid_envelope', 'copies must be an integer between 1 and 4');
    }
    if (!Number.isInteger(job.priority) || job.priority < 1 || job.priority > 9) {
      return rejectAck(job, 'invalid_envelope', 'priority must be an integer between 1 and 9');
    }
    // Serialize once here: the same string feeds the size cap and the row insert.
    const payloadJson = JSON.stringify(job.payload);
    if (Buffer.byteLength(payloadJson, 'utf8') > PAYLOAD_MAX_BYTES) {
      return rejectAck(job, 'invalid_doc', 'payload exceeds the 32 KiB cap');
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
      payloadJson,
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

  /** schedule() wrapper for timer callbacks that touch the store: a closed or
   *  failing store would otherwise throw uncaught inside a timer context. */
  function scheduleSafely(fn: () => void, delayMs: number): void {
    schedule(() => {
      try {
        fn();
      } catch (err) {
        report(`job engine: scheduled work failed: ${String(err)}`);
      }
    }, delayMs);
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
        // Pre-transmission stranding guard: a transient StoreError before
        // transmission would leave the row durable but queued nowhere. Requeue
        // ONLY rows still in a pre-transmission state ('accepted'/'rendered')
        // — re-running those is byte-identical and safe. Rows past the
        // transmission boundary ('sending', 'sent_to_printer', 'printer_ack')
        // must NEVER requeue: a re-run re-renders and re-writes every copy —
        // a silent duplicate print (ADR-5/T4). They strand durably in their
        // last state for restart recovery instead. Requeue with backoff through
        // the injected scheduler — never synchronously, so a persistently
        // failing store cannot become a zero-delay microtask spin — and after
        // 4 consecutive engine-error requeues (counters 1..3 scheduled; the
        // 4th does not) the job is left for restart recovery too.
        try {
          const stranded = store.get(jobId);
          if (
            stranded !== null &&
            (stranded.status === 'accepted' || stranded.status === 'rendered')
          ) {
            const count = (engineErrorRequeues.get(jobId) ?? 0) + 1;
            if (count > 3) {
              report(
                `job engine: ${jobId} hit the engine-error requeue cap; giving up until restart recovery`,
              );
              engineErrorRequeues.delete(jobId);
            } else {
              engineErrorRequeues.set(jobId, count);
              const backoff = Math.min(
                limits.retryBaseDelayMs * 2 ** (count - 1),
                limits.retryMaxDelayMs,
              );
              scheduleSafely(() => {
                enqueueExecution(printerId, jobId);
              }, backoff);
            }
          } else {
            // Terminal, mid-transmission, or post-write: never requeued, so the
            // cap counter is moot.
            engineErrorRequeues.delete(jobId);
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
    return err instanceof Error &&
      'code' in err &&
      typeof (err as { code: unknown }).code === 'string'
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
    // Render-stage codes (invalid_doc, unsupported_doc_version, unsupported_doc_type,
    // payload_too_large, text_not_encodable, render_failed) all map to outcome
    // 'render_error'; the specific code is preserved in errorCode.
    const outcome = code === 'unknown_printer' ? 'unknown_printer' : 'render_error';
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
      failJob(
        jobId,
        'unknown_printer',
        `printer ${row.printerId} disappeared before execution`,
        row.attempts + 1,
      );
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
    // store proven writable through render + the durable sending marker — a
    // fresh pass may proceed; reset the engine-error requeue cap.
    engineErrorRequeues.delete(jobId);
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
    store.recordAttempt(
      jobId,
      attempt,
      { outcome: 'connect_error', errorCode: code, errorMessage: message },
      now(),
    );
    const row = store.get(jobId);
    if (row === null) return;
    if (row.attempts >= limits.maxAttempts) {
      store.updateStatus(jobId, 'failed', { lastError: encodeStoredError(code, message) });
      const failed = store.get(jobId);
      if (failed !== null) emit(failed, 'failed', { code, message });
      return;
    }
    store.updateStatus(jobId, 'rendered', { lastError: encodeStoredError(code, message) });
    const backoff = Math.min(
      limits.retryBaseDelayMs * 2 ** (row.attempts - 1),
      limits.retryMaxDelayMs,
    );
    scheduleSafely(() => {
      enqueueExecution(row.printerId, jobId);
    }, backoff);
  }

  function onAmbiguous(jobId: string, attempt: number, code: string, message: string): void {
    store.recordAttempt(
      jobId,
      attempt,
      { outcome: 'write_ambiguous', errorCode: code, errorMessage: message },
      now(),
    );
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

  // ---- startup recovery (docs/architecture.md §5, ADR-5) -------------------

  function recover(): void {
    // Startup recovery never throws: a single bad row must not veto resuming healthy
    // jobs. Per-row failures are reported and skipped; they remain in their current
    // status and are retried on the next restart.
    // 1) Jobs caught mid-transmission by a crash: the write outcome is unknowable.
    //    They land in ambiguous — resolution is operator/policy action, never
    //    automatic re-sending (ADR-5).
    for (const row of store.listByStatus('sending')) {
      try {
        store.recordAttempt(
          row.id,
          Math.max(row.attempts, 1),
          {
            outcome: 'ambiguous_crash',
            errorCode: 'restarted_in_flight',
            errorMessage: 'agent restarted while job was transmitting',
          },
          now(),
        );
        store.updateStatus(row.id, 'ambiguous', {
          lastError: encodeStoredError(
            'restarted_in_flight',
            'agent restarted while job was transmitting',
          ),
        });
        const fresh = store.get(row.id);
        if (fresh !== null) {
          emit(fresh, 'ambiguous', {
            code: 'restarted_in_flight',
            message: 'agent restarted while job was transmitting',
          });
        }
      } catch (err) {
        report(`job engine: recovery failed for ${row.id}: ${String(err)}`);
      }
    }
    // 2) Rows stranded between hand-off and completion by a crash: bytes were
    //    written to the transport, but the process died before the durable
    //    completion write landed. Hand-off status is knowable, but the job
    //    never reached a terminal state — resolve to ambiguous like
    //    mid-transmission rows; the printer is never re-sent (ADR-5). The
    //    attempt-history row uses attempts + 1: the stranded attempt already
    //    has its history row (recorded before the sent_to_printer write) and
    //    (job_id, attempt) is the primary key.
    for (const row of store.listByStatus('sent_to_printer', 'printer_ack')) {
      try {
        store.recordAttempt(
          row.id,
          row.attempts + 1,
          {
            outcome: 'ambiguous_crash',
            errorCode: 'restarted_in_flight',
            errorMessage: 'agent restarted after transmission but before hand-off was recorded',
          },
          now(),
        );
        store.updateStatus(row.id, 'ambiguous', {
          lastError: encodeStoredError(
            'restarted_in_flight',
            'agent restarted after transmission but before hand-off was recorded',
          ),
        });
        const fresh = store.get(row.id);
        if (fresh !== null) {
          emit(fresh, 'ambiguous', {
            code: 'restarted_in_flight',
            message: 'agent restarted after transmission but before hand-off was recorded',
          });
        }
      } catch (err) {
        report(`job engine: recovery failed for ${row.id}: ${String(err)}`);
      }
    }
    // 3) Pre-transmission jobs survive the restart and resume from the queue.
    //    Rows whose printer is unknown stay put: the printer may be restored by
    //    config later, and they still count against the queue bound.
    for (const row of store.listByStatus('accepted', 'rendered')) {
      try {
        if (printers.get(row.printerId) !== null) enqueueExecution(row.printerId, row.id);
      } catch (err) {
        report(`job engine: recovery re-enqueue failed for ${row.id}: ${String(err)}`);
      }
    }
  }

  // ---- operator actions (threat-model T4: explicit operator actions only; no
  // silent reprints — reprints are separate rows with reprint_of for audit) ----

  function retryJob(jobId: string): void {
    const row = store.get(jobId);
    if (row === null) {
      throw new JobEngineError('illegal_transition', `retryJob: unknown job ${jobId}`);
    }
    if (row.status !== 'failed') {
      throw new JobEngineError(
        'illegal_transition',
        `retryJob: job ${jobId} is ${row.status}; only failed jobs can be retried`,
      );
    }
    // Fresh attempt budget + clear the stored failure so a re-failure overwrites
    // lastError rather than layering on it; the row re-enters the queue as accepted.
    store.resetAttempts(jobId);
    store.updateStatus(jobId, 'accepted', { clearError: true });
    enqueueExecution(row.printerId, jobId);
  }

  function reprintJob(jobId: string): string {
    const row = store.get(jobId);
    if (row === null) {
      throw new JobEngineError('illegal_transition', `reprintJob: unknown job ${jobId}`);
    }
    if (!isTerminal(row.status) || row.status === 'rejected') {
      throw new JobEngineError(
        'illegal_transition',
        `reprintJob: job ${jobId} is ${row.status}; only completed/failed/ambiguous jobs can be reprinted`,
      );
    }
    // The pending-queue bound applies to operator reprints too — the operator
    // sees this typed error instead of a silent override of the bound.
    if (store.countByStatus(...NON_TERMINAL) >= limits.maxPending) {
      throw new JobEngineError(
        'illegal_transition',
        `reprintJob: local queue is at capacity (${String(limits.maxPending)} pending)`,
      );
    }
    // A NEW row with a unique idempotency key (the original key is taken by the
    // unique index) so the server-side duplicate ledger is never disturbed.
    const id = newId();
    store.insert({
      id,
      idempotencyKey: `${row.idempotencyKey}#reprint-${id}`,
      tenantId: row.tenantId,
      restaurantId: row.restaurantId,
      printerId: row.printerId,
      docType: row.docType,
      docVersion: row.docVersion,
      payloadJson: row.payloadJson,
      priority: row.priority,
      copies: row.copies,
      status: 'accepted',
      attempts: 0,
      reprintOf: row.id,
      createdAt: now(),
      expiresAt: null, // an operator reprint does not inherit the original's expiry
      sentAt: null,
      completedAt: null,
      updatedAt: now(),
      lastError: null,
    });
    enqueueExecution(row.printerId, id);
    const fresh = store.get(id);
    if (fresh !== null) emit(fresh, 'accepted');
    return id;
  }

  function cancel(jobId: string): boolean {
    const row = store.get(jobId);
    if (row === null) return false;
    // Safe window: queued (accepted) or rendered but NOT yet executing. Anything
    // else — mid-transmission (sending or executing), terminal — is refused; an
    // ambiguous outcome must never be manufactured by the operator (ADR-5).
    const safeWindow =
      (row.status === 'accepted' || row.status === 'rendered') && !executing.has(jobId);
    if (!safeWindow) return false;
    const fromQueue = pending.get(row.printerId);
    if (fromQueue !== undefined) {
      const idx = fromQueue.indexOf(jobId);
      if (idx >= 0) fromQueue.splice(idx, 1);
    }
    store.recordAttempt(jobId, row.attempts + 1, { outcome: 'cancelled' }, now());
    store.updateStatus(jobId, 'failed', {
      lastError: encodeStoredError('cancelled', 'cancelled by operator before transmission'),
    });
    const fresh = store.get(jobId);
    if (fresh !== null) {
      emit(fresh, 'failed', {
        code: 'cancelled',
        message: 'cancelled by operator before transmission',
      });
    }
    return true;
  }

  /** Retention: delete terminal rows past the age cutoff and/or the row cap.
   *  Safe-deletion rule: terminalIdsOlderThan itself only ever returns
   *  TERMINAL rows (rejected/completed/failed/ambiguous), so a job whose final
   *  state is not durably recorded is never eligible.
   *  `ambiguous` is terminal, so UNRESOLVED ambiguous rows are retention-eligible:
   *  operator resolution is expected within `retentionDays` — after that window
   *  retention may silently delete an unresolved ambiguous job (with its attempt
   *  history). */
  function cleanup(): number {
    const cutoff = now() - limits.retentionDays * 86_400_000;
    const ids = store.terminalIdsOlderThan(cutoff, limits.retentionMaxRows);
    if (ids.length === 0) return 0;
    store.deleteWithAttempts(ids); // single transaction; attempts deleted with their job
    return ids.length;
  }

  return {
    submit,
    getJob,
    listAttempts,
    pendingCount,
    recover,
    retryJob,
    reprintJob,
    cancel,
    cleanup,
  };
}
