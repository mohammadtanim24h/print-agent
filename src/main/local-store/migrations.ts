import type { SqliteDatabase } from './db';
import { StoreError } from './errors';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: (db: SqliteDatabase) => void;
}

/** Append-only: never edit an applied migration; add a new one. */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'jobs_and_attempts',
    up: (db) => {
      // Column set follows docs/architecture.md §6 (normative), plus reprint_of,
      // copies, priority, updated_at — required by the §5 state machine and T4 audit trail.
      db.exec(`
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          restaurant_id TEXT NOT NULL,
          printer_id TEXT NOT NULL,
          doc_type TEXT NOT NULL,
          doc_version INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 5,
          copies INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          reprint_of TEXT,
          created_at INTEGER NOT NULL,
          expires_at INTEGER,
          sent_at INTEGER,
          completed_at INTEGER,
          updated_at INTEGER NOT NULL,
          last_error TEXT
        );
        CREATE UNIQUE INDEX ux_jobs_idem ON jobs (restaurant_id, idempotency_key);
        CREATE INDEX ix_jobs_status ON jobs (status, priority, created_at);

        CREATE TABLE job_attempts (
          job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
          attempt INTEGER NOT NULL,
          outcome TEXT NOT NULL,
          error_code TEXT,
          error_message TEXT,
          at INTEGER NOT NULL,
          PRIMARY KEY (job_id, attempt)
        );
      `);
    },
  },
];

export function migrate(db: SqliteDatabase, now: () => number = Date.now): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as {
    version: number;
  }[];
  const applied = new Set(appliedRows.map((r) => r.version));
  const onDiskMax = Math.max(0, ...applied);
  const highestKnown = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
  if (onDiskMax > highestKnown) {
    // CLAUDE.md rule 11 (no downgrades): a newer build's schema cannot be understood here.
    throw new StoreError(
      'db_version_newer',
      `local store schema v${String(onDiskMax)} is newer than this build (v${String(highestKnown)})`,
    );
  }
  // Gap guard: applied versions must all be known to this build and form an exact
  // prefix {1..k} of the runner's list. A non-prefix set (e.g. {1,3} with 2 missing)
  // means the schema was tampered with or partially copied — refusing is safer than
  // applying migrations on top of an unknown shape.
  const knownVersions = new Set(MIGRATIONS.map((m) => m.version));
  for (const v of applied) {
    if (!knownVersions.has(v)) {
      throw new StoreError(
        'db_version_newer',
        `local store has applied migration v${String(v)} which this build does not know`,
      );
    }
  }
  // Versions are distinct positive integers, so |applied| === max(applied) iff the
  // set is exactly {1..max} — i.e. no gaps in the applied prefix.
  if (applied.size !== onDiskMax) {
    throw new StoreError(
      'db_version_newer',
      'local store schema is missing migrations applied out of order (non-contiguous applied set)',
    );
  }
  let ran = 0;
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    const apply = db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        now(),
      );
    });
    apply();
    ran += 1;
  }
  return ran;
}
