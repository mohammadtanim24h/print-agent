# C2 Load Burst Test (R-VAL-6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CI-able burst test proving the poll delivery path drains a 10-job
kitchen rush (one `pollJobs` response, 2 printers × 5) with per-printer FIFO
order intact, acks fully drained, and zero ambiguous outcomes.

**Architecture:** Full AgentRuntime in-process test — the real chain
poll → ed25519 verify → engine intake → per-printer drain → ack buffer → wire
acks, over in-memory SQLite with fake cloud + printer transports. The
`makeRuntime` harness currently private to `tests/agent-runtime.test.ts` is
extracted to `tests/helpers/runtime-harness.ts` so both files share it.

**Tech Stack:** TypeScript strict, vitest (node project). Spec:
`docs/superpowers/specs/2026-10-30-c2-burst-test-design.md`.

**Conventions for this repo:** no `any` at module boundaries; deps injected;
docs updated in the same change when status changes; commit at each green
step (never push).

---

### Task 1: Extract the shared runtime harness

The harness (in-memory SQLite, fake cloud transport, clamped schedule,
pairing fixture, signed-envelope factory) moves verbatim out of
`tests/agent-runtime.test.ts` into a helper both test files import. Pure
mechanical move — no behavior change. Note the cloud fake is renamed
`FakeCloudTransport` in the helper to avoid colliding with the *printer*
`FakeTransport` in `tests/helpers/fake-transport.ts`; the runtime test file
aliases it back so its body stays untouched.

**Files:**
- Create: `tests/helpers/runtime-harness.ts`
- Modify: `tests/agent-runtime.test.ts` (delete moved code, fix imports)

- [ ] **Step 1: Create `tests/helpers/runtime-harness.ts`**

```typescript
import { createPrivateKey } from 'node:crypto';
import { afterEach, vi } from 'vitest';
import {
  createAgentRuntime,
  type AgentRuntime,
  type RuntimeDeps,
} from '../../src/main/agent-runtime';
import { openDatabase, closeDatabase } from '../../src/main/local-store/db';
import type { SqliteDatabase } from '../../src/main/local-store/db';
import { migrate } from '../../src/main/local-store/migrations';
import { createSettingsStore, type SettingsStore } from '../../src/main/services/settings';
import type { Logger } from '../../src/main/services/logger/logger';
import type { SecretKv, SafeStorageLike } from '../../src/main/cloud-client/secret-store';
import type {
  AckBatch,
  AgentTransport,
  HeartbeatSample,
  TransportAuth,
} from '../../src/main/cloud-client/types';
import type {
  ConfigUpdate,
  PairResponse,
  PollResponse,
  PrinterConfig,
  RefreshResponse,
  ServerKeysResponse,
} from '../../src/main/cloud-client/schemas';
import { CloudError } from '../../src/main/cloud-client/errors';
import { generateDeviceKeyPair, signJobForTest } from '../../src/main/cloud-client/envelope-sig';
import { ENVELOPE_VERSION } from '../../src/main/cloud-client/schemas';
import type { TransportRegistry } from '../../src/main/transport/registry';
import { memoryAdapter } from './memory-adapter';

/**
 * Shared AgentRuntime test harness: fake cloud transport + kv + safeStorage
 * over an in-memory SQLite database. The fake transport's `pair` returns a
 * REAL ed25519 public key generated at module scope; test envelopes built
 * with `signedJobEnvelope` are signed with the matching private key so the
 * poller's signature verification accepts them.
 *
 * The harness registers its own `afterEach` cleanup (stops runtimes, closes
 * databases) in every test file that imports `makeRuntime`.
 */

export const TENANT_ID = '018f3c2e-0000-7000-8000-000000000001';
export const RESTAURANT_ID = '018f3c2e-0000-7000-8000-000000000002';
export const PAIRING_CODE = '7QJ2K9XD';

export function makeUuid(n: number): string {
  return `018f3c2e-0000-7000-8000-${String(n).padStart(12, '0')}`;
}

function fakeSafeStorage(): SafeStorageLike {
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

export interface FakeCloudTransport extends AgentTransport {
  readonly queuedJobs: unknown[];
  readonly acks: AckBatch[];
  readonly heartbeats: HeartbeatSample[];
  /** Next pollJobs call throws this once (e.g. CloudError with serverCode 'device_revoked'). */
  failNextPoll: Error | null;
  /** Mutable GET /config response for refreshConfig tests. */
  configResponse: ConfigUpdate;
  readonly configFetches: number;
}

export function fakeCloudTransport(): FakeCloudTransport {
  const impl = {
    baseUrl: 'https://api.test',
    queuedJobs: [] as unknown[],
    acks: [] as AckBatch[],
    heartbeats: [] as HeartbeatSample[],
    failNextPoll: null as Error | null,
    configResponse: {
      type: 'config_update',
      config_version: 0,
      printers: [],
    } as ConfigUpdate,
    configFetches: 0,
    pair(): Promise<PairResponse> {
      return Promise.resolve().then(() => ({
        device_id: makeUuid(3),
        device_token: 'device-token-test',
        refresh_token: 'refresh-token-test',
        // The poller verifies envelope sigs against THIS key; test envelopes
        // are signed with the matching module-scope private key.
        server_signing_pubkey: serverKeys.publicKeyRaw,
        restaurant_id: RESTAURANT_ID,
        tenant_id: TENANT_ID,
        token_ttl_s: 3600,
      }));
    },
    refresh(): Promise<RefreshResponse> {
      return Promise.reject(new CloudError('unauthorized', 'refresh not used in runtime tests'));
    },
    pollJobs(): Promise<PollResponse> {
      return Promise.resolve().then(() => {
        if (impl.failNextPoll !== null) {
          const err = impl.failNextPoll;
          impl.failNextPoll = null;
          throw err;
        }
        const jobs = impl.queuedJobs;
        impl.queuedJobs = [];
        return { jobs };
      });
    },
    sendAcks(_auth: TransportAuth, batch: AckBatch) {
      impl.acks.push(batch);
      return Promise.resolve().then(() => ({
        results: batch.acks.map((a) => ({ job_id: a.job_id, result: 'applied' as const })),
      }));
    },
    getConfig(): Promise<ConfigUpdate> {
      impl.configFetches += 1;
      return Promise.resolve().then(() => impl.configResponse);
    },
    heartbeat(_auth: TransportAuth, sample: HeartbeatSample): Promise<void> {
      impl.heartbeats.push(sample);
      return Promise.resolve();
    },
    serverKeys(): Promise<ServerKeysResponse> {
      return Promise.reject(new CloudError('unauthorized', 'serverKeys not used in runtime tests'));
    },
  };
  return impl;
}

export function makeCloudPrinterConfig(n: number, overrides: Partial<PrinterConfig> = {}): PrinterConfig {
  return {
    printer_id: makeUuid(100 + n),
    name: `Cloud-${String(n)}`,
    transport: {
      kind: 'tcp_raw',
      host: '192.168.1.87',
      port: 9100,
      connect_timeout_ms: 3000,
      write_timeout_ms: 5000,
    },
    station: 'kitchen',
    copies_default: 1,
    codepage: 'cp437',
    cut_default: 'partial',
    duplicate_policy: 'ask_operator',
    status_polling: 'auto',
    ...overrides,
  };
}

export function makeCloudConfig(configVersion: number, printers: PrinterConfig[]): ConfigUpdate {
  return { type: 'config_update', config_version: configVersion, printers };
}

/** Printer transports that succeed instantly — hermetic, no real sockets. */
export function stubTransports(): TransportRegistry {
  return {
    forPrinter: () => ({
      open: () => Promise.resolve(),
      write: () => Promise.resolve(),
      close: () => Promise.resolve(),
      healthCheck: () => Promise.resolve(),
    }),
  };
}

// ---- signed envelope fixture --------------------------------------------------

const serverKeys = generateDeviceKeyPair();
const serverPrivateKey = createPrivateKey({
  key: Buffer.from(serverKeys.privateKeyPkcs8, 'base64url'),
  format: 'der',
  type: 'pkcs8',
});

let jobSeq = 0;

/** A print_job envelope whose signature verifies against the paired pubkey. */
export function signedJobEnvelope(
  printerId: string,
  jobOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  jobSeq += 1;
  const job = {
    job_id: makeUuid(100 + jobSeq),
    idempotency_key: `ord-${String(jobSeq)}`,
    tenant_id: TENANT_ID,
    restaurant_id: RESTAURANT_ID,
    printer_id: printerId,
    priority: 5,
    copies: 1,
    doc_type: 'customer_receipt',
    doc_version: 1,
    issued_at: '2026-10-01T10:00:00.000Z',
    expires_at: '2030-01-01T10:00:00.000Z',
    payload: makeDoc(),
    ...jobOverrides,
  };
  return {
    envelope_version: ENVELOPE_VERSION,
    type: 'print_job',
    job,
    sig: signJobForTest(job, serverPrivateKey),
  };
}

// ---- harness -------------------------------------------------------------------

export interface RuntimeHarness {
  runtime: AgentRuntime;
  transport: FakeCloudTransport;
  db: SqliteDatabase;
  settings: SettingsStore;
  log: Logger;
}

const runtimes: AgentRuntime[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.stop();
  }
  for (const db of databases.splice(0)) {
    closeDatabase(db);
  }
});

async function makeRuntime(
  overrides: {
    transport?: FakeCloudTransport;
    transports?: TransportRegistry;
    schedule?: (fn: () => void, delayMs: number) => () => void;
    fetchOverride?: typeof fetch;
    kv?: SecretKv;
    safeStorage?: SafeStorageLike;
    log?: Logger;
    spoolerBridge?: SpoolerBridge;
  } = {},
): Promise<RuntimeHarness> {
  const db = openDatabase({ file: null });
  migrate(db);
  databases.push(db);
  const transport = overrides.transport ?? fakeCloudTransport();
  const settings = await createSettingsStore({
    filePath: ':memory-settings',
    adapter: memoryAdapter(),
    report: () => {},
  });
  const log: Logger = overrides.log ?? {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  // Clamp every scheduled delay to 5 ms: engine backoffs, ack-buffer timers and
  // the poll cadence all run fast; vi.waitFor handles the async settling.
  const schedule =
    overrides.schedule ??
    ((fn: () => void, delayMs: number): (() => void) => {
      const t = setTimeout(fn, Math.min(delayMs, 5));
      return () => {
        clearTimeout(t);
      };
    });
  const env: NonNullable<RuntimeDeps['env']> = {
    transportOverride: transport,
    kvOverride: overrides.kv ?? fakeKv(),
    transportsOverride: overrides.transports ?? stubTransports(),
    adapterOverride: memoryAdapter(),
    schedule,
    ...(overrides.fetchOverride !== undefined ? { fetchOverride: overrides.fetchOverride } : {}),
    ...(overrides.spoolerBridge !== undefined
      ? { spoolerBridgeOverride: overrides.spoolerBridge }
      : {}),
  };
  const runtime = await createAgentRuntime({
    db,
    settings,
    log,
    agentVersion: '0.1.0-test',
    deviceName: 'TEST-PC',
    safeStorage: overrides.safeStorage ?? fakeSafeStorage(),
    paths: {
      printersFile: ':memory-printers',
      dbFile: null,
      identityKvFile: ':memory-identity-kv',
    },
    cloud: { baseUrl: 'https://api.test', pollIntervalMs: 20 },
    env,
  });
  runtimes.push(runtime);
  return { runtime, transport, db, settings, log };
}

export { makeRuntime };
```

The helper references `makeDoc` and `SpoolerBridge` — add these imports at
the top (not shown in the block above):

```typescript
import type { SpoolerBridge } from '../../src/main/transport/spooler-native';
import { makeDoc } from './render';
```

- [ ] **Step 2: Trim `tests/agent-runtime.test.ts`**

Delete the now-moved definitions — everything between the imports and the
`// ---- db seeding ----` section **except** `failingTransports()` (keep
lines ~178-188), plus the harness block `RuntimeHarness` / `runtimes` /
`databases` / `afterEach` / `makeRuntime` (lines ~260-348). Keep
`manualSchedule()` (lines ~350-378) and `insertJobRow`/`SeedOverrides`.

Replace the import block at the top with:

```typescript
import { describe, expect, it, vi } from 'vitest';
import type { SqliteDatabase } from '../src/main/local-store/db';
import { CloudError } from '../src/main/cloud-client/errors';
import type { TransportRegistry } from '../src/main/transport/registry';
import { TransportError } from '../src/main/transport/errors';
import { makeDraft } from './helpers/printers';
import {
  PAIRING_CODE,
  RESTAURANT_ID,
  TENANT_ID,
  fakeKv,
  makeCloudConfig,
  makeCloudPrinterConfig,
  makeRuntime,
  makeUuid,
  signedJobEnvelope,
} from './helpers/runtime-harness';
```

The old local `FakeTransport` name does not appear in test bodies (transports
come from `makeRuntime()`), so no other body edits are needed.

- [ ] **Step 3: Run typecheck + lint and prune unused imports**

Run: `pnpm typecheck && pnpm lint`

Expected: clean. If `no-unused-vars` fires on imports that only the moved
code used (expected candidates: `createPrivateKey`, `generateDeviceKeyPair`,
`signJobForTest`, `ENVELOPE_VERSION`, `PollResponse`, `PairResponse`,
`RefreshResponse`, `ServerKeysResponse`, `PrinterConfig`, `ConfigUpdate`,
`AckBatch`, `AgentTransport`, `HeartbeatSample`, `TransportAuth`,
`SecretKv`, `SafeStorageLike`, `Logger`, `createSettingsStore`,
`SettingsStore`, `memoryAdapter`, `openDatabase`, `closeDatabase`,
`migrate`, `makeDoc`, `SpoolerBridge`, `afterEach`), delete those import
lines. If typecheck reports a *missing* import instead, add it back — the
file body is the source of truth.

- [ ] **Step 4: Run the runtime test suite**

Run: `pnpm vitest run tests/agent-runtime.test.ts`

Expected: all tests PASS, same count as before the extraction (no skips).

- [ ] **Step 5: Commit**

```bash
git add tests/helpers/runtime-harness.ts tests/agent-runtime.test.ts
git commit -m "refactor(tests): extract shared AgentRuntime harness to tests/helpers"
```

---

### Task 2: The burst test

**Files:**
- Create: `tests/burst-load.test.ts`

This is a test-only addition against unchanged production code, so "red"
would mean a product bug — if Step 2 fails, stop and debug the product
(systematic-debugging), do not weaken assertions.

- [ ] **Step 1: Create `tests/burst-load.test.ts`**

```typescript
import { describe, expect, it, vi } from 'vitest';
import { FakeTransportRegistry } from './helpers/fake-transport';
import { decodeEscpos } from './helpers/escpos-decode';
import { makeDoc } from './helpers/render';
import {
  PAIRING_CODE,
  makeCloudConfig,
  makeCloudPrinterConfig,
  makeRuntime,
  signedJobEnvelope,
} from './helpers/runtime-harness';

/**
 * C2 load burst (R-VAL-6): 10 jobs in 5 s over the poll delivery path.
 * The schedule seam clamps every timer to 5 ms, so the "5 s" window is
 * virtual — the stress is intake depth (ONE pollJobs response carries the
 * whole burst) and per-printer interleaving, not wall clock. Deterministic:
 * no sleeps, no real network, no real printers.
 */

const BURST_SIZE = 10;
const JOBS_PER_PRINTER = 5;

describe('C2 load burst (R-VAL-6)', () => {
  it('drains a 10-job single-poll burst across 2 printers: FIFO order, acks drain, zero ambiguous', async () => {
    const printerTransports = new FakeTransportRegistry();
    const printerA = makeCloudPrinterConfig(1, { station: 'kitchen' });
    const printerB = makeCloudPrinterConfig(2, { station: 'counter' });
    const { runtime, transport } = await makeRuntime({ transports: printerTransports });

    // Cloud config (version 1, two tcp_raw printers) applies before any job
    // is released — otherwise intake would reject on unknown printers.
    transport.configResponse = makeCloudConfig(1, [printerA, printerB]);
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    await vi.waitFor(() => {
      expect(runtime.printers.list()).toHaveLength(2);
    });

    // Interleaved A1,B1,A2,B2,… — per-printer submission order is 1→5.
    const envelopeIds = new Set<string>();
    const expectedOrder: Record<'A' | 'B', string[]> = { A: [], B: [] };
    const burst: Record<string, unknown>[] = [];
    for (let seq = 1; seq <= JOBS_PER_PRINTER; seq += 1) {
      for (const key of ['A', 'B'] as const) {
        const printer = key === 'A' ? printerA : printerB;
        const marker = `BURST-${key}-${String(seq)}`;
        expectedOrder[key].push(marker);
        const envelope = signedJobEnvelope(printer.printer_id, {
          job_id: `018f3c2e-0000-7000-8000-${String(300 + burst.length).padStart(12, '0')}`,
          idempotency_key: `burst-${key}-${String(seq)}`,
          payload: makeDoc({ lines: [{ text: marker }] }),
        });
        envelopeIds.add((envelope.job as { job_id: string }).job_id);
        burst.push(envelope);
      }
    }

    // Worst-case arrival: one poll response delivers the entire burst.
    transport.queuedJobs.push(...burst);

    // 1. Completion: all 10 reach `completed`; queue fully drained.
    await vi.waitFor(() => {
      const jobs = runtime.jobs.list();
      expect(jobs).toHaveLength(BURST_SIZE);
      for (const job of jobs) expect(job.status).toBe('completed');
    });
    const snap = await runtime.snapshot();
    expect(snap.pendingJobs).toBe(0);
    expect(snap.ambiguousJobs).toBe(0);

    // 2. Per-printer FIFO: decoded receipt text per printer is strictly in
    //    submission order — the engine never reorders within a printer.
    for (const key of ['A', 'B'] as const) {
      const printer = key === 'A' ? printerA : printerB;
      const t = printerTransports.get(printer.printer_id);
      expect(t, `printer transport for ${key}`).toBeDefined();
      const seen = (t?.writes ?? []).flatMap((w) =>
        decodeEscpos(w).flatMap((e) =>
          e.kind === 'text' && e.text.includes('BURST-') ? [e.text] : [],
        ),
      );
      expect(seen).toEqual(expectedOrder[key]);
    }

    // 3. Ack wire drain: exactly the burst's job ids reached the wire, each
    //    with BOTH the accepted and the completed ack; nothing rejected.
    await vi.waitFor(() => {
      const acks = transport.acks.flatMap((b) => b.acks);
      for (const status of ['accepted', 'completed'] as const) {
        const acked = new Set(acks.filter((a) => a.status === status).map((a) => a.job_id));
        expect(acked).toEqual(envelopeIds);
      }
      expect(acks.some((a) => a.status === 'rejected')).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run the burst test**

Run: `pnpm vitest run tests/burst-load.test.ts`

Expected: PASS. If it fails, the failure is a finding about the engine,
poller, or ack buffer under burst load — investigate the actual
ordering/drain behavior against `docs/architecture.md` §5 before touching
anything; do not add sleeps, retries, or weakened assertions to force green.

- [ ] **Step 3: Run the full suite**

Run: `pnpm test`

Expected: full suite PASS (new test included).

- [ ] **Step 4: Commit**

```bash
git add tests/burst-load.test.ts
git commit -m "test(load): C2 burst — 10-job single-poll rush: FIFO, ack drain, zero ambiguous (R-VAL-6)"
```

---

### Task 3: Update production-readiness and run the full gate

**Files:**
- Modify: `docs/production-readiness.md` (§C2)

- [ ] **Step 1: Update the C2 status**

In `docs/production-readiness.md`, replace:

```markdown
### C2. Load burst test (R-VAL-6)

- **Status:** open.
```

with:

```markdown
### C2. Load burst test (R-VAL-6)

- **Status:** CI burst test done (2026-10-30) — `tests/burst-load.test.ts`:
  10 signed envelopes delivered in one poll response across two tcp_raw
  printers (5+5), asserting per-printer FIFO order (decoded ESC/POS output),
  full ack drain (accepted + completed for every burst job id), zero
  ambiguous/failed/rejected, and queue depth back to 0. Shared runtime
  harness extracted to `tests/helpers/runtime-harness.ts`. Still open: the
  recorded run against staging — blocked on the staging backend (same
  blocker as B2).
```

Leave the What/Depends on/Closes with bullets untouched.

- [ ] **Step 2: Full gate**

Run: `pnpm test && pnpm typecheck && pnpm lint`

Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add docs/production-readiness.md
git commit -m "docs: C2 CI burst leg done, staging run deferred with B2"
```
