import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { AgentTransport, AckBatch, TransportAuth } from '../../src/main/cloud-client/types';
import type {
  ConfigUpdate,
  PairResponse,
  PollResponse,
  RefreshResponse,
  ServerKeysResponse,
  Heartbeat,
} from '../../src/main/cloud-client/schemas';
import type {
  IdentitySecrets,
  SecretKv,
  SafeStorageLike,
} from '../../src/main/cloud-client/secret-store';
import { canonicalJson } from '../../src/main/cloud-client/canonical-json';

/** Shared fixtures for the mocked cloud-client tests: no real network, no
 *  real Electron, deterministic IDs. */

export const TENANT_ID = '018f3c2e-0000-7000-8000-000000000001';
export const RESTAURANT_ID = '018f3c2e-0000-7000-8000-000000000002';
export const DEVICE_ID = '018f3c2e-0000-7000-8000-000000000003';
export const PRINTER_ID = '018f3c2e-0000-7000-8000-000000000004';
export const JOB_ID = '018f3c2e-0000-7000-8000-000000000005';
export const OTHER_TENANT_ID = '018f3c2e-0000-7000-8000-000000000006';

export function makeUuid(n: number): string {
  return `018f3c2e-0000-7000-8000-${String(n).padStart(12, '0')}`;
}

export function makeB64Url32(): string {
  return randomBytes(32).toString('base64url');
}

const VALID_JOB_BASE = {
  job_id: JOB_ID,
  idempotency_key: 'ord_1-receipt-1',
  tenant_id: TENANT_ID,
  restaurant_id: RESTAURANT_ID,
  printer_id: PRINTER_ID,
  priority: 5,
  copies: 1,
  doc_type: 'customer_receipt',
  doc_version: 1,
  issued_at: '2026-10-22T10:00:00Z',
  expires_at: '2026-10-22T10:10:00Z',
  payload: {
    header: { restaurant_name: 'Test Diner', address_lines: [] },
    meta: { title: 'RECEIPT', order_ref: 'ord_1', created_at: '2026-10-22T10:00:00Z' },
    lines: [{ text: '1x Burger' }],
  },
} as const;

export interface SignedEnvelopeOverrides {
  readonly job?: Record<string, unknown>;
  readonly sig?: string;
  readonly envelope_version?: number;
}

/** Builds a full print_job envelope with a VALID ed25519 sig over the job. */
export function makeSignedEnvelope(overrides: SignedEnvelopeOverrides = {}): {
  envelope: Record<string, unknown>;
  publicKeyRaw: Uint8Array;
  publicKeyB64Url: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyRaw = new Uint8Array(
    publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
  );
  const job = { ...VALID_JOB_BASE, ...overrides.job };
  const sig =
    overrides.sig ??
    sign(null, Buffer.from(canonicalJson(job), 'utf8'), privateKey).toString('base64url');
  const envelope: Record<string, unknown> = {
    envelope_version: overrides.envelope_version ?? 1,
    type: 'print_job',
    job,
    sig,
  };
  return {
    envelope,
    publicKeyRaw,
    publicKeyB64Url: Buffer.from(publicKeyRaw).toString('base64url'),
  };
}

export function makePairResponse(overrides: Partial<PairResponse> = {}): PairResponse {
  return {
    device_id: DEVICE_ID,
    device_token: 'device-token-abc',
    refresh_token: 'refresh-token-abc',
    server_signing_pubkey: makeB64Url32(),
    restaurant_id: RESTAURANT_ID,
    tenant_id: TENANT_ID,
    token_ttl_s: 3600,
    ...overrides,
  };
}

/** Raw (unvalidated) config builder for negative fixtures. */
export function makeConfigRaw(
  configVersion: number,
  overrides: Record<string, unknown> = {},
): unknown {
  return { ...makeConfig(configVersion), ...overrides };
}

export function makeRefreshResponse(overrides: Partial<RefreshResponse> = {}): RefreshResponse {
  return {
    device_token: 'device-token-2',
    refresh_token: 'refresh-token-2',
    token_ttl_s: 3600,
    ...overrides,
  };
}

export function makePollResponse(jobs: unknown[] = [], nextCursor?: string): PollResponse {
  return nextCursor === undefined ? { jobs } : { jobs, next_cursor: nextCursor };
}

export function makeConfig(
  configVersion: number,
  overrides: Partial<ConfigUpdate> = {},
): ConfigUpdate {
  return {
    type: 'config_update',
    config_version: configVersion,
    printers: [
      {
        printer_id: PRINTER_ID,
        name: 'Kitchen-1',
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
        status_polling: 'off',
      },
    ],
    ...overrides,
  };
}

export function makeServerKeys(): ServerKeysResponse {
  return { keys: [{ kid: 'key-1', public_key: makeB64Url32(), active: true }] };
}

export function makeSecrets(overrides: Partial<IdentitySecrets> = {}): IdentitySecrets {
  return {
    deviceId: DEVICE_ID,
    deviceToken: 'device-token-abc',
    refreshToken: 'refresh-token-abc',
    devicePrivateKey: 'priv',
    devicePublicKey: makeB64Url32(),
    serverSigningPubkey: makeB64Url32(),
    tenantId: TENANT_ID,
    restaurantId: RESTAURANT_ID,
    ...overrides,
  };
}

export class MemoryKv implements SecretKv {
  readonly map = new Map<string, string>();
  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.map.set(key, value);
  }
  delete(key: string): void {
    this.map.delete(key);
  }
}

export class FakeSafeStorage implements SafeStorageLike {
  available = true;
  corruption: 'none' | 'decrypt' = 'none';
  isEncryptionAvailable(): boolean {
    return this.available;
  }
  encryptString(plainText: string): Buffer {
    return Buffer.concat([Buffer.from('enc:'), Buffer.from(plainText, 'utf8')]);
  }
  decryptString(encrypted: Buffer): string {
    if (this.corruption === 'decrypt' || !encrypted.subarray(0, 4).equals(Buffer.from('enc:'))) {
      throw new Error('decrypt failed');
    }
    return encrypted.subarray(4).toString('utf8');
  }
}

export type TransportScript = {
  pair?: PairResponse | Error;
  refresh?: RefreshResponse | Error | ((refreshToken: string) => RefreshResponse | Error);
  poll?: PollResponse | Error | ((since: string) => PollResponse | Error);
  acks?: Error;
  config?: ConfigUpdate | Error | (() => ConfigUpdate | Error);
  heartbeat?: Error;
  serverKeys?: ServerKeysResponse | Error;
};

export interface TransportCall {
  readonly op: string;
  readonly since?: string;
  readonly batch?: AckBatch;
  readonly sample?: Heartbeat;
  readonly auth?: TransportAuth;
}

/** Scripted in-memory AgentTransport; records every call for assertions.
 *  Non-async methods returning promises: scripted errors REJECT (like real I/O). */
export class FakeTransport implements AgentTransport {
  readonly baseUrl = 'https://cloud.test';
  readonly calls: TransportCall[] = [];

  constructor(private readonly script: TransportScript) {}

  private static resolve<T>(value: T | Error | ((arg: string) => T | Error), arg: string): T {
    const resolved = typeof value === 'function' ? (value as (a: string) => T | Error)(arg) : value;
    if (resolved instanceof Error) throw resolved;
    return resolved;
  }

  pair(): Promise<PairResponse> {
    this.calls.push({ op: 'pair' });
    return Promise.resolve().then(() =>
      FakeTransport.resolve(this.script.pair ?? makePairResponse(), ''),
    );
  }
  refresh(refreshToken: string): Promise<RefreshResponse> {
    this.calls.push({ op: 'refresh' });
    return Promise.resolve().then(() =>
      FakeTransport.resolve(this.script.refresh ?? makeRefreshResponse(), refreshToken),
    );
  }
  pollJobs(auth: TransportAuth, since: string): Promise<PollResponse> {
    this.calls.push({ op: 'poll', since, auth });
    return Promise.resolve().then(() =>
      FakeTransport.resolve(this.script.poll ?? makePollResponse(), since),
    );
  }
  sendAcks(auth: TransportAuth, batch: AckBatch): Promise<void> {
    this.calls.push({ op: 'acks', batch, auth });
    return Promise.resolve().then(() => {
      if (this.script.acks !== undefined) throw this.script.acks;
    });
  }
  getConfig(auth: TransportAuth): Promise<ConfigUpdate> {
    this.calls.push({ op: 'config', auth });
    return Promise.resolve().then(() =>
      FakeTransport.resolve(this.script.config ?? makeConfig(1), ''),
    );
  }
  heartbeat(auth: TransportAuth, sample: Heartbeat): Promise<void> {
    this.calls.push({ op: 'heartbeat', sample, auth });
    return Promise.resolve().then(() => {
      if (this.script.heartbeat !== undefined) throw this.script.heartbeat;
    });
  }
  serverKeys(auth: TransportAuth): Promise<ServerKeysResponse> {
    this.calls.push({ op: 'server-keys', auth });
    return Promise.resolve().then(() =>
      FakeTransport.resolve(this.script.serverKeys ?? makeServerKeys(), ''),
    );
  }
  callsOf(op: string): TransportCall[] {
    return this.calls.filter((c) => c.op === op);
  }
}

/** Deterministic manual scheduler for poller tests: timers only fire when
 *  advanced explicitly, so no real waiting and no fake-timer plumbing. */
export class ManualScheduler {
  private queue: Array<{ fn: () => void; at: number; cancelled: boolean }> = [];
  nowMs = 0;
  readonly schedule = (fn: () => void, delayMs: number): (() => void) => {
    const entry = { fn, at: this.nowMs + delayMs, cancelled: false };
    this.queue.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  get pendingCount(): number {
    return this.queue.filter((e) => !e.cancelled).length;
  }
  nextDelay(): number | null {
    const pending = this.queue.filter((e) => !e.cancelled);
    if (pending.length === 0) return null;
    return Math.min(...pending.map((e) => e.at)) - this.nowMs;
  }
  /** Runs the earliest due timer and lets its async work settle. */
  async runNext(): Promise<void> {
    const pending = this.queue.filter((e) => !e.cancelled).sort((a, b) => a.at - b.at);
    const entry = pending[0];
    if (entry === undefined) throw new Error('no pending timer');
    this.queue = this.queue.filter((e) => e !== entry);
    this.nowMs = entry.at;
    entry.fn();
    await settle();
  }
}

/** Lets all pending microtasks (and one macrotask hop) settle. */
export async function settle(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
