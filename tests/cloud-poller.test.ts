import { describe, expect, it } from 'vitest';
import { createPollingCloudClient } from '../src/main/cloud-client/poller';
import { CloudError } from '../src/main/cloud-client/errors';
import type { PrintJobEnvelope } from '../src/main/cloud-client/schemas';
import type { ConnectionState } from '../src/main/cloud-client/types';
import { createSafeStorageSecretStore } from '../src/main/cloud-client/secret-store';
import {
  FakeSafeStorage,
  FakeTransport,
  ManualScheduler,
  makeB64Url32,
  makeConfig,
  makePollResponse,
  makeRefreshResponse,
  makeSecrets,
  makeSignedEnvelope,
  OTHER_TENANT_ID,
  settle,
} from './helpers/cloud';

/** Polling-client behavior with a scripted transport and manual clock. */

interface Harness {
  client: ReturnType<typeof createPollingCloudClient>;
  transport: FakeTransport;
  scheduler: ManualScheduler;
  secrets: ReturnType<typeof createSafeStorageSecretStore>;
  jobs: PrintJobEnvelope[];
  configs: Array<{ config_version: number }>;
  states: ConnectionState[];
  revoked: Array<{ reason: string }>;
  revokedWipes: string[];
  logs: string[];
}

function makeHarness(script: ConstructorParameters<typeof FakeTransport>[0] = {}): Harness {
  const scheduler = new ManualScheduler();
  const transport = new FakeTransport(script);
  const secrets = createSafeStorageSecretStore(new MemoryKvAdapter(), new FakeSafeStorage());
  secrets.save(makeSecrets());
  const jobs: PrintJobEnvelope[] = [];
  const configs: Array<{ config_version: number }> = [];
  const states: ConnectionState[] = [];
  const revoked: Array<{ reason: string }> = [];
  const revokedWipes: string[] = [];
  const logs: string[] = [];
  const client = createPollingCloudClient({
    transport,
    secrets,
    agentVersion: '0.1.0',
    schedule: scheduler.schedule,
    now: () => scheduler.nowMs,
    pollIntervalMs: 30_000,
    refreshCooldownMs: 30_000,
    onRevoked: (reason) => revokedWipes.push(reason),
    log: (message) => logs.push(message),
  });
  client.on('job', (envelope) => jobs.push(envelope));
  client.on('config', (config) => configs.push(config));
  client.on('state', (s) => states.push(s));
  client.on('revoked', (r) => revoked.push(r));
  return { client, transport, scheduler, secrets, jobs, configs, states, revoked, revokedWipes, logs };
}

class MemoryKvAdapter {
  private map = new Map<string, string>();
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

/** start() schedules the first cycle at delay 0 — run it through the manual scheduler. */
async function startAndSettle(h: Harness): Promise<void> {
  h.client.start();
  if (h.scheduler.pendingCount > 0) await h.scheduler.runNext();
  await settle();
}

describe('lifecycle', () => {
  it('unpaired when no identity is stored; start does not schedule cycles', async () => {
    const store = createSafeStorageSecretStore(new MemoryKvAdapter(), new FakeSafeStorage());
    const scheduler = new ManualScheduler();
    const client = createPollingCloudClient({
      transport: new FakeTransport({}),
      secrets: store,
      agentVersion: '0.1.0',
      schedule: scheduler.schedule,
    });
    client.start();
    await settle();
    expect(client.state()).toBe('unpaired');
    expect(scheduler.pendingCount).toBe(0);
  });

  it('first cycle runs immediately after start and emits validated jobs', async () => {
    const { envelope, publicKeyB64Url } = makeSignedEnvelope();
    const h = makeHarness({ poll: makePollResponse([envelope], 'c1') });
    // Pin the pairing server key to the envelope signer.
    h.secrets.save(makeSecrets({ serverSigningPubkey: publicKeyB64Url }));
    await startAndSettle(h);
    expect(h.client.state()).toBe('online');
    expect(h.jobs).toHaveLength(1);
    expect(h.jobs[0]?.job.job_id).toBe((envelope.job as { job_id: string }).job_id);
    expect(h.transport.callsOf('poll')[0]?.since).toBe('');
  });

  it('carries the cursor forward on subsequent polls', async () => {
    const sinses: string[] = [];
    let call = 0;
    const h = makeHarness({
      poll: (since: string) => {
        sinses.push(since);
        call += 1;
        return call === 1 ? makePollResponse([], 'cursor-A') : makePollResponse([]);
      },
    });
    await startAndSettle(h);
    await h.scheduler.runNext();
    await settle();
    expect(h.transport.callsOf('poll')).toHaveLength(2);
    expect(sinses).toEqual(['', 'cursor-A']);
  });
});

describe('job admission (untrusted server)', () => {
  it('drops out-of-scope jobs and acks them rejected with wrong_scope', async () => {
    const { envelope, publicKeyB64Url } = makeSignedEnvelope({
      job: { tenant_id: OTHER_TENANT_ID },
    });
    const h = makeHarness({ poll: makePollResponse([envelope]) });
    h.secrets.save(makeSecrets({ serverSigningPubkey: publicKeyB64Url }));
    await startAndSettle(h);
    expect(h.jobs).toHaveLength(0);
    await settle(); // let the fire-and-forget ack land
    const ackCall = h.transport.callsOf('acks')[0];
    expect(ackCall?.batch?.acks[0]).toMatchObject({
      job_id: (envelope.job as { job_id: string }).job_id,
      status: 'rejected',
    });
  });

  it('drops jobs whose signature does not verify and acks rejected{bad_signature}', async () => {
    const { envelope } = makeSignedEnvelope(); // signed by a different key than the pinned one
    const h = makeHarness({ poll: makePollResponse([envelope]) });
    h.secrets.save(makeSecrets({ serverSigningPubkey: makeB64Url32() }));
    await startAndSettle(h);
    expect(h.jobs).toHaveLength(0);
    await settle();
    const ackCall = h.transport.callsOf('acks')[0];
    expect(ackCall?.batch?.acks[0]).toMatchObject({
      job_id: (envelope.job as { job_id: string }).job_id,
      status: 'rejected',
      error: { code: 'bad_signature' },
    });
  });

  it('acks a print_job with a null sig as rejected{bad_signature} (never strands the claim)', async () => {
    const { envelope } = makeSignedEnvelope();
    const nullSig = { ...envelope, sig: null };
    const h = makeHarness({ poll: makePollResponse([nullSig]) });
    h.secrets.save(makeSecrets({ serverSigningPubkey: makeB64Url32() }));
    await startAndSettle(h);
    expect(h.jobs).toHaveLength(0);
    expect(h.client.state()).toBe('online');
    await settle();
    const ackCall = h.transport.callsOf('acks')[0];
    expect(ackCall?.batch?.acks[0]).toMatchObject({
      job_id: (envelope.job as { job_id: string }).job_id,
      status: 'rejected',
      error: { code: 'bad_signature' },
    });
  });

  it('acks a schema-invalid v1 print_job as rejected{invalid_envelope}', async () => {
    const { envelope } = makeSignedEnvelope({ job: { copies: 9 } }); // out of range → schema fails
    const h = makeHarness({ poll: makePollResponse([envelope]) });
    h.secrets.save(makeSecrets({ serverSigningPubkey: makeB64Url32() }));
    await startAndSettle(h);
    expect(h.jobs).toHaveLength(0);
    await settle();
    const ackCall = h.transport.callsOf('acks')[0];
    expect(ackCall?.batch?.acks[0]).toMatchObject({
      job_id: (envelope.job as { job_id: string }).job_id,
      status: 'rejected',
      error: { code: 'invalid_envelope' },
    });
  });

  it('drops unnameable garbage as malformed without acking', async () => {
    const h = makeHarness({ poll: makePollResponse([{ type: 'print_job', job: { job_id: 'x' } }]) });
    await startAndSettle(h);
    await settle();
    expect(h.transport.callsOf('acks')).toHaveLength(0);
    expect(h.client.state()).toBe('online');
  });

  it('drops malformed messages without crashing the loop', async () => {
    const h = makeHarness({ poll: makePollResponse(['garbage', { type: 'ping' }, 42]) });
    await startAndSettle(h);
    expect(h.client.state()).toBe('online');
    expect(h.jobs).toHaveLength(0);
  });
});

describe('token refresh (no infinite retry loop)', () => {
  it('401 → single refresh → retried request succeeds; rotated tokens persisted', async () => {
    const { envelope, publicKeyB64Url } = makeSignedEnvelope();
    let pollCount = 0;
    const h = makeHarness({
      poll: () => {
        pollCount += 1;
        if (pollCount === 1) throw new CloudError('unauthorized');
        return makePollResponse([envelope]);
      },
      refresh: makeRefreshResponse({
        device_token: 'token-v2',
        refresh_token: 'refresh-v2',
      }),
    });
    h.secrets.save(makeSecrets({ serverSigningPubkey: publicKeyB64Url }));
    await startAndSettle(h);
    expect(h.client.state()).toBe('online');
    expect(h.jobs).toHaveLength(1);
    expect(h.secrets.load()?.deviceToken).toBe('token-v2');
    expect(h.secrets.load()?.refreshToken).toBe('refresh-v2');
    expect(h.transport.callsOf('refresh')).toHaveLength(1);
  });

  it('refresh refusal (401) is terminal: revoked state, credentials wiped, loop stops', async () => {
    const h = makeHarness({
      poll: new CloudError('unauthorized'),
      refresh: new CloudError('unauthorized'),
    });
    await startAndSettle(h);
    expect(h.client.state()).toBe('revoked');
    expect(h.secrets.load()).toBeNull();
    expect(h.revoked).toEqual([{ reason: 'token_refresh_refused' }]);
    expect(h.revokedWipes).toEqual(['token_refresh_refused']);
    const pollsAfter = h.transport.callsOf('poll').length;
    expect(h.scheduler.pendingCount).toBe(0);
    await h.scheduler.runNext().catch(() => undefined);
    expect(h.transport.callsOf('poll').length).toBe(pollsAfter);
  });

  it('at most one refresh attempt per cooldown window across repeated 401 cycles', async () => {
    let clockMs = 0;
    const scheduler = new ManualScheduler();
    const transport = new FakeTransport({
      poll: new CloudError('unauthorized'), // always 401
      refresh: new CloudError('network'), // refresh fails with a retryable error (not refusal)
    });
    const secrets = createSafeStorageSecretStore(new MemoryKvAdapter(), new FakeSafeStorage());
    secrets.save(makeSecrets());
    const client = createPollingCloudClient({
      transport,
      secrets,
      agentVersion: '0.1.0',
      schedule: scheduler.schedule,
      now: () => clockMs,
      pollIntervalMs: 30_000,
      refreshCooldownMs: 30_000,
    });
    client.start();
    await scheduler.runNext(); // cycle 1: 401 → refresh attempt #1 → network error → offline
    expect(client.state()).toBe('offline');
    expect(transport.callsOf('refresh')).toHaveLength(1);
    // Hammer cycles forward, always less than the 30 s cooldown into the window:
    // no further refresh attempts may occur (that is the loop-prevention guarantee).
    for (let i = 0; i < 6; i += 1) {
      clockMs += 4_000;
      await scheduler.runNext();
    }
    expect(transport.callsOf('refresh')).toHaveLength(1);
    // Once the window passes, exactly one more attempt is allowed.
    clockMs += 31_000;
    await scheduler.runNext();
    expect(transport.callsOf('refresh')).toHaveLength(2);
  });
});

describe('offline / backoff / reconnect', () => {
  it('network failure → offline, exponential backoff; success resets and goes online', async () => {
    let pollCount = 0;
    const h = makeHarness({
      poll: () => {
        pollCount += 1;
        if (pollCount <= 2) throw new CloudError('network');
        return makePollResponse([]);
      },
    });
    await startAndSettle(h);
    expect(h.client.state()).toBe('offline');
    const firstDelay = h.scheduler.nextDelay();
    expect(firstDelay).toBeGreaterThan(0);
    await h.scheduler.runNext();
    await settle();
    expect(h.client.state()).toBe('offline');
    const secondDelay = h.scheduler.nextDelay();
    expect(secondDelay ?? 0).toBeGreaterThan(15_000); // backoff grew past the base interval
    await h.scheduler.runNext();
    await settle();
    expect(h.client.state()).toBe('online');
    expect(h.scheduler.nextDelay()).toBe(30_000); // reset to healthy cadence
  });

  it('pollNow triggers an immediate cycle (reconnect recovery)', async () => {
    let pollCount = 0;
    const h = makeHarness({
      poll: () => {
        pollCount += 1;
        if (pollCount === 1) throw new CloudError('network');
        return makePollResponse([]);
      },
    });
    await startAndSettle(h);
    expect(h.client.state()).toBe('offline');
    expect(h.scheduler.nextDelay() ?? 0).toBeGreaterThan(0);
    h.client.pollNow();
    expect(h.scheduler.nextDelay()).toBe(0);
    await h.scheduler.runNext();
    await settle();
    expect(h.client.state()).toBe('online');
  });

  it('malformed 200 responses keep the loop alive at healthy cadence', async () => {
    const h = makeHarness({
      poll: new CloudError('malformed_response', 'schema rejected /jobs response'),
    });
    await startAndSettle(h);
    expect(h.client.state()).toBe('online');
    expect(h.scheduler.nextDelay()).toBe(30_000);
  });
});

describe('config sync', () => {
  it('emits config on a version increase; ignores regressions and repeats', async () => {
    let version = 5;
    const h = makeHarness({
      config: () => makeConfig(version),
    });
    await startAndSettle(h);
    expect(h.configs).toHaveLength(0); // poll cycles do not fetch config
    await h.client.refreshConfig();
    expect(h.configs).toHaveLength(1);
    version = 4; // regression → ignored
    await h.client.refreshConfig();
    version = 5; // repeat → ignored
    await h.client.refreshConfig();
    expect(h.configs).toHaveLength(1);
    version = 6;
    await h.client.refreshConfig();
    expect(h.configs).toHaveLength(2);
  });
});

describe('revocation envelope', () => {
  it('stops the loop, wipes credentials, fires handlers on { type: revoke }', async () => {
    const h = makeHarness({
      poll: makePollResponse([{ type: 'revoke', reason: 'manager_initiated' }]),
    });
    await startAndSettle(h);
    expect(h.client.state()).toBe('revoked');
    expect(h.revoked).toEqual([{ reason: 'manager_initiated' }]);
    expect(h.revokedWipes).toEqual(['manager_initiated']);
    expect(h.secrets.load()).toBeNull();
    expect(h.scheduler.pendingCount).toBe(0);
    // start() after revocation is a no-op (terminal until reinstall/re-pair)
    h.client.start();
    await settle();
    expect(h.client.state()).toBe('revoked');
  });
});

describe('acks and heartbeat', () => {
  /** A minimal valid ack item for submitAcks tests. */
  function makeAckItem(): {
    job_id: string;
    status: 'completed';
    printer_status: 'unknown';
    printed: false;
    attempt: number;
    at: string;
  } {
    return {
      job_id: '018f3c2e-0000-7000-8000-000000000005',
      status: 'completed',
      printer_status: 'unknown',
      printed: false,
      attempt: 1,
      at: '2026-10-24T10:00:02.000Z',
    };
  }

  it.each(['applied', 'duplicate', 'stale'] as const)(
    'ack result %s is a success-no-op: stays online, no retry',
    async (result) => {
      const h = makeHarness({
        acks: { results: [{ job_id: '018f3c2e-0000-7000-8000-000000000005', result }] },
      });
      await startAndSettle(h);
      await h.client.submitAcks({ envelope_version: 1, type: 'ack', acks: [makeAckItem()] });
      expect(h.client.state()).toBe('online');
      expect(h.transport.callsOf('acks')).toHaveLength(1); // never retried
      if (result !== 'applied') {
        expect(h.logs.some((l) => l.includes(result))).toBe(false);
      }
    },
  );

  it('ack result not_found is surfaced as an anomaly and not retried', async () => {
    const h = makeHarness({
      acks: { results: [{ job_id: '018f3c2e-0000-7000-8000-000000000005', result: 'not_found' }] },
    });
    await startAndSettle(h);
    await h.client.submitAcks({ envelope_version: 1, type: 'ack', acks: [makeAckItem()] });
    expect(h.transport.callsOf('acks')).toHaveLength(1);
    expect(h.logs.some((l) => l.includes('not_found'))).toBe(true);
  });

  it('ack result rejected is logged for diagnostics and not retried', async () => {
    const h = makeHarness({
      acks: { results: [{ job_id: '018f3c2e-0000-7000-8000-000000000005', result: 'rejected' }] },
    });
    await startAndSettle(h);
    await h.client.submitAcks({ envelope_version: 1, type: 'ack', acks: [makeAckItem()] });
    expect(h.transport.callsOf('acks')).toHaveLength(1);
    expect(h.logs.some((l) => l.includes('rejected by server'))).toBe(true);
  });

  it('per-call ack result scripts are consumed in order', async () => {
    const h = makeHarness({
      acks: [
        { results: [{ job_id: '018f3c2e-0000-7000-8000-000000000005', result: 'applied' }] },
        { results: [{ job_id: '018f3c2e-0000-7000-8000-000000000005', result: 'not_found' }] },
      ],
    });
    await startAndSettle(h);
    await h.client.submitAcks({ envelope_version: 1, type: 'ack', acks: [makeAckItem()] });
    await h.client.submitAcks({ envelope_version: 1, type: 'ack', acks: [makeAckItem()] });
    expect(h.logs.filter((l) => l.includes('not_found'))).toHaveLength(1);
  });

  it('submitAcks sends the batch authenticated', async () => {
    const h = makeHarness({});
    await startAndSettle(h);
    await h.client.submitAcks({
      envelope_version: 1,
      type: 'ack',
      acks: [
        {
          job_id: '018f3c2e-0000-7000-8000-000000000009',
          status: 'completed',
          printer_status: 'unknown',
          printed: false,
          attempt: 1,
          at: '2026-10-22T10:00:02.000Z',
        },
      ],
    });
    const ackCall = h.transport.callsOf('acks')[0];
    expect(ackCall?.batch?.acks[0]?.status).toBe('completed');
    expect(ackCall?.auth?.deviceToken).toBe('device-token-abc');
  });

  it('in-cycle heartbeat is sent when a sample provider is wired', async () => {
    const scheduler = new ManualScheduler();
    const transport = new FakeTransport({});
    const secrets = createSafeStorageSecretStore(new MemoryKvAdapter(), new FakeSafeStorage());
    secrets.save(makeSecrets());
    const client = createPollingCloudClient({
      transport,
      secrets,
      agentVersion: '0.1.0',
      schedule: scheduler.schedule,
      heartbeatSample: () => ({ uptime_s: 10, queue_depth: 0, connection: 'poll', printers: [] }),
    });
    client.start();
    await scheduler.runNext();
    await settle();
    expect(transport.callsOf('heartbeat')).toHaveLength(1);
  });

  it('403 on data call triggers refresh; if refresh succeeds the request retries once', async () => {
    let pollCount = 0;
    const h = makeHarness({
      poll: () => {
        pollCount += 1;
        if (pollCount === 1) throw new CloudError('forbidden');
        return makePollResponse([]);
      },
    });
    await startAndSettle(h);
    expect(h.client.state()).toBe('online');
    expect(h.transport.callsOf('refresh')).toHaveLength(1);
  });
});
