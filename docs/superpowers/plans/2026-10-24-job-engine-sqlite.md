# Local Job Engine + SQLite Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement phase P1 — a durable SQLite-backed local job store and the job-engine state machine that persists every print job before execution, suppresses duplicates, retries only pre-transmission failures, routes ambiguous outcomes to an explicit `ambiguous` state, and serializes writes per physical printer.

**Architecture:** Two new modules under `src/main/`, following the repo's injected-dependencies pattern (`docs/architecture.md` §3): `local-store/` (single owner of SQLite disk I/O: connection, versioned migrations, job repository) and `jobs/` (state-machine owner: intake, execution scheduling, recovery, operator actions, retention). The engine consumes already-zod-validated job objects (the `cloud-client` that produces them is phase P4 and out of scope); acks are emitted through an injected `AckSink` that P4 will wire to the WebSocket. Execution is tested against in-memory and on-disk SQLite plus scripted fake transports; no real printer or network is involved.

**Tech Stack:** TypeScript strict (existing tsconfig), `better-sqlite3` 13.x (N-API prebuilds, MIT — pre-vetted in `.research/dependency-research.md`, ADR-9), Vitest 5 node project, existing helpers (`tests/helpers/printers.ts`, `tests/helpers/memory-adapter.ts`).

---

## Normative constraints (read first)

CLAUDE.md: "`docs/api-contract.md` and the state machine in `docs/architecture.md` §5 are normative — code that diverges from them is wrong."

**State names.** The task description used shorthand names; the normative states (architecture §5) are:

| Task shorthand | Normative state (`docs/architecture.md` §5) |
|---|---|
| received | `accepted` (validated + durably persisted, no print guarantee) |
| queued_local | `accepted` (queue membership is engine-internal, not a state) |
| rendering | `rendered` (ESC/POS stream produced, held in memory only) |
| sending | `sending` (write in flight — only observable via crash recovery) |
| sent_to_printer | `sent_to_printer` (bytes written to socket — no print guarantee) |
| outcome_unknown | `ambiguous` (never auto-reprinted) |
| — | `rejected`, `failed`, `completed` (terminal), `printer_ack` (reserved, unused in P1) |

Other hard rules encoded here:

- **Ack statuses** (api-contract §3.1) are exactly `accepted | rejected | rendered | sent_to_printer | completed | failed | ambiguous`. `sending` and `printer_ack` are internal-only and never appear in acks. `printed` is always `false` (security rule 8).
- **Idempotency**: unique index on `(restaurant_id, idempotency_key)` (architecture §6). A re-delivered job whose row is terminal is acked from stored state and never re-executed (threat model T4, ADR-6).
- **Persist before print** (ADR-9): a job row exists in `accepted` before any byte is rendered or written.
- **Crash recovery**: rows found in `sending` at startup become `ambiguous` — never re-sent automatically.
- **Retries**: only failures that occurred before any transmission byte (connect-phase `TransportError` codes) are retried, with bounded attempts and backoff. Write-phase failures are ambiguous, not retryable.
- **Reprints/retakes are explicit operator actions** (`retryJob` for `failed`, `reprintJob` for terminal jobs, creating a new row with `reprint_of` set — T4 audit trail).
- **Deletion**: only terminal rows past retention are deleted, together with their attempt history, inside one transaction.
- **Serialization**: one execution at a time per `printer_id` so concurrent tickets never interleave on a physical printer (R-VAL-6).
- **No secrets in job data or logs**: the jobs table stores doc payload and metadata only; identity/DPAPI is a later phase and never touches this schema.

**Out of scope (non-goals), with rationale:**
- WebSocket cloud client, envelope signature verification, REST ack batching → P4/P5. The engine consumes validated `PrintJobInput` and emits `JobAck`s to an injected sink.
- Migrating `printers`/`settings` JSON files into SQLite (architecture §3.5 lists them as future tables) — mechanical follow-up; this plan touches only `jobs` + `job_attempts`.
- DLE EOT `printer_ack` (R-VAL-3), `duplicate_policy` auto-resolution, IPC job channels/UI wiring, electron-builder `asarUnpack` packaging of the native module (P8 — noted in docs as a TODO).
- Cancellation of in-flight `sending` jobs (unsafe by definition — requirement says "only where cancellation is still safe").

**Import style:** check `src/main/printers/service.ts` before writing the first import — new files must match the existing relative-import extension convention used by neighboring files.

---

### Task 1: Add better-sqlite3 and wire the build

**Files:**
- Modify: `package.json` (deps, `pnpm.onlyBuiltDependencies`)
- Modify: `electron.vite.config.ts` (main-process externals)

- [ ] **Step 1: Install the dependency exact-pinned**

```bash
pnpm add -E better-sqlite3@13
```

Expected: installs newest 13.x with `better-sqlite3@<version>` recorded exactly in `package.json`. better-sqlite3 ships its own TypeScript types; do **not** add `@types/better-sqlite3`.

- [ ] **Step 2: Allow its install script**

better-sqlite3 has a `prebuild-install`-style install script. pnpm blocks build scripts unless allow-listed. In `package.json`, extend the existing block:

```json
  "pnpm": {
    "onlyBuiltDependencies": [
      "better-sqlite3",
      "electron",
      "esbuild"
    ]
  }
```

If pnpm printed a warning about ignored build scripts during step 1, re-run `pnpm rebuild better-sqlite3` after editing.

- [ ] **Step 3: Verify the native module loads and executes in plain Node**

```bash
node --input-type=commonjs -e "const D=require('better-sqlite3'); const db=new D(':memory:'); console.log(db.prepare('select 1 as ok').get().ok)"
```

Expected output: `1`. If it fails with an ABI/version error, stop and escalate (dependency-admission rule; do not improvise with electron-rebuild — research says v13 prebuilds cover Electron without it).

- [ ] **Step 4: Add to electron-vite main externals**

In `electron.vite.config.ts`, add `'better-sqlite3'` to the same externals list that contains `'electron'` and `'electron-log'` (native modules must stay external — rolldown cannot bundle a `.node` binary). Match the exact list shape already in the file.

- [ ] **Step 5: Verify nothing broke**

```bash
pnpm typecheck && pnpm test
```

Expected: all existing tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml electron.vite.config.ts
git commit -m "deps: add better-sqlite3 13 (N-API prebuilds) — local store foundation (ADR-9)"
```

---

### Task 2: Database open/close + typed store errors

**Files:**
- Create: `src/main/local-store/errors.ts`
- Create: `src/main/local-store/db.ts`
- Test: `tests/local-store-db.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/local-store-db.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, closeDatabase } from '../src/main/local-store/db.js';

describe('openDatabase', () => {
  it('opens an in-memory database when file is null', () => {
    const db = openDatabase({ file: null });
    expect(db.prepare('select 1 as v').get()).toEqual({ v: 1 });
    closeDatabase(db);
  });

  it('enables WAL and full fsync on a file database (ADR-9 durability)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'print-agent-db-'));
    try {
      const db = openDatabase({ file: join(dir, 'jobs.db') });
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.pragma('synchronous', { simple: true })).toBe(2); // FULL
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      closeDatabase(db);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('survives reopen — data persists across restarts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'print-agent-db-'));
    try {
      const file = join(dir, 'jobs.db');
      const db1 = openDatabase({ file });
      db1.exec('create table t (v text)');
      db1.prepare('insert into t values (?)').run('kept');
      closeDatabase(db1);
      const db2 = openDatabase({ file });
      expect(db2.prepare('select v from t').get()).toEqual({ v: 'kept' });
      closeDatabase(db2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run tests/local-store-db.test.ts
```

Expected: FAIL — cannot resolve `../src/main/local-store/db.js`.

- [ ] **Step 3: Implement**

`src/main/local-store/errors.ts` (match the `TypedError` convention of `src/main/transport/errors.ts` — read it first and copy its class shape):

```typescript
import type { TypedError } from '../../shared/errors.js';

export type StoreErrorCode =
  | 'db_open_failed'     // could not open/create the database file
  | 'db_version_newer'   // on-disk schema is newer than this build supports
  | 'unique_violation'   // constraint rejected the row (e.g. duplicate idempotency key)
  | 'store_unavailable'; // the store threw mid-operation (disk I/O, corruption)

export class StoreError extends Error implements TypedError {
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}
```

`src/main/local-store/db.ts`:

```typescript
import Database from 'better-sqlite3';

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
```

Adjust import extensions (`./db.js` vs `./db`) to the convention found in Task 0's check.

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm vitest run tests/local-store-db.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/local-store tests/local-store-db.test.ts
git commit -m "feat(local-store): openDatabase with WAL + FULL fsync, typed store errors (ADR-9)"
```

---

### Task 3: Versioned migrations + v1 schema (jobs, job_attempts)

**Files:**
- Create: `src/main/local-store/migrations.ts`
- Test: `tests/local-store-migrations.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/local-store-migrations.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { openDatabase, closeDatabase } from '../src/main/local-store/db.js';
import { migrate, MIGRATIONS } from '../src/main/local-store/migrations.js';
import { StoreError } from '../src/main/local-store/errors.js';

describe('migrate', () => {
  it('applies all pending migrations to a fresh database and records them', () => {
    const db = openDatabase({ file: null });
    const ran = migrate(db);
    expect(ran).toBe(MIGRATIONS.length);
    const tables = db
      .prepare("select name from sqlite_master where type='table' order by name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain('jobs');
    expect(tables).toContain('job_attempts');
    expect(tables).toContain('schema_migrations');
    closeDatabase(db);
  });

  it('is idempotent — second run applies nothing', () => {
    const db = openDatabase({ file: null });
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(migrate(db)).toBe(0);
    closeDatabase(db);
  });

  it('enforces the unique idempotency index across restarts', () => {
    const db = openDatabase({ file: null });
    migrate(db);
    const insert = db.prepare(
      `insert into jobs (id, idempotency_key, tenant_id, restaurant_id, printer_id, doc_type,
         doc_version, payload_json, priority, copies, status, attempts, created_at, updated_at)
       values ('j1', 'k1', 't', 'r', 'p', 'customer_receipt', 1, '{}', 5, 1, 'accepted', 0, 1, 1)`,
    );
    expect(() => {
      insert.run();
      insert.run();
    }).toThrow();
    closeDatabase(db);
  });

  it('refuses to open a database migrated by a newer build (no downgrade)', () => {
    const db = openDatabase({ file: null });
    db.exec('create table schema_migrations (version integer primary key, name text not null, applied_at integer not null)');
    db.prepare('insert into schema_migrations values (?, ?, ?)').run(9_999, 'from_the_future', 0);
    expect(() => migrate(db)).toThrow(StoreError);
    closeDatabase(db);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run tests/local-store-migrations.test.ts
```

Expected: FAIL — module `migrations.js` does not exist.

- [ ] **Step 3: Implement**

`src/main/local-store/migrations.ts`:

```typescript
import type { SqliteDatabase } from './db.js';
import { StoreError } from './errors.js';

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
  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[];
  const applied = new Set(appliedRows.map((r) => r.version));
  const onDiskMax = Math.max(0, ...applied);
  const highestKnown = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
  if (onDiskMax > highestKnown) {
    throw new StoreError('db_version_newer', `local store schema v${onDiskMax} is newer than this build (v${highestKnown})`);
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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm vitest run tests/local-store-migrations.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/local-store/migrations.ts tests/local-store-migrations.test.ts
git commit -m "feat(local-store): versioned migration runner + v1 jobs/job_attempts schema (arch §6)"
```

---

### Task 4: JobStore — the SQLite job repository

**Files:**
- Create: `src/main/local-store/job-store.ts`
- Test: `tests/job-store.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/job-store.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { openDatabase, closeDatabase } from '../src/main/local-store/db.js';
import { migrate } from '../src/main/local-store/migrations.js';
import { createSqliteJobStore } from '../src/main/local-store/job-store.js';
import type { NewJobRow } from '../src/main/local-store/job-store.js';

function makeStore() {
  const db = openDatabase({ file: null });
  migrate(db);
  return { db, store: createSqliteJobStore(db) };
}

function makeRow(overrides: Partial<NewJobRow> = {}): NewJobRow {
  return {
    id: 'job-1',
    idempotencyKey: 'key-1',
    tenantId: 'tenant-1',
    restaurantId: 'rest-1',
    printerId: 'printer-1',
    docType: 'customer_receipt',
    docVersion: 1,
    payloadJson: '{"kind":"customer_receipt_v1"}',
    priority: 5,
    copies: 1,
    status: 'accepted',
    reprintOf: null,
    createdAt: 1_000,
    expiresAt: null,
    lastError: null,
    ...overrides,
  };
}

describe('sqlite JobStore', () => {
  it('persists and reads back every field', () => {
    const { store } = makeStore();
    store.insert(makeRow());
    const row = store.get('job-1');
    expect(row).toMatchObject({
      id: 'job-1',
      idempotencyKey: 'key-1',
      status: 'accepted',
      attempts: 0,
      priority: 5,
      copies: 1,
      createdAt: 1_000,
      sentAt: null,
      completedAt: null,
    });
  });

  it('returns null for unknown ids and finds rows by idempotency scope', () => {
    const { store } = makeStore();
    store.insert(makeRow());
    expect(store.get('nope')).toBeNull();
    expect(store.findByIdempotency('rest-1', 'key-1')?.id).toBe('job-1');
    expect(store.findByIdempotency('other-restaurant', 'key-1')).toBeNull();
  });

  it('rejects duplicate (restaurant_id, idempotency_key) with unique_violation', () => {
    const { store } = makeStore();
    store.insert(makeRow());
    expect(() => store.insert(makeRow({ id: 'job-2' }))).toThrowError(/unique/i);
  });

  it('updateStatus stamps updated_at, sent_at on first send, completed_at on completion', () => {
    let t = 1_000;
    const { db, store } = makeStore();
    const clock = { now: () => t };
    // recreate store with injected clock
    const timed = createSqliteJobStore(db, clock);
    timed.insert(makeRow());
    t = 2_000;
    timed.updateStatus('job-1', 'rendered');
    t = 3_000;
    timed.updateStatus('job-1', 'sending');
    t = 4_000;
    timed.updateStatus('job-1', 'sent_to_printer');
    let row = timed.get('job-1');
    expect(row?.sentAt).toBe(4_000);
    t = 5_000;
    timed.updateStatus('job-1', 'completed');
    row = timed.get('job-1');
    expect(row?.sentAt).toBe(4_000); // first send time is preserved
    expect(row?.completedAt).toBe(5_000);
  });

  it('updateStatus records and can clear last_error', () => {
    const { store } = makeStore();
    store.insert(makeRow());
    store.updateStatus('job-1', 'failed', { lastError: 'connect_refused: printer down' });
    expect(store.get('job-1')?.lastError).toBe('connect_refused: printer down');
    store.updateStatus('job-1', 'accepted', { clearError: true });
    expect(store.get('job-1')?.lastError).toBeNull();
  });

  it('updateStatus on a missing row throws', () => {
    const { store } = makeStore();
    expect(() => store.updateStatus('ghost', 'rendered')).toThrow();
  });

  it('incrementAttempts and resetAttempts manage the counter', () => {
    const { store } = makeStore();
    store.insert(makeRow());
    expect(store.incrementAttempts('job-1')).toBe(1);
    expect(store.incrementAttempts('job-1')).toBe(2);
    store.resetAttempts('job-1');
    expect(store.get('job-1')?.attempts).toBe(0);
  });

  it('recordAttempt appends to the durable attempt history', () => {
    const { store } = makeStore();
    store.insert(makeRow());
    store.recordAttempt('job-1', 1, { outcome: 'connect_error', errorCode: 'connect_refused', errorMessage: 'ECONNREFUSED' }, 5_000);
    store.recordAttempt('job-1', 2, { outcome: 'completed' }, 6_000);
    const attempts = store.listAttempts('job-1');
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ attempt: 1, outcome: 'connect_error', errorCode: 'connect_refused' });
    expect(attempts[1]).toMatchObject({ attempt: 2, outcome: 'completed' });
  });

  it('listByStatus orders by priority then created_at, and counts non-terminal rows', () => {
    const { store } = makeStore();
    store.insert(makeRow({ id: 'b', priority: 3, createdAt: 1 }));
    store.insert(makeRow({ id: 'a', priority: 3, createdAt: 2 }));
    store.insert(makeRow({ id: 'c', priority: 9, createdAt: 0 }));
    store.insert(makeRow({ id: 'z', status: 'completed', updatedAt: 1 }));
    const order = store.listByStatus('accepted').map((r) => r.id);
    expect(order).toEqual(['b', 'a', 'c']);
    expect(store.countByStatus('accepted', 'rendered', 'sending')).toBe(3);
  });

  it('deleteWithAttempts removes the job and its history in one transaction', () => {
    const { db, store } = makeStore();
    store.insert(makeRow());
    store.recordAttempt('job-1', 1, { outcome: 'completed' }, 1);
    store.deleteWithAttempts(['job-1']);
    expect(store.get('job-1')).toBeNull();
    const left = db.prepare('select count(*) as n from job_attempts').get() as { n: number };
    expect(left.n).toBe(0);
  });
});
```

Note: `NewJobRow` (defined below) has no `updatedAt` field — the store stamps it. `makeRow` with `status: 'completed'` override must still type-check: include `updatedAt` in the `NewJobRow` type as optional-with-default? No — see implementation: `NewJobRow` carries `updatedAt: number` and `makeRow` supplies `updatedAt: 0` by default; add `updatedAt: 0` to `makeRow`'s literal and to the `completed` override row. Adjust the test above: add `updatedAt: 0` to `makeRow`'s defaults and `updatedAt: 100` to the `z` row.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run tests/job-store.test.ts
```

Expected: FAIL — `createSqliteJobStore` does not exist.

- [ ] **Step 3: Implement**

`src/main/local-store/job-store.ts`:

```typescript
import type { SqliteDatabase } from './db.js';
import { StoreError } from './errors.js';

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

export type NewJobRow = Omit<JobRow, 'sentAt' | 'completedAt'>;

export interface AttemptRecord {
  readonly outcome: string; // 'render_error' | 'connect_error' | 'write_ambiguous' | 'ambiguous_crash' | 'completed' | 'cancelled'
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
  return typeof err === 'object' && err !== null && 'code' in err &&
    String((err as { code: unknown }).code).startsWith('SQLITE_CONSTRAINT');
}

export function createSqliteJobStore(
  db: SqliteDatabase,
  clock: { now: () => number } = { now: Date.now },
): JobStore {
  const insertStmt = db.prepare(`
    INSERT INTO jobs (id, idempotency_key, tenant_id, restaurant_id, printer_id, doc_type, doc_version,
                      payload_json, priority, copies, status, attempts, reprint_of, created_at, expires_at,
                      updated_at, last_error)
    VALUES (@id, @idempotencyKey, @tenantId, @restaurantId, @printerId, @docType, @docVersion,
            @payloadJson, @priority, @copies, @status, @attempts, @reprintOf, @createdAt, @expiresAt,
            @updatedAt, @lastError)
  `);
  const updateStatusStmt = db.prepare(`
    UPDATE jobs SET status = @status, updated_at = @at,
      sent_at = CASE WHEN @status IN ('sent_to_printer', 'completed') AND sent_at IS NULL THEN @at ELSE sent_at END,
      completed_at = CASE WHEN @status = 'completed' THEN @at ELSE completed_at END,
      last_error = CASE WHEN @clearError = 1 THEN NULL ELSE COALESCE(@lastError, last_error) END
    WHERE id = @id
  `);

  return {
    insert(row) {
      try {
        insertStmt.run({ ...row, sentAt: undefined, completedAt: undefined } as never);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new StoreError('unique_violation', `duplicate (restaurant_id, idempotency_key): ${row.restaurantId}/${row.idempotencyKey}`);
        }
        throw err;
      }
    },
    get(id) {
      const r = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobDbRow | undefined;
      return r === undefined ? null : toRow(r);
    },
    findByIdempotency(restaurantId, idempotencyKey) {
      const r = db.prepare('SELECT * FROM jobs WHERE restaurant_id = ? AND idempotency_key = ?').get(restaurantId, idempotencyKey) as JobDbRow | undefined;
      return r === undefined ? null : toRow(r);
    },
    updateStatus(id, status, patch) {
      const info = updateStatusStmt.run({
        id,
        status,
        at: clock.now(),
        lastError: patch?.lastError ?? null,
        clearError: patch?.clearError === true ? 1 : 0,
      });
      if (info.changes === 0) {
        throw new StoreError('store_unavailable', `updateStatus: no such job ${id}`);
      }
    },
    incrementAttempts(id) {
      const r = db.prepare('UPDATE jobs SET attempts = attempts + 1, updated_at = ? WHERE id = ? RETURNING attempts').get(clock.now(), id) as { attempts: number } | undefined;
      if (r === undefined) throw new StoreError('store_unavailable', `incrementAttempts: no such job ${id}`);
      return r.attempts;
    },
    resetAttempts(id) {
      const info = db.prepare('UPDATE jobs SET attempts = 0, updated_at = ? WHERE id = ?').run(clock.now(), id);
      if (info.changes === 0) throw new StoreError('store_unavailable', `resetAttempts: no such job ${id}`);
    },
    recordAttempt(jobId, attempt, record, at) {
      db.prepare('INSERT INTO job_attempts (job_id, attempt, outcome, error_code, error_message, at) VALUES (?, ?, ?, ?, ?, ?)').run(
        jobId,
        attempt,
        record.outcome,
        record.errorCode ?? null,
        record.errorMessage ?? null,
        at,
      );
    },
    listAttempts(jobId) {
      return (db.prepare('SELECT * FROM job_attempts WHERE job_id = ? ORDER BY attempt ASC').all(jobId) as Array<Record<string, unknown>>).map((r) => ({
        jobId: r['job_id'] as string,
        attempt: r['attempt'] as number,
        outcome: r['outcome'] as string,
        errorCode: (r['error_code'] as string | null) ?? null,
        errorMessage: (r['error_message'] as string | null) ?? null,
        at: r['at'] as number,
      }));
    },
    listByStatus(...statuses) {
      const placeholders = statuses.map(() => '?').join(', ');
      const rows = db.prepare(`SELECT * FROM jobs WHERE status IN (${placeholders}) ORDER BY priority ASC, created_at ASC, id ASC`).all(...statuses) as JobDbRow[];
      return rows.map(toRow);
    },
    countByStatus(...statuses) {
      const placeholders = statuses.map(() => '?').join(', ');
      const r = db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status IN (${placeholders})`).get(...statuses) as { n: number };
      return r.n;
    },
    terminalIdsOlderThan(cutoff, limit) {
      const marks = TERMINAL.map(() => '?').join(', ');
      const rows = db.prepare(`SELECT id FROM jobs WHERE status IN (${marks}) AND updated_at < ? ORDER BY updated_at ASC LIMIT ?`).all(...TERMINAL, cutoff, limit) as Array<{ id: string }>;
      return rows.map((r) => r.id);
    },
    deleteWithAttempts(ids) {
      const remove = db.transaction((ids: readonly string[]) => {
        const delA = db.prepare('DELETE FROM job_attempts WHERE job_id = ?');
        const delJ = db.prepare('DELETE FROM jobs WHERE id = ?');
        for (const id of ids) {
          delA.run(id);
          delJ.run(id);
        }
      });
      remove(ids);
    },
  };
}
```

Implementation notes:
- The `insert` spread with `sentAt: undefined, completedAt: undefined` plus `as never` is deliberately simple; if the project's lint rules reject `as never`, instead destructure `NewJobRow` and build an explicit parameter object without the two absent keys.
- `insert` must type-check without `sentAt`/`completedAt` (they are `Omit`ted from `NewJobRow` and the SQL uses named parameters that don't reference them) — remove the spread hack if unnecessary and pass `row` directly.

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm vitest run tests/job-store.test.ts
```

Expected: PASS (10 tests). Fix the `makeRow`/`updatedAt` typing noted in Step 1 if the compiler complains.

- [ ] **Step 5: Commit**

```bash
git add src/main/local-store/job-store.ts tests/job-store.test.ts
git commit -m "feat(local-store): SQLite job repository — statuses, timestamps, attempt history, retention queries"
```

---

### Task 5: Job engine — types, errors, durable intake with duplicate suppression

**Files:**
- Create: `src/main/jobs/types.ts`
- Create: `src/main/jobs/errors.ts`
- Create: `src/main/jobs/engine.ts` (intake-only skeleton)
- Test: `tests/job-engine-intake.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/job-engine-intake.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { openDatabase, closeDatabase } from '../src/main/local-store/db.js';
import { migrate } from '../src/main/local-store/migrations.js';
import { createSqliteJobStore } from '../src/main/local-store/job-store.js';
import { createPrinterStore } from '../src/main/printers/store.js';
import { createMemorySettingsAdapter } from './helpers/memory-adapter.js';
import { makeDraft } from './helpers/printers.js';
import { makeDoc } from './helpers/render.js';
import { createJobEngine } from '../src/main/jobs/engine.js';
import type { JobAck, PrintJobInput } from '../src/main/jobs/types.js';

// Fixed clock: 2026-01-01T00:00:00Z
const T0 = 1_767_225_600_000;

export interface Harness {
  engine: ReturnType<typeof createJobEngine>;
  acks: JobAck[];
  dispose: () => void;
}

export function makeHarness(options: { now?: () => number; maxPending?: number } = {}): Harness {
  const acks: JobAck[] = [];
  const db = openDatabase({ file: null });
  migrate(db);
  const store = createSqliteJobStore(db, { now: options.now ?? ((): number => T0) });
  const printerFile = 'printers.json';
  const printers = createPrinterStore({
    filePath: printerFile,
    adapter: createMemorySettingsAdapter(),
    newId: (() => {
      let n = 0;
      return () => `printer-${(n += 1)}`;
    })(),
  });
  const profile = printers.add(makeDraft());
  const transports = {
    forPrinter: () => {
      throw new Error('no transport in intake tests');
    },
  };
  const engine = createJobEngine({
    store,
    printers,
    transports,
    acks: { submit: (a) => acks.push(a) },
    now: options.now ?? ((): number => T0),
    schedule: () => {}, // intake tests never execute
    limits: options.maxPending === undefined ? {} : { maxPending: options.maxPending },
  });
  return {
    engine,
    acks,
    dispose: () => closeDatabase(db),
    printerId: profile.printerId,
  } as Harness & { printerId: string };
}

export function makeJob(overrides: Partial<PrintJobInput> = {}, printerId: string): PrintJobInput {
  return {
    jobId: 'job-1',
    idempotencyKey: 'key-1',
    tenantId: 'tenant-1',
    restaurantId: 'rest-1',
    printerId,
    priority: 5,
    copies: 1,
    docType: 'customer_receipt',
    docVersion: 1,
    expiresAt: null,
    payload: makeDoc(),
    ...overrides,
  };
}

describe('engine intake', () => {
  it('durably accepts a valid job and emits exactly one accepted ack', () => {
    const h = makeHarness();
    try {
      const ack = h.engine.submit(makeJob({}, h.printerId));
      expect(ack).toMatchObject({ jobId: 'job-1', status: 'accepted', printed: false, attempt: 1 });
      expect(ack.at).toBe(new Date(T0).toISOString());
      expect(h.acks).toHaveLength(1);
      // durable: readable from the store with all metadata
      const row = h.engine.getJob('job-1');
      expect(row).not.toBeNull();
      expect(row?.status).toBe('accepted');
      expect(row?.docType).toBe('customer_receipt');
    } finally {
      h.dispose();
    }
  });

  it('rejects jobs for an unknown printer without persisting them', () => {
    const h = makeHarness();
    try {
      const ack = h.engine.submit(makeJob({ printerId: 'ghost' }, h.printerId));
      expect(ack.status).toBe('rejected');
      expect(ack.error?.code).toBe('unknown_printer');
      expect(h.engine.getJob('job-1')).toBeNull();
    } finally {
      h.dispose();
    }
  });

  it('rejects expired jobs', () => {
    const h = makeHarness();
    try {
      const ack = h.engine.submit(makeJob({ expiresAt: T0 - 1 }, h.printerId));
      expect(ack.status).toBe('rejected');
      expect(ack.error?.code).toBe('job_expired');
    } finally {
      h.dispose();
    }
  });

  it('rejects unsupported doc versions', () => {
    const h = makeHarness();
    try {
      const ack = h.engine.submit(makeJob({ docVersion: 2 }, h.printerId));
      expect(ack.status).toBe('rejected');
      expect(ack.error?.code).toBe('unsupported_doc_version');
    } finally {
      h.dispose();
    }
  });

  it('rejects payloads that violate the doc model (api-contract §2: invalid_doc)', () => {
    const h = makeHarness();
    try {
      const ack = h.engine.submit(makeJob({ payload: { nope: true } }, h.printerId));
      expect(ack.status).toBe('rejected');
      expect(ack.error?.code).toBe('invalid_doc');
    } finally {
      h.dispose();
    }
  });

  it('suppresses duplicate delivery per (restaurant_id, idempotency_key) without re-execution', () => {
    const h = makeHarness();
    try {
      h.engine.submit(makeJob({}, h.printerId));
      h.engine.submit(makeJob({ jobId: 'job-1-dup' }, h.printerId)); // same idempotency key
      expect(h.acks.filter((a) => a.status === 'accepted')).toHaveLength(1);
      expect(h.engine.getJob('job-1-dup')).toBeNull();
    } finally {
      h.dispose();
    }
  });

  it('enforces the bounded queue size', () => {
    const h = makeHarness({ maxPending: 1 });
    try {
      h.engine.submit(makeJob({}, h.printerId));
      const ack = h.engine.submit(makeJob({ jobId: 'job-2', idempotencyKey: 'key-2' }, h.printerId));
      expect(ack.status).toBe('rejected');
      expect(ack.error?.code).toBe('queue_full');
    } finally {
      h.dispose();
    }
  });

  it('throws store_unavailable (no ack) when the database insert fails — the server re-delivers', () => {
    const h = makeHarness();
    try {
      const broken = makeJob({ printerId: h.printerId }, h.printerId);
      // fault injection: corrupt the doc payload AFTER validation by monkey-patching store is
      // covered in the db-failure suite; here verify the engine surfaces insert errors as
      // JobEngineError with code store_unavailable
      (h.engine as unknown as { deps: { store: { insert: () => void } } });
      expect(broken.jobId).toBe('job-1'); // placeholder assertion, replaced below
    } finally {
      h.dispose();
    }
  });
});
```

**Note on the last test:** delete that final placeholder test here — the real store-failure fault-injection test is written in Task 12. Also fix the harness: `makeHarness` returns `printerId` via the `as` cast — instead declare the harness interface explicitly:

```typescript
export interface Harness {
  engine: ReturnType<typeof createJobEngine>;
  acks: JobAck[];
  printerId: string;
  dispose: () => void;
}
```

Check `tests/helpers/printers.ts` and `tests/helpers/memory-adapter.ts` for the exact exported names (`makeDraft`, `createMemorySettingsAdapter`) before using them; adapt to actual names. Check `tests/helpers/render.ts` for `makeDoc` (a valid `DocV1` payload).

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run tests/job-engine-intake.test.ts
```

Expected: FAIL — `src/main/jobs/engine.js` does not exist.

- [ ] **Step 3: Implement**

`src/main/jobs/types.ts`:

```typescript
import type { PrinterStatus } from '../transport/types.js';

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
export const ACK_STATUSES = ['accepted', 'rejected', 'rendered', 'sent_to_printer', 'completed', 'failed', 'ambiguous'] as const;
export type AckStatus = (typeof ACK_STATUSES)[number];

export interface JobAck {
  readonly jobId: string;
  readonly status: AckStatus;
  readonly printerStatus: PrinterStatus; // always 'unknown' until DLE EOT lands (R-VAL-3)
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
```

`src/main/jobs/errors.ts`:

```typescript
import type { TypedError } from '../../shared/errors.js';

export type JobEngineErrorCode =
  | 'store_unavailable'   // DB failed; no ack is emitted so the server re-delivers
  | 'illegal_transition'; // caller violated an engine precondition (operator actions)

export class JobEngineError extends Error implements TypedError {
  readonly code: JobEngineErrorCode;
  constructor(code: JobEngineErrorCode, message: string) {
    super(message);
    this.name = 'JobEngineError';
    this.code = code;
  }
}
```

`src/main/jobs/engine.ts` — intake skeleton (execution tasks extend this file; the full final shape is assembled across Tasks 5–12, so each later task shows the exact functions being added or replaced):

```typescript
import { randomUUID } from 'node:crypto';
import { DocV1Schema } from '../render/doc.js';
import type { PrinterStore } from '../printers/store.js';
import type { TransportRegistry } from '../transport/registry.js';
import { StoreError } from '../local-store/errors.js';
import type { JobRow, JobStatus, JobStore } from '../local-store/job-store.js';
import { isTerminal } from '../local-store/job-store.js';
import type { AckSink, EngineLimits, JobAck, PrintJobInput } from './types.js';
import { ACK_STATUSES, DEFAULT_LIMITS } from './types.js';
import { JobEngineError } from './errors.js';

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
  /** Startup recovery: sending → ambiguous; accepted/rendered re-enqueued. */
  recover(): void;
  /** Read one job row (for UI/diagnostics). */
  getJob(jobId: string): JobRow | null;
  /** Operator: re-run a failed job (resets the attempt counter). */
  retryJob(jobId: string): void;
  /** Operator: print a copy of a terminal job as a NEW row with reprint_of set. Returns the new job id. */
  reprintJob(jobId: string): string;
  /** Operator: cancel before transmission only. Returns false when the job is past the safe point. */
  cancel(jobId: string): boolean;
  /** Retention: delete terminal rows past the limits. Returns the number deleted. */
  cleanup(): number;
  /** Non-terminal row count (queue depth). */
  pendingCount(): number;
}

export function createJobEngine(deps: JobEngineDeps): JobEngine {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? ((): string => randomUUID());
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => { setTimeout(fn, ms); });
  const limits: EngineLimits = { ...DEFAULT_LIMITS, ...deps.limits };
  const { store, printers, acks } = deps;

  const executing = new Set<string>(); // job ids with runJob in flight
  const pending = new Map<string, string[]>(); // printerId → queued job ids (best-first)

  function emit(row: JobRow, status: AckStatus, error?: JobAck['error']): void {
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
    switch (row.status) {
      case 'accepted': return emitCopy('accepted');
      case 'rendered': return emitCopy('rendered');
      case 'sending': return emitCopy('accepted'); // still in flight, nothing sent yet is knowable
      case 'printer_ack': return emitCopy('completed');
      case 'rejected': return ackFromStoredError(row, 'rejected');
      case 'failed': return ackFromStoredError(row, 'failed');
      default: return emitCopy(row.status as AckStatus);
    }
    function emitCopy(status: AckStatus): JobAck {
      return {
        jobId: row.id,
        status,
        printerStatus: 'unknown',
        printed: false,
        attempt: Math.max(row.attempts, 1),
        at: new Date(now()).toISOString(),
      };
    }
  }

  function submit(job: PrintJobInput): JobAck {
    if (printers.get(job.printerId) === null) {
      return rejectAck(job, 'unknown_printer', `printer ${job.printerId} is not configured`);
    }
    if (job.docVersion !== 1) {
      return rejectAck(job, 'unsupported_doc_version', `doc_version ${job.docVersion} is not supported`);
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
    enqueueExecution(job.printerId, job.jobId); // defined in Task 6; in this task a no-op stub
    return emit(row, 'accepted');
  }

  function getJob(jobId: string): JobRow | null {
    return store.get(jobId);
  }

  function pendingCount(): number {
    return store.countByStatus(...NON_TERMINAL);
  }

  // Task 6 adds: enqueueExecution, drain, runJob, failJob, safeClose, codeOf, msgOf.
  // Task 7 adds: scheduleRetryOr (replaces the open-failure handling in runJob).
  // Task 10 adds: recover, retryJob, reprintJob, cancel, cleanup.
  return {
    submit,
    getJob,
    pendingCount,
    recover: (): void => {
      throw new Error('not implemented until Task 10');
    },
    retryJob: (): void => {
      throw new Error('not implemented until Task 10');
    },
    reprintJob: (): string => {
      throw new Error('not implemented until Task 10');
    },
    cancel: (): boolean => {
      throw new Error('not implemented until Task 10');
    },
    cleanup: (): number => {
      throw new Error('not implemented until Task 10');
    },
  };
}
```

Adjust: `ACK_STATUSES` import is used by `duplicateAck`'s default branch cast; `enqueueExecution` — in this task, add a temporary stub just above `submit`:

```typescript
function enqueueExecution(_printerId: string, _jobId: string): void {
  // replaced in Task 6 with the per-printer scheduler
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm vitest run tests/job-engine-intake.test.ts
```

Expected: PASS (7 tests, after removing the placeholder last test).

- [ ] **Step 5: Commit**

```bash
git add src/main/jobs tests/job-engine-intake.test.ts
git commit -m "feat(jobs): engine intake — validation, durable accept, idempotent duplicate suppression, bounded queue (T4, arch §5)"
```

---

### Task 6: Execution — render → sending → write copies → sent_to_printer → completed

**Files:**
- Create: `tests/helpers/fake-transport.ts`
- Modify: `src/main/jobs/engine.ts`
- Test: `tests/job-engine-execution.test.ts`

- [ ] **Step 1: Write the fake transport helper**

`tests/helpers/fake-transport.ts` — a scripted `PrinterTransport` (read `src/main/transport/types.ts` first and implement exactly that interface):

```typescript
import type { PrinterTransport, PrinterStatus } from '../../src/main/transport/types.js';
import type { TransportRegistry } from '../../src/main/transport/registry.js';

export interface FakeTransportScript {
  /** open() rejects with this error (simulates printer disconnected). */
  readonly openError?: Error;
  /** write() rejects on the Nth write (1-based) with this error — simulates mid-stream disconnect. */
  readonly failWriteNumber?: number;
  readonly writeError?: Error;
}

export class FakeTransport implements PrinterTransport {
  readonly writes: Uint8Array[] = [];
  opens = 0;
  closes = 0;
  activeWrites = 0;
  maxConcurrentWrites = 0;
  statusCalls = 0;

  constructor(private readonly script: FakeTransportScript) {}

  async open(): Promise<void> {
    this.opens += 1;
    if (this.script.openError !== undefined) throw this.script.openError;
  }

  async write(bytes: Uint8Array): Promise<void> {
    this.activeWrites += 1;
    this.maxConcurrentWrites = Math.max(this.maxConcurrentWrites, this.activeWrites);
    try {
      if (this.script.failWriteNumber !== undefined && this.writes.length + 1 >= this.script.failWriteNumber) {
        throw this.script.writeError ?? new Error('write failed');
      }
      this.writes.push(bytes);
    } finally {
      this.activeWrites -= 1;
    }
  }

  async close(): Promise<void> {
    this.closes += 1;
  }

  async healthCheck(): Promise<void> {}

  status(): Promise<PrinterStatus> {
    this.statusCalls += 1;
    return Promise.resolve('unknown');
  }
}

export class FakeTransportRegistry implements TransportRegistry {
  private readonly transports = new Map<string, FakeTransport>();
  constructor(private readonly scriptFor: (printerId: string) => FakeTransportScript = () => ({})) {}

  forPrinter(profile: { readonly printerId: string }): FakeTransport {
    const existing = this.transports.get(profile.printerId);
    if (existing !== undefined) return existing;
    const t = new FakeTransport(this.scriptFor(profile.printerId));
    this.transports.set(profile.printerId, t);
    return t;
  }

  get(printerId: string): FakeTransport | undefined {
    return this.transports.get(printerId);
  }
}
```

- [ ] **Step 2: Write the failing test**

`tests/job-engine-execution.test.ts` (reuses `makeHarness`/`makeJob` from the intake test — refactor those two helpers into `tests/helpers/job-engine-harness.ts` and import from both test files; the harness needs two changes: accept a `transports` dep and use a real `schedule` that fires immediately so execution runs deterministically):

```typescript
// tests/helpers/job-engine-harness.ts
import { openDatabase, closeDatabase } from '../../src/main/local-store/db.js';
import { migrate } from '../../src/main/local-store/migrations.js';
import { createSqliteJobStore } from '../../src/main/local-store/job-store.js';
import { createPrinterStore } from '../../src/main/printers/store.js';
import { createMemorySettingsAdapter } from './memory-adapter.js';
import { makeDraft } from './printers.js';
import type { JobAck } from '../../src/main/jobs/types.js';
import type { TransportRegistry } from '../../src/main/transport/registry.js';
import type { JobEngine } from '../../src/main/jobs/engine.js';

const T0 = 1_767_225_600_000;

export interface Harness {
  readonly engine: JobEngine;
  readonly acks: JobAck[];
  readonly printerId: string;
  /** Jobs waiting on the injected schedule timer; tests flush them manually. */
  readonly timers: Array<() => void>;
  dispose(): void;
}

export interface HarnessOptions {
  readonly now?: () => number;
  readonly transports?: TransportRegistry;
  /** 'manual' (default): timers are collected in `timers` for deterministic tests. 'immediate': run retries synchronously. */
  readonly scheduling?: 'manual' | 'immediate';
  readonly limits?: { readonly maxPending?: number; readonly maxAttempts?: number };
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const acks: JobAck[] = [];
  const timers: Array<() => void> = [];
  const db = openDatabase({ file: null });
  migrate(db);
  const now = options.now ?? ((): number => T0);
  const store = createSqliteJobStore(db, { now });
  const printers = createPrinterStore({
    filePath: 'printers.json',
    adapter: createMemorySettingsAdapter(),
    newId: (() => { let n = 0; return (): string => `printer-${(n += 1)}`; })(),
  });
  const profile = printers.add(makeDraft());
  const schedule =
    options.scheduling === 'immediate'
      ? (fn: () => void): void => { fn(); }
      : (fn: () => void): void => { timers.push(fn); };
  const engine = createJobEngine({
    store,
    printers,
    transports: options.transports ?? { forPrinter: (): never => { throw new Error('no transport configured'); } },
    acks: { submit: (a) => acks.push(a) },
    now,
    schedule,
    limits: options.limits ?? {},
  });
  return {
    engine,
    acks,
    printerId: profile.printerId,
    timers,
    dispose: (): void => closeDatabase(db),
  };
}

export function makeJob(printerId: string, overrides: Partial<Parameters<JobEngine['submit']>[0]> = {}): Parameters<JobEngine['submit']>[0] {
  return {
    jobId: 'job-1',
    idempotencyKey: 'key-1',
    tenantId: 'tenant-1',
    restaurantId: 'rest-1',
    printerId,
    priority: 5,
    copies: 1,
    docType: 'customer_receipt',
    docVersion: 1,
    expiresAt: null,
    payload: makeDoc(),
    ...overrides,
  };
}
```

(Check `makeDoc` in `tests/helpers/render.ts` for its actual signature — it may need the doc-type argument, e.g. `makeDoc('customer_receipt')`. Adapt both call sites.)

Execution tests:

```typescript
import { describe, expect, it } from 'vitest';
import { makeHarness, makeJob } from './helpers/job-engine-harness.js';
import { FakeTransportRegistry } from './helpers/fake-transport.js';
import { decodeEscpos } from './helpers/escpos-decode.js';

async function drained(p: Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await p;
}

describe('engine execution', () => {
  it('happy path: accepted → rendered → sending → sent_to_printer → completed, in order, with copies loop', async () => {
    const transports = new FakeTransportRegistry();
    const h = makeHarness({ transports });
    try {
      h.engine.submit(makeJob(h.printerId, { copies: 2 }));
      await drained(Promise.resolve());
      const transport = transports.get(h.printerId);
      expect(transport?.writes).toHaveLength(2); // copies loop: one write per copy
      expect(transport?.closes).toBe(1);
      expect(h.acks.map((a) => a.status)).toEqual(['accepted', 'rendered', 'sent_to_printer', 'completed']);
      const row = h.engine.getJob('job-1');
      expect(row?.status).toBe('completed');
      expect(row?.sentAt).not.toBeNull();
      expect(row?.completedAt).not.toBeNull();
      expect(row?.attempts).toBe(1);
      expect(h.acks.every((a) => a.printed === false)).toBe(true);
      // the bytes are a valid ESC/POS receipt (decode helper already used by render tests)
      const events = decodeEscpos(transport?.writes[0] ?? new Uint8Array());
      expect(events.length).toBeGreaterThan(0);
    } finally {
      h.dispose();
    }
  });

  it('emits no sending ack and never sets printed (api-contract §3.1)', async () => {
    const transports = new FakeTransportRegistry();
    const h = makeHarness({ transports });
    try {
      h.engine.submit(makeJob(h.printerId));
      await drained(Promise.resolve());
      expect(h.acks.some((a) => a.status === ('sending' as never))).toBe(false);
      expect(h.acks.some((a) => a.status === ('printer_ack' as never))).toBe(false);
    } finally {
      h.dispose();
    }
  });

  it('does not re-execute a job whose idempotency key already completed (repeated delivery)', async () => {
    const transports = new FakeTransportRegistry();
    const h = makeHarness({ transports });
    try {
      h.engine.submit(makeJob(h.printerId));
      await drained(Promise.resolve());
      const writesAfterFirst = transports.get(h.printerId)?.writes.length ?? 0;
      expect(writesAfterFirst).toBeGreaterThan(0);
      h.engine.submit(makeJob(h.printerId, { jobId: 'dup-1' })); // same idempotency key
      await drained(Promise.resolve());
      expect(transports.get(h.printerId)?.writes.length).toBe(writesAfterFirst); // no second print
      expect(h.acks.filter((a) => a.jobId === 'dup-1' && a.status === 'completed')).toHaveLength(1);
    } finally {
      h.dispose();
    }
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm vitest run tests/job-engine-execution.test.ts
```

Expected: FAIL — engine never executes jobs (schedule stub + no runJob).

- [ ] **Step 4: Implement execution**

In `src/main/jobs/engine.ts`, add imports:

```typescript
import { renderDoc } from '../render/render.js';
import { renderProfileFromPrinterConfig } from '../render/profile.js';
```

Replace the `enqueueExecution` stub with the per-printer serialized scheduler (this also lands the Task 8 machinery early — priority ordering and single-flight-per-printer are structural):

```typescript
const transports = deps.transports;

/** Queue one job for execution on its printer. Jobs on the same printer run strictly one at a time. */
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
  void runJob(jobId)
    .catch((err: unknown) => {
      // Unexpected engine bug or store failure mid-flight. The row keeps whatever
      // status it had ('sending' → recovered to ambiguous on next start). Never crash the process.
      report(`job engine: unhandled error executing ${jobId}: ${String(err)}`);
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
```

Add `const draining = new Set<string>();` next to `executing`.

Add the execution core:

```typescript
const PRE_TRANSMISSION_CODES: ReadonlySet<string> = new Set([
  'connect_refused',
  'connect_timeout',
  'host_unreachable',
  'dns_unsupported',
  'not_open',
]);

function codeOf(err: unknown): string {
  return err instanceof Error && 'code' in err && typeof (err as { code: unknown }).code === 'string'
    ? (err as { code: string }).code
    : 'internal_error';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeClose(transport: { close(): Promise<void> }): void {
  void transport.close().catch((err: unknown) => report(`job engine: close failed (hand-off already done): ${String(err)}`));
}

/** Render error / unknown-printer failure: terminal, not retried (deterministic). */
function failJob(jobId: string, code: string, message: string, attempt: number): void {
  store.recordAttempt(jobId, attempt, { outcome: code === 'invalid_doc' || code === 'unsupported_doc_version' ? 'render_error' : code, errorCode: code, errorMessage: message }, now());
  store.updateStatus(jobId, 'failed', { lastError: `${code}: ${message}` });
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

  // -- render -------------------------------------------------------------
  if (row.status === 'accepted') store.updateStatus(jobId, 'rendered');
  const parsed = DocV1Schema.safeParse(JSON.parse(row.payloadJson) as unknown);
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

  // -- transmit -----------------------------------------------------------
  const attempt = store.incrementAttempts(jobId);
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
```

For this task, give `onConnectFailure` a placeholder that immediately fails, then replace it in Task 7:

```typescript
// TEMP (Task 6): replaced by retry logic in Task 7
function onConnectFailure(jobId: string, attempt: number, code: string, message: string): void {
  failJob(jobId, code, message, attempt);
}
```

Add:

```typescript
function onAmbiguous(jobId: string, attempt: number, code: string, message: string): void {
  store.recordAttempt(jobId, attempt, { outcome: 'write_ambiguous', errorCode: code, errorMessage: message }, now());
  store.updateStatus(jobId, 'ambiguous', { lastError: `${code}: ${message}` });
  const row = store.get(jobId);
  if (row !== null) emit(row, 'ambiguous', { code, message });
}
```

Also: `failJob` is called before transmission, where `attempts` was not yet incremented — the `attempt` parameter records the history row; keep `failJob` writing `updateStatus` with `lastError` (clearError semantics untouched).

- [ ] **Step 5: Run the tests**

```bash
pnpm vitest run tests/job-engine-execution.test.ts tests/job-engine-intake.test.ts
```

Expected: PASS. If ack order flakes (async drain), the `drained` helper already awaits a macrotask; verify `submit` is synchronous in emitting `accepted` (it is — the ack is returned, not pushed).

- [ ] **Step 6: Commit**

```bash
git add tests/helpers/fake-transport.ts tests/helpers/job-engine-harness.ts src/main/jobs/engine.ts tests/job-engine-execution.test.ts
git commit -m "feat(jobs): execution pipeline — render, durable sending marker, copies loop, sent_to_printer/completed acks"
```

---

### Task 7: Pre-transmission retry with bounded backoff; write failures are ambiguous

**Files:**
- Modify: `src/main/jobs/engine.ts`
- Test: `tests/job-engine-failures.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/job-engine-failures.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { makeHarness, makeJob } from './helpers/job-engine-harness.js';
import { FakeTransportRegistry } from './helpers/fake-transport.js';
import { TransportError } from '../src/main/transport/errors.js';

async function drained(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('engine failure semantics', () => {
  it('retries connect failures with backoff, then completes once the printer returns', async () => {
    let failFirst = 2; // first two opens fail
    const transports = new FakeTransportRegistry((printerId) =>
      failFirst-- > 0 ? { openError: new TransportError('connect_refused', `printer ${printerId} refused`) } : {},
    );
    const h = makeHarness({ transports });
    try {
      h.engine.submit(makeJob(h.printerId));
      await drained();
      // attempt 1 failed → retry scheduled
      expect(h.engine.getJob('job-1')?.status).toBe('rendered');
      expect(h.acks.at(-1)?.status).toBe('rendered'); // no failed ack yet
      h.timers.shift()?.(); // fire retry 1 → open fails again
      await drained();
      expect(h.engine.getJob('job-1')?.status).toBe('rendered');
      h.timers.shift()?.(); // fire retry 2 → printer is back
      await drained();
      const row = h.engine.getJob('job-1');
      expect(row?.status).toBe('completed');
      expect(row?.attempts).toBe(3);
      expect(transports.get(h.printerId)?.opens).toBe(3);
      expect(transports.get(h.printerId)?.writes.length).toBe(1); // printed exactly once
      expect(h.acks.at(-1)?.status).toBe('completed');
    } finally {
      h.dispose();
    }
  });

  it('fails terminally after maxAttempts exhausted, without writing any bytes', async () => {
    const transports = new FakeTransportRegistry(() => ({
      openError: new TransportError('connect_timeout', 'no answer'),
    }));
    const h = makeHarness({ transports, limits: { maxAttempts: 2 } });
    try {
      h.engine.submit(makeJob(h.printerId));
      await drained();
      h.timers.shift()?.();
      await drained();
      h.timers.shift()?.(); // fires the next-enqueue... but attempt 2 already failed terminally
      await drained();
      const row = h.engine.getJob('job-1');
      expect(row?.status).toBe('failed');
      expect(row?.lastError).toContain('connect_timeout');
      expect(transports.get(h.printerId)?.writes).toHaveLength(0); // never wrote a byte
      expect(h.acks.at(-1)).toMatchObject({ status: 'failed', error: { code: 'connect_timeout' } });
      expect(h.timers).toHaveLength(0); // no further retries scheduled
    } finally {
      h.dispose();
    }
  });

  it('marks ambiguous (never retries) when a write fails mid-stream', async () => {
    const transports = new FakeTransportRegistry(() => ({
      failWriteNumber: 1,
      writeError: new TransportError('write_timeout', 'printer vanished mid-ticket'),
    }));
    const h = makeHarness({ transports });
    try {
      h.engine.submit(makeJob(h.printerId, { copies: 2 }));
      await drained();
      const row = h.engine.getJob('job-1');
      expect(row?.status).toBe('ambiguous');
      expect(transports.get(h.printerId)?.writes).toHaveLength(0); // second copy never attempted
      expect(transports.get(h.printerId)?.opens).toBe(1); // no reconnect
      expect(h.acks.at(-1)).toMatchObject({ status: 'ambiguous', error: { code: 'write_timeout' } });
      // no retry timer for ambiguous jobs — outcome_unknown is operator territory
      h.timers.shift()?.();
      await drained();
      expect(h.engine.getJob('job-1')?.status).toBe('ambiguous');
      // the attempt history records the ambiguous write
      const attempts = (h.engine as unknown as { deps: { store: { listAttempts(id: string): Array<{ outcome: string }> } } }).deps.store.listAttempts('job-1');
      expect(attempts.some((a) => a.outcome === 'write_ambiguous')).toBe(true);
    } finally {
      h.dispose();
    }
  });
});
```

Note: the third test reaches into internals for `listAttempts`; expose attempts properly instead — add `listAttempts(jobId: string)` to the `JobEngine` interface (one-line delegation to the store) in Task 10's interface, or simply add it now to the returned object and interface:

```typescript
/** Attempt history (UI/diagnostics). */
listAttempts(jobId: string): JobAttemptRow[];
```

with implementation `listAttempts: (jobId) => store.listAttempts(jobId)`. Use `h.engine.listAttempts('job-1')` in the test. Import `JobAttemptRow` from the local-store module in `engine.ts`.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run tests/job-engine-failures.test.ts
```

Expected: FAIL — first test: job is `failed` immediately (Task 6 placeholder), no retry timers.

- [ ] **Step 3: Implement retry semantics**

In `src/main/jobs/engine.ts`, replace `onConnectFailure`:

```typescript
/** Pre-transmission failure: nothing was written, so retrying is safe (ADR-6 at-most-once per attempt). */
function onConnectFailure(jobId: string, attempt: number, code: string, message: string): void {
  store.recordAttempt(jobId, attempt, { outcome: 'connect_error', errorCode: code, errorMessage: message }, now());
  const row = store.get(jobId);
  if (row === null) return;
  if (row.attempts >= limits.maxAttempts) {
    store.updateStatus(jobId, 'failed', { lastError: `${code}: ${message}` });
    const failed = store.get(jobId);
    if (failed !== null) emit(failed, 'failed', { code, message });
    return;
  }
  store.updateStatus(jobId, 'rendered', { lastError: `${code}: ${message}` });
  const backoff = Math.min(limits.retryBaseDelayMs * 2 ** (row.attempts - 1), limits.retryMaxDelayMs);
  schedule(() => enqueueExecution(row.printerId, jobId), backoff);
}
```

Add `listAttempts` to the interface and return object:

```typescript
listAttempts: (jobId: string): JobAttemptRow[] => store.listAttempts(jobId),
```

- [ ] **Step 4: Run the tests**

```bash
pnpm vitest run tests/job-engine-failures.test.ts
```

Expected: PASS (3 tests). Note the exhaust test asserts `maxAttempts: 2` produces exactly 2 opens then `failed` with no further timer.

- [ ] **Step 5: Commit**

```bash
git add src/main/jobs/engine.ts tests/job-engine-failures.test.ts
git commit -m "feat(jobs): bounded backoff retry for pre-transmission failures; write failures land ambiguous, never auto-retried (ADR-5/6, T4)"
```

---

### Task 8: Per-printer serialization and priority ordering

**Files:**
- Test: `tests/job-engine-serialization.test.ts`
- (Scheduler code already landed in Task 6; this task proves it.)

- [ ] **Step 1: Write the test**

`tests/job-engine-serialization.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { makeHarness, makeJob } from './helpers/job-engine-harness.js';
import { FakeTransportRegistry } from './helpers/fake-transport.js';

async function drained(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('per-printer serialization', () => {
  it('never interleaves jobs on one printer (single flight), runs printers independently', async () => {
    const transports = new FakeTransportRegistry();
    const h = makeHarness({ transports });
    try {
      // Interleave submissions: two jobs on printer-1, one on printer-2.
      const draft2 = { ...makeDraftForSecond() };
      h.engine.submit(makeJob(h.printerId, { jobId: 'j1', idempotencyKey: 'k1' }));
      h.engine.submit(makeJob(h.printerId, { jobId: 'j2', idempotencyKey: 'k2' }));
      // create a second printer via the engine's printer store through a second harness is heavy;
      // instead verify single-flight on one printer and rely on printer-store tests for multi-printer
      await drained();
      const t = transports.get(h.printerId);
      expect(t?.maxConcurrentWrites).toBe(1); // no overlapping writes → no interleaved tickets
      expect(t?.writes.length).toBe(2);
    } finally {
      h.dispose();
    }
  });

  it('executes higher-priority jobs first when queued on the same printer', async () => {
    const transports = new FakeTransportRegistry();
    const h = makeHarness({ transports });
    try {
      // Priority 1 = highest. Submit low-priority first, then high — high must print first.
      h.engine.submit(makeJob(h.printerId, { jobId: 'low', idempotencyKey: 'kl', priority: 9 }));
      h.engine.submit(makeJob(h.printerId, { jobId: 'high', idempotencyKey: 'kh', priority: 1 }));
      await drained();
      // decode order: the transport saw 'high' before 'low' — assert via opens order using job sizes
      const t = transports.get(h.printerId);
      expect(t?.writes.length).toBe(2);
      // strongest observable: both completed and the engine drained in rank order
      expect(h.engine.getJob('high')?.status).toBe('completed');
      expect(h.engine.getJob('low')?.status).toBe('completed');
    } finally {
      h.dispose();
    }
  });
});
```

Priority-order observability: to make ordering directly assertable, have the harness's ack sink record `(jobId, status)` and assert `acks` contains `rendered` for `high` before `rendered` for `low`:

```typescript
const renderedOrder = h.acks.filter((a) => a.status === 'rendered').map((a) => a.jobId);
expect(renderedOrder).toEqual(['high', 'low']);
```

(Remove the unused `draft2`/`makeDraftForSecond` sketch — the first test only needs single-flight; cross-printer independence is covered by the transport registry being per-printer and is exercised again in the recovery suite.)

- [ ] **Step 2: Run the test**

```bash
pnpm vitest run tests/job-engine-serialization.test.ts
```

Expected: PASS with the Task 6 scheduler (the task is a regression net; if `maxConcurrentWrites` exceeds 1 or order is wrong, fix `drain`/`byRank` — do not proceed until green).

- [ ] **Step 3: Commit**

```bash
git add tests/job-engine-serialization.test.ts
git commit -m "test(jobs): per-printer single-flight serialization + priority ordering (R-VAL-6)"
```

---

### Task 9: Startup recovery and restart durability (fault injection: process restart)

**Files:**
- Modify: `src/main/jobs/engine.ts`
- Test: `tests/job-engine-recovery.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/job-engine-recovery.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, closeDatabase } from '../src/main/local-store/db.js';
import { migrate } from '../src/main/local-store/migrations.js';
import { createSqliteJobStore } from '../src/main/local-store/job-store.js';
import { createPrinterStore } from '../src/main/printers/store.js';
import { createMemorySettingsAdapter } from './helpers/memory-adapter.js';
import { makeDraft } from './helpers/printers.js';
import { makeDoc } from './helpers/render.js';
import { createJobEngine } from '../src/main/jobs/engine.js';
import { FakeTransportRegistry } from './helpers/fake-transport.js';
import type { JobAck } from '../src/main/jobs/types.js';

const T0 = 1_767_225_600_000;

/** Boot an engine against a real on-disk database — simulates a fresh process start. */
function boot(file: string, transports: FakeTransportRegistry, acks: JobAck[]) {
  const db = openDatabase({ file });
  migrate(db);
  const printers = createPrinterStore({
    filePath: 'printers.json',
    adapter: createMemorySettingsAdapter(),
    newId: (() => { let n = 0; return (): string => `printer-${(n += 1)}`; })(),
  });
  const profile = printers.add(makeDraft());
  const engine = createJobEngine({
    store: createSqliteJobStore(db, { now: (): number => T0 }),
    printers,
    transports,
    acks: { submit: (a) => acks.push(a) },
    now: (): number => T0,
    schedule: (): void => {}, // recovery tests never exercise backoff
  });
  return { engine, printerId: profile.printerId, dispose: (): void => closeDatabase(db) };
}

describe('crash recovery', () => {
  it('crash mid-write → restart: sending becomes ambiguous, never re-sent automatically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'print-agent-recovery-'));
    try {
      const file = join(dir, 'jobs.db');
      const transports = new FakeTransportRegistry();
      const acks: JobAck[] = [];

      // "Process 1": engine accepts a job; simulating a crash mid-transmission by
      // durably marking it 'sending' directly through the engine's own store path.
      const p1 = boot(file, transports, acks);
      p1.engine.submit(makeJobFor(p1.printerId));
      // Simulate: process died right after updateStatus('sending'), before write resolved.
      // Fastest honest simulation: reach into the store via the engine's public seam is not
      // possible, so use a second store handle on the same db through the same module.
      closeDatabase(p1.dispose); // placeholder — see Step 3 note
      p1.dispose();

      // "Process 2": restart on the same file, recover, verify.
      const acks2: JobAck[] = [];
      const p2 = boot(file, transports, acks2);
      p2.engine.recover();
      const row = p2.engine.getJob('job-1');
      expect(row?.status).toBe('ambiguous');
      expect(transports.get(p2.printerId)?.opens).toBe(0); // nothing re-sent
      expect(acks2.at(-1)).toMatchObject({ status: 'ambiguous', printed: false });
      p2.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('restart resumes accepted/rendered jobs to completion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'print-agent-recovery-'));
    try {
      const file = join(dir, 'jobs.db');
      const transports = new FakeTransportRegistry();
      const acks: JobAck[] = [];
      const p1 = boot(file, transports, acks);
      // accepted but never executed (schedule is a no-op in this harness)
      p1.engine.submit(makeJobFor(p1.printerId));
      p1.dispose();

      const acks2: JobAck[] = [];
      const p2 = boot(file, transports, acks2);
      p2.engine.recover();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(p2.engine.getJob('job-1')?.status).toBe('completed');
      expect(transports.get(p2.printerId)?.writes.length).toBe(1);
      p2.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('restart with a completed job re-delivered: no duplicate execution, completed acked from store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'print-agent-recovery-'));
    try {
      const file = join(dir, 'jobs.db');
      const transports = new FakeTransportRegistry();
      const acks: JobAck[] = [];
      const p1 = boot(file, transports, acks, { immediate: true });
      p1.engine.submit(makeJobFor(p1.printerId));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(p1.engine.getJob('job-1')?.status).toBe('completed');
      p1.dispose();

      const acks2: JobAck[] = [];
      const p2 = boot(file, transports, acks2);
      // same idempotency key re-delivered after restart
      const ack = p2.engine.submit(makeJobFor(p2.printerId, { jobId: 'redelivery-1' }));
      expect(ack.status).toBe('completed');
      expect(transports.get(p2.printerId)?.writes.length).toBe(1); // still exactly one print
      p2.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function makeJobFor(printerId: string, overrides: Record<string, unknown> = {}): never {
  throw new Error('replaced by import from harness helper below');
}
```

**Step 1 note (important):** the first test's "crash mid-write" simulation is the crux. The honest way: process 1 runs with an **immediate** scheduler and a transport whose `write` **never resolves** (a hanging promise). Then: submit, await one macrotask (job is now durably `sending`, write in flight), then `dispose()` (kills the "process" — the pending write is abandoned) and boot process 2. Add a `hang: true` option to `FakeTransportScript`:

```typescript
// in FakeTransport.write, before anything else:
if (this.script.hang === true) {
  return new Promise<void>(() => {}); // never resolves — write "in flight" forever
}
```

Then test 1 becomes:

```typescript
const transports = new FakeTransportRegistry(() => ({ hang: true }));
const p1 = boot(file, transports, acks);
p1.engine.submit(makeJobFor(p1.printerId));
await new Promise<void>((resolve) => setTimeout(resolve, 0)); // job now durably 'sending'
p1.dispose(); // crash: db closed under the in-flight write
```

Also: `makeJobFor` is `makeJob` from `tests/helpers/job-engine-harness.js` — import it instead of the throwing placeholder, and give `boot` the same `scheduling` option plumbing as the harness (`immediate` fires timers synchronously). Delete the placeholder `makeJobFor`.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run tests/job-engine-recovery.test.ts
```

Expected: FAIL — `recover()` throws "not implemented".

- [ ] **Step 3: Implement recovery**

In `src/main/jobs/engine.ts`, replace the `recover` stub:

```typescript
function recover(): void {
  // 1) Jobs caught mid-transmission by a crash: the write outcome is unknowable.
  //    They land in ambiguous — resolution is operator/policy action, never automatic (ADR-5).
  for (const row of store.listByStatus('sending')) {
    store.recordAttempt(
      row.id,
      Math.max(row.attempts, 1),
      { outcome: 'ambiguous_crash', errorCode: 'restarted_in_flight', errorMessage: 'agent restarted while job was transmitting' },
      now(),
    );
    store.updateStatus(row.id, 'ambiguous', { lastError: 'restarted_in_flight: agent restarted while job was transmitting' });
    const fresh = store.get(row.id);
    if (fresh !== null) emit(fresh, 'ambiguous', { code: 'restarted_in_flight', message: 'agent restarted while job was transmitting' });
  }
  // 2) Pre-transmission jobs survive the restart and resume from the queue.
  for (const row of store.listByStatus('accepted', 'rendered')) {
    if (printers.get(row.printerId) !== null) enqueueExecution(row.printerId, row.id);
  }
}
```

Return `recover` in the engine object (replace the throwing stub).

- [ ] **Step 4: Run the tests**

```bash
pnpm vitest run tests/job-engine-recovery.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/jobs/engine.ts tests/job-engine-recovery.test.ts tests/helpers/fake-transport.ts
git commit -m "feat(jobs): startup recovery — sending→ambiguous, resume pre-transmission jobs; restart fault-injection tests (AC-2/AC-3)"
```

---

### Task 10: Operator actions — retryJob, reprintJob, cancel

**Files:**
- Modify: `src/main/jobs/engine.ts`
- Test: `tests/job-engine-operator.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/job-engine-operator.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { makeHarness, makeJob } from './helpers/job-engine-harness.js';
import { FakeTransportRegistry } from './helpers/fake-transport.js';
import { TransportError } from '../src/main/transport/errors.js';
import { JobEngineError } from '../src/main/jobs/errors.js';

async function drained(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('operator actions', () => {
  it('retryJob re-runs a failed job and resets the attempt budget', async () => {
    let failFirst = 1;
    const transports = new FakeTransportRegistry(() =>
      failFirst-- > 0 ? { openError: new TransportError('connect_refused', 'down') } : {},
    );
    const h = makeHarness({ transports, limits: { maxAttempts: 1 } });
    try {
      h.engine.submit(makeJob(h.printerId));
      await drained();
      expect(h.engine.getJob('job-1')?.status).toBe('failed');
      h.engine.retryJob('job-1'); // explicit operator action
      await drained();
      const row = h.engine.getJob('job-1');
      expect(row?.status).toBe('completed');
      expect(row?.attempts).toBe(1); // budget was reset
      expect(transports.get(h.printerId)?.writes).toHaveLength(1);
    } finally {
      h.dispose();
    }
  });

  it('retryJob refuses non-failed jobs', async () => {
    const h = makeHarness({ transports: new FakeTransportRegistry() });
    try {
      expect(() => h.engine.retryJob('ghost')).toThrow(JobEngineError);
      h.engine.submit(makeJob(h.printerId, { schedulingImmediate: true } as never));
      await drained();
      expect(() => h.engine.retryJob('job-1')).toThrow(JobEngineError); // completed
    } finally {
      h.dispose();
    }
  });

  it('reprintJob creates a NEW row (reprint_of set, unique idempotency key) and prints it', async () => {
    const transports = new FakeTransportRegistry();
    const h = makeHarness({ transports });
    try {
      h.engine.submit(makeJob(h.printerId));
      await drained();
      const newId = h.engine.reprintJob('job-1');
      await drained();
      expect(newId).not.toBe('job-1');
      const reprint = h.engine.getJob(newId);
      expect(reprint?.reprintOf).toBe('job-1');
      expect(reprint?.status).toBe('completed');
      expect(reprint?.idempotencyKey).not.toBe('key-1'); // unique index would reject the original key
      expect(transports.get(h.printerId)?.writes.length).toBe(2); // original + reprint, both actually printed
    } finally {
      h.dispose();
    }
  });

  it('reprintJob is allowed for ambiguous jobs (operator resolution) and refused for non-terminal ones', async () => {
    const transports = new FakeTransportRegistry(() => ({ failWriteNumber: 1, writeError: new TransportError('write_failed', 'gone') }));
    const h = makeHarness({ transports });
    try {
      h.engine.submit(makeJob(h.printerId));
      await drained();
      expect(h.engine.getJob('job-1')?.status).toBe('ambiguous');
      expect(() => h.engine.reprintJob('in-flight')).toThrow(JobEngineError);
      const newId = h.engine.reprintJob('job-1');
      expect(h.engine.getJob(newId)?.reprintOf).toBe('job-1');
    } finally {
      h.dispose();
    }
  });

  it('cancel works before transmission only; once sending it is refused', async () => {
    const transports = new FakeTransportRegistry(() => ({ hang: true }));
    const h = makeHarness({ transports });
    try {
      h.engine.submit(makeJob(h.printerId));
      await drained();
      // write is hung in-flight → sending; cancellation must be refused (unsafe)
      expect(h.engine.getJob('job-1')?.status).toBe('sending');
      expect(h.engine.cancel('job-1')).toBe(false);
      expect(h.engine.getJob('job-1')?.status).toBe('sending');
    } finally {
      h.dispose();
    }
  });

  it('cancel of a queued-not-started job marks it failed without any print', async () => {
    const transports = new FakeTransportRegistry();
    const h = makeHarness({ transports });
    try {
      // submit two jobs: the first hangs nothing (completes), the second stays queued behind it is
      // already drained... simplest deterministic case: cancel immediately after submit — job may
      // already be running; to make it deterministic use a hanging OPEN so the job is 'rendered'
      // and executing is true → also refused. The cancellable window is tested via a manual
      // scheduler harness instead:
      const h2 = makeHarness({ transports: new FakeTransportRegistry(), scheduling: 'manual-drain' });
      h2.engine.submit(makeJob(h2.printerId));
      // nothing ran yet (manual scheduler gates execution? no — scheduling only gates retries)
      // → see implementation note below
      void h2;
      void h;
    } finally {
      h.dispose();
    }
  });
});
```

**Step 1 implementation note (cancellable window):** with the current design, `submit` synchronously enqueues and `drain` starts `runJob` in the same microtask chain — the deterministic cancellable case is "submit, then cancel before any macrotask ran". Since `drain()` invokes `runJob` synchronously up to the first `await` (the render happens synchronously; the first await is `transport.open()`), a job that was cancelled synchronously after `submit` will be observed by `runJob` as already terminal when it re-checks... Actually `runJob` starts executing immediately inside `drain` before `submit` returns. The reliable deterministic test: use a transport whose `open` **hangs** is the unsafe case (covered above); for the safe case, replace test 6 with a **queued second job**: submit `j1` (hanging write) then `j2` (queued behind it on the same printer), cancel `j2` synchronously — it is in `pending` with status `accepted`, `executing` does not contain it:

```typescript
it('cancel of a queued-not-started job marks it failed without any print', async () => {
  const transports = new FakeTransportRegistry((printerId) =>
    printerId === 'second' ? {} : { hang: true },
  );
  // Use two printers: job A hangs on printer-1; job B sits QUEUED on printer-1 behind it.
  const h = makeHarness({ transports });
  try {
    h.engine.submit(makeJob(h.printerId, { jobId: 'a', idempotencyKey: 'ka' }));
    h.engine.submit(makeJob(h.printerId, { jobId: 'b', idempotencyKey: 'kb' }));
    await drained();
    expect(h.engine.getJob('a')?.status).toBe('sending'); // hung mid-write
    expect(h.engine.getJob('b')?.status).toBe('accepted'); // queued, never started
    expect(h.engine.cancel('b')).toBe(true);
    expect(h.engine.getJob('b')?.status).toBe('failed');
    expect(h.engine.getJob('b')?.lastError).toContain('cancelled');
    // when A eventually resolves (never, here) B would not run: drain skips terminal rows
  } finally {
    h.dispose();
  }
});
```

(Also delete the sketchy sixth test above and the stray `schedulingImmediate` property in test 2 — submit the second `makeJob` plainly and await `drained()`.)

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run tests/job-engine-operator.test.ts
```

Expected: FAIL — the three operator methods still throw "not implemented".

- [ ] **Step 3: Implement**

In `src/main/jobs/engine.ts`, replace the three stubs:

```typescript
function retryJob(jobId: string): void {
  const row = store.get(jobId);
  if (row === null) throw new JobEngineError('illegal_transition', `retryJob: unknown job ${jobId}`);
  if (row.status !== 'failed') {
    throw new JobEngineError('illegal_transition', `retryJob: job ${jobId} is ${row.status}; only failed jobs can be retried`);
  }
  store.resetAttempts(jobId);
  store.updateStatus(jobId, 'accepted', { clearError: true });
  enqueueExecution(row.printerId, jobId);
}

function reprintJob(jobId: string): string {
  const row = store.get(jobId);
  if (row === null) throw new JobEngineError('illegal_transition', `reprintJob: unknown job ${jobId}`);
  if (!isTerminal(row.status) || row.status === 'rejected') {
    throw new JobEngineError('illegal_transition', `reprintJob: job ${jobId} is ${row.status}; only completed/failed/ambiguous jobs can be reprinted`);
  }
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
    expiresAt: null,
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
  const safeWindow = (row.status === 'accepted' || row.status === 'rendered') && !executing.has(jobId);
  if (!safeWindow) return false; // past the safe point (sending/terminal) — refuse
  const fromQueue = pending.get(row.printerId);
  if (fromQueue !== undefined) {
    const idx = fromQueue.indexOf(jobId);
    if (idx >= 0) fromQueue.splice(idx, 1);
  }
  store.recordAttempt(jobId, row.attempts + 1, { outcome: 'cancelled' }, now());
  store.updateStatus(jobId, 'failed', { lastError: 'cancelled: cancelled by operator before transmission' });
  const fresh = store.get(jobId);
  if (fresh !== null) emit(fresh, 'failed', { code: 'cancelled', message: 'cancelled by operator before transmission' });
  return true;
}
```

One fix required by the `hang` test: with the write hanging forever, the job is `sending` and `executing.has(jobId)` is true — cancel returns false. Good. But the queued-job cancel test needs the second job to still be queued when cancel runs: it is, because the printer chain is single-flight (`draining` holds printer-1 while `a` hangs).

- [ ] **Step 4: Run the tests**

```bash
pnpm vitest run tests/job-engine-operator.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/jobs/engine.ts tests/job-engine-operator.test.ts
git commit -m "feat(jobs): operator seams — retryJob (failed only), reprintJob (new row + reprint_of), cancel (pre-transmission only) (T4)"
```

---

### Task 11: Retention and cleanup

**Files:**
- Modify: `src/main/jobs/engine.ts` (replace `cleanup` stub)
- Test: `tests/job-engine-retention.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/job-engine-retention.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { makeHarness, makeJob } from './helpers/job-engine-harness.js';
import { FakeTransportRegistry } from './helpers/fake-transport.js';

describe('retention', () => {
  it('deletes only terminal rows past the cutoff, together with attempt history', async () => {
    let t = 1_000_000;
    const transports = new FakeTransportRegistry();
    const h = makeHarness({ transports, now: () => t, limits: { retentionDays: 1, retentionMaxRows: 100 } });
    try {
      h.engine.submit(makeJob(h.printerId, { jobId: 'old', idempotencyKey: 'k-old' }));
      await new Promise<void>((r) => setTimeout(r, 0));
      expect(h.engine.getJob('old')?.status).toBe('completed');
      t += 3 * 86_400_000; // 3 days pass
      h.engine.submit(makeJob(h.printerId, { jobId: 'new', idempotencyKey: 'k-new' }));
      await new Promise<void>((r) => setTimeout(r, 0));
      const deleted = h.engine.cleanup();
      expect(deleted).toBeGreaterThanOrEqual(1);
      expect(h.engine.getJob('old')).toBeNull();
      expect(h.engine.getJob('new')?.status).toBe('completed'); // untouched
      expect(h.engine.listAttempts('old')).toHaveLength(0); // history deleted with the job
    } finally {
      h.dispose();
    }
  });

  it('never deletes non-terminal rows regardless of age', async () => {
    const transports = new FakeTransportRegistry(() => ({ hang: true }));
    let t = 1_000_000;
    const h = makeHarness({ transports, now: () => t, limits: { retentionDays: 0, retentionMaxRows: 100 } });
    try {
      h.engine.submit(makeJob(h.printerId));
      await new Promise<void>((r) => setTimeout(r, 0));
      t += 400 * 86_400_000; // more than a year
      h.engine.cleanup();
      expect(h.engine.getJob('job-1')?.status).toBe('sending'); // still there — final state must be resolved first
    } finally {
      h.dispose();
    }
  });

  it('caps the number of terminal rows kept (retentionMaxRows)', async () => {
    const transports = new FakeTransportRegistry();
    const h = makeHarness({ transports, limits: { retentionDays: 0, retentionMaxRows: 2 } });
    try {
      for (let i = 1; i <= 4; i += 1) {
        h.engine.submit(makeJob(h.printerId, { jobId: `j${i}`, idempotencyKey: `k${i}` }));
        await new Promise<void>((r) => setTimeout(r, 0));
      }
      h.engine.cleanup();
      const remaining = ['j1', 'j2', 'j3', 'j4'].filter((id) => h.engine.getJob(id) !== null);
      expect(remaining.length).toBeLessThanOrEqual(2);
      expect(remaining).toContain('j4'); // newest kept
    } finally {
      h.dispose();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run tests/job-engine-retention.test.ts
```

Expected: FAIL — `cleanup` throws "not implemented".

- [ ] **Step 3: Implement**

Replace the `cleanup` stub:

```typescript
function cleanup(): number {
  const cutoff = now() - limits.retentionDays * 86_400_000;
  const ids = store.terminalIdsOlderThan(cutoff, limits.retentionMaxRows);
  if (ids.length === 0) return 0;
  store.deleteWithAttempts(ids); // single transaction; only ever terminal rows (safe-deletion rule)
  return ids.length;
}
```

Note: with `retentionDays: 0` the cutoff is `now`, and rows completed in the same clock tick (`updated_at === cutoff`) are **not** `< cutoff` — the max-rows test works because completion timestamps are equal; `terminalIdsOlderThan` uses `updated_at < cutoff` with `now()` advancing between jobs? In the harness the clock is fixed per test... Fix: the `retentionMaxRows` test must let time advance — change the harness call to `now: () => t` with `t += 1_000` inside the loop, or make `terminalIdsOlderThan` use `<=` for the max-rows path. Simplest correct semantics: keep `< cutoff` for the age path and order by `updated_at ASC LIMIT retentionMaxRows` **only among rows already past the cutoff**. Update the third test to advance `t += 1_000` per iteration and call cleanup after a final `t += 86_400_000`. Apply whichever keeps the semantics honest: age cutoff + count cap, no cap on fresh rows.

- [ ] **Step 4: Run the tests**

```bash
pnpm vitest run tests/job-engine-retention.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/jobs/engine.ts tests/job-engine-retention.test.ts
git commit -m "feat(jobs): retention — terminal-only deletion past age cutoff and row cap, attempts deleted atomically"
```

---

### Task 12: Database-failure fault injection

**Files:**
- Test: `tests/job-engine-db-failures.test.ts`
- Modify: `src/main/jobs/engine.ts` only if a gap surfaces

- [ ] **Step 1: Write the test**

`tests/job-engine-db-failures.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { makeHarness, makeJob } from './helpers/job-engine-harness.js';
import { FakeTransportRegistry } from './helpers/fake-transport.js';
import { JobEngineError } from '../src/main/jobs/errors.js';
import type { JobStore } from '../src/main/local-store/job-store.js';

/** Proxy that throws from a chosen method — simulates disk I/O failure / corruption. */
function failingStore(real: JobStore, broken: keyof JobStore): JobStore {
  return new Proxy(real, {
    get(target, prop: string) {
      if (prop === broken) {
        return () => {
          throw new Error(`simulated db failure in ${String(prop)}`);
        };
      }
      return target[prop as keyof JobStore] as unknown;
    },
  }) as JobStore;
}

describe('database failures (fault injection)', () => {
  it('intake insert failure → JobEngineError(store_unavailable), no ack (server re-delivers)', () => {
    const h = makeHarness();
    try {
      // Rebuild the engine with a store whose insert throws.
      // makeHarness exposes no store; construct the failure through a second engine over
      // the same db is complex — instead test at the store+engine seam with a dedicated harness:
      const acks: unknown[] = [];
      void acks;
      // Simplify: assert the engine wrapper converts a throwing store into JobEngineError.
      const engineWithBrokenStore = makeEngineWithStore(h, 'insert');
      expect(() => engineWithBrokenStore.submit(makeJobFor(engineWithBrokenStore))).toThrow(JobEngineError);
    } finally {
      h.dispose();
    }
  });

  it('store failure mid-execution does not crash the engine or double-print; recovery resolves the row on restart', async () => {
    // Covered end-to-end by the recovery suite; here: a store that throws on updateStatus('completed')
    // leaves the job 'sending' (durable), the engine keeps serving later jobs, and no second write happens.
    const transports = new FakeTransportRegistry();
    const h = makeHarness({ transports });
    try {
      h.engine.submit(makeJob(h.printerId, { jobId: 'a', idempotencyKey: 'ka' }));
      await new Promise<void>((r) => setTimeout(r, 0));
      expect(h.engine.getJob('a')?.status).toBe('completed');
      expect(transports.get(h.printerId)?.writes).toHaveLength(1);
    } finally {
      h.dispose();
    }
  });
});
```

**Step 1 note:** this test file needs a harness variant that injects a wrapped store. Extend `tests/helpers/job-engine-harness.ts` with a `store` option:

```typescript
export interface HarnessOptions {
  // ...existing
  readonly wrapStore?: (base: JobStore) => JobStore;
}
```

applied as `store: options.wrapStore ? options.wrapStore(baseStore) : baseStore`. Then the tests:

```typescript
it('intake insert failure → JobEngineError(store_unavailable), no ack', () => {
  const h = makeHarness({ wrapStore: (base) => failingStore(base, 'insert') });
  const acksBefore = h.acks.length;
  expect(() => h.engine.submit(makeJob(h.printerId))).toThrow(JobEngineError);
  expect(h.acks.length).toBe(acksBefore); // no accepted ack escaped
});

it('store failure after the write (recordAttempt) leaves the row recoverable, engine still serves', async () => {
  let broke = false;
  const transports = new FakeTransportRegistry();
  const h = makeHarness({
    transports,
    wrapStore: (base) => failingStore(base, broke ? 'recordAttempt' : 'get'),
  });
  try {
    h.engine.submit(makeJob(h.printerId, { jobId: 'a', idempotencyKey: 'ka' }));
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(h.engine.getJob('a')?.status).toBe('completed');
    broke = true; // next job's engine store calls throw mid-execution
    h.engine.submit(makeJob(h.printerId, { jobId: 'b', idempotencyKey: 'kb' }));
    await new Promise<void>((r) => setTimeout(r, 0));
    // Engine did not crash; job b is stuck durably at whatever the last successful
    // transition was ('sending' most likely) — restart/recover resolves it to ambiguous.
    const status = h.engine.getJob('b')?.status;
    expect(['sending', 'sent_to_printer']).toContain(status);
    expect(transports.get(h.printerId)?.writes.length).toBeLessThanOrEqual(2);
  } finally {
    h.dispose();
  }
});
```

Delete the two placeholder tests drafted above and use these two instead; keep the `failingStore` proxy helper.

- [ ] **Step 2: Run the test**

```bash
pnpm vitest run tests/job-engine-db-failures.test.ts
```

Expected: PASS. If the second test shows the engine crashing or double-writing, fix `runJob`'s catch in `drain` (it must never rethrow) before proceeding.

- [ ] **Step 3: Commit**

```bash
git add tests/job-engine-db-failures.test.ts tests/helpers/job-engine-harness.ts
git commit -m "test(jobs): db fault injection — intake failure surfaces store_unavailable, mid-flight store failure stays recoverable without double-print"
```

---

### Task 13: Documentation + full verification

**Files:**
- Create: `docs/job-engine.md`
- Modify: `docs/architecture.md` §3.2 job-engine row (one-line pointer to `docs/job-engine.md`) — only if the file has a natural place; do not restructure the normative doc.

- [ ] **Step 1: Write `docs/job-engine.md`**

Content skeleton (fill with the implemented reality — statuses, limits, operator seams as built):

```markdown
# Job engine & local persistence (P1)

Implementation of `docs/architecture.md` §5 (state machine, normative) and ADR-5/6/9.
Modules: `src/main/local-store/` (SQLite: connection, migrations, job repository — the single
owner of disk I/O for jobs) and `src/main/jobs/` (state machine + scheduling).

## The three milestones this system distinguishes (and never conflates)

1. **Local persistence (`accepted`)** — the job envelope is validated and committed to SQLite
   (WAL, `synchronous = FULL`). This is a durable local record. It says nothing about any printer.
2. **Printer/driver acceptance (`sent_to_printer`)** — the ESC/POS byte stream was written to the
   transport and the OS/driver accepted it (for `tcp_raw`: kernel buffer). This is NOT evidence
   that paper moved or that any ink hit paper.
3. **Confirmation of physical printing — DOES NOT EXIST.** There is no `printed` state, no
   `printed: true`, in any ack, log, or UI string (api-contract §3.1, ADR-5, security rule 8).
   `completed` means "hand-off to printer/driver succeeded". The best the UI can say is
   "Sent to printer (✓ hand-off)".

## Lifecycle

pushed → validated → `accepted` (persisted) → `rendered` → `sending` → `sent_to_printer` →
`completed`; branches: `rejected` (validation/expiry/tenant, never prints), `failed`
(terminal, manual retry), `ambiguous` (outcome unknown; operator or duplicate-policy resolution).

- Intake rejects (with acked error codes): `unknown_printer`, `unsupported_doc_version`,
  `job_expired`, `invalid_doc`, `queue_full`.
- Duplicate re-delivery per `(restaurant_id, idempotency_key)` is answered from the stored row
  and never re-executed; a completed job re-delivered → `completed` ack, zero prints.
- Retries: connect-phase failures only (nothing written yet), exponential backoff
  (2 s base, 60 s cap, `maxAttempts` = 3 by default), then terminal `failed`.
- Write-phase failures: `ambiguous`. Never retried automatically (at-most-once print attempt
  per execution, ADR-6).
- Crash between the `sending` marker and write resolution: on restart the row becomes
  `ambiguous` (`restarted_in_flight`). Never re-sent automatically.
- Retention: only terminal rows past `retentionDays` (14) — capped at `retentionMaxRows` (1000) —
  are deleted, with their `job_attempts` history, in one transaction. A job is never deleted
  before its final state is durably recorded.

## Operator actions (explicit, never automatic)

- `retryJob(id)` — `failed` jobs only; resets the attempt budget.
- `reprintJob(id)` — `completed`/`failed`/`ambiguous` jobs; creates a NEW row with `reprint_of`
  set and a fresh idempotency key (audit trail per threat model T4).
- `cancel(id)` — only while `accepted`/`rendered` and not executing; refused once `sending`.

## Attempt history

Every transport attempt is recorded in `job_attempts` (`connect_error`, `write_ambiguous`,
`ambiguous_crash`, `completed`, `cancelled`) with machine error codes. This is the audit
surface for duplicate-print investigations.

## Storage

- `better-sqlite3` 13.x (N-API prebuilds, no electron-rebuild; MIT — see
  `.research/dependency-research.md`). Dependency-admission vetting already recorded there.
- Migrations are versioned and append-only (`schema_migrations`); a database written by a
  newer build is refused, never downgraded.
- Job rows contain doc payload + metadata only. No credentials, no tokens, no PII in job rows
  or logs (threat model T7; identity/DPAPI is a separate store, later phase).
- Packaging TODO (P8): `better-sqlite3` must be `asarUnpack`ed; `@napi-rs/canvas` external
  (already flagged in render-pipeline.md §10).

## Test coverage map (fault injection)

| Fault | Test |
|---|---|
| Process restart mid-write | `tests/job-engine-recovery.test.ts` (hang-transport + dispose + re-boot) |
| Process restart pre-transmission | `tests/job-engine-recovery.test.ts` |
| Repeated delivery after completion | `tests/job-engine-recovery.test.ts`, `tests/job-engine-execution.test.ts` |
| Ambiguous outcome (write failure) | `tests/job-engine-failures.test.ts` |
| Database failure at intake | `tests/job-engine-db-failures.test.ts` |
| Database failure mid-execution | `tests/job-engine-db-failures.test.ts` |
| Printer disconnect (connect / mid-stream) | `tests/job-engine-failures.test.ts` |
```

- [ ] **Step 2: Full verification**

```bash
pnpm typecheck && pnpm lint && pnpm format && pnpm test
```

Expected: typecheck clean; lint clean; all tests pass (existing 23 node + 9 UI files plus the 9 new files from this plan). Fix anything surfaced.

- [ ] **Step 3: Commit**

```bash
git add docs/job-engine.md docs/architecture.md
git commit -m "docs: job engine & local persistence — lifecycle, ack semantics, operator seams, fault-injection map"
```

---

## Self-review notes

- **Spec coverage:** every user requirement maps to a task — migrations/transactions (T3), unique cloud job id + schema version + doc type + printer id + timestamps + attempt history + status (T3/T4), durability across restarts (T2/T9), state machine incl. failed/ambiguous branches (T5–T7), no duplicate execution (T5/T6/T9), bounded queue (T5), retention with safe deletion (T11), pre-transmission retry (T7), ambiguous → outcome_unknown without auto reprint (T7/T9), explicit retry/reprint (T10), safe-only cancellation (T10), per-printer serialization (T6/T8), no credentials in job data/logs (schema has none; T13 documents), fault-injection suite (T9/T12 + failure tests), persistence vs acceptance vs physical-print documentation (T13).
- **Type consistency:** `JobStore` methods used by the engine (`insert/get/findByIdempotency/updateStatus/incrementAttempts/resetAttempts/recordAttempt/listAttempts/listByStatus/countByStatus/terminalIdsOlderThan/deleteWithAttempts`) are all defined in Task 4; `JobRow` field names are camelCase at the interface and snake_case only inside the SQLite mapping. `Harness` in Task 5 is superseded by `tests/helpers/job-engine-harness.ts` in Task 6 — implementers should create the helper directly and point the intake test at it.
- **Known simplification:** `submit` returns the `accepted` ack synchronously while execution is async; P4's cloud client treats intake throw (`store_unavailable`) as "don't ack, let the server re-deliver" — documented in `JobEngineDeps`.
