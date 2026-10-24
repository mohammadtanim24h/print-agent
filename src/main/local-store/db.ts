import Database from 'better-sqlite3';
import { StoreError } from './errors';

/** Instance type of the better-sqlite3 constructor — avoids depending on its namespace shape. */
export type SqliteDatabase = InstanceType<typeof Database>;

export interface DatabaseOptions {
  /** Path to the database file, or null for a transient in-memory database (tests). */
  readonly file: string | null;
}

/**
 * Open the local store. WAL gives crash-safe concurrent readers; `synchronous = FULL`
 * fsyncs the WAL on every commit so an `accepted` row survives power loss (ADR-9:
 * jobs are persisted before print). Ticket volume is far too low for the fsync cost
 * to matter.
 */
export function openDatabase(options: DatabaseOptions): SqliteDatabase {
  try {
    const db = options.file === null ? new Database(':memory:') : new Database(options.file);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    return db;
  } catch (err) {
    throw new StoreError('db_open_failed', `cannot open local store: ${String(err)}`);
  }
}

/** Close gracefully; WAL is checkpointed automatically on last connection close. */
export function closeDatabase(db: SqliteDatabase): void {
  db.close();
}
