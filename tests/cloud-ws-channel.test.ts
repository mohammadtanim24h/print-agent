import { describe, expect, it } from 'vitest';
import { createWssChannel, deriveWssUrl, assertWssUrl } from '../src/main/cloud-client/ws-channel';
import type { WsFactory } from '../src/main/cloud-client/ws-channel';
import { CloudError } from '../src/main/cloud-client/errors';
import type { HeartbeatSample, WssChannelState } from '../src/main/cloud-client/types';
import { FakeSocket, ManualScheduler, DEVICE_ID } from './helpers/cloud';

describe('deriveWssUrl', () => {
  it('maps the REST base URL to the §1 WSS endpoint path', () => {
    expect(deriveWssUrl('https://saas.example.com/api/agent/v1')).toBe(
      'wss://saas.example.com/agent/v1/ws',
    );
  });

  it('preserves the port and strips query/hash', () => {
    expect(deriveWssUrl('https://saas.test:8443/api/agent/v1?x=1')).toBe(
      'wss://saas.test:8443/agent/v1/ws',
    );
  });

  it('maps http to ws (dev-only; production refusal is assertWssUrl’s job)', () => {
    expect(deriveWssUrl('http://localhost:8000/api/agent/v1')).toBe(
      'ws://localhost:8000/agent/v1/ws',
    );
  });
});

describe('assertWssUrl', () => {
  it('accepts wss://', () => {
    expect(assertWssUrl('wss://saas.test/agent/v1/ws', false)).toBe('wss://saas.test/agent/v1/ws');
  });

  it('refuses ws:// by default', () => {
    expect(() => assertWssUrl('ws://saas.test/agent/v1/ws', false)).toThrow(CloudError);
  });

  it('refuses garbage', () => {
    expect(() => assertWssUrl('not a url', false)).toThrow(CloudError);
  });

  it('allows ws:// outside production when explicitly opted in', () => {
    expect(assertWssUrl('ws://127.0.0.1:9876/agent/v1/ws', true)).toBe(
      'ws://127.0.0.1:9876/agent/v1/ws',
    );
  });

  it('refuses ws:// even with the flag when NODE_ENV=production', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => assertWssUrl('ws://saas.test/agent/v1/ws', true)).toThrow(
        /forbidden in production/,
      );
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });
});

interface ChannelHarness {
  channel: ReturnType<typeof createWssChannel>;
  sockets: FakeSocket[];
  scheduler: ManualScheduler;
  states: WssChannelState[];
  messages: unknown[];
  authFailures: number;
  logs: string[];
}

function makeChannelHarness(
  overrides: {
    getAuth?: () => { deviceId: string; deviceToken: string } | null;
    heartbeatSample?: () => HeartbeatSample;
    heartbeatIntervalMs?: number;
    pingIntervalMs?: number;
  } = {},
): ChannelHarness {
  const scheduler = new ManualScheduler();
  const sockets: FakeSocket[] = [];
  const states: WssChannelState[] = [];
  const messages: unknown[] = [];
  let authFailures = 0;
  const logs: string[] = [];
  const factory: WsFactory = (url, options) => {
    const s = new FakeSocket(url, options);
    sockets.push(s);
    return s;
  };
  const channel = createWssChannel({
    url: 'wss://cloud.test/agent/v1/ws',
    agentVersion: '0.1.0',
    getAuth: overrides.getAuth ?? (() => ({ deviceId: DEVICE_ID, deviceToken: 'token-1' })),
    now: () => scheduler.nowMs,
    schedule: scheduler.schedule,
    random: () => 0.5, // half-jitter backoff → attempt N waits exactly 750·2^(N-1) ms
    wsFactory: factory,
    log: (message) => logs.push(message),
    ...(overrides.heartbeatSample !== undefined
      ? { heartbeatSample: overrides.heartbeatSample }
      : {}),
    ...(overrides.heartbeatIntervalMs !== undefined
      ? { heartbeatIntervalMs: overrides.heartbeatIntervalMs }
      : {}),
    ...(overrides.pingIntervalMs !== undefined ? { pingIntervalMs: overrides.pingIntervalMs } : {}),
  });
  channel.on('state', (s) => states.push(s));
  channel.on('message', (raw) => messages.push(raw));
  channel.on('auth-failed', () => {
    authFailures += 1;
  });
  return { channel, sockets, scheduler, states, messages, authFailures, logs };
}

describe('ws-channel lifecycle', () => {
  it('dials with §1 upgrade headers and reports connected on open', () => {
    const h = makeChannelHarness();
    h.channel.start();
    expect(h.sockets).toHaveLength(1);
    expect(h.states).toContain('connecting');
    expect(h.sockets[0]?.headers).toEqual({
      Authorization: 'Bearer token-1',
      'X-Device-Id': DEVICE_ID,
      'X-Agent-Version': '0.1.0',
      'X-Protocol-Version': '1',
    });
    h.sockets[0]?.serverOpen();
    expect(h.channel.isConnected()).toBe(true);
    expect(h.states).toContain('connected');
  });

  it('redials with backoff after a close; backoff resets on a successful open', async () => {
    const h = makeChannelHarness();
    h.channel.start();
    h.sockets[0]?.serverOpen();
    h.sockets[0]?.serverClose(1000);
    expect(h.channel.isConnected()).toBe(false);
    // attempt 1 → 1000/2 + 0.5·1000/2 = 750 ms
    expect(h.scheduler.nextDelay()).toBe(750);
    await h.scheduler.runNext();
    expect(h.sockets).toHaveLength(2);
    // Redial reads credentials at dial time.
    expect(h.sockets[1]?.headers['Authorization']).toBe('Bearer token-1');
    h.sockets[1]?.serverOpen(); // backoff resets
    h.sockets[1]?.serverClose(1011);
    expect(h.scheduler.nextDelay()).toBe(750); // attempt restarted at 1
  });

  it('stop() tears down the socket and cancels the pending redial', async () => {
    const h = makeChannelHarness();
    h.channel.start();
    h.sockets[0]?.serverClose(1000);
    expect(h.scheduler.pendingCount).toBe(1);
    h.channel.stop();
    expect(h.scheduler.pendingCount).toBe(0);
    await h.scheduler.runNext().catch(() => undefined);
    expect(h.sockets).toHaveLength(1); // no redial after stop
  });

  it('never dials while unpaired', () => {
    const h = makeChannelHarness({ getAuth: () => null });
    h.channel.start();
    expect(h.sockets).toHaveLength(0);
    expect(h.channel.isConnected()).toBe(false);
  });

  it('replaces a live socket on notifyAuthChanged and ignores the stale close', () => {
    const h = makeChannelHarness();
    h.channel.start();
    h.sockets[0]?.serverOpen();
    h.channel.notifyAuthChanged();
    expect(h.sockets).toHaveLength(2);
    expect(h.channel.isConnected()).toBe(false); // new socket is connecting
    // The disposed socket's close fires later — must not schedule a second dial.
    h.sockets[0]?.serverClose(1005);
    expect(h.scheduler.pendingCount).toBe(0);
    h.sockets[1]?.serverOpen();
    expect(h.channel.isConnected()).toBe(true);
  });
});

describe('ws-channel robustness', () => {
  it('a failing heartbeat sample does not kill the cadence', async () => {
    const h = makeChannelHarness({
      heartbeatSample: () => {
        throw new Error('boom');
      },
      // Keep the keepalive timer out of the scheduler so nextDelay reflects
      // only the heartbeat cadence.
      pingIntervalMs: 10_000_000,
    });
    h.channel.start();
    h.sockets[0]?.serverOpen();
    expect(h.scheduler.nextDelay()).toBe(30_000); // ~30s ± jitter (random=0.5 → exact)
    await expect(h.scheduler.runNext()).resolves.toBeUndefined(); // must not throw
    expect(h.sockets[0]?.sent).toEqual([]);
    expect(h.scheduler.nextDelay()).toBe(30_000); // chain survived
  });

  it('an auth-failed listener that redials is not followed by a phantom backoff dial', () => {
    const h = makeChannelHarness();
    h.channel.on('auth-failed', () => {
      h.channel.notifyAuthChanged();
    });
    h.channel.start();
    h.sockets[0]?.serverOpen();
    h.sockets[0]?.serverClose(4401);
    // The listener redialed synchronously — exactly one fresh socket, and no
    // backoff dial scheduled behind it that would tear that socket down.
    expect(h.sockets).toHaveLength(2);
    expect(h.scheduler.pendingCount).toBe(0);
    h.sockets[1]?.serverOpen();
    expect(h.channel.isConnected()).toBe(true);
  });
});
