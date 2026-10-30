import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPrivateKey } from 'node:crypto';
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
  PrinterConfig,
  RefreshResponse,
  ServerKeysResponse,
} from '../src/main/cloud-client/schemas';
import { CloudError } from '../src/main/cloud-client/errors';
import { generateDeviceKeyPair, signJobForTest } from '../src/main/cloud-client/envelope-sig';
import { ENVELOPE_VERSION } from '../src/main/cloud-client/schemas';
import type { TransportRegistry } from '../src/main/transport/registry';
import type { SpoolerBridge } from '../src/main/transport/spooler-native';
import { TransportError } from '../src/main/transport/errors';
import { memoryAdapter } from './helpers/memory-adapter';
import { makeDraft } from './helpers/printers';
import { makeDoc } from './helpers/render';

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
  /** Mutable GET /config response for refreshConfig tests. */
  configResponse: ConfigUpdate;
  readonly configFetches: number;
}

function fakeTransport(): FakeTransport {
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

function makeCloudPrinterConfig(n: number, overrides: Partial<PrinterConfig> = {}): PrinterConfig {
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

function makeCloudConfig(configVersion: number, printers: PrinterConfig[]): ConfigUpdate {
  return { type: 'config_update', config_version: configVersion, printers };
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

function failingTransports(): TransportRegistry {
  return {
    forPrinter: () => ({
      open: () => Promise.reject(new TransportError('host_unreachable', 'stub: unreachable')),
      write: () => Promise.reject(new TransportError('write_failed', 'stub: not connected')),
      close: () => Promise.resolve(),
      healthCheck: () =>
        Promise.reject(new TransportError('host_unreachable', 'stub: unreachable')),
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
function signedJobEnvelope(
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

/** Inert marker removed: the runtime is polling-first (api-contract §7,
 *  amended 2026-10-30) and constructs no WSS channel at all. */

async function makeRuntime(
  overrides: {
    transport?: FakeTransport;
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
  const transport = overrides.transport ?? fakeTransport();
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

/** Manual scheduler: collects timers; tick() fires only sub-second timers
 *  (poll cadence, engine backoffs) so the ack buffer's 5 s delay timer never
 *  auto-fires — retained acks can then only reach the wire via flushNow. */
function manualSchedule(): {
  schedule: (fn: () => void, delayMs: number) => () => void;
  tick: () => Promise<void>;
} {
  const timers: Array<{ fn: () => void; delayMs: number; cancelled: boolean }> = [];
  const settle = async (ticks = 8): Promise<void> => {
    for (let i = 0; i < ticks; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
  return {
    schedule: (fn, delayMs) => {
      const t = { fn, delayMs, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    async tick() {
      const due = timers.filter((t) => !t.cancelled && t.delayMs < 1_000);
      for (const t of due) t.cancelled = true;
      for (const t of due) t.fn();
      await settle();
    },
  };
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

  it('presents as unpaired instead of crashing when the stored identity cannot be decrypted', async () => {
    // DPAPI decrypt failure after a Windows credential reset: secrets.load()
    // throws CloudError('secure_storage_unavailable') — start() must not
    // reject, and the snapshot must present the operator with a pairable,
    // unpaired state (never a wipe, never an unhandled rejection).
    const kv = fakeKv();
    kv.set('cloud.identity', Buffer.from('undecryptable-blob', 'utf8').toString('base64'));
    const storage: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(plain, 'utf8'),
      decryptString: () => {
        throw new Error('simulated DPAPI failure');
      },
    };
    const warnLog = vi.fn();
    const { runtime } = await makeRuntime({
      kv,
      safeStorage: storage,
      log: { debug: vi.fn(), info: vi.fn(), warn: warnLog, error: vi.fn() },
    });
    expect(() => {
      runtime.start();
    }).not.toThrow();
    const snap = await runtime.snapshot();
    expect(snap.connection).toBe('unpaired');
    expect(snap.identity).toBeNull();
    // readIdentity's policy fired: unreadable storage is surfaced, never wiped.
    expect(warnLog).toHaveBeenCalledWith(
      expect.stringContaining('stored identity unreadable, presenting as unpaired'),
    );
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

describe('cloud event plumbing', () => {
  it('a polled signed job becomes an engine row and produces acks on the wire', async () => {
    const { runtime, transport } = await makeRuntime();
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    const printer = await runtime.printers.add(makeDraft());
    transport.queuedJobs.push(signedJobEnvelope(printer.config.printerId));
    await vi.waitFor(() => {
      const jobs = runtime.jobs.list();
      expect(jobs).toHaveLength(1);
      expect(['completed', 'failed']).toContain(jobs[0]?.status);
    });
    await vi.waitFor(() => {
      // Batches may flush incrementally — wait until the accepted AND the
      // terminal ack both reached the wire before asserting on the set.
      const statuses = transport.acks.flatMap((b) => b.acks.map((a) => a.status));
      expect(statuses).toContain('accepted');
      // Stub transport hand-off succeeds: 'completed' means hand-off, never 'printed' (§3.1).
      expect(statuses).toContain('completed');
    });
    const statuses = transport.acks.flatMap((b) => b.acks.map((a) => a.status));
    expect(statuses).not.toContain('rejected');
  });

  it('heartbeat sample reports queue depth and printer health', async () => {
    const { runtime, transport } = await makeRuntime();
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    const printer = await runtime.printers.add(makeDraft());
    await vi.waitFor(() => {
      expect(transport.heartbeats.length).toBeGreaterThanOrEqual(1);
    });
    const sample = transport.heartbeats.at(-1);
    expect(sample).toMatchObject({
      connection: 'poll',
      queue_depth: 0,
      printers: [{ printer_id: printer.config.printerId, health: 'unknown' }],
    });
    expect(sample?.uptime_s).toBeGreaterThanOrEqual(0);
  });

  it('a config_update in the poll response persists to cloud_config', async () => {
    const { runtime, transport, db } = await makeRuntime();
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    transport.queuedJobs.push({ type: 'config_update', config_version: 7, printers: [] });
    await vi.waitFor(() => {
      const row = db.prepare('SELECT config_version FROM cloud_config').get();
      expect(row).toMatchObject({ config_version: 7 });
    });
  });

  it('revocation wipes local state and surfaces the revoked snapshot', async () => {
    const { runtime, transport, settings } = await makeRuntime();
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    await runtime.printers.add(makeDraft());
    transport.failNextPoll = new CloudError(
      'unauthorized',
      'device revoked',
      undefined,
      'device_revoked',
    );
    await vi.waitFor(async () => {
      expect((await runtime.snapshot()).connection).toBe('revoked');
    });
    expect((await runtime.snapshot()).identity).toBeNull();
    expect(runtime.printers.list()).toEqual([]);
    expect(runtime.jobs.list()).toEqual([]);
    expect(settings.get().pairedAt).toBeNull();
    expect(runtime.agentInfo().connectionState).toBe('revoked');
  });

  it('retained acks drain when the client transitions back to online (flushNow)', async () => {
    const sched = manualSchedule();
    const { runtime, transport } = await makeRuntime({ schedule: sched.schedule });
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    await sched.tick(); // cycle 1 → online
    expect((await runtime.snapshot()).connection).toBe('online');

    const printer = await runtime.printers.add(makeDraft());
    transport.queuedJobs.push(signedJobEnvelope(printer.config.printerId));
    await sched.tick(); // cycle 2 → job submitted; acks retained (the 5 s delay timer never fires)
    expect(runtime.jobs.list()).toHaveLength(1);
    expect(transport.acks).toHaveLength(0);

    transport.failNextPoll = new CloudError('network', 'link down');
    await sched.tick(); // cycle 3 → offline
    expect((await runtime.snapshot()).connection).toBe('offline');

    transport.failNextPoll = null;
    await sched.tick(); // cycle 4 → online transition → flushNow drains the retained acks
    expect(transport.acks.length).toBeGreaterThanOrEqual(1);
    expect(transport.acks.flatMap((b) => b.acks.map((a) => a.status))).toContain('accepted');
  });

  it('reprint creates a new row with reprint_of set and refuses retrying completed jobs', async () => {
    const { runtime, transport, db } = await makeRuntime();
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    const printer = await runtime.printers.add(makeDraft());
    transport.queuedJobs.push(signedJobEnvelope(printer.config.printerId));
    await vi.waitFor(() => {
      const jobs = runtime.jobs.list();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.status).toBe('completed');
    });
    const original = runtime.jobs.list()[0];
    if (original === undefined) throw new Error('unreachable: original job missing');

    const reprinted = await runtime.jobs.reprint(original.jobId);
    expect(reprinted.jobId).not.toBe(original.jobId);
    expect(reprinted.idempotencyKey).toContain('#reprint-');
    expect(reprinted.destinationPrinterName).toBe('Kitchen');
    await vi.waitFor(() => {
      expect(
        runtime.jobs.list().some((j) => j.jobId === reprinted.jobId && j.status === 'completed'),
      ).toBe(true);
    });
    expect(
      db.prepare('SELECT reprint_of FROM jobs WHERE id = ?').get(reprinted.jobId),
    ).toMatchObject({ reprint_of: original.jobId });

    // Completed jobs are not retryable — the typed engine error propagates.
    await expect(runtime.jobs.retry(reprinted.jobId)).rejects.toThrow(/only failed jobs/);
  });

  it('retry re-queues a failed job through a fresh attempt cycle', async () => {
    const { runtime, transport } = await makeRuntime({ transports: failingTransports() });
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    const printer = await runtime.printers.add(makeDraft());
    transport.queuedJobs.push(signedJobEnvelope(printer.config.printerId));
    await vi.waitFor(() => {
      const jobs = runtime.jobs.list();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.status).toBe('failed');
    });
    const failed = runtime.jobs.list()[0];
    if (failed === undefined) throw new Error('unreachable: failed job missing');

    const retried = await runtime.jobs.retry(failed.jobId);
    expect(retried.jobId).toBe(failed.jobId);
    // The retry exhausts its fresh attempt budget against the failing transport.
    await vi.waitFor(() => {
      const record = runtime.jobs.list()[0];
      expect(record?.status).toBe('failed');
      expect(record?.attempts).toBe(3);
    });
  });
});

describe('AgentRuntime config application (FR-16)', () => {
  it('applies a config_update from the poll batch to the printer store', async () => {
    const { runtime, transport } = await makeRuntime();
    transport.queuedJobs.push(makeCloudConfig(1, [makeCloudPrinterConfig(1)]));
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    await vi.waitFor(() => {
      const cloud = runtime.printers.list().find((p) => p.config.source === 'cloud');
      expect(cloud?.config.name).toBe('Cloud-1');
    });
    expect(
      runtime.printers.list().find((p) => p.config.printerId === makeUuid(101))?.config.source,
    ).toBe('cloud');
  });

  it('a later config removes a dropped cloud printer but keeps local ones', async () => {
    const { runtime, transport } = await makeRuntime();
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    const local = await runtime.printers.add(makeDraft({ name: 'Local-Front' }));

    transport.queuedJobs.push(
      makeCloudConfig(1, [makeCloudPrinterConfig(1), makeCloudPrinterConfig(2)]),
    );
    await vi.waitFor(() => {
      expect(runtime.printers.list().filter((p) => p.config.source === 'cloud')).toHaveLength(2);
    });

    transport.queuedJobs.push(makeCloudConfig(2, [makeCloudPrinterConfig(1)]));
    await vi.waitFor(() => {
      const ids = runtime.printers.list().map((p) => p.config.printerId);
      expect(ids).toContain(local.config.printerId);
      expect(ids).toContain(makeUuid(101));
      expect(ids).not.toContain(makeUuid(102));
    });
  });

  it('updates a cloud printer in place when a new version changes its fields', async () => {
    const { runtime, transport } = await makeRuntime();
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    transport.queuedJobs.push(makeCloudConfig(1, [makeCloudPrinterConfig(1)]));
    await vi.waitFor(() => {
      expect(runtime.printers.list()).toHaveLength(1);
    });

    transport.queuedJobs.push(
      makeCloudConfig(2, [makeCloudPrinterConfig(1, { name: 'Cloud-1-renamed', station: 'bar' })]),
    );
    await vi.waitFor(() => {
      expect(runtime.printers.list().map((p) => p.config.name)).toEqual(['Cloud-1-renamed']);
    });
    const updated = runtime.printers.list()[0];
    if (updated === undefined) return;
    expect(updated.config.role).toBe('bar');
    expect(updated.config.source).toBe('cloud');
    // Still exactly one printer: update-in-place, not create+stale.
    expect(runtime.printers.list()).toHaveLength(1);
  });

  it('ignores a config_version regression end-to-end (contract §6)', async () => {
    const { runtime, transport } = await makeRuntime();
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    transport.queuedJobs.push(makeCloudConfig(5, [makeCloudPrinterConfig(1)]));
    await vi.waitFor(() => {
      expect(runtime.printers.list()).toHaveLength(1);
    });

    transport.queuedJobs.push(makeCloudConfig(4, [makeCloudPrinterConfig(2)]));
    // Give the poll loop a moment; the regression must never mutate the store.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runtime.printers.list().map((p) => p.config.name)).toEqual(['Cloud-1']);
  });

  it('reject-all: a config with an unmappable printer mutates nothing and warns', async () => {
    const warn = vi.fn();
    const { runtime, transport } = await makeRuntime({
      log: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    transport.queuedJobs.push(
      makeCloudConfig(3, [
        makeCloudPrinterConfig(1, { transport: { kind: 'usb', vid: '04b8', pid: '0202' } }),
      ]),
    );
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('not applicable in v1'));
    });
    expect(runtime.printers.list()).toHaveLength(0);
  });

  it('a fresh pair fetches GET /config once (initial fleet)', async () => {
    const { runtime, transport } = await makeRuntime();
    transport.configResponse = makeCloudConfig(7, [makeCloudPrinterConfig(3)]);
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    await vi.waitFor(() => {
      expect(runtime.printers.list().some((p) => p.config.name === 'Cloud-3')).toBe(true);
    });
    expect(transport.configFetches).toBeGreaterThanOrEqual(1);
  });

  it('start() re-applies a persisted config that was saved but never applied', async () => {
    const { runtime, db, transport } = await makeRuntime();
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    // Applied v1 (marker = 1), then simulate a crash after save of v2 but
    // before its apply: write v2 straight into cloud_config.
    transport.queuedJobs.push(makeCloudConfig(1, [makeCloudPrinterConfig(1)]));
    await vi.waitFor(() => {
      expect(runtime.printers.list()).toHaveLength(1);
    });
    await runtime.stop();
    const v2 = makeCloudConfig(2, [makeCloudPrinterConfig(1), makeCloudPrinterConfig(2)]);
    const upsert = db.prepare(
      `INSERT INTO cloud_config (id, config_version, payload_json, updated_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET config_version = excluded.config_version,
         payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
    );
    upsert.run(v2.config_version, JSON.stringify(v2), Date.now());

    runtime.start(); // restart path: persisted v2 > marker 1 → apply

    await vi.waitFor(() => {
      expect(runtime.printers.list()).toHaveLength(2);
    });
  });

  it('unpair resets the applied-version marker so a fresh pair can use lower versions', async () => {
    const { runtime, transport, settings } = await makeRuntime();
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    transport.queuedJobs.push(makeCloudConfig(9, [makeCloudPrinterConfig(1)]));
    await vi.waitFor(() => {
      expect(runtime.printers.list()).toHaveLength(1);
    });
    expect(settings.get().appliedConfigVersion).toBe(9);

    await runtime.unpair();
    expect(settings.get().appliedConfigVersion).toBe(-1);
    expect(settings.get().pairedAt).toBeNull();
  });

  it('applies two back-to-back config versions from one poll batch in order', async () => {
    const { runtime, transport, settings } = await makeRuntime();
    // Both versions queued BEFORE pairing: the first poll cycle after pair()
    // hands both to the client in one batch — the apply chain must serialize
    // them (v1 then v2) without the regression guard misfiring on v2.
    transport.queuedJobs.push(
      makeCloudConfig(1, [makeCloudPrinterConfig(1)]),
      makeCloudConfig(2, [makeCloudPrinterConfig(1), makeCloudPrinterConfig(2)]),
    );
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    await vi.waitFor(() => {
      expect(runtime.printers.list().filter((p) => p.config.source === 'cloud')).toHaveLength(2);
    });
    expect(
      runtime.printers
        .list()
        .map((p) => p.config.name)
        .sort(),
    ).toEqual(['Cloud-1', 'Cloud-2']);
    expect(settings.get().appliedConfigVersion).toBe(2);
  });

  it('config and revoke in the same poll batch end fully wiped', async () => {
    const { runtime, transport, settings, db } = await makeRuntime();
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    transport.queuedJobs.push(makeCloudConfig(1, [makeCloudPrinterConfig(1)]));
    await vi.waitFor(() => {
      expect(runtime.printers.list()).toHaveLength(1);
    });

    // v2 is processed before the revoke envelope in the same batch, so its
    // apply races the wipe. This test's wipe-safety coverage comes via the
    // poller's synchronous secrets.clear() before onRevoked: by the time the
    // wipe runs, the identity gate sees a null identity. The unpair-path
    // mid-drain window is closed by the wipe's double-drain and is not
    // directly arrangeable with the fake transport's microtask-timed
    // promises.
    transport.queuedJobs.push(makeCloudConfig(2, [makeCloudPrinterConfig(2)]), {
      type: 'revoke',
      reason: 'device revoked by operator',
    });
    await vi.waitFor(async () => {
      expect((await runtime.snapshot()).connection).toBe('revoked');
    });
    expect(runtime.printers.list()).toEqual([]);
    expect((await runtime.snapshot()).identity).toBeNull();
    expect(settings.get().appliedConfigVersion).toBe(-1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM cloud_config').get()).toMatchObject({ n: 0 });
  });

  it('an unreadable persisted config warns and applies nothing at start', async () => {
    const warn = vi.fn();
    const { runtime, db, transport, settings } = await makeRuntime({
      log: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    transport.queuedJobs.push(makeCloudConfig(1, [makeCloudPrinterConfig(1)]));
    await vi.waitFor(() => {
      expect(runtime.printers.list()).toHaveLength(1);
    });
    await runtime.stop();

    // Simulate a corrupted/partial persisted payload that fails ConfigUpdateSchema.
    const broken = JSON.stringify({
      type: 'config_update',
      config_version: 3,
      printers: [{ broken: true }],
    });
    const upsert = db.prepare(
      `INSERT INTO cloud_config (id, config_version, payload_json, updated_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET config_version = excluded.config_version,
         payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
    );
    upsert.run(3, broken, Date.now());

    runtime.start(); // restart path: persisted config is unreadable → warn, skip
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('unreadable'));
    });
    expect(runtime.printers.list().map((p) => p.config.name)).toEqual(['Cloud-1']);
    expect(settings.get().appliedConfigVersion).toBe(1);
  });
});

describe('AgentRuntime polling-first delivery (§7 amendment 2026-10-30)', () => {
  it('runs REST cycles with the piggybacked heartbeat — no channel involved', async () => {
    const { runtime, transport } = await makeRuntime();
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    // Poll cycles carry §3.2 heartbeats directly over REST (no WSS channel is
    // constructed by the runtime, so nothing ever dials `wss://`).
    await vi.waitFor(() => {
      expect(transport.heartbeats.length).toBeGreaterThanOrEqual(1);
    });
    await runtime.stop();
  });
});

describe('AgentRuntime system printers (A2)', () => {
  it('exposes Windows printer names via the injected spooler bridge', async () => {
    const spoolerBridge = {
      printerExists: () => Promise.resolve(true),
      writeRaw: () => Promise.resolve(),
      enumerate: () => Promise.resolve(['EPSON TM-T20', 'Star TSP143']),
    };
    const { runtime } = await makeRuntime({ spoolerBridge });
    await expect(runtime.printers.systemPrinters()).resolves.toEqual([
      'EPSON TM-T20',
      'Star TSP143',
    ]);
  });
});

// ---- printer status polling (C1) ------------------------------------------------

/** Factory so a rejected probe creates a FRESH rejected promise per call — a
 *  single shared rejected promise would trip vitest's unhandled-rejection
 *  detection before the poller ever attaches its handler. */
function statusTransports(
  answer: () => Promise<readonly [number, number]>,
): TransportRegistry {
  return {
    forPrinter: () => ({
      open: () => Promise.resolve(),
      write: () => Promise.resolve(),
      close: () => Promise.resolve(),
      healthCheck: () => Promise.resolve(),
      status: () => answer(),
    }),
  };
}

describe('AgentRuntime printer status polling (C1)', () => {
  it('heartbeat reports cached DLE EOT status for gated printers', async () => {
    const { runtime, transport } = await makeRuntime({
      transports: statusTransports(() => Promise.resolve([0x12, 0x00] as const)),
    });
    runtime.start();
    expect((await runtime.pair(PAIRING_CODE)).ok).toBe(true);
    await runtime.printers.add(makeDraft({ statusPolling: 'auto', name: 'Kitchen-1' }));

    await vi.waitFor(
      () => {
        const sample = transport.heartbeats.at(-1);
        expect(sample?.printers[0]).toMatchObject({ health: 'ok' });
      },
      { timeout: 2_000 },
    );
  });

  it('ungated printers keep reporting unknown', async () => {
    const { runtime, transport } = await makeRuntime({
      transports: statusTransports(() => Promise.resolve([0x12, 0x00] as const)),
    });
    runtime.start();
    expect((await runtime.pair(PAIRING_CODE)).ok).toBe(true);
    await runtime.printers.add(makeDraft({ name: 'Kitchen-2' })); // statusPolling unset

    await vi.waitFor(
      () => {
        const sample = transport.heartbeats.at(-1);
        expect(sample?.printers[0]).toMatchObject({ health: 'unknown' });
      },
      { timeout: 2_000 },
    );
  });

  it('an unreachable gated printer reports offline (connect-class mapping)', async () => {
    const { runtime, transport } = await makeRuntime({
      transports: statusTransports(() =>
        Promise.reject(new TransportError('connect_refused', 'refused')),
      ),
    });
    runtime.start();
    expect((await runtime.pair(PAIRING_CODE)).ok).toBe(true);
    await runtime.printers.add(makeDraft({ statusPolling: 'auto', name: 'Kitchen-3' }));

    await vi.waitFor(
      () => {
        const sample = transport.heartbeats.at(-1);
        expect(sample?.printers[0]).toMatchObject({ health: 'offline' });
      },
      { timeout: 2_000 },
    );
  });

  it('stop() halts cleanly after status polling ran', async () => {
    const { runtime, transport } = await makeRuntime({
      transports: statusTransports(() => Promise.resolve([0x12, 0x00] as const)),
    });
    runtime.start();
    expect((await runtime.pair(PAIRING_CODE)).ok).toBe(true);
    await runtime.printers.add(makeDraft({ statusPolling: 'auto', name: 'Kitchen-4' }));
    await vi.waitFor(() => {
      expect(transport.heartbeats.length).toBeGreaterThanOrEqual(1);
    });
    await runtime.stop();
    // stop() intentionally keeps the last connection state; the observable
    // halt is that no further heartbeat cycles reach the wire.
    const atStop = transport.heartbeats.length;
    await new Promise((resolve) => setTimeout(resolve, 60)); // several poll cadences
    expect(transport.heartbeats.length).toBe(atStop);
  });
});
