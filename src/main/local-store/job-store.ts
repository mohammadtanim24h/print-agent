import type { SqliteDatabase } from './db';
import { StoreError } from './errors';

/** Normative states from docs/architecture.md §5. */
export const JOB_STATUSES = [
  'accepted',
  'rejected',
  'rendered',
  'sending',
  'sent_to_printer',
  'printer_ack',
  'completed',
  'failed',
  'ambiguous',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

const TERMINAL: readonly JobStatus[] = ['rejected', 'completed', 'failed', 'ambiguous'];
export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.includes(status);
}

export interface JobRow {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly tenantId: string;
  readonly restaurantId: string;
  readonly printerId: string;
  readonly docType: string;
  readonly docVersion: number;
  readonly payloadJson: string;
  readonly priority: number;
  readonly copies: number;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly reprintOf: string | null;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly sentAt: number | null;
  readonly completedAt: number | null;
  readonly updatedAt: number;
  readonly lastError: string | null;
}

export type NewJobRow = JobRow;

export interface AttemptRecord {
  /** Outcome values: 'render_error' | 'unknown_printer' | 'connect_error' |
   *  'write_ambiguous' | 'ambiguous_crash' | 'completed' | 'cancelled'.
   *  'render_error' covers ANY render-stage code (invalid_doc,
   *  unsupported_doc_version, unsupported_doc_type, payload_too_large,
   *  text_not_encodable, render_failed); the errorCode field carries the
   *  specific code. */
  readonly outcome: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface StatusPatch {
  readonly lastError?: string;
  readonly clearError?: boolean;
}

export interface JobAttemptRow {
  readonly jobId: string;
  readonly attempt: number;
  readonly outcome: string;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly at: number;
}

/** Persistence facade. The engine depends on this interface, never on better-sqlite3 directly. */
export interface JobStore {
  insert(row: NewJobRow): void;
  get(id: string): JobRow | null;
  findByIdempotency(restaurantId: string, idempotencyKey: string): JobRow | null;
  updateStatus(id: string, status: JobStatus, patch?: StatusPatch): void;
  incrementAttempts(id: string): number;
  /** Start a fresh attempt cycle: counter back to 0 AND the cycle's attempt history cleared. */
  resetAttempts(id: string): void;
  recordAttempt(jobId: string, attempt: number, record: AttemptRecord, at: number): void;
  listAttempts(jobId: string): JobAttemptRow[];
  listByStatus(...statuses: JobStatus[]): JobRow[];
  countByStatus(...statuses: JobStatus[]): number;
  terminalIdsOlderThan(cutoff: number, limit: number): string[];
  deleteWithAttempts(ids: readonly string[]): void;
}

interface JobDbRow {
  id: string;
  idempotency_key: string;
  tenant_id: string;
  restaurant_id: string;
  printer_id: string;
  doc_type: string;
  doc_version: number;
  payload_json: string;
  priority: number;
  copies: number;
  status: string;
  attempts: number;
  reprint_of: string | null;
  created_at: number;
  expires_at: number | null;
  sent_at: number | null;
  completed_at: number | null;
  updated_at: number;
  last_error: string | null;
}

interface AttemptDbRow {
  job_id: string;
  attempt: number;
  outcome: string;
  error_code: string | null;
  error_message: string | null;
  at: number;
}

function toRow(r: JobDbRow): JobRow {
  return {
    id: r.id,
    idempotencyKey: r.idempotency_key,
    tenantId: r.tenant_id,
    restaurantId: r.restaurant_id,
    printerId: r.printer_id,
    docType: r.doc_type,
    docVersion: r.doc_version,
    payloadJson: r.payload_json,
    priority: r.priority,
    copies: r.copies,
    status: r.status as JobStatus,
    attempts: r.attempts,
    reprintOf: r.reprint_of,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    sentAt: r.sent_at,
    completedAt: r.completed_at,
    updatedAt: r.updated_at,
    lastError: r.last_error,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    String(err.code).startsWith('SQLITE_CONSTRAINT')
  );
}

/** Typed-error boundary: native better-sqlite3 throws become StoreError('store_unavailable'). */
function wrap(method: string, err: unknown): StoreError {
  if (err instanceof StoreError) return err;
  return new StoreError('store_unavailable', `${method} failed`, { cause: err });
}

export function createSqliteJobStore(
  db: SqliteDatabase,
  clock: { now: () => number } = { now: Date.now },
): JobStore {
  // Prepared once at factory time — these sit on the hot path (every state transition).
  const insertStmt = db.prepare(`
    INSERT INTO jobs (id, idempotency_key, tenant_id, restaurant_id, printer_id, doc_type, doc_version,
                      payload_json, priority, copies, status, attempts, reprint_of, created_at, expires_at,
                      sent_at, completed_at, updated_at, last_error)
    VALUES (@id, @idempotencyKey, @tenantId, @restaurantId, @printerId, @docType, @docVersion,
            @payloadJson, @priority, @copies, @status, @attempts, @reprintOf, @createdAt, @expiresAt,
            @sentAt, @completedAt, @updatedAt, @lastError)
  `);
  const updateStatusStmt = db.prepare(`
    UPDATE jobs SET status = @status, updated_at = @at,
      sent_at = CASE WHEN @status IN ('sent_to_printer', 'completed') AND sent_at IS NULL THEN @at ELSE sent_at END,
      completed_at = CASE WHEN @status = 'completed' THEN @at ELSE completed_at END,
      last_error = CASE WHEN @clearError = 1 THEN NULL ELSE COALESCE(@lastError, last_error) END
    WHERE id = @id
  `);
  const getByIdStmt = db.prepare('SELECT * FROM jobs WHERE id = ?');
  const findByIdemStmt = db.prepare('SELECT * FROM jobs WHERE restaurant_id = ? AND idempotency_key = ?');
  const incrementAttemptsStmt = db.prepare(
    'UPDATE jobs SET attempts = attempts + 1, updated_at = ? WHERE id = ? RETURNING attempts',
  );
  const resetAttemptsStmt = db.prepare('UPDATE jobs SET attempts = 0, updated_at = ? WHERE id = ?');
  const recordAttemptStmt = db.prepare(
    'INSERT INTO job_attempts (job_id, attempt, outcome, error_code, error_message, at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const listAttemptsStmt = db.prepare('SELECT * FROM job_attempts WHERE job_id = ? ORDER BY attempt ASC');
  const deleteAttemptsStmt = db.prepare('DELETE FROM job_attempts WHERE job_id = ?');
  const deleteJobStmt = db.prepare('DELETE FROM jobs WHERE id = ?');

  return {
    insert(row) {
      try {
        insertStmt.run(row);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new StoreError(
            'unique_violation',
            `unique_violation: duplicate (restaurant_id, idempotency_key) ${row.restaurantId}/${row.idempotencyKey}`,
            { cause: err },
          );
        }
        throw wrap('insert', err);
      }
    },
    get(id) {
      const r = getByIdStmt.get(id) as JobDbRow | undefined;
      return r === undefined ? null : toRow(r);
    },
    findByIdempotency(restaurantId, idempotencyKey) {
      const r = findByIdemStmt.get(restaurantId, idempotencyKey) as JobDbRow | undefined;
      return r === undefined ? null : toRow(r);
    },
    updateStatus(id, status, patch) {
      let info;
      try {
        info = updateStatusStmt.run({
          id,
          status,
          at: clock.now(),
          lastError: patch?.lastError ?? null,
          clearError: patch?.clearError === true ? 1 : 0,
        });
      } catch (err) {
        throw wrap('updateStatus', err);
      }
      if (info.changes === 0) {
        throw new StoreError('not_found', `updateStatus: no such job ${id}`);
      }
    },
    incrementAttempts(id) {
      let r;
      try {
        r = incrementAttemptsStmt.get(clock.now(), id) as { attempts: number } | undefined;
      } catch (err) {
        throw wrap('incrementAttempts', err);
      }
      if (r === undefined) throw new StoreError('not_found', `incrementAttempts: no such job ${id}`);
      return r.attempts;
    },
    resetAttempts(id) {
      // A fresh attempt cycle: the counter restarts at 0, so the history rows of
      // the superseded cycle must go too — the job_attempts PK (job_id, attempt)
      // would collide when the engine records attempt 1 of the new cycle.
      const cycle = db.transaction((jobId: string): void => {
        const info = resetAttemptsStmt.run(clock.now(), jobId);
        if (info.changes === 0) throw new StoreError('not_found', `resetAttempts: no such job ${jobId}`);
        deleteAttemptsStmt.run(jobId);
      });
      try {
        cycle(id);
      } catch (err) {
        throw wrap('resetAttempts', err);
      }
    },
    recordAttempt(jobId, attempt, record, at) {
      try {
        recordAttemptStmt.run(jobId, attempt, record.outcome, record.errorCode ?? null, record.errorMessage ?? null, at);
      } catch (err) {
        throw wrap('recordAttempt', err);
      }
    },
    listAttempts(jobId) {
      const rows = listAttemptsStmt.all(jobId) as AttemptDbRow[];
      return rows.map((r) => ({
        jobId: r.job_id,
        attempt: r.attempt,
        outcome: r.outcome,
        errorCode: r.error_code,
        errorMessage: r.error_message,
        at: r.at,
      }));
    },
    listByStatus(...statuses) {
      const placeholders = statuses.map(() => '?').join(', ');
      const rows = db
        .prepare(`SELECT * FROM jobs WHERE status IN (${placeholders}) ORDER BY priority ASC, created_at ASC, id ASC`)
        .all(...statuses) as JobDbRow[];
      return rows.map(toRow);
    },
    countByStatus(...statuses) {
      const placeholders = statuses.map(() => '?').join(', ');
      const r = db
        .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status IN (${placeholders})`)
        .get(...statuses) as { n: number };
      return r.n;
    },
    terminalIdsOlderThan(cutoff, limit) {
      const marks = TERMINAL.map(() => '?').join(', ');
      const rows = db
        .prepare(
          `SELECT id FROM jobs WHERE status IN (${marks}) AND updated_at < ? ORDER BY updated_at ASC LIMIT ?`,
        )
        .all(...TERMINAL, cutoff, limit) as Array<{ id: string }>;
      return rows.map((r) => r.id);
    },
    deleteWithAttempts(ids) {
      const remove = db.transaction((toDelete: readonly string[]) => {
        for (const id of toDelete) {
          deleteAttemptsStmt.run(id);
          deleteJobStmt.run(id);
        }
      });
      try {
        remove(ids);
      } catch (err) {
        throw wrap('deleteWithAttempts', err);
      }
    },
  };
}
