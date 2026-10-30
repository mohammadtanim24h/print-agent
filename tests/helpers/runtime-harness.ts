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
import type { SpoolerBridge } from '../../src/main/transport/spooler-native';
import { memoryAdapter } from './memory-adapter';
import { makeDoc } from './render';

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
