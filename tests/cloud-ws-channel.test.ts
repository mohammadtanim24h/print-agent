import { describe, expect, it } from 'vitest';
import { createWssChannel, deriveWssUrl, assertWssUrl } from '../src/main/cloud-client/ws-channel';
import type { WsFactory } from '../src/main/cloud-client/ws-channel';
import { CloudError } from '../src/main/cloud-client/errors';
import type { HeartbeatSample, WssChannelState } from '../src/main/cloud-client/types';
import { FakeSocket, ManualScheduler, DEVICE_ID } from './helpers/cloud';
import { HeartbeatSchema } from '../src/main/cloud-client/schemas';

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

describe('ws-channel inbound frames', () => {
  it('delivers valid JSON frames as parsed values', () => {
    const h = makeChannelHarness();
    h.channel.start();
    h.sockets[0]?.serverOpen();
    h.sockets[0]?.serverMessage('{"type":"ping"}');
    expect(h.messages).toEqual([{ type: 'ping' }]);
  });

  it('drops non-JSON frames without emitting', () => {
    const h = makeChannelHarness();
    h.channel.start();
    h.sockets[0]?.serverOpen();
    h.sockets[0]?.serverMessage('not json');
    expect(h.messages).toHaveLength(0);
    expect(h.logs).toContain('wss: dropped non-JSON frame');
  });

  it('drops frames above the size cap without emitting', () => {
    const scheduler = new ManualScheduler();
    const sockets: FakeSocket[] = [];
    const logs: string[] = [];
    const channel = createWssChannel({
      url: 'wss://cloud.test/agent/v1/ws',
      agentVersion: '0.1.0',
      getAuth: () => ({ deviceId: DEVICE_ID, deviceToken: 't' }),
      schedule: scheduler.schedule,
      now: () => scheduler.nowMs,
      random: () => 0.5,
      maxFrameBytes: 64,
      wsFactory: (url, options) => {
        const s = new FakeSocket(url, options);
        sockets.push(s);
        return s;
      },
      log: (message) => logs.push(message),
    });
    const messages: unknown[] = [];
    channel.on('message', (raw) => messages.push(raw));
    channel.start();
    sockets[0]?.serverOpen();
    sockets[0]?.serverMessage(JSON.stringify({ type: 'ping', pad: 'x'.repeat(1024) }));
    expect(messages).toHaveLength(0);
    expect(logs).toContain('wss: dropped oversized frame');
  });
});

describe('ws-channel heartbeat + watchdog', () => {
  it('sends §3.2 heartbeats every 30 s with connection "wss" and live facts', async () => {
    const scheduler = new ManualScheduler();
    const sockets: FakeSocket[] = [];
    const channel = createWssChannel({
      url: 'wss://cloud.test/agent/v1/ws',
      agentVersion: '1.4.2',
      getAuth: () => ({ deviceId: DEVICE_ID, deviceToken: 'token-1' }),
      heartbeatSample: () => ({
        uptime_s: 120,
        queue_depth: 3,
        connection: 'poll' as const, // channel must override to 'wss'
        printers: [],
      }),
      now: () => scheduler.nowMs,
      schedule: scheduler.schedule,
      random: () => 0.5,
      // Keep the keepalive timer out of the scheduler so nextDelay reflects
      // only the heartbeat cadence (it shares the 30 s default).
      pingIntervalMs: 10_000_000,
      wsFactory: (url, options) => {
        const s = new FakeSocket(url, options);
        sockets.push(s);
        return s;
      },
    });
    channel.start();
    sockets[0]?.serverOpen();
    // First heartbeat is scheduled 30 s after open (jitter 1.0 with random 0.5).
    expect(scheduler.nextDelay()).toBe(30_000);
    await scheduler.runNext();
    expect(sockets[0]?.sent).toHaveLength(1);
    const parsed = HeartbeatSchema.parse(JSON.parse(sockets[0]?.sent[0] ?? '{}'));
    expect(parsed).toMatchObject({
      type: 'heartbeat',
      agent_version: '1.4.2',
      uptime_s: 120,
      queue_depth: 3,
      connection: 'wss',
    });
    // Cadence repeats.
    expect(scheduler.nextDelay()).toBe(30_000);
  });

  it('pings on the keepalive tick and terminates after 90 s of silence', async () => {
    // Heartbeat timer disabled: it shares the 30 s delay and would interleave
    // with the keepalive tick in the manual scheduler.
    const h = makeChannelHarness({ heartbeatIntervalMs: 3_600_000 });
    h.channel.start();
    h.sockets[0]?.serverOpen();
    // tick 1 at 30 s: ping (last activity = open time = 0)
    await h.scheduler.runNext();
    expect(h.sockets[0]?.pingCount).toBe(1);
    // tick 2 at 60 s: still within the 90 s window → ping again
    await h.scheduler.runNext();
    expect(h.sockets[0]?.pingCount).toBe(2);
    // tick 3 at 90 s: silence window reached → terminate (fires close 1006)
    const before = h.sockets.length;
    await h.scheduler.runNext();
    expect(h.sockets[0]?.pingCount).toBe(2); // no ping on the terminating tick
    expect(h.sockets.length).toBeGreaterThanOrEqual(before); // redial scheduled
    expect(h.scheduler.pendingCount).toBe(1);
  });

  it('a pong or inbound frame refreshes the silence window', async () => {
    const h = makeChannelHarness({ heartbeatIntervalMs: 3_600_000 });
    h.channel.start();
    h.sockets[0]?.serverOpen();
    await h.scheduler.runNext(); // t=30: ping
    h.sockets[0]?.emit('pong');
    h.scheduler.nowMs += 25_000; // t=55
    await h.scheduler.runNext(); // t=60: ping again (30 s since last activity)
    expect(h.sockets[0]?.pingCount).toBe(2);
    h.sockets[0]?.serverMessage('{"type":"ping"}');
    h.scheduler.nowMs += 25_000; // t=85
    await h.scheduler.runNext(); // t=90: 5 s since last frame → ping, not terminate
    expect(h.sockets[0]?.pingCount).toBe(3);
  });
});
