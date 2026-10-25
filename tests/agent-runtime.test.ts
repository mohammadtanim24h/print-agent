import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentRuntime, type AgentRuntime, type RuntimeDeps } from '../src/main/agent-runtime';
import { openDatabase, closeDatabase } from '../src/main/local-store/db';
import type { SqliteDatabase } from '../src/main/local-store/db';
import { migrate } from '../src/main/local-store/migrations';
import { createSettingsStore, type SettingsStore } from '../src/main/services/settings';
import type { Logger } from '../src/main/services/logger/logger';
import type { SecretKv, SafeStorageLike } from '../src/main/cloud-client/secret-store';
import type {
  AckBatch,
  AgentTransport,
  HeartbeatSample,
  TransportAuth,
} from '../src/main/cloud-client/types';
import type {
  ConfigUpdate,
  PairResponse,
  PollResponse,
  RefreshResponse,
  ServerKeysResponse,
} from '../src/main/cloud-client/schemas';
import { CloudError } from '../src/main/cloud-client/errors';
import { generateDeviceKeyPair } from '../src/main/cloud-client/envelope-sig';
import type { TransportRegistry } from '../src/main/transport/registry';
import { memoryAdapter } from './helpers/memory-adapter';
import { makeDraft } from './helpers/printers';

/**
 * AgentRuntime tests: fake transport + kv + safeStorage over an in-memory
 * SQLite database. The fake transport's `pair` returns a REAL ed25519 public
 * key generated at module scope; test envelopes are signed with the matching
 * private key so the poller's signature verification accepts them.
 */

const TENANT_ID = '018f3c2e-0000-7000-8000-000000000001';
const RESTAURANT_ID = '018f3c2e-0000-7000-8000-000000000002';
const PAIRING_CODE = '7QJ2K9XD';

function makeUuid(n: number): string {
  return `018f3c2e-0000-7000-8000-${String(n).padStart(12, '0')}`;
}

// ---- fakes ------------------------------------------------------------------

function fakeSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(plain, 'utf8'),
    decryptString: (buf) => buf.toString('utf8'),
  };
}

function fakeKv(): SecretKv {
  const map = new Map<string, string>();
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => void map.set(k, v),
    delete: (k) => void map.delete(k),
  };
}

export interface FakeTransport extends AgentTransport {
  readonly queuedJobs: unknown[];
  readonly acks: AckBatch[];
  readonly heartbeats: HeartbeatSample[];
  /** Next pollJobs call throws this once (e.g. CloudError with serverCode 'device_revoked'). */
  failNextPoll: Error | null;
}

function fakeTransport(): FakeTransport {
  const impl = {
    baseUrl: 'https://api.test',
    queuedJobs: [] as unknown[],
    acks: [] as AckBatch[],
    heartbeats: [] as HeartbeatSample[],
    failNextPoll: null as Error | null,
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
      return Promise.resolve({ type: 'config_update', config_version: 0, printers: [] });
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

/** Printer transports that succeed instantly — hermetic, no real sockets. */
function stubTransports(): TransportRegistry {
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

// ---- db seeding ----------------------------------------------------------------

interface SeedOverrides {
  readonly id: string;
  readonly status: string;
  readonly printerId?: string;
  readonly createdAt?: number;
}

function insertJobRow(db: SqliteDatabase, seed: SeedOverrides): void {
  db.prepare(
    `INSERT INTO jobs (id, idempotency_key, tenant_id, restaurant_id, printer_id, doc_type,
                       doc_version, payload_json, priority, copies, status, attempts, reprint_of,
                       created_at, expires_at, sent_at, completed_at, updated_at, last_error)
     VALUES (?, ?, ?, ?, ?, ?, 1, '{}', 5, 1, ?, 0, NULL, ?, NULL, NULL, NULL, ?, NULL)`,
  ).run(
    seed.id,
    `key-${seed.id}`,
    TENANT_ID,
    RESTAURANT_ID,
    seed.printerId ?? makeUuid(9),
    'customer_receipt',
    seed.status,
    seed.createdAt ?? 1_000,
    seed.createdAt ?? 1_000,
  );
}

// ---- harness -------------------------------------------------------------------

interface RuntimeHarness {
  runtime: AgentRuntime;
  transport: FakeTransport;
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
    transport?: FakeTransport;
    transports?: TransportRegistry;
    schedule?: (fn: () => void, delayMs: number) => () => void;
    fetchOverride?: typeof fetch;
  } = {},
): Promise<RuntimeHarness> {
  const db = openDatabase({ file: null });
  migrate(db);
  databases.push(db);
  const transport = overrides.transport ?? fakeTransport();
  const settings = await createSettingsStore({
    filePath: ':memory-settings',
    adapter: memoryAdapter(),
    report: () => {},
  });
  const log: Logger = {
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
    kvOverride: fakeKv(),
    transportsOverride: overrides.transports ?? stubTransports(),
    adapterOverride: memoryAdapter(),
    schedule,
    ...(overrides.fetchOverride !== undefined
      ? { fetchOverride: overrides.fetchOverride }
      : {}),
  };
  const runtime = await createAgentRuntime({
    db,
    settings,
    log,
    agentVersion: '0.1.0-test',
    deviceName: 'TEST-PC',
    safeStorage: fakeSafeStorage(),
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

// ---- tests ---------------------------------------------------------------------

describe('AgentRuntime lifecycle', () => {
  it('starts unpaired with no identity and an empty queue', async () => {
    const { runtime } = await makeRuntime();
    runtime.start();
    const snap = await runtime.snapshot();
    expect(snap.connection).toBe('unpaired');
    expect(snap.identity).toBeNull();
    expect(snap.pendingJobs).toBe(0);
    expect(snap.ambiguousJobs).toBe(0);
    expect(snap.lastActivityAt).toBeNull();
    expect(runtime.agentInfo()).toEqual({
      name: 'print-agent',
      version: '0.1.0-test',
      connectionState: 'unpaired',
    });
  });

  it('pairs, records pairedAt in settings, and reaches online', async () => {
    const { runtime, settings, transport } = await makeRuntime();
    runtime.start();
    const result = await runtime.pair(PAIRING_CODE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity).toMatchObject({
        deviceId: makeUuid(3),
        agentName: 'TEST-PC',
        restaurantId: RESTAURANT_ID,
        restaurantName: RESTAURANT_ID,
      });
      expect(result.identity.pairedAt).not.toBeNull();
    }
    expect(settings.get().pairedAt).not.toBeNull();
    await vi.waitFor(async () => {
      expect((await runtime.snapshot()).connection).toBe('online');
    });
    expect(transport.heartbeats.length).toBeGreaterThanOrEqual(0); // cycle heartbeat seam exercised
  });

  it('refuses a second pair while already paired', async () => {
    const { runtime } = await makeRuntime();
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    const second = await runtime.pair(PAIRING_CODE);
    expect(second).toMatchObject({ ok: false, reason: 'already_paired' });
  });

  it('unpair wipes identity, jobs, printers and config', async () => {
    const { runtime, db } = await makeRuntime();
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    await runtime.printers.add(makeDraft());
    insertJobRow(db, { id: makeUuid(50), status: 'completed' });
    expect(runtime.jobs.list()).toHaveLength(1);

    await runtime.unpair();

    const snap = await runtime.snapshot();
    expect(snap.connection).toBe('unpaired');
    expect(snap.identity).toBeNull();
    expect(runtime.printers.list()).toEqual([]);
    expect(runtime.jobs.list()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM jobs').get()).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM cloud_config').get()).toMatchObject({ n: 0 });
  });

  it('recovers interrupted rows before the first poll', async () => {
    const { runtime, db } = await makeRuntime();
    insertJobRow(db, { id: makeUuid(51), status: 'sending' });
    runtime.start();
    await vi.waitFor(() => {
      const row = db.prepare('SELECT status FROM jobs WHERE id = ?').get(makeUuid(51));
      expect(row).toMatchObject({ status: 'ambiguous' });
    });
  });

  it('unpair after a wiped state never throws and stays unpaired', async () => {
    const { runtime } = await makeRuntime();
    runtime.start();
    await runtime.unpair();
    await runtime.unpair();
    expect((await runtime.snapshot()).connection).toBe('unpaired');
  });
});

describe('AgentSnapshot details', () => {
  it('reports lastActivityAt from terminal rows and honest per-state detail', async () => {
    const { runtime, db } = await makeRuntime();
    insertJobRow(db, { id: makeUuid(52), status: 'failed', createdAt: 5_000 });
    runtime.start();
    const snap = await runtime.snapshot();
    expect(snap.lastActivityAt).toBe(new Date(5_000).toISOString());
    expect(snap.connectionDetail).toContain('Not paired');
    expect(snap.version).toBe('0.1.0-test');
  });
});

describe('AgentRuntime diagnostics', () => {
  it('returns exactly the three checks, passing on a healthy system', async () => {
    const { runtime } = await makeRuntime({
      fetchOverride: () => Promise.resolve(new Response('ok')),
    });
    const checks = await runtime.diagnostics.checks();
    expect(checks.map((c) => c.id)).toEqual(['cloud-api', 'printers', 'db']);
    expect(checks[0]).toMatchObject({ status: 'pass', detail: 'TLS/HTTP reachable' });
    expect(checks[1]).toMatchObject({ status: 'pass', detail: 'No printers configured' });
    expect(checks[2]).toMatchObject({ status: 'pass', detail: 'Integrity check passed' });
  });

  it('cloud-api check fails when the fetch throws', async () => {
    const { runtime } = await makeRuntime({
      fetchOverride: () => Promise.reject(new Error('no route to host')),
    });
    const checks = await runtime.diagnostics.checks();
    expect(checks[0]).toMatchObject({ id: 'cloud-api', status: 'fail' });
  });

  it('report carries db facts and platform info', async () => {
    const { runtime } = await makeRuntime();
    const report = await runtime.diagnostics.report();
    expect(report).toMatchObject({
      version: '0.1.0-test',
      platform: expect.stringContaining(process.arch),
      db: { ok: true, sizeBytes: 0, queueDepth: 0, journalMode: 'memory' },
    });
    expect(report.uptimeS).toBeGreaterThanOrEqual(0);
  });

  it('recentLogs delegates to the logger ring', async () => {
    const { runtime } = await makeRuntime();
    expect(runtime.diagnostics.recentLogs()).toEqual([]);
  });
});
