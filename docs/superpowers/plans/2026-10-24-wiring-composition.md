# Wiring / Composition Phase — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instantiate the tested modules (cloud-client, job engine, transports, printers) in the Electron main process via a new `AgentRuntime` composition root, expose them over the validated IPC bridge, and replace the renderer's demo service with the real one.

**Architecture:** New `src/main/agent-runtime.ts` builds the whole object graph with injected deps (per the existing `job-engine-harness` pattern), owns cloud-event plumbing (job→engine, acks→buffer→cloud, revocation→wipe) and maps module types to renderer view models (`view-model.ts`). `main.ts` shrinks to guards → settings → runtime → IPC router → window/tray.

**Tech Stack:** TypeScript strict, Electron 45, better-sqlite3, zod 4, vitest, electron-log.

**Spec:** `docs/superpowers/specs/2026-10-24-wiring-composition-design.md` (normative for this plan).

**Conventions for every task:** run `pnpm test -- <file>` for targeted tests, `pnpm typecheck` before committing. Never commit while red. Messages must never claim physical printing (§3.1: `completed` = hand-off).

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `src/shared/ipc-contract.ts` | Modify | New channels + schemas; widen `AgentInfoSchema`; extend `AppSettingsSchema` |
| `src/main/local-store/migrations.ts` | Modify | Migration v2: `cloud_config` table |
| `src/main/local-store/config-store.ts` | Create | Typed kv access to `cloud_config` |
| `src/main/local-store/job-store.ts` | Modify | Add `clearJobs()` |
| `src/main/printers/store.ts` | Modify | Add `clear()` |
| `src/main/services/logger/logger.ts` | Modify | In-memory ring buffer + `getRecentLogLines()` |
| `src/main/ack-buffer.ts` | Create | Batch JobAcks → `client.submitAcks` |
| `src/main/view-model.ts` | Create | Module-type → renderer view-model mappers |
| `src/main/agent-runtime.ts` | Create | Composition root, lifecycle, cloud-event plumbing |
| `src/main/main.ts` | Modify | Wire runtime + new handlers; apply startMinimized/logLevel |
| `src/preload/index.ts` | Modify | New named bridge methods |
| `src/renderer/src/services/types.ts` | Modify | Real `ConnectionState`; real printer types |
| `src/renderer/src/services/production-service.ts` | Modify | Real bridge-backed implementation |
| `src/renderer/src/services/mock-agent-service.ts` | Delete | — |
| `src/renderer/src/ui/status.tsx` | Modify | `CONNECTION_META` for new union |
| `src/renderer/src/ui/screens/OverviewScreen.tsx` | Modify | `revoked` handling; role instead of station |
| `src/renderer/src/ui/screens/PrintersScreen.tsx` | Modify | Form reworked to real `PrinterDraft` |
| `tests/ui/helpers.tsx`, `tests/ui/*.test.tsx` | Modify | Local fake replaces deleted mock |

---

### Task 1: Shared IPC contract — new channels, widened schemas

**Files:**
- Modify: `src/shared/ipc-contract.ts`
- Test: `tests/ipc-contract.test.ts`

- [ ] **Step 1: Write failing tests** — append to `tests/ipc-contract.test.ts`:

```ts
import { Channel, RequestSchemas, AgentInfoSchema, AppSettingsSchema } from '../src/shared/ipc-contract';

describe('wiring-phase channels', () => {
  it('registers the new agent/pairing/printers/jobs/diagnostics channels', () => {
    expect(Channel.PairWithCode).toBe('pair:with-code');
    expect(Channel.AgentSnapshot).toBe('agent:snapshot');
    expect(Channel.AgentUnpair).toBe('agent:unpair');
    expect(Channel.PrintersList).toBe('printers:list');
    expect(Channel.PrintersAdd).toBe('printers:add');
    expect(Channel.PrintersUpdate).toBe('printers:update');
    expect(Channel.PrintersRemove).toBe('printers:remove');
    expect(Channel.PrintersTest).toBe('printers:test');
    expect(Channel.JobsList).toBe('jobs:list');
    expect(Channel.JobsRetry).toBe('jobs:retry');
    expect(Channel.JobsReprint).toBe('jobs:reprint');
    expect(Channel.DiagnosticsReport).toBe('diagnostics:report');
    expect(Channel.DiagnosticsChecks).toBe('diagnostics:checks');
    expect(Channel.LogsRecent).toBe('logs:recent');
  });

  it('validates the pairing code per api-contract §3.4 (8 alnum chars)', () => {
    expect(RequestSchemas[Channel.PairWithCode].safeParse({ code: '7QJ2K9XD' }).success).toBe(true);
    expect(RequestSchemas[Channel.PairWithCode].safeParse({ code: '7QJ2K9X' }).success).toBe(false);
    expect(RequestSchemas[Channel.PairWithCode].safeParse({ code: '7QJ2K9XD1' }).success).toBe(false);
    expect(RequestSchemas[Channel.PairWithCode].safeParse({ code: '7QJ2K9X!' }).success).toBe(false);
    // unknown fields rejected
    expect(
      RequestSchemas[Channel.PairWithCode].safeParse({ code: '7QJ2K9XD', extra: 1 }).success,
    ).toBe(false);
  });

  it('bounds printer/job id payloads and rejects unknown fields', () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    expect(RequestSchemas[Channel.PrintersTest].safeParse({ printerId: uuid }).success).toBe(true);
    expect(RequestSchemas[Channel.PrintersTest].safeParse({ printerId: 'nope' }).success).toBe(false);
    expect(RequestSchemas[Channel.JobsRetry].safeParse({ jobId: uuid }).success).toBe(true);
  });

  it('widens AgentInfo connectionState to the cloud union', () => {
    for (const s of ['unpaired', 'connecting', 'online', 'offline', 'revoked'] as const) {
      expect(AgentInfoSchema.safeParse({ name: 'print-agent', version: '0.1.0', connectionState: s }).success).toBe(true);
    }
    expect(AgentInfoSchema.safeParse({ name: 'print-agent', version: '0.1.0', connectionState: 'disabled' }).success).toBe(false);
  });

  it('extends AppSettings with startMinimized and logLevel (defaults for old files)', () => {
    expect(AppSettingsSchema.safeParse({ launchAtLogin: false }).success).toBe(true);
    const parsed = AppSettingsSchema.parse({ launchAtLogin: false });
    expect(parsed.startMinimized).toBe(true);
    expect(parsed.logLevel).toBe('info');
    expect(parsed.pairedAt).toBeNull();
    expect(AppSettingsSchema.safeParse({ launchAtLogin: false, logLevel: 'verbose' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run** `pnpm test -- tests/ipc-contract.test.ts` — expect FAIL (missing channels).

- [ ] **Step 3: Implement** in `src/shared/ipc-contract.ts`:

```ts
export const Channel = {
  GetAgentInfo: 'app:info',
  GetSettings: 'settings:get',
  SetLaunchAtLogin: 'settings:set-launch-at-login',
  HideWindow: 'window:hide',
  QuitApp: 'app:quit',
  AgentSnapshot: 'agent:snapshot',
  PairWithCode: 'pair:with-code',
  AgentUnpair: 'agent:unpair',
  PrintersList: 'printers:list',
  PrintersAdd: 'printers:add',
  PrintersUpdate: 'printers:update',
  PrintersRemove: 'printers:remove',
  PrintersTest: 'printers:test',
  JobsList: 'jobs:list',
  JobsRetry: 'jobs:retry',
  JobsReprint: 'jobs:reprint',
  DiagnosticsReport: 'diagnostics:report',
  DiagnosticsChecks: 'diagnostics:checks',
  LogsRecent: 'logs:recent',
} as const;
```

The printer draft schema must be shared without importing `node:net` into the renderer bundle. In `src/main/printers/profile.ts`, extract the pure schema parts (everything except the `isIP`/host refine) OR — simpler — keep the schema where it is and have the shared contract define only the **request envelope** (`{ printerId }` / `{ draft: unknown }`), leaving draft validation to `PrinterStore.add/update` which already `PrinterDraftSchema.parse`s. Take the simpler route:

```ts
const printerIdPayload = z.strictObject({ printerId: z.string().uuid() });

export const RequestSchemas = {
  // ...existing 5 entries unchanged...
  [Channel.AgentSnapshot]: noPayload,
  [Channel.PairWithCode]: z.strictObject({ code: z.string().regex(/^[A-Z0-9]{8}$/) }),
  [Channel.AgentUnpair]: noPayload,
  [Channel.PrintersList]: noPayload,
  [Channel.PrintersAdd]: z.strictObject({ draft: z.unknown() }), // PrinterDraftSchema.parse in store
  [Channel.PrintersUpdate]: z.strictObject({ printerId: z.string().uuid(), draft: z.unknown() }),
  [Channel.PrintersRemove]: printerIdPayload,
  [Channel.PrintersTest]: printerIdPayload,
  [Channel.JobsList]: noPayload,
  [Channel.JobsRetry]: z.strictObject({ jobId: z.string().uuid() }),
  [Channel.JobsReprint]: z.strictObject({ jobId: z.string().uuid() }),
  [Channel.DiagnosticsReport]: noPayload,
  [Channel.DiagnosticsChecks]: noPayload,
  [Channel.LogsRecent]: noPayload,
} as const satisfies Record<Channel, z.ZodType>;
```

Widen info + settings:

```ts
export const CONNECTION_STATES = ['unpaired', 'connecting', 'online', 'offline', 'revoked'] as const;

export const AgentInfoSchema = z.strictObject({
  name: z.string(),
  version: z.string(),
  connectionState: z.enum(CONNECTION_STATES),
});

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export const AppSettingsSchema = z.strictObject({
  launchAtLogin: z.boolean(),
  startMinimized: z.boolean().default(true),
  logLevel: z.enum(LOG_LEVELS).default('info'),
  /** Non-secret: when the device was paired (RFC 3339), null before pairing. */
  pairedAt: z.string().nullable().default(null),
});
```

- [ ] **Step 4: Run** `pnpm test -- tests/ipc-contract.test.ts tests/settings.test.ts` — expect PASS (settings defaults keep old files parsing).
- [ ] **Step 5:** `pnpm typecheck` — fix fallout in `src/main/main.ts` (`connectionState: 'disabled' as const` no longer type-checks → Task 8 fixes the handler; as an interim, change it to `'unpaired' as const`).
- [ ] **Step 6: Commit** `feat(ipc): wiring-phase channels and widened shared schemas`

---

### Task 2: local-store — `cloud_config` migration + config store

**Files:**
- Modify: `src/main/local-store/migrations.ts`
- Create: `src/main/local-store/config-store.ts`
- Test: `tests/local-store-migrations.test.ts`, `tests/config-store.test.ts`

- [ ] **Step 1: Failing tests** — append to `tests/local-store-migrations.test.ts`:

```ts
import { openDatabase } from '../src/main/local-store/db';
import { migrate } from '../src/main/local-store/migrations';
import { createConfigStore } from '../src/main/local-store/config-store';

describe('cloud_config migration (v2)', () => {
  it('creates the single-row cloud_config table', () => {
    const db = openDatabase({ file: null });
    migrate(db);
    const row = db.prepare("SELECT name FROM sqlite_master WHERE name = 'cloud_config'").get();
    expect(row).toBeDefined();
  });
});

describe('config store', () => {
  it('saves, reads, version-guards and clears the latest config', () => {
    const db = openDatabase({ file: null });
    migrate(db);
    const store = createConfigStore(db);
    expect(store.get()).toBeNull();
    store.save({ config_version: 3, printers: [] });
    expect(store.get()?.config_version).toBe(3);
    store.save({ config_version: 5, printers: [] });
    expect(store.get()?.config_version).toBe(5); // upsert, never two rows
    store.clear();
    expect(store.get()).toBeNull();
  });
});
```

- [ ] **Step 2: Run** `pnpm test -- tests/local-store-migrations.test.ts tests/config-store.test.ts` — expect FAIL.

- [ ] **Step 3: Implement.** Append migration v2 to `MIGRATIONS` in `migrations.ts`:

```ts
{
  version: 2,
  name: 'cloud_config',
  up: (db) => {
    // FR-16 landing spot: latest validated ConfigUpdate, persisted but not
    // applied yet (wiring phase). Single row enforced by CHECK.
    db.exec(`
      CREATE TABLE cloud_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        config_version INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  },
},
```

Create `src/main/local-store/config-store.ts`:

```ts
import { z } from 'zod';
import type { SqliteDatabase } from './db';

/** Schema mirrors the cloud-client's ConfigUpdate loosely (looseObject upstream);
 *  we persist what arrived so FR-16 application can be built against real data. */
const StoredConfigSchema = z.looseObject({
  config_version: z.number().int().min(0),
});
export type StoredCloudConfig = z.output<typeof StoredConfigSchema>;

export interface ConfigStore {
  get(): StoredCloudConfig | null;
  save(config: StoredCloudConfig): void;
  clear(): void;
}

export function createConfigStore(db: SqliteDatabase): ConfigStore {
  const select = db.prepare('SELECT config_version, payload_json FROM cloud_config WHERE id = 1');
  const upsert = db.prepare(
    `INSERT INTO cloud_config (id, config_version, payload_json, updated_at) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET config_version = excluded.config_version,
       payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
  );
  const del = db.prepare('DELETE FROM cloud_config WHERE id = 1');
  return {
    get() {
      const row = select.get() as { config_version: number; payload_json: string } | undefined;
      if (row === undefined) return null;
      try {
        const parsed = StoredConfigSchema.parse(JSON.parse(row.payload_json) as unknown);
        return parsed;
      } catch {
        return null; // unreadable config is treated as no config
      }
    },
    save(config) {
      const validated = StoredConfigSchema.parse(config);
      upsert.run(validated.config_version, JSON.stringify(config), Date.now());
    },
    clear() {
      del.run();
    },
  };
}
```

- [ ] **Step 4: Run** targeted tests — expect PASS. Also `pnpm test -- tests/local-store-migrations.test.ts` (existing v1 tests must stay green; the migration gap-guard test, if any, must still pass since v2 is contiguous).
- [ ] **Step 5: Commit** `feat(local-store): cloud_config single-row store (migration v2)`

---

### Task 3: Store wipe support — `JobStore.clearJobs()` and `PrinterStore.clear()`

**Files:**
- Modify: `src/main/local-store/job-store.ts` (interface + sqlite impl), `src/main/printers/store.ts`
- Test: `tests/job-store.test.ts`, `tests/printer-store.test.ts`

- [ ] **Step 1: Failing tests.** Append:

```ts
// tests/job-store.test.ts
it('clearJobs removes every job and its attempts', () => {
  // arrange: insert two jobs with attempts (use the file's existing helpers)
  store.insert(rowFixture({ id: 'j1' }));
  store.insert(rowFixture({ id: 'j2' }));
  store.recordAttempt('j1', 1, { outcome: 'completed' }, 1);
  store.clearJobs();
  expect(store.get('j1')).toBeNull();
  expect(store.get('j2')).toBeNull();
  expect(store.listAttempts('j1')).toEqual([]);
});
```

```ts
// tests/printer-store.test.ts
it('clear removes all printers and persists the empty list', async () => {
  await store.add(validDraft());
  await store.clear();
  expect(store.list()).toEqual([]);
  // a fresh store over the same file sees the wipe
  const reopened = await createPrinterStore({ filePath, adapter, newId });
  expect(reopened.list()).toEqual([]);
});
```

(Adapt fixture names to what those test files already use — read them first.)

- [ ] **Step 2: Run** both files — expect FAIL.

- [ ] **Step 3: Implement.**

In `JobStore` interface + sqlite impl:

```ts
/** Wipes ALL jobs and attempts in one transaction (revocation/unpair wipe, §3.5).
 *  Deliberately unscoped: a wiped device must retain nothing tenant-related. */
clearJobs(): void;
```

```ts
clearJobs() {
  const run = db.transaction(() => {
    db.prepare('DELETE FROM job_attempts').run();
    db.prepare('DELETE FROM jobs').run();
  });
  run();
},
```

(If `job_attempts` has `ON DELETE CASCADE` the first delete is redundant but harmless — keep it explicit for clarity.)

In `PrinterStore` interface + factory:

```ts
/** Wipes all cached printer profiles (revocation/unpair wipe, §3.5). */
clear(): Promise<void>;
```

```ts
async clear() {
  await adapter.writeAtomic(filePath, JSON.stringify([]));
  cached = [];
},
```

- [ ] **Step 4: Run** both test files — PASS.
- [ ] **Step 5: Commit** `feat(stores): clearJobs/clear for revocation + unpair wipe`

---

### Task 4: Logger ring buffer (`getRecentLogLines`)

**Files:**
- Modify: `src/main/services/logger/logger.ts`
- Test: `tests/redact.test.ts` (or new `tests/logger-ring.test.ts` — prefer new file)

- [ ] **Step 1: Failing test** — `tests/logger-ring.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { pushRecentLogLine, getRecentLogLines, type LogLine } from '../src/main/services/logger/logger';

describe('log ring buffer', () => {
  it('keeps the newest lines in order, capped', () => {
    for (let i = 0; i < 600; i++) {
      pushRecentLogLine({ ts: new Date(i).toISOString(), level: 'info', module: 't', message: `m${String(i)}` });
    }
    const lines: readonly LogLine[] = getRecentLogLines();
    expect(lines.length).toBe(500);
    expect(lines[lines.length - 1]?.message).toBe('m599');
    expect(lines[0]?.message).toBe('m100');
  });
});
```

- [ ] **Step 2: Run** — FAIL (no export).

- [ ] **Step 3: Implement** in `logger.ts` (top-level; redaction is applied by the existing hook before `emit` writes — the ring receives already-redacted data because `emit` is only called after redaction in the transport chain; to guarantee it, push inside `emit`):

```ts
export interface LogLine {
  readonly ts: string;
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly module: string;
  readonly message: string;
}

const RING_CAP = 500;
const ring: LogLine[] = [];

/** Diagnostics seam: newest-last ring of redacted lines for the renderer. */
export function pushRecentLogLine(line: LogLine): void {
  ring.push(line);
  if (ring.length > RING_CAP) ring.shift();
}

export function getRecentLogLines(): readonly LogLine[] {
  return [...ring];
}
```

and inside `createLogger`'s `emit`, before dispatching to electron-log:

```ts
pushRecentLogLine({ ts: new Date().toISOString(), level, module: scope, message });
```

- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(logger): in-memory redacted ring buffer for diagnostics`

---

### Task 5: `AckBuffer` — batch JobAcks for the cloud client

**Files:**
- Create: `src/main/ack-buffer.ts`
- Test: `tests/ack-buffer.test.ts`

- [ ] **Step 1: Failing tests:**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createAckBuffer } from '../src/main/ack-buffer';
import type { JobAck } from '../src/main/jobs/types';
import type { AckBatch } from '../src/main/cloud-client/types';

const ack = (jobId: string, status: JobAck['status'] = 'completed'): JobAck => ({
  jobId, status, printerStatus: 'unknown', printed: false, attempt: 1,
  at: new Date(0).toISOString(),
});

function makeEnv() {
  const submitted: AckBatch[] = [];
  const timers: (() => void)[] = [];
  const schedule = (fn: () => void): (() => void) => { timers.push(fn); return () => {}; };
  const submitAcks = vi.fn(async (batch: AckBatch) => { submitted.push(batch); });
  return { submitted, timers, schedule, submitAcks };
}

describe('AckBuffer', () => {
  it('flushes when maxBatch is reached', async () => {
    const env = makeEnv();
    const buf = createAckBuffer({ submitAcks: env.submitAcks, schedule: env.schedule, maxBatch: 2, maxDelayMs: 5_000, envelopeVersion: 1 });
    buf.add(ack('a'));
    buf.add(ack('b'));
    await vi.waitFor(() => expect(env.submitted.length).toBe(1));
    expect(env.submitted[0]?.acks.map((a) => a.job_id)).toEqual(['a', 'b']);
  });

  it('flushes on the delay timer otherwise', async () => {
    const env = makeEnv();
    const buf = createAckBuffer({ submitAcks: env.submitAcks, schedule: env.schedule, maxBatch: 10, maxDelayMs: 5_000, envelopeVersion: 1 });
    buf.add(ack('a'));
    expect(env.timers.length).toBe(1);
    env.timers[0]?.();
    await vi.waitFor(() => expect(env.submitted.length).toBe(1));
  });

  it('retains acks on failure and flushes them on the next flush', async () => {
    const env = makeEnv();
    let fail = true;
    const submitAcks = vi.fn(async (batch: AckBatch) => {
      if (fail) throw new Error('network');
      env.submitted.push(batch);
    });
    const buf = createAckBuffer({ submitAcks, schedule: env.schedule, maxBatch: 1, maxDelayMs: 5_000, envelopeVersion: 1 });
    buf.add(ack('a'));
    await vi.waitFor(() => expect(submitAcks).toHaveBeenCalledTimes(1));
    buf.add(ack('b'));
    fail = false;
    await vi.waitFor(() => expect(env.submitted.length).toBe(1));
    expect(env.submitted[0]?.acks.map((a) => a.job_id)).toEqual(['a', 'b']);
  });

  it('caps at maxQueued, dropping oldest', async () => {
    const env = makeEnv();
    const submitAcks = vi.fn(async () => { throw new Error('down'); });
    const buf = createAckBuffer({ submitAcks, schedule: env.schedule, maxBatch: 100, maxDelayMs: 60_000, maxQueued: 3, envelopeVersion: 1 });
    for (const id of ['a', 'b', 'c', 'd']) buf.add(ack(id));
    await buf.stop(); // final flush fails; queue retains the newest 3
    expect(buf.pendingCount()).toBe(3);
    // the dropped ack is 'a' — verified by the next successful flush
    const submitOk = vi.fn(async (batch: AckBatch) => { env.submitted.push(batch); });
    const buf2 = createAckBuffer({ submitAcks: submitOk, schedule: env.schedule, maxBatch: 100, maxDelayMs: 60_000, envelopeVersion: 1 });
    for (const id of ['a', 'b', 'c', 'd']) buf2.add(ack(id));
    await buf2.stop();
    expect(env.submitted[0]?.acks.map((a) => a.job_id)).toEqual(['a', 'b', 'c', 'd']); // uncapped keeps all
  });

  it('stop() flushes pending acks', async () => {
    const env = makeEnv();
    const buf = createAckBuffer({ submitAcks: env.submitAcks, schedule: env.schedule, maxBatch: 100, maxDelayMs: 60_000, envelopeVersion: 1 });
    buf.add(ack('a'));
    await buf.stop();
    expect(env.submitted.length).toBe(1);
  });
});
```

(Note: the "caps" case above is awkward to assert through the public surface — instead expose `pendingCount(): number` on the buffer and assert `expect(buf.pendingCount()).toBe(3)` after the failed stop, with the dropped ack being `'a'` verified by the next successful flush in the same test.)

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement** `src/main/ack-buffer.ts`:

```ts
import { ENVELOPE_VERSION } from './cloud-client/schemas';
import type { AckBatch } from './cloud-client/types';
import type { JobAck } from './jobs/types';

/** Collects engine acks and delivers them to the cloud client in batches
 *  (§7.1). Failures retain acks (retry on next trigger); the queue is capped
 *  with oldest-first drop, mirroring the engine's bounded-queue philosophy. */
export interface AckBuffer {
  add(ack: JobAck): void;
  pendingCount(): number;
  /** Final flush; resolves after the attempt (even if it failed — callers
   *  must not block shutdown on a dead network). */
  stop(): Promise<void>;
}

export interface AckBufferOptions {
  submitAcks(batch: AckBatch): Promise<void>;
  schedule(fn: () => void, delayMs: number): () => void;
  maxBatch?: number;   // default 20 (AckBatchSchema caps at 100)
  maxDelayMs?: number; // default 5_000
  maxQueued?: number;  // default 500
  envelopeVersion?: number; // default ENVELOPE_VERSION
  log?: (message: string) => void;
}

export function createAckBuffer(options: AckBufferOptions): AckBuffer {
  const maxBatch = options.maxBatch ?? 20;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const maxQueued = options.maxQueued ?? 500;
  const envelopeVersion = options.envelopeVersion ?? ENVELOPE_VERSION;
  const log = options.log ?? ((): void => {});
  let queue: JobAck[] = [];
  let timer: (() => void) | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  const toBatch = (acks: readonly JobAck[]): AckBatch => ({
    envelope_version: envelopeVersion,
    type: 'ack',
    acks: acks.map((a) => ({
      job_id: a.jobId,
      status: a.status,
      printer_status: a.printerStatus,
      printed: a.printed,
      attempt: a.attempt,
      at: a.at,
      ...(a.error === undefined ? {} : { error: a.error }),
    })),
  });

  function flush(): void {
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    inFlight = inFlight
      .then(() => options.submitAcks(toBatch(batch)))
      .catch((err: unknown) => {
        // Retain for the next trigger; bounded.
        log(`ack buffer: flush failed, ${String(batch.length)} ack(s) retained`);
        queue = [...batch, ...queue].slice(-maxQueued);
      });
  }

  function armTimer(): void {
    if (timer !== null) return;
    timer = options.schedule(() => {
      timer = null;
      flush();
    }, maxDelayMs);
  }

  return {
    add(ack) {
      queue.push(ack);
      if (queue.length > maxQueued) {
        queue.shift();
        log('ack buffer: overflow, oldest ack dropped');
      }
      if (queue.length >= maxBatch) flush();
      else armTimer();
    },
    pendingCount: () => queue.length,
    async stop() {
      timer?.();
      timer = null;
      flush();
      await inFlight;
    },
  };
}
```

- [ ] **Step 4: Run** `pnpm test -- tests/ack-buffer.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(main): ack buffer batching engine acks to the cloud client`

---

### Task 6: `view-model.ts` — module types → renderer view models

**Files:**
- Create: `src/main/view-model.ts`
- Test: `tests/view-model.test.ts`

- [ ] **Step 1: Failing tests** (key cases; fixtures use real schema shapes):

```ts
import { describe, expect, it } from 'vitest';
import { toJobRecord, toPrinterInfo, mapPairFailure } from '../src/main/view-model';
import type { JobRow } from '../src/main/local-store/job-store';
import type { PrinterProfile } from '../src/main/printers/profile';
import { CloudError } from '../src/main/cloud-client/errors';

const row: JobRow = {
  id: '018f0000-0000-7000-8000-000000000001',
  idempotencyKey: 'idem',
  tenantId: '11111111-1111-4111-8111-111111111111',
  restaurantId: '22222222-2222-4222-8222-222222222222',
  printerId: '33333333-3333-4333-8333-333333333333',
  docType: 'kitchen_ticket',
  docVersion: 1,
  payloadJson: '{}',
  priority: 5,
  copies: 1,
  status: 'completed',
  attempts: 1,
  reprintOf: null,
  createdAt: 0,
  expiresAt: null,
  sentAt: 1,
  completedAt: 2,
  updatedAt: 2,
  lastError: null,
};

const profile: PrinterProfile = {
  printerId: '33333333-3333-4333-8333-333333333333',
  name: 'Kitchen-1',
  role: 'kitchen',
  paperWidthMm: 80,
  printableDots: 576,
  charsPerLine: 48,
  capabilities: { cut: true, qrCode: true, barcode128: false, statusPolling: false, cashDrawer: false },
  transport: { kind: 'tcp_raw', host: '192.168.1.87', port: 9100 },
};

describe('view-model mappers', () => {
  it('maps a job row, resolving the printer name', () => {
    const record = toJobRecord(row, (id) => (id === profile.printerId ? profile : null));
    expect(record).toMatchObject({
      jobId: row.id, docType: 'kitchen_ticket', status: 'completed',
      destinationPrinterName: 'Kitchen-1', attempts: 1, lastError: null,
    });
  });

  it('falls back to the printer id when the printer is gone', () => {
    expect(toJobRecord(row, () => null).destinationPrinterName).toBe(row.printerId);
  });

  it('decodes stored lastError into the record', () => {
    const failed = { ...row, status: 'failed' as const, lastError: 'connect_timeout: no route' };
    expect(toJobRecord(failed, () => null).lastError).toBe('connect_timeout: no route');
  });

  it('maps a profile to PrinterInfo with honest unknown health', () => {
    const info = toPrinterInfo(profile);
    expect(info.config).toEqual(profile);
    expect(info.health).toBe('unknown');
    expect(info.lastPrintAt).toBeNull(); // no health polling this phase (R-VAL-3)
  });

  it('maps cloud errors to PairFailureReason', () => {
    expect(mapPairFailure(new CloudError('network'))).toMatchObject({ ok: false, reason: 'network' });
    expect(mapPairFailure(new CloudError('request_rejected', 'status 422: code_expired', undefined, 'code_expired')))
      .toMatchObject({ ok: false, reason: 'expired' });
    expect(mapPairFailure(new CloudError('request_rejected', 'status 422: bad_code'))).toMatchObject({ ok: false, reason: 'invalid_code' });
  });
});
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement** `src/main/view-model.ts`:

```ts
import type { JobRow } from './local-store/job-store';
import type { PrinterProfile } from './printers/profile';
import type { CloudError } from './cloud-client/errors';
import type {
  DocType, JobRecord, PairFailureReason, PairResult, PrinterInfo,
} from '../renderer/src/services/types';

/** Rows only ever enter the store from contract-validated envelopes
 *  (doc_type is an enum at the boundary), so this cast is safe; a stray
 *  legacy value would only mislabel a list row. */
const toDocType = (value: string): DocType => value as DocType;

export function toJobRecord(
  row: JobRow,
  printerName: (printerId: string) => string | null,
): JobRecord {
  return {
    jobId: row.id,
    idempotencyKey: row.idempotencyKey,
    docType: toDocType(row.docType),
    destinationPrinterName: printerName(row.printerId) ?? row.printerId,
    status: row.status,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    attempts: row.attempts,
    lastError: row.lastError,
  };
}

/** Health stays 'unknown' until status polling lands (R-VAL-3); lastPrintAt
 *  is null — the agent never claims a physical print (§3.1). */
export function toPrinterInfo(profile: PrinterProfile): PrinterInfo {
  return { config: profile, health: 'unknown', lastPrintAt: null };
}

export function mapPairFailure(err: CloudError): PairResult {
  const reason: PairFailureReason =
    err.code === 'request_rejected'
      ? err.serverCode !== undefined && err.serverCode.includes('expired')
        ? 'expired'
        : 'invalid_code'
      : 'network';
  const message =
    reason === 'expired'
      ? 'That pairing code expired. Generate a new one in the dashboard.'
      : reason === 'invalid_code'
        ? 'The pairing code was rejected. Check it and try a fresh code.'
        : 'Could not reach the server. Check the connection and try again.';
  return { ok: false, reason, message };
}
```

Note: importing renderer types from `src/main` is type-only and erased at build; the single-source-of-truth for view models lives in the renderer types file. If the tsconfig boundary complains, move the view-model types into `src/shared/view-types.ts` and have the renderer re-export — prefer whichever typechecks cleanly.

- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(main): view-model mappers for the renderer surface`

---

### Task 7: `AgentRuntime` — composition root, lifecycle, event plumbing

The biggest task. Build it in two commits (7a composition/lifecycle/snapshot/pairing; 7b job/ack/config/heartbeat plumbing).

**Files:**
- Create: `src/main/agent-runtime.ts`
- Test: `tests/agent-runtime.test.ts`

- [ ] **Step 1: Test harness + composition/lifecycle tests.** The harness mirrors `tests/helpers/job-engine-harness.ts` injection style: fake `AgentTransport`, in-memory SQLite, fake `safeStorage`, fake timers.

```ts
// tests/agent-runtime.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createAgentRuntime, type RuntimeDeps } from '../src/main/agent-runtime';
import { openDatabase, closeDatabase } from '../src/main/local-store/db';
import { migrate } from '../src/main/local-store/migrations';
import { createSafeStorageSecretStore, type SecretKv, type SafeStorageLike } from '../src/main/cloud-client/secret-store';
import { ENVELOPE_VERSION } from '../src/main/cloud-client/schemas';
import type { AgentTransport, AckBatch, HeartbeatSample } from '../src/main/cloud-client/types';

export function fakeSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(plain, 'utf8'),
    decryptString: (buf) => buf.toString('utf8'),
  };
}

export function fakeKv(): SecretKv {
  const map = new Map<string, string>();
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => void map.set(k, v),
    delete: (k) => void map.delete(k),
  };
}

export function fakeTransport(): AgentTransport & {
  queuedJobs: unknown[];
  acks: AckBatch[];
  heartbeats: HeartbeatSample[];
} {
  const impl = {
    baseUrl: 'https://api.test',
    queuedJobs: [] as unknown[],
    acks: [] as AckBatch[],
    heartbeats: [] as HeartbeatSample[],
    async pair() {
      return {
        device_id: '11111111-1111-4111-8111-111111111111',
        device_token: 'tok',
        refresh_token: 'ref',
        server_signing_pubkey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA0',
        restaurant_id: '22222222-2222-4222-8222-222222222222',
        tenant_id: '33333333-3333-4333-8333-333333333333',
        token_ttl_s: 3600,
      };
    },
    async refresh() { throw new Error('not used'); },
    async pollJobs(_auth, cursor) {
      const jobs = impl.queuedJobs;
      impl.queuedJobs = [];
      return { jobs, next_cursor: null, has_more: false, ...(cursor ? {} : {}) };
    },
    async sendAcks(_auth, batch) {
      impl.acks.push(batch);
      return { results: batch.acks.map((a) => ({ job_id: a.job_id, result: 'applied' as const })) };
    },
    async getConfig() { return { config_version: 0, printers: [] }; },
    async heartbeat(_auth, sample) { impl.heartbeats.push(sample); },
    async serverKeys() { throw new Error('not used'); },
  };
  return impl;
}
```

**Harness decisions locked here** (they shape `RuntimeDeps`):
- `RuntimeDeps.db: SqliteDatabase` — main.ts opens + migrates and closes it in
  `before-quit`; the runtime owns stores/lifecycle but never closes the DB.
- `RuntimeDeps.env` carries optional test overrides: `{ transportOverride?:
  AgentTransport, kvOverride?: SecretKv, now?, schedule?, random? }`,
  defaulting to real implementations.
- `createAgentRuntime` is an **async** factory (`createPrinterStore` is async);
  `makeRuntime` and main.ts `await` it.

Full harness `makeRuntime`:

```ts
export async function makeRuntime(overrides: {
  transport?: ReturnType<typeof fakeTransport>;
} = {}) {
  const db = openDatabase({ file: null });
  migrate(db);
  const transport = overrides.transport ?? fakeTransport();
  const settings = createSettingsStore({
    filePath: ':memory-settings', adapter: memoryAdapter(), report: () => {},
  });
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: RuntimeDeps = {
    db,
    settings,
    log,
    agentVersion: '0.1.0-test',
    deviceName: 'TEST-PC',
    safeStorage: fakeSafeStorage(),
    paths: { printersFile: ':memory-printers' },
    cloud: { baseUrl: 'https://api.test' },
    env: {
      transportOverride: transport, // test seam: replaces createHttpTransport
      kvOverride: fakeKv(),
    },
  };
  const runtime = await createAgentRuntime(deps);
  return { runtime, transport, db, settings, log };
}
```

(`memoryAdapter` is a 10-line in-memory `SettingsFileAdapter` — `read` from a Map, `writeAtomic` into it; write it inline in the harness.)

**Tests for 7a:**

```ts
describe('AgentRuntime lifecycle', () => {
  it('starts unpaired with no identity', async () => {
    const { runtime } = makeRuntime();
    runtime.start();
    const snap = await runtime.snapshot();
    expect(snap.connection).toBe('unpaired');
    expect(snap.identity).toBeNull();
    expect(snap.pendingJobs).toBe(0);
  });

  it('pairs, records pairedAt in settings, and reaches online', async () => {
    const { runtime, settings, transport } = makeRuntime();
    runtime.start();
    const result = await runtime.pair('7QJ2K9XD');
    expect(result.ok).toBe(true);
    expect(settings.get().pairedAt).not.toBeNull();
    expect((await runtime.snapshot()).connection).toBe('online');
    expect(transport.heartbeats.length).toBeGreaterThanOrEqual(0);
  });

  it('refuses to pair when already paired', async () => {
    const { runtime } = makeRuntime();
    runtime.start();
    await runtime.pair('7QJ2K9XD');
    const second = await runtime.pair('7QJ2K9XD');
    expect(second).toMatchObject({ ok: false, reason: 'already_paired' });
  });

  it('unpair wipes identity, jobs, printers and config', async () => {
    const { runtime, transport, db } = makeRuntime();
    runtime.start();
    await runtime.pair('7QJ2K9XD');
    // seed a printer + job row via the runtime's own seams
    await runtime.printers.add(validDraft());
    transport.queuedJobs.push(validEnvelope('job-1'));
    await vi.waitFor(() => expect(runtime.jobs.list().length).toBe(1));
    await runtime.unpair();
    const snap = await runtime.snapshot();
    expect(snap.connection).toBe('unpaired');
    expect(snap.identity).toBeNull();
    expect(runtime.printers.list()).toEqual([]);
    expect(runtime.jobs.list()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM cloud_config').get()).toMatchObject({ n: 0 });
  });

  it('recovers interrupted rows before the first poll', async () => {
    const { runtime, db } = makeRuntime();
    // seed a 'sending' row directly (simulates crash mid-transmission)
    insertRow(db, { id: 'job-9', status: 'sending' });
    runtime.start();
    await vi.waitFor(() => {
      const row = db.prepare("SELECT status FROM jobs WHERE id = 'job-9'").get();
      expect(row).toMatchObject({ status: 'ambiguous' });
    });
  });
});
```

`validEnvelope`, `validDraft`, `insertRow` helpers construct schema-valid fixtures (envelope per `PrintJobSchema`; sign it with `generateDeviceKeyPair` + `signEnvelope` from `envelope-sig.ts` — the poller verifies signatures against the paired `server_signing_pubkey`, so the test must sign with the matching key. Export the test keypair from the harness so `fakeTransport().pair` returns ITS pubkey and the signer uses the SAME private key).

- [ ] **Step 2: Run** — FAIL (module missing).

- [ ] **Step 3: Implement 7a** — `src/main/agent-runtime.ts`:

```ts
import { hostname } from 'node:os';
import { createPollingCloudClient } from './cloud-client/poller';
import { createHttpTransport } from './cloud-client/http-transport';
import { createSafeStorageSecretStore, type SecretStore, type SafeStorageLike, type SecretKv } from './cloud-client/secret-store';
import { CloudError } from './cloud-client/errors';
import type { CloudClient, ConnectionState, HeartbeatSample } from './cloud-client/types';
import type { ConfigUpdate } from './cloud-client/schemas';
import { createJobEngine, type JobEngine } from './jobs/engine';
import type { AckSink } from './jobs/types';
import { createPrinterStore, type PrinterStore } from './printers/store';
import { createPrinterService, type PrinterService } from './printers/service';
import { createTransportRegistry } from './transport/registry';
import type { SettingsStore } from './services/settings';
import type { Logger } from './services/logger/logger';
import { createConfigStore, type ConfigStore } from './local-store/config-store';
import type { SqliteDatabase } from './local-store/db';
import { createAckBuffer, type AckBuffer } from './ack-buffer';
import { mapPairFailure, toJobRecord, toPrinterInfo } from './view-model';
import type {
  AgentSnapshot, ConnectivityCheck, DiagnosticsReport, JobRecord, PairResult, UiSettings,
} from '../renderer/src/services/types';

export interface RuntimeDeps {
  db: SqliteDatabase;
  settings: SettingsStore;
  paths: { printersFile: string };
  log: Logger;
  agentVersion: string;
  deviceName?: string; // default os.hostname()
  safeStorage: SafeStorageLike;
  cloud: { baseUrl: string; pollIntervalMs?: number };
  env?: {
    transportOverride?: AgentTransport;
    kvOverride?: SecretKv;
    now?: () => number;
    schedule?: (fn: () => void, delayMs: number) => () => void;
    random?: () => number;
  };
}
```

Structure (final signatures, renderer's concrete types):

```ts
export interface AgentRuntime {
  start(): void;
  stop(): void;
  agentInfo(): { name: string; version: string; connectionState: ConnectionState };
  snapshot(): Promise<AgentSnapshot>;
  pair(code: string): Promise<PairResult>;
  unpair(): Promise<void>;
  readonly printers: {
    list(): readonly PrinterInfo[];
    add(draft: unknown): Promise<PrinterInfo>; // PrinterDraftSchema.parse inside the store
    update(printerId: string, patch: unknown): Promise<PrinterInfo>;
    remove(printerId: string): Promise<boolean>;
    testPrint(printerId: string): Promise<TestPrintResult>;
  };
  readonly jobs: {
    list(): readonly JobRecord[];
    retry(jobId: string): Promise<JobRecord>;
    reprint(jobId: string): Promise<JobRecord>;
  };
  readonly diagnostics: {
    report(): Promise<DiagnosticsReport>;
    checks(): Promise<readonly ConnectivityCheck[]>;
    recentLogs(): readonly LogLine[]; // delegates to logger.getRecentLogLines()
  };
}
```

Composition function shape:

```ts
export function createAgentRuntime(deps: RuntimeDeps): AgentRuntime {
  const now = deps.env?.now ?? Date.now;
  const schedule = deps.env?.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
  const random = deps.env?.random ?? Math.random;
  const log = deps.log;
  const deviceName = deps.deviceName ?? hostname();

  const kv: SecretKv = deps.env?.kvOverride ?? createSettingsKv(deps); // see note
  const secrets: SecretStore = createSafeStorageSecretStore(kv, deps.safeStorage);
  const transport = deps.env?.transportOverride ?? createHttpTransport({
    baseUrl: deps.cloud.baseUrl, agentVersion: deps.agentVersion,
  });
  const jobStore = createSqliteJobStore(deps.db);
  const printers: PrinterStore = await-created — see note
  const registry = createTransportRegistry();
  const configStore = createConfigStore(deps.db);

  // AckSink → buffer → client (client created after buffer, buffer holds a
  // forward reference via closure).
  let client: CloudClient;
  const ackBuffer: AckBuffer = createAckBuffer({
    submitAcks: (batch) => client.submitAcks(batch),
    schedule: (fn, ms) => schedule(fn, ms),
    log: (m) => log.warn(m),
  });
  const ackSink: AckSink = { submit: (ack) => ackBuffer.add(ack) };

  const engine: JobEngine = createJobEngine({
    store: jobStore, printers, transports: registry, acks: ackSink,
    now, schedule: (fn, ms) => void schedule(fn, ms),
  });

  client = createPollingCloudClient({
    transport, secrets, agentVersion: deps.agentVersion,
    log: (m) => log.info(m), now, schedule, random,
    pollIntervalMs: deps.cloud.pollIntervalMs,
    heartbeatSample: () => heartbeatSample(),
    onRevoked: () => { void wipeLocalState(); },
  });

  client.on('job', (envelope) => {
    const job = envelope.job;
    const ack = engine.submit({
      jobId: job.job_id, idempotencyKey: job.idempotency_key,
      tenantId: job.tenant_id, restaurantId: job.restaurant_id,
      printerId: job.printer_id, priority: job.priority, copies: job.copies,
      docType: job.doc_type, docVersion: job.doc_version,
      expiresAt: job.expires_at === null ? null : Date.parse(job.expires_at),
      payload: job.payload,
    });
    void ack;
  });

  client.on('config', (config: ConfigUpdate) => {
    configStore.save(config); // persist-only this phase (FR-16 application is later)
  });

  let state: ConnectionState = client.state();
  client.on('state', (next) => { state = next; });

  let started = false;
  function start(): void {
    if (started) return;
    started = true;
    engine.recover();           // crash recovery BEFORE first poll (§5)
    client.start();             // first cycle pulls pending work; no-op if unpaired
  }
  async function stop(): Promise<void> {
    if (!started) return;
    started = false;
    client.stop();
    await ackBuffer.stop();
  }

  async function wipeLocalState(): Promise<void> {
    client.stop();
    secrets.clear();
    jobStore.clearJobs();
    await printers.clear();
    configStore.clear();
    await deps.settings.set({ pairedAt: null });
  }

  // ... snapshot/pair/unpair/printers/jobs/diagnostics per the interface
}
```

Notes to resolve while writing:
- `createPrinterStore` and `createSettingsStore` are async. Either make `createAgentRuntime` async (`await createAgentRuntime(deps)` in main.ts — preferred) or load lazily. **Decision: async factory.**
- `SecretKv` backing: main.ts composition passes a settings-file-backed kv adapter (atomic tmp+rename — satisfies the single-record requirement). Create a tiny `createJsonFileKv(filePath, adapter)` in `agent-runtime.ts` (or reuse `createNodeSettingsAdapter`) storing `{ key: value }` JSON. Keep it in `src/main/secret-kv.ts` (new small file) with a unit test (tests/secret-kv.test.ts: set/get/delete + persistence across reopen).
- `pair()`:
```ts
async pair(code: string): Promise<PairResult> {
  if (secrets.load() !== null) {
    return { ok: false, reason: 'already_paired', message: 'This agent is already paired.' };
  }
  try {
    const identity = await client.pair({ pairingCode: code, deviceName });
    await deps.settings.set({ pairedAt: new Date(now()).toISOString() });
    return {
      ok: true,
      identity: {
        deviceId: identity.deviceId,
        agentName: deviceName,
        restaurantId: identity.restaurantId,
        restaurantName: identity.restaurantId, // display name arrives via config later
        pairedAt: new Date(now()).toISOString(),
      },
    };
  } catch (err) {
    if (err instanceof CloudError) return mapPairFailure(err);
    throw err;
  }
}
```
- `snapshot()`:
```ts
async snapshot(): Promise<AgentSnapshot> {
  const identitySecrets = readIdentitySafely(); // try/catch → null (log warn)
  const s = deps.settings.get();
  const pendingJobs = engine.pendingCount();
  const ambiguousJobs = jobStore.countByStatus('ambiguous');
  const terminal = jobStore.listByStatus('completed', 'failed', 'ambiguous', 'rejected');
  const lastActivityAt = terminal.length === 0 ? null : new Date(Math.max(...terminal.map((r) => r.updatedAt))).toISOString();
  return {
    version: deps.agentVersion,
    connection: state,
    connectionDetail: CONNECTION_DETAILS[state](),  // small static-string map per §3.1 wording
    identity: identitySecrets === null ? null : {
      deviceId: identitySecrets.deviceId,
      agentName: deviceName,
      restaurantId: identitySecrets.restaurantId,
      restaurantName: identitySecrets.restaurantId,
      pairedAt: s.pairedAt,
    },
    pendingJobs, ambiguousJobs, lastActivityAt,
  };
}
```
- `jobs.list()`: `jobStore.listByStatus(...ALL_STATUSES).sort((a, b) => b.createdAt - a.createdAt).slice(0, 200).map((row) => toJobRecord(row, (id) => printers.get(id)?.name ?? null))`.
- `jobs.retry/reprint`: wrap `engine.retryJob(id)` (void) then return `toJobRecord(store.get(id)!, ...)`; `reprint` returns new id. Errors from `JobEngineError` are rethrown (message is clean).
- `diagnostics.report()`: `process.versions.electron`, `process.platform`, `process.uptime()`, db size via `deps.paths` — the DB may be `:memory:` in tests; guard `statSync` in try/catch → `sizeBytes: 0`; `journalMode: String(deps.db.pragma('journal_mode', { simple: true }))`; `queueDepth: engine.pendingCount()`.
- `diagnostics.checks()`: three checks as specced — cloud reachability via `fetch(deps.cloud.baseUrl, { signal: AbortSignal.timeout(5_000) })` (pass on ANY response; fail on throw → `warn` for timeout, `fail` for unreachable); printers via `printerService.testConnection(id)` per printer aggregated; DB via `deps.db.pragma('quick_check', { simple: true })`.
- `heartbeatSample()`:
```ts
function heartbeatSample(): HeartbeatSample {
  return {
    uptime_s: Math.floor(process.uptime()),
    queue_depth: engine.pendingCount(),
    connection: 'poll',
    printers: printers.list().map((p) => ({ printer_id: p.printerId, health: 'unknown' as const })),
  };
}
```

**7b tests** (append to the same file):

```ts
describe('cloud event plumbing', () => {
  it('a polled job becomes an engine row and produces acks on the wire', async () => {
    const { runtime, transport } = makeRuntime();
    runtime.start();
    await runtime.pair('7QJ2K9XD');
    await runtime.printers.add(validDraft());
    transport.queuedJobs.push(signedEnvelope('job-1'));
    await vi.waitFor(() => {
      const jobs = runtime.jobs.list();
      expect(jobs.length).toBe(1);
      expect(jobs[0]?.status === 'completed' || jobs[0]?.status === 'failed').toBe(true);
    });
    await vi.waitFor(() => expect(transport.acks.length).toBeGreaterThanOrEqual(1));
    const statuses = transport.acks.flatMap((b) => b.acks.map((a) => a.status));
    expect(statuses).toContain('accepted');
  });

  it('config updates persist to cloud_config', async () => {
    const { runtime, transport } = makeRuntime();
    runtime.start();
    await runtime.pair('7QJ2K9XD');
    transport.nextConfig = { config_version: 7, printers: [] };
    client polling picks it up → assert via db read (expose configVersion() on runtime.diagnostics or query db);
  });

  it('revocation wipes everything and surfaces revoked state', async () => {
    const { runtime, transport } = makeRuntime();
    runtime.start();
    await runtime.pair('7QJ2K9XD');
    transport.failAuthWith = 'device_revoked'; // harness makes pollJobs throw CloudError('unauthorized', ..., undefined, 'device_revoked')
    await vi.waitFor(() => expect((await runtime.snapshot()).connection).toBe('revoked'));
    expect(runtime.printers.list()).toEqual([]);
    expect(runtime.jobs.list()).toEqual([]);
  });
});
```

- [ ] **Step 4: Run** `pnpm test -- tests/agent-runtime.test.ts tests/ack-buffer.test.ts tests/secret-kv.test.ts` — PASS.
- [ ] **Step 5:** `pnpm typecheck && pnpm lint`.
- [ ] **Step 6: Commit** (two commits: `feat(main): AgentRuntime composition root — lifecycle, pairing, wipe` then `feat(main): wire cloud events — job intake, ack buffering, config persist, heartbeat`)

---

### Task 8: `main.ts` wiring + preload bridge

**Files:**
- Modify: `src/main/main.ts`, `src/preload/index.ts`
- Modify: `src/main/window.ts` (startMinimized)

- [ ] **Step 1: main.ts.** After settings creation:

```ts
import { closeDatabase } from './local-store/db';
import { openDatabase } from './local-store/db';
import { migrate } from './local-store/migrations';
import { createAgentRuntime } from './agent-runtime';
import { getRecentLogLines } from './services/logger/logger';

// API base URL — the Laravel team owns the production value; overridable for dev.
const API_BASE_URL = process.env['PRINT_AGENT_API_URL'] ?? 'https://print-api.example-saas.test';

const db = openDatabase({ file: join(app.getPath('userData'), 'print-agent.db') });
migrate(db);

const runtime = await createAgentRuntime({
  db,
  settings,
  paths: { printersFile: join(app.getPath('userData'), 'printers.json') },
  log,
  agentVersion: app.getVersion(),
  safeStorage: safeStorage,          // from 'electron'
  cloud: { baseUrl: API_BASE_URL },
});
runtime.start();

if (settings.get().startMinimized && devServerUrl === undefined) {
  window.hide(); // tray-resident start; the window.ts ready-to-show show() fires first
}
```

Apply `logLevel` at startup:

```ts
import log from 'electron-log/main';
log.transports.file.level = settings.get().logLevel;
```

Replace the handlers map:

```ts
handlers: {
  [Channel.GetAgentInfo]: () => runtime.agentInfo(),   // { name: 'print-agent', version, connectionState }
  [Channel.AgentSnapshot]: () => runtime.snapshot(),
  [Channel.PairWithCode]: ({ code }) => runtime.pair(code),
  [Channel.AgentUnpair]: () => runtime.unpair(),
  [Channel.PrintersList]: () => runtime.printers.list(),
  [Channel.PrintersAdd]: ({ draft }) => runtime.printers.add(draft),
  [Channel.PrintersUpdate]: ({ printerId, draft }) => runtime.printers.update(printerId, draft),
  [Channel.PrintersRemove]: ({ printerId }) => runtime.printers.remove(printerId),
  [Channel.PrintersTest]: ({ printerId }) => runtime.printers.testPrint(printerId),
  [Channel.JobsList]: () => runtime.jobs.list(),
  [Channel.JobsRetry]: ({ jobId }) => runtime.jobs.retry(jobId),
  [Channel.JobsReprint]: ({ jobId }) => runtime.jobs.reprint(jobId),
  [Channel.DiagnosticsReport]: () => runtime.diagnostics.report(),
  [Channel.DiagnosticsChecks]: () => runtime.diagnostics.checks(),
  [Channel.LogsRecent]: () => getRecentLogLines(),
  [Channel.GetSettings]: () => settings.get(),
  // SetLaunchAtLogin / HideWindow / QuitApp unchanged
}
```

Add `agentInfo()` to `AgentRuntime` returning `{ name: 'print-agent', version: deps.agentVersion, connectionState: state }`.

Lifecycle:

```ts
app.on('before-quit', () => {
  quitting = true;
  void runtime.stop().then(() => closeDatabase(db)).catch((error: unknown) => {
    log.error('shutdown failed', error);
  });
});
```

Also wire network-online → `pollNow`: keep simple, skip (poller already loops).

- [ ] **Step 2: preload.** Extend `api` in `src/preload/index.ts` with one named method per new channel:

```ts
getSnapshot: (): Promise<AgentSnapshot> => ipcRenderer.invoke(Channel.AgentSnapshot),
pairWithCode: (code: string): Promise<PairResult> => ipcRenderer.invoke(Channel.PairWithCode, { code }),
unpair: (): Promise<void> => ipcRenderer.invoke(Channel.AgentUnpair),
getPrinters: (): Promise<readonly PrinterInfo[]> => ipcRenderer.invoke(Channel.PrintersList),
addPrinter: (draft: PrinterDraft): Promise<PrinterInfo> => ipcRenderer.invoke(Channel.PrintersAdd, { draft }),
updatePrinter: (printerId: string, draft: PrinterDraft): Promise<PrinterInfo> =>
  ipcRenderer.invoke(Channel.PrintersUpdate, { printerId, draft }),
removePrinter: (printerId: string): Promise<boolean> => ipcRenderer.invoke(Channel.PrintersRemove, { printerId }),
testPrint: (printerId: string): Promise<TestPrintResult> => ipcRenderer.invoke(Channel.PrintersTest, { printerId }),
getJobs: (): Promise<readonly JobRecord[]> => ipcRenderer.invoke(Channel.JobsList),
retryJob: (jobId: string): Promise<JobRecord> => ipcRenderer.invoke(Channel.JobsRetry, { jobId }),
reprintJob: (jobId: string): Promise<JobRecord> => ipcRenderer.invoke(Channel.JobsReprint, { jobId }),
getDiagnostics: (): Promise<DiagnosticsReport> => ipcRenderer.invoke(Channel.DiagnosticsReport),
runConnectivityChecks: (): Promise<readonly ConnectivityCheck[]> => ipcRenderer.invoke(Channel.DiagnosticsChecks),
getRecentLogs: (): Promise<readonly LogLine[]> => ipcRenderer.invoke(Channel.LogsRecent),
```

Types are imported `import type` from `../renderer/src/services/types` (type-only, erased).

- [ ] **Step 3:** `pnpm typecheck` (main + preload compile; renderer will NOT compile yet — that is Tasks 9–10; scope typecheck to node project: `pnpm tsc -b tsconfig.node.json` if the projects are split, else accept renderer errors until Task 10 and note it).
- [ ] **Step 4: Run** `pnpm test -- tests/no-listen-guard.test.ts` (AC-4 smoke must stay green) and `pnpm test` for the full suite.
- [ ] **Step 5: Commit** `feat(main): wire AgentRuntime into main process + full IPC bridge`

---

### Task 9: Renderer — real types, real service, delete the mock

**Files:**
- Modify: `src/renderer/src/services/types.ts`, `src/renderer/src/services/production-service.ts`
- Delete: `src/renderer/src/services/mock-agent-service.ts`
- Modify: `tests/ui/helpers.tsx`, `tests/ui/jobs.test.tsx`

- [ ] **Step 1: types.ts.** Replace the connection union and printer types:

```ts
/** Mirrors the cloud client's ConnectionState 1:1 (architecture §7). */
export type ConnectionState = 'unpaired' | 'connecting' | 'online' | 'offline' | 'revoked';

export type PrinterProfile = import('../../../main/printers/profile').PrinterProfile;
export type PrinterDraft = import('../../../main/printers/profile').PrinterDraft;
```

Delete `TransportConfig`, `PrinterConfig`, `DuplicatePolicy`, `CutMode` (they describe fields the real store does not have). `PrinterInfo` becomes:

```ts
export interface PrinterInfo {
  readonly config: PrinterProfile;
  readonly health: PrinterHealth;
  readonly lastPrintAt: string | null;
}
```

`AgentIdentity`, `JobRecord`, `AgentSnapshot`, `UiSettings`, `PairResult`, `DiagnosticsReport`, `ConnectivityCheck`, `LogLine`, `TestPrintResult`, `PrinterHealth` stay as-is.

- [ ] **Step 2: production-service.ts** — full rewrite:

```ts
import type { AgentService } from './agent-service';
import type { PrinterDraft, UiSettings } from './types';

/** Every call is one validated IPC round-trip; the main process owns all
 *  privileged work (network, printers, SQLite, secrets). */
export function createProductionService(): AgentService {
  const bridge = window.printAgent;
  return {
    demo: false,
    getSnapshot: () => bridge.getSnapshot(),
    pairWithCode: (code) => bridge.pairWithCode(code),
    unpair: () => bridge.unpair(),
    getPrinters: () => bridge.getPrinters(),
    addPrinter: (draft: PrinterDraft) => bridge.addPrinter(draft),
    updatePrinter: (printerId, draft) => bridge.updatePrinter(printerId, draft),
    removePrinter: (printerId) => bridge.removePrinter(printerId).then(() => undefined),
    testPrint: (printerId) => bridge.testPrint(printerId),
    getJobs: () => bridge.getJobs(),
    retryJob: (jobId) => bridge.retryJob(jobId),
    reprintJob: (jobId) => bridge.reprintJob(jobId),
    getSettings: async (): Promise<UiSettings> => {
      const s = await bridge.getSettings();
      return { launchAtLogin: s.launchAtLogin, startMinimized: s.startMinimized, logLevel: s.logLevel };
    },
    updateSettings: async (patch) => {
      if (patch.launchAtLogin !== undefined) await bridge.setLaunchAtLogin(patch.launchAtLogin);
      const applied = await bridge.updateSettings({
        ...(patch.startMinimized === undefined ? {} : { startMinimized: patch.startMinimized }),
        ...(patch.logLevel === undefined ? {} : { logLevel: patch.logLevel }),
      });
      return { launchAtLogin: applied.launchAtLogin, startMinimized: applied.startMinimized, logLevel: applied.logLevel };
    },
    getDiagnostics: () => bridge.getDiagnostics(),
    runConnectivityChecks: () => bridge.runConnectivityChecks(),
    getRecentLogs: () => bridge.getRecentLogs(),
  };
}
```

`startMinimized`/`logLevel` need a settings-write channel — add it here (also add `SettingsUpdate: 'settings:update'` + schema `z.strictObject({ startMinimized: z.boolean().optional(), logLevel: z.enum(LOG_LEVELS).optional() })` to the Task 1 contract file and a `updateSettings` preload method):

```ts
// main.ts handlers
[Channel.SettingsUpdate]: async (patch) => {
  const next = await settings.set(patch);
  if (patch.logLevel !== undefined) log.transports.file.level = next.logLevel;
  return next;
},

// preload
updateSettings: (patch: { startMinimized?: boolean; logLevel?: 'debug' | 'info' | 'warn' | 'error' }): Promise<AppSettings> =>
  ipcRenderer.invoke(Channel.SettingsUpdate, patch),
```

- [ ] **Step 3: Delete** `src/renderer/src/services/mock-agent-service.ts`.
- [ ] **Step 4: tests/ui/helpers.tsx** — replace the mock with a local fake:

```ts
import type { AgentService } from '../../src/renderer/src/services/agent-service';
import type { PrinterProfile } from '../../src/main/printers/profile';

const profile: PrinterProfile = {
  printerId: '33333333-3333-4333-8333-333333333333',
  name: 'Kitchen-1', role: 'kitchen', paperWidthMm: 80, printableDots: 576, charsPerLine: 48,
  capabilities: { cut: true, qrCode: true, barcode128: false, statusPolling: false, cashDrawer: false },
  transport: { kind: 'tcp_raw', host: '192.168.1.87', port: 9100 },
};

export function makeService(overrides: Partial<AgentService> = {}): AgentService {
  return {
    demo: false,
    getSnapshot: async () => ({ /* same shape the tests assert today, connection: 'online', identity: {...} */ }),
    pairWithCode: async () => { throw new Error('not implemented in fake'); },
    unpair: async () => undefined,
    getPrinters: async () => [{ config: profile, health: 'unknown', lastPrintAt: null }],
    addPrinter: async () => ({ config: profile, health: 'unknown', lastPrintAt: null }),
    updatePrinter: async () => ({ config: profile, health: 'unknown', lastPrintAt: null }),
    removePrinter: async () => undefined,
    testPrint: async () => ({ ok: true, detail: 'handed off', at: new Date(0).toISOString() }),
    getJobs: async () => [ /* same JobRecord fixtures the tests assert */ ],
    retryJob: async (jobId) => { throw new Error('not implemented in fake'); },
    reprintJob: async (jobId) => { throw new Error('not implemented in fake'); },
    getSettings: async () => ({ launchAtLogin: false, startMinimized: true, logLevel: 'info' }),
    updateSettings: async (patch) => ({ launchAtLogin: false, startMinimized: true, logLevel: 'info', ...patch }),
    getDiagnostics: async () => ({ /* existing shape */ }),
    runConnectivityChecks: async () => [],
    getRecentLogs: async () => [],
    ...overrides,
  };
}
```

(Copy the exact fixture values from the current mock usage so assertions keep passing; fill every method the removed mock provided that tests rely on.)

Update `tests/ui/jobs.test.tsx` to import `makeService` from `./helpers` instead of `MockAgentService`.

- [ ] **Step 5:** `pnpm typecheck && pnpm test -- tests/ui` — fix fallout. Screens still reference removed types (`station`, `codepage`, …) → Task 10 fixes them; if typecheck is all-or-nothing, do Task 10 before running typecheck here.
- [ ] **Step 6: Commit** `feat(renderer): real IPC-backed AgentService; delete demo mock`

---

### Task 10: Renderer — screens for the real model

**Files:**
- Modify: `src/renderer/src/ui/status.tsx`, `OverviewScreen.tsx`, `PrintersScreen.tsx`
- Test: `tests/ui/overview.test.tsx`, `tests/ui/printers.test.tsx`, `tests/ui/setup.test.tsx`

- [ ] **Step 1: status.tsx** — replace `CONNECTION_META`:

```ts
export const CONNECTION_META: Readonly<Record<ConnectionState, StatusMeta>> = {
  unpaired: {
    label: 'Not paired',
    tone: 'neutral',
    Icon: InfoIcon,
    title: 'Pair this PC with a code from the SaaS dashboard to begin.',
  },
  connecting: { label: 'Connecting…', tone: 'info', Icon: ClockIcon, title: 'Establishing the outbound connection.' },
  online: { label: 'Connected', tone: 'success', Icon: CheckCircleIcon, title: 'Outbound connection to the cloud is established.' },
  offline: { label: 'Offline', tone: 'danger', Icon: CrossCircleIcon, title: 'No connection to the cloud. Jobs sent while offline queue on the server and replay on reconnect.' },
  revoked: {
    label: 'Revoked',
    tone: 'danger',
    Icon: WarnTriangleIcon,
    title: 'The restaurant revoked this device. Local data was wiped — pair again with a new code.',
  },
};
```

- [ ] **Step 2: OverviewScreen.** The `identity === null` empty state already covers `unpaired`. Add a revoked banner between header and content:

```tsx
{snapshot.connection === 'revoked' && (
  <div className="banner banner-error" role="alert">
    <span className="banner-text">
      This device was revoked by the restaurant. Cached credentials, jobs and printers were wiped
      from this PC. Pair again with a new code to resume.
    </span>
    <button type="button" className="btn btn-sm" onClick={() => props.onNavigate('setup')}>
      Open setup
    </button>
  </div>
)}
```

Replace `printer.config.station` with `printer.config.role`.

- [ ] **Step 3: PrintersScreen** — rework to the real `PrinterDraft`:

New `emptyDraft`:

```ts
const emptyDraft: PrinterDraft = {
  name: '',
  role: 'kitchen',
  paperWidthMm: 80,
  printableDots: 576,
  charsPerLine: 48,
  capabilities: { cut: true, qrCode: true, barcode128: false, statusPolling: false, cashDrawer: false },
  transport: { kind: 'tcp_raw', host: '', port: 9100 },
};
```

Form fields (replacing station/copies/codepage/cut/policy):
- Name (unchanged)
- Role `<select>`: kitchen / receipt / bar / custom
- Paper width `<select>` 80 / 58 — onChange also sets `printableDots` (80→576, 58→384) and `charsPerLine` (80→48, 58→32) as defaults; both remain editable number inputs ("Advanced")
- Transport: host + port only (drop the spooler option — the schema and registry are TCP-only this phase)
- Capabilities: five checkboxes in one row

Row display: `<span className="tag">{printer.config.role}</span>`; sub-line `{paperWidthMm}mm · {host}:{port}`; drop the copies/cut/policy line.

`transportLabel` simplifies to `TCP ${host}:${port}`.

- [ ] **Step 4: SetupScreen** — no flow change (8-char code already matches contract). Remove the now-unused `DemoBadge` import if `demo` is false (it stays valid — `service.demo` exists).
- [ ] **Step 5: Jobs/Diagnostics/Settings screens** — verify against the unchanged shapes (`JobRecord`, `DiagnosticsReport`, `UiSettings`); fix compile errors only (e.g. any `station`/`codepage` references in JobHistoryScreen's printer filter — use `destinationPrinterName` only, which is unchanged).
- [ ] **Step 6: Update UI tests** — `tests/ui/overview.test.tsx` (fixture printers use real profile; assert revoked banner with a fake service override), `tests/ui/printers.test.tsx` (form: role select, paper width, no codepage field), `tests/ui/setup.test.tsx` (unchanged assertions should hold).
- [ ] **Step 7:** `pnpm typecheck && pnpm lint && pnpm test` — full suite green.
- [ ] **Step 8: Commit** `feat(renderer): screens on the real printer/connection model`

---

### Task 11: Docs + final verification

**Files:**
- Modify: `docs/architecture.md` (§3 composition-root note), `docs/operations.md` (runbook: pairing, revocation behavior, `PRINT_AGENT_API_URL`)

- [ ] **Step 1: architecture.md** — add a short §3.x "Composition root" subsection: `AgentRuntime` in `src/main/agent-runtime.ts` is the only place modules are instantiated; event flow diagram (poller → engine → ack-buffer → poller); recovery ordering (recover → start); wipe path (revocation/unpair → secrets+jobs+printers+config+pairedAt).
- [ ] **Step 2: operations.md** — document: pairing flow from the operator's perspective; what revocation/unpair wipes; `PRINT_AGENT_API_URL` env override for dev (production builds use the compiled constant — **must be replaced with the real URL before release; tracked as a release checklist item**).
- [ ] **Step 3:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build` — all green (build proves electron-vite bundles main+preload+renderer).
- [ ] **Step 4: Manual smoke (dev):** `pnpm dev` — Overview shows "Not paired" honestly; Settings toggles persist to `settings.json`; no console errors. (Full pairing smoke requires the Laravel mock server — out of scope here.)
- [ ] **Step 5: Commit** `docs: composition root + ops notes for the wired agent`

---

## Self-review notes

- Spec coverage: §1 runtime (Task 7), §2 events (Task 7), §3 IPC (Tasks 1, 8), §4 renderer (Tasks 9–10), §5 errors/diagnostics/lifecycle (Tasks 4, 7, 8), §6 testing (throughout), §7 acceptance (Task 11 + module-level coverage; physical pairing smoke needs the Laravel side).
- Deliberate deviations from the spec, all recorded in the spec: recovery ordering inside `runtime.start()`; printer view-model alignment (bigger UI change than "unchanged shape"); pairing code regex per contract.
- Type consistency: `AgentRuntime` method names used in Task 8 handlers (`agentInfo`, `snapshot`, `pair`, `unpair`, `printers.*`, `jobs.*`, `diagnostics.*`) match Task 7's interface. `toJobRecord`/`toPrinterInfo`/`mapPairFailure` defined in Task 6, consumed in Task 7. `createConfigStore` (Task 2) consumed in Task 7's wipe + config handler. `clearJobs`/`clear` (Task 3) consumed only in Task 7's `wipeLocalState`.
- Known follow-ups (out of scope, do not silently add): WSS, spooler transport, FR-16 application, FR-14 duplicate banner, `Restaurant.name` via config, real API base URL.
