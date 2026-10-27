# WSS Push Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver jobs/config/revoke in real time over an agent-initiated WSS connection (contract §1–§3.2), with REST polling demoted to a slow safety net while the socket is healthy.

**Architecture:** A new `ws-channel.ts` module owns the socket lifecycle (dial with auth headers, backoff redial, heartbeats, ping/pong watchdog) and feeds raw frames into the polling client's existing envelope pipeline. The poller keeps single ownership of identity/tokens and switches cadence and heartbeat mode on channel state. Acks stay on REST.

**Tech Stack:** TypeScript (strict), `ws` npm package (MIT, pure JS), zod, vitest with the existing `ManualScheduler`/`FakeTransport` helpers, in-process `ws` server for integration tests.

**Spec:** `docs/superpowers/specs/2026-10-27-wss-push-channel-design.md`

---

### Task 1: Install the `ws` dependency

**Files:**
- Modify: `package.json` (via pnpm)
- Modify: `pnpm-lock.yaml` (via pnpm)

- [ ] **Step 1: Install ws (runtime) and @types/ws (dev), exact-pinned**

```bash
pnpm add --save-exact ws
pnpm add -D --save-exact @types/ws
```

- [ ] **Step 2: Verify the dependency gate still passes**

`ws` is MIT, pure JS, no postinstall scripts — it must pass the admission check (`ADR-13`, `scripts/check-deps.mjs`).

Run: `pnpm vitest run tests/check-deps.test.ts`
Expected: PASS. Also confirm `package.json` shows `"ws": "x.y.z"` with no `^` range.

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "feat(cloud): add ws dependency for the WSS push channel"
```

---

### Task 2: Channel types in the transport seam

**Files:**
- Modify: `src/main/cloud-client/types.ts`

- [ ] **Step 1: Add `WssChannelState` and `WssChannelLike`**

Append after the `CloudListener<T>` type (around line 36 of `types.ts`):

```ts
export type WssChannelState = 'stopped' | 'connecting' | 'connected' | 'disconnected';

/**
 * Live WSS push channel (api-contract §1). Owns the socket lifecycle only —
 * identity, tokens and envelope validation stay with the polling client,
 * which consumes `message` frames through the same pipeline as poll batches.
 */
export interface WssChannelLike {
  on(event: 'message', listener: CloudListener<unknown>): void;
  on(event: 'state', listener: CloudListener<WssChannelState>): void;
  on(event: 'auth-failed', listener: CloudListener<void>): void;
  isConnected(): boolean;
  /** Begin dialing; no-op while unpaired (getAuth returns null). Idempotent. */
  start(): void;
  /** Tear down the socket and timers; redials only after a new start(). */
  stop(): void;
  /** Redial now with current credentials (token rotation, fresh pairing). */
  notifyAuthChanged(): void;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (types only, no consumers yet).

- [ ] **Step 3: Commit**

```bash
git add src/main/cloud-client/types.ts
git commit -m "feat(cloud): WssChannelLike seam for the push channel"
```

---

### Task 3: ws-channel URL derivation and validation

**Files:**
- Create: `src/main/cloud-client/ws-channel.ts`
- Test: `tests/cloud-ws-channel.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/cloud-ws-channel.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { deriveWssUrl, assertWssUrl } from '../src/main/cloud-client/ws-channel';
import { CloudError } from '../src/main/cloud-client/errors';

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
    expect(deriveWssUrl('http://localhost:8000/api/agent/v1')).toBe('ws://localhost:8000/agent/v1/ws');
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/cloud-ws-channel.test.ts`
Expected: FAIL — cannot find module `ws-channel`.

- [ ] **Step 3: Create the module with the URL helpers**

Create `src/main/cloud-client/ws-channel.ts`:

```ts
import { CloudError } from './errors';

/**
 * WSS push channel (api-contract §1): agent-initiated, outbound-only socket
 * that receives server envelopes and carries §3.2 heartbeats. Owns the
 * socket lifecycle only — tokens, envelope validation and scheduling stay
 * with the polling client.
 *
 * Security posture (mirrors http-transport.ts):
 * - wss:// only; plaintext ws:// is refused outright in production builds
 *   (`allowInsecureWs` exists solely for local integration tests).
 * - TLS certificate verification is never disabled.
 * - The device token travels in the upgrade `Authorization` header and is
 *   never logged; logs carry close codes and static messages only.
 * - Inbound frames are size-capped and JSON-parsed defensively; zod
 *   validation happens downstream in `parseServerMessage` (single funnel).
 */

/** Close code the server uses for auth failures on the socket (§1, additive). */
export const WS_AUTH_CLOSE_CODE = 4401;

const WS_OPEN = 1;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_DEAD_SILENCE_MS = 90_000;
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
const BASE_BACKOFF_MS = 1_000;

/** REST base URL → §1 WSS endpoint (https→wss; http→ws for local dev). */
export function deriveWssUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/agent/v1/ws';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function assertWssUrl(raw: string, allowInsecureWs: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CloudError('insecure_transport', 'WSS URL is not a valid URL');
  }
  if (url.protocol === 'wss:') return raw;
  if (url.protocol === 'ws:' && allowInsecureWs) {
    if (process.env.NODE_ENV === 'production') {
      throw new CloudError('insecure_transport', 'insecure WS is forbidden in production builds');
    }
    return raw;
  }
  throw new CloudError('insecure_transport', 'WSS URL must use wss');
}
```

(The constants stay module-private; Tasks 4+ append the code that uses them.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/cloud-ws-channel.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/cloud-client/ws-channel.ts tests/cloud-ws-channel.test.ts
git commit -m "feat(cloud): WSS URL derivation + transport-security validation"
```

---

### Task 4: FakeSocket test helper + dial/lifecycle with backoff

**Files:**
- Modify: `tests/helpers/cloud.ts` (append `FakeSocket`)
- Modify: `src/main/cloud-client/ws-channel.ts` (append the channel)
- Test: `tests/cloud-ws-channel.test.ts`

- [ ] **Step 1: Append `FakeSocket` to `tests/helpers/cloud.ts`**

Add the import at the top of the file (after the existing type imports):

```ts
import type { WsLike } from '../../src/main/cloud-client/ws-channel';
```

Append at the end of the file:

```ts
/** Scriptable stand-in for a `ws` WebSocket. `server*` methods simulate the
 *  remote end; `emit` drives the channel's event handlers directly. */
export class FakeSocket implements WsLike {
  readonly url: string;
  readonly headers: Record<string, string>;
  readyState = 0; // CONNECTING
  readonly sent: string[] = [];
  pingCount = 0;
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(url: string, options: { headers: Record<string, string> }) {
    this.url = url;
    this.headers = options.headers;
  }

  on(event: string, cb: (...args: unknown[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  ping(): void {
    this.pingCount += 1;
  }

  close(): void {
    this.readyState = 3;
  }

  terminate(): void {
    this.readyState = 3;
    this.emit('close', 1006);
  }

  serverOpen(): void {
    this.readyState = 1;
    this.emit('open');
  }

  /** Real `ws` delivers text frames as Buffers. */
  serverMessage(text: string): void {
    this.emit('message', Buffer.from(text, 'utf8'));
  }

  serverClose(code: number): void {
    this.readyState = 3;
    this.emit('close', code);
  }

  serverError(err: Error): void {
    this.emit('error', err);
  }
}
```

- [ ] **Step 2: Write the failing lifecycle tests**

Append to `tests/cloud-ws-channel.test.ts` (extend the existing import from `./helpers/cloud`):

```ts
import { FakeSocket, ManualScheduler, DEVICE_ID } from './helpers/cloud';
import { createWssChannel, WS_AUTH_CLOSE_CODE } from '../src/main/cloud-client/ws-channel';
import type { WssChannelState } from '../src/main/cloud-client/types';
import type { WsFactory } from '../src/main/cloud-client/ws-channel';

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
    heartbeatIntervalMs?: number;
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
    ...(overrides.heartbeatIntervalMs !== undefined
      ? { heartbeatIntervalMs: overrides.heartbeatIntervalMs }
      : {}),
  });
  channel.on('state', (s) => states.push(s));
  channel.on('message', (raw) => messages.push(raw));
  channel.on('auth-failed', () => {
    authFailures += 1;
  });
  return { channel, sockets, scheduler, states, messages, authFailures, logs };
}
```

Append the tests:

```ts
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

  it('never dials while unpaired, and starts dialing once credentials exist', () => {
    const h = makeChannelHarness({ getAuth: () => null });
    h.channel.start();
    expect(h.sockets).toHaveLength(0);
    expect(h.channel.isConnected()).toBe(false);
  });

  it('replaces a live socket on notifyAuthChanged and ignores the stale close', async () => {
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run tests/cloud-ws-channel.test.ts`
Expected: FAIL — `createWssChannel` is not exported.

- [ ] **Step 4: Implement the channel**

Replace the placeholder `DEFAULTS`/`WS_OPEN_STATE` exports from Task 3 with the real implementation (keep `deriveWssUrl`, `assertWssUrl`, `WS_AUTH_CLOSE_CODE`, and the module docstring). Full implementation:

```ts
/** Structural surface of a `ws` WebSocket the channel touches. Injectable so
 *  unit tests script sockets without a network. */
export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  ping(callback?: () => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'close', cb: (code: number) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'pong', cb: () => void): void;
}

export type WsFactory = (url: string, options: { headers: Record<string, string> }) => WsLike;

export interface WssChannelDeps {
  readonly url: string;
  readonly agentVersion: string;
  /** Live credentials at dial time; null = unpaired → no dial. */
  readonly getAuth: () => TransportAuth | null;
  /** Queue/printer facts for §3.2 heartbeats (connection is forced to 'wss'). */
  readonly heartbeatSample?: () => HeartbeatSample;
  readonly log?: (message: string) => void;
  readonly now?: () => number;
  readonly schedule?: (fn: () => void, delayMs: number) => () => void;
  readonly random?: () => number;
  readonly heartbeatIntervalMs?: number;
  readonly pingIntervalMs?: number;
  readonly deadSilenceMs?: number;
  readonly maxFrameBytes?: number;
  readonly maxBackoffMs?: number;
  /** Local-integration escape hatch (ws://); refused outright in production. */
  readonly allowInsecureWs?: boolean;
  readonly wsFactory?: WsFactory;
}

function defaultSchedule(fn: () => void, delayMs: number): () => void {
  const t = setTimeout(fn, delayMs);
  return () => {
    clearTimeout(t);
  };
}

export function createWssChannel(deps: WssChannelDeps): WssChannelLike {
  const url = assertWssUrl(deps.url, deps.allowInsecureWs === true);
  const factory = deps.wsFactory ?? realWsFactory;
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? defaultSchedule;
  const random = deps.random ?? Math.random;
  const log = deps.log ?? ((): void => {});
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const pingIntervalMs = deps.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const deadSilenceMs = deps.deadSilenceMs ?? DEFAULT_DEAD_SILENCE_MS;
  const maxFrameBytes = deps.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const maxBackoffMs = deps.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

  const listeners = {
    message: new Set<(raw: unknown) => void>(),
    state: new Set<(s: WssChannelState) => void>(),
    'auth-failed': new Set<() => void>(),
  };

  let state: WssChannelState = 'stopped';
  let stopped = true;
  let socket: WsLike | null = null;
  let backoffAttempt = 0;
  let cancelDial: (() => void) | null = null;
  let cancelHeartbeat: (() => void) | null = null;
  let cancelKeepalive: (() => void) | null = null;
  let lastActivityAt = 0;

  function setState(next: WssChannelState): void {
    if (state === next) return;
    state = next;
    for (const l of listeners.state) l(next);
  }

  /** Cancels per-connection timers and force-closes the live socket. The
   *  socket reference is cleared BEFORE terminate(): FakeSocket.terminate
   *  emits close synchronously, and the identity guard in dial must see
   *  socket ≠ ws so the stale close never schedules a phantom redial. */
  function disposeSocket(): void {
    cancelHeartbeat?.();
    cancelHeartbeat = null;
    cancelKeepalive?.();
    cancelKeepalive = null;
    if (socket !== null) {
      const stale = socket;
      socket = null;
      stale.terminate();
    }
  }

  function dial(): void {
    if (stopped) return;
    disposeSocket();
    const auth = deps.getAuth();
    if (auth === null) {
      setState('disconnected'); // unpaired: dialing waits for credentials
      return;
    }
    setState('connecting');
    lastActivityAt = now();
    const ws = factory(url, {
      headers: {
        Authorization: `Bearer ${auth.deviceToken}`,
        'X-Device-Id': auth.deviceId,
        'X-Agent-Version': deps.agentVersion,
        'X-Protocol-Version': PROTOCOL_VERSION,
      },
    });
    socket = ws;
    ws.on('open', () => {
      if (socket !== ws || stopped) return;
      backoffAttempt = 0;
      lastActivityAt = now();
      setState('connected');
      cancelHeartbeat = schedule(sendHeartbeat, jitteredHeartbeatMs());
      cancelKeepalive = schedule(keepaliveTick, pingIntervalMs);
    });
    ws.on('message', (data) => {
      if (socket !== ws) return;
      onMessage(data);
    });
    ws.on('close', (code) => {
      if (socket !== ws) return; // stale socket (disposed/replaced) — ignore
      onClose(code);
    });
    ws.on('error', (err) => {
      if (socket !== ws) return;
      onSocketError(err);
    });
    ws.on('pong', () => {
      if (socket !== ws) return;
      lastActivityAt = now();
    });
  }

  function backoffDelayMs(): number {
    const exponential = Math.min(
      BASE_BACKOFF_MS * 2 ** Math.max(0, backoffAttempt - 1),
      maxBackoffMs,
    );
    return Math.floor(exponential / 2 + random() * (exponential / 2)); // half-jitter
  }

  /** §3.2 cadence "every 30 s ± jitter" — a synchronized fleet must never
   *  heartbeat in lockstep (mirrors the poller's healthy cadence). */
  function jitteredHeartbeatMs(): number {
    return Math.floor(heartbeatIntervalMs * (0.9 + 0.2 * random()));
  }

  function scheduleDial(): void {
    cancelDial?.();
    cancelDial = schedule(dial, backoffDelayMs());
  }

  function onClose(code: number): void {
    socket = null;
    cancelHeartbeat?.();
    cancelHeartbeat = null;
    cancelKeepalive?.();
    cancelKeepalive = null;
    setState('disconnected');
    if (stopped) return;
    if (code === WS_AUTH_CLOSE_CODE) {
      log('wss: server closed with auth failure');
      for (const l of listeners['auth-failed']) l();
    }
    backoffAttempt += 1;
    scheduleDial();
  }

  function onSocketError(err: Error): void {
    // Failed upgrades surface as "Unexpected server response: 401" with no
    // close frame; match the status for routing — the text is never logged.
    if (/\b401\b/.test(err.message)) {
      log('wss: upgrade rejected (auth failure)');
      for (const l of listeners['auth-failed']) l();
    } else {
      log('wss: socket error'); // static only; error text may echo server internals
    }
  }

  function onMessage(data: unknown): void {
    lastActivityAt = now();
    const text = frameText(data);
    if (text === null) {
      log('wss: dropped non-text frame');
      return;
    }
    if (Buffer.byteLength(text, 'utf8') > maxFrameBytes) {
      log('wss: dropped oversized frame');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      log('wss: dropped non-JSON frame');
      return;
    }
    for (const l of listeners.message) l(parsed);
  }

  function frameText(data: unknown): string | null {
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
    if (Array.isArray(data) && data.every((part) => Buffer.isBuffer(part))) {
      return Buffer.concat(data).toString('utf8');
    }
    return null;
  }

  function sendHeartbeat(): void {
    cancelHeartbeat = null;
    if (socket === null || socket.readyState !== WS_OPEN) return;
    const sample = deps.heartbeatSample?.();
    const heartbeat = HeartbeatSchema.parse({
      type: 'heartbeat' as const,
      agent_version: deps.agentVersion,
      uptime_s: sample?.uptime_s ?? 0,
      queue_depth: sample?.queue_depth ?? 0,
      connection: 'wss' as const,
      printers: sample?.printers ?? [],
    });
    try {
      socket.send(JSON.stringify(heartbeat));
    } catch {
      log('wss: heartbeat send failed'); // close/error handlers drive the reconnect
    }
    cancelHeartbeat = schedule(sendHeartbeat, jitteredHeartbeatMs());
  }

  function keepaliveTick(): void {
    cancelKeepalive = null;
    if (socket === null || socket.readyState !== WS_OPEN) return;
    if (now() - lastActivityAt >= deadSilenceMs) {
      log('wss: no pong within the silence window — terminating');
      socket.terminate(); // onClose fires and drives the redial
      return;
    }
    socket.ping();
    cancelKeepalive = schedule(keepaliveTick, pingIntervalMs);
  }

  return {
    on(event, listener) {
      (listeners[event] as Set<unknown>).add(listener);
    },
    isConnected: () => state === 'connected',
    start(): void {
      if (!stopped) return;
      stopped = false;
      backoffAttempt = 0;
      dial();
    },
    stop(): void {
      stopped = true;
      cancelDial?.();
      cancelDial = null;
      disposeSocket();
      setState('stopped');
    },
    notifyAuthChanged(): void {
      if (stopped) return;
      cancelDial?.();
      cancelDial = null;
      dial(); // disposeSocket inside dial tears down the live socket first
    },
  };
}
```

Extend the module's import block at the top (added in Task 3) with everything this implementation needs:

```ts
import { CloudError } from './errors';
import { HeartbeatSchema, PROTOCOL_VERSION } from './schemas';
import type {
  HeartbeatSample,
  TransportAuth,
  WssChannelLike,
  WssChannelState,
} from './types';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run tests/cloud-ws-channel.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm typecheck`
Expected: PASS.

```bash
git add src/main/cloud-client/ws-channel.ts tests/cloud-ws-channel.test.ts tests/helpers/cloud.ts
git commit -m "feat(cloud): WSS channel dial/lifecycle with backoff and stale-socket guard"
```

---

### Task 5: Inbound frame handling

**Files:**
- Test: `tests/cloud-ws-channel.test.ts`

Implementation already landed with Task 4 (`onMessage`/`frameText`). This task locks the frame rules with tests.

- [ ] **Step 1: Write the tests**

Append to `tests/cloud-ws-channel.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `pnpm vitest run tests/cloud-ws-channel.test.ts`
Expected: PASS (14 tests). If a test fails, fix the channel, not the test.

- [ ] **Step 3: Commit**

```bash
git add tests/cloud-ws-channel.test.ts
git commit -m "test(cloud): WSS frame size cap and defensive JSON handling"
```

---

### Task 6: Heartbeat + ping/pong watchdog

**Files:**
- Test: `tests/cloud-ws-channel.test.ts`

Implementation already landed with Task 4 (`sendHeartbeat`/`keepaliveTick`). This task locks the timing behavior.

- [ ] **Step 1: Write the tests**

Append to `tests/cloud-ws-channel.test.ts`:

```ts
import { HeartbeatSchema } from '../src/main/cloud-client/schemas';

describe('ws-channel heartbeat + watchdog', () => {
  it('sends §3.2 heartbeats every 30 s with connection "wss" and live facts', async () => {
    const h = makeChannelHarness();
    // Recreate with a sample provider: simplest is a dedicated harness below.
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
      wsFactory: (url, options) => {
        const s = new FakeSocket(url, options);
        sockets.push(s);
        return s;
      },
    });
    channel.start();
    sockets[0]?.serverOpen();
    // First heartbeat is scheduled 30 s after open.
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
    // tick 3 at 90 s: silence window exceeded → terminate (fires close 1006)
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
    await h.scheduler.runNext(); // t=60: ping again (35 s since last activity)
    expect(h.sockets[0]?.pingCount).toBe(2);
    h.sockets[0]?.serverMessage('{"type":"ping"}');
    h.scheduler.nowMs += 25_000; // t=85
    await h.scheduler.runNext(); // t=90: 5 s since last frame → ping, not terminate
    expect(h.sockets[0]?.pingCount).toBe(3);
  });
});
```

Note the ManualScheduler's `runNext` advances `nowMs` to each timer's due time — verify that helper advances the clock (it does: `this.nowMs = entry.at`), so consecutive `runNext()` calls land at 30 s, 60 s, 90 s.

- [ ] **Step 2: Run tests to verify they pass**

Run: `pnpm vitest run tests/cloud-ws-channel.test.ts`
Expected: PASS (17 tests).

- [ ] **Step 3: Commit**

```bash
git add tests/cloud-ws-channel.test.ts
git commit -m "test(cloud): WSS heartbeat cadence and ping/pong dead-connection watchdog"
```

---

### Task 7: Auth-failure routing

**Files:**
- Test: `tests/cloud-ws-channel.test.ts`

Implementation landed with Task 4 (`onClose` 4401 branch, `onSocketError` 401 match). This task locks it.

- [ ] **Step 1: Write the tests**

Append to `tests/cloud-ws-channel.test.ts`:

```ts
describe('ws-channel auth failures', () => {
  it('emits auth-failed on a 4401 close and still schedules a redial', () => {
    const h = makeChannelHarness();
    h.channel.start();
    h.sockets[0]?.serverOpen();
    h.sockets[0]?.serverClose(WS_AUTH_CLOSE_CODE);
    expect(h.authFailures).toBe(1);
    expect(h.scheduler.pendingCount).toBe(1); // consumer refreshes → notifyAuthChanged
  });

  it('emits auth-failed on an HTTP 401 upgrade rejection (no close frame)', () => {
    const h = makeChannelHarness();
    h.channel.start();
    h.sockets[0]?.serverError(new Error('Unexpected server response: 401'));
    expect(h.authFailures).toBe(1);
    expect(h.logs).toContain('wss: upgrade rejected (auth failure)');
  });

  it('does not emit auth-failed for other errors or closes', () => {
    const h = makeChannelHarness();
    h.channel.start();
    h.sockets[0]?.serverError(new Error('getaddrinfo ENOTFOUND cloud.test'));
    h.sockets[0]?.serverClose(1011);
    expect(h.authFailures).toBe(0);
  });

  it('notifyAuthChanged is a no-op while stopped', () => {
    const h = makeChannelHarness();
    h.channel.notifyAuthChanged();
    expect(h.sockets).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `pnpm vitest run tests/cloud-ws-channel.test.ts`
Expected: PASS (21 tests).

- [ ] **Step 3: Commit**

```bash
git add tests/cloud-ws-channel.test.ts
git commit -m "test(cloud): 4401 close and 401 upgrade rejection route to auth-failed"
```

---

### Task 8: Integration test against a real in-process ws server

**Files:**
- Test: `tests/cloud-ws-integration.test.ts`

Loopback listener exists only in tests (the no-listen rule governs the shipped app — same precedent as the TCP escpos-emulator integration tests).

- [ ] **Step 1: Write the test**

Create `tests/cloud-ws-integration.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { createWssChannel } from '../src/main/cloud-client/ws-channel';

/** End-to-end over a real socket: §1 upgrade headers, frame delivery, 4401
 *  auth-failure routing. Loopback listener — tests only (ADR-2 governs the
 *  shipped app, which never listens). */

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

function startServer(
  handlers: {
    onConnection?: (ws: WebSocket, headers: Record<string, string | undefined>) => void;
  } = {},
): Promise<{ url: string }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    wss.on('connection', (ws, req) => handlers.onConnection?.(ws, req.headers));
    wss.on('listening', () => {
      const addr = wss.address() as AddressInfo;
      servers.push({
        close: () =>
          new Promise<void>((resolveClose) => {
            wss.close(() => resolveClose());
          }),
      });
      resolve({ url: `ws://127.0.0.1:${String(addr.port)}/agent/v1/ws` });
    });
  });
});

describe('ws-channel over a real socket', () => {
  it('sends §1 headers on upgrade, delivers frames, and routes 4401 closes', async () => {
    const seenHeaders: Array<Record<string, string | undefined>> = [];
    const { url } = await startServer({
      onConnection: (ws, headers) => {
        seenHeaders.push(headers);
        ws.send('{"type":"ping"}');
        // Close with the contract's auth-failure code after the frame lands.
        setTimeout(() => ws.close(4401, 'auth'), 20);
      },
    });
    const channel = createWssChannel({
      url,
      agentVersion: '0.1.0-test',
      getAuth: () => ({ deviceId: '018f3c2e-0000-7000-8000-000000000003', deviceToken: 'tok' }),
      allowInsecureWs: true, // loopback test server has no TLS
      heartbeatIntervalMs: 3_600_000, // keep heartbeat out of this test
      pingIntervalMs: 3_600_000,
    });
    const messages: unknown[] = [];
    const authFailures = vi.fn();
    channel.on('message', (raw) => messages.push(raw));
    channel.on('auth-failed', authFailures);
    channel.start();
    await vi.waitFor(() => expect(messages).toEqual([{ type: 'ping' }]), { timeout: 2_000 });
    expect(seenHeaders[0]?.['authorization']).toBe('Bearer tok');
    expect(seenHeaders[0]?.['x-agent-version']).toBe('0.1.0-test');
    expect(seenHeaders[0]?.['x-protocol-version']).toBe('1');
    await vi.waitFor(() => expect(authFailures).toHaveBeenCalledOnce(), { timeout: 2_000 });
    channel.stop();
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm vitest run tests/cloud-ws-integration.test.ts`
Expected: PASS. If the upgrade is rejected, check `allowInsecureWs` and that the URL is `ws://` (loopback).

- [ ] **Step 3: Commit**

```bash
git add tests/cloud-ws-integration.test.ts
git commit -m "test(cloud): real-socket WSS integration — headers, frames, 4401 routing"
```

---

### Task 9: Poller integration

**Files:**
- Modify: `tests/helpers/cloud.ts` (append `FakeChannel`)
- Modify: `src/main/cloud-client/poller.ts`
- Test: `tests/cloud-poller.test.ts`

- [ ] **Step 1: Append `FakeChannel` to `tests/helpers/cloud.ts`**

Add to the type imports at the top:

```ts
import type { WssChannelLike, WssChannelState } from '../../src/main/cloud-client/types';
```

Append at the end:

```ts
/** Scriptable WssChannelLike for poller tests: tests drive connect/disconnect/
 *  push/authFailed and assert on the recorded lifecycle calls. */
export class FakeChannel implements WssChannelLike {
  connected = false;
  starts = 0;
  stops = 0;
  authChangedCalls = 0;
  private messageListeners = new Set<(raw: unknown) => void>();
  private stateListeners = new Set<(s: WssChannelState) => void>();
  private authListeners = new Set<() => void>();

  on(event: 'message', listener: (raw: unknown) => void): void;
  on(event: 'state', listener: (s: WssChannelState) => void): void;
  on(event: 'auth-failed', listener: () => void): void;
  on(event: string, listener: (arg?: unknown) => void): void {
    if (event === 'message') this.messageListeners.add(listener as (raw: unknown) => void);
    else if (event === 'state') this.stateListeners.add(listener as (s: WssChannelState) => void);
    else this.authListeners.add(listener as () => void);
  }

  isConnected(): boolean {
    return this.connected;
  }
  start(): void {
    this.starts += 1;
  }
  stop(): void {
    this.stops += 1;
  }
  notifyAuthChanged(): void {
    this.authChangedCalls += 1;
  }

  // -- test drivers --
  connect(): void {
    this.connected = true;
    for (const l of this.stateListeners) l('connected');
  }
  disconnect(): void {
    this.connected = false;
    for (const l of this.stateListeners) l('disconnected');
  }
  push(raw: unknown): void {
    for (const l of this.messageListeners) l(raw);
  }
  authFailed(): void {
    for (const l of this.authListeners) l();
  }
}
```

- [ ] **Step 2: Write the failing poller tests**

In `tests/cloud-poller.test.ts`, extend the harness: add an optional channel and `safetyPollIntervalMs`. Modify `makeHarness` (line ~39) to accept a second parameter and pass it through:

```ts
function makeHarness(
  script: ConstructorParameters<typeof FakeTransport>[0] = {},
  options: {
    channel?: FakeChannel;
    safetyPollIntervalMs?: number;
    heartbeatSample?: () => HeartbeatSample;
  } = {},
): Harness {
  const scheduler = new ManualScheduler();
  const transport = new FakeTransport(script);
  const secrets = createSafeStorageSecretStore(new MemoryKvAdapter(), new FakeSafeStorage());
  secrets.save(makeSecrets());
  const channel = options.channel ?? new FakeChannel();
  // ... (existing body unchanged, except:)
  const client = createPollingCloudClient({
    transport,
    secrets,
    agentVersion: '0.1.0',
    schedule: scheduler.schedule,
    now: () => scheduler.nowMs,
    pollIntervalMs: 30_000,
    refreshCooldownMs: 30_000,
    random: () => 0.5,
    onRevoked: (reason) => revokedWipes.push(reason),
    log: (message) => logs.push(message),
    channel,
    ...(options.safetyPollIntervalMs !== undefined
      ? { safetyPollIntervalMs: options.safetyPollIntervalMs }
      : {}),
    ...(options.heartbeatSample !== undefined
      ? { heartbeatSample: options.heartbeatSample }
      : {}),
  });
  // ... existing listener wiring unchanged ...
  return { client, transport, scheduler, secrets, jobs, configs, states, revoked, revokedWipes, logs, channel };
}
```

Add `channel: FakeChannel` to the `Harness` interface, add `HeartbeatSample` to the type imports from `../src/main/cloud-client/types`, and add `FakeChannel` to the import from `./helpers/cloud`. The heartbeat tests below are the only ones that pass `heartbeatSample` — existing tests keep their exact behavior (no sample provider → no REST heartbeats, as today).

Append the tests:

```ts
import { FakeChannel } from './helpers/cloud';

describe('WSS channel integration', () => {
  it('channel connect flips state online and the next cadence slows to the safety interval', async () => {
    const h = makeHarness({}, { safetyPollIntervalMs: 300_000 });
    await startAndSettle(h);
    h.channel.connect();
    expect(h.client.state()).toBe('online');
    await h.scheduler.runNext(); // the pre-connect cycle runs; the NEXT one is safety-cadence
    // 300_000 · (0.9 + 0.2·0.5) = 300_000 ms exactly.
    expect(h.scheduler.nextDelay()).toBe(300_000);
  });

  it('delivers envelopes pushed over the channel through the same pipeline', async () => {
    const { envelope, publicKeyB64Url } = makeSignedEnvelope();
    const h = makeHarness({});
    h.secrets.save(makeSecrets({ serverSigningPubkey: publicKeyB64Url }));
    await startAndSettle(h);
    const before = h.jobs.length;
    h.channel.connect();
    h.channel.push(envelope);
    await settle();
    expect(h.jobs.length).toBe(before + 1);
  });

  it('out-of-scope jobs pushed over the channel are rejected via REST acks', async () => {
    const { envelope, publicKeyB64Url } = makeSignedEnvelope({
      job: { tenant_id: OTHER_TENANT_ID },
    });
    const h = makeHarness({});
    h.secrets.save(makeSecrets({ serverSigningPubkey: publicKeyB64Url }));
    await startAndSettle(h);
    h.channel.connect();
    h.channel.push(envelope);
    await settle();
    const ackCall = h.transport.callsOf('acks')[0];
    expect(ackCall?.batch?.acks[0]).toMatchObject({
      job_id: (envelope.job as { job_id: string }).job_id,
      status: 'rejected',
    });
  });

  it('a revoke envelope over the channel wipes local state', async () => {
    const h = makeHarness({});
    await startAndSettle(h);
    h.channel.connect();
    h.channel.push({ type: 'revoke', reason: 'manager_initiated' });
    await settle();
    expect(h.revoked).toEqual([{ reason: 'manager_initiated' }]);
    expect(h.revokedWipes).toEqual(['manager_initiated']);
    expect(h.client.state()).toBe('revoked');
  });

  it('REST heartbeat is skipped while the channel carries heartbeats', async () => {
    const h = makeHarness(
      {},
      {
        heartbeatSample: () => ({
          uptime_s: 1,
          queue_depth: 0,
          connection: 'poll' as const,
          printers: [],
        }),
      },
    );
    h.channel.connect();
    await startAndSettle(h);
    expect(h.transport.callsOf('heartbeat')).toHaveLength(0);
  });

  it('channel disconnect triggers an immediate cycle that sends a poll-mode heartbeat', async () => {
    const h = makeHarness(
      {},
      {
        heartbeatSample: () => ({
          uptime_s: 1,
          queue_depth: 0,
          connection: 'poll' as const,
          printers: [],
        }),
      },
    );
    h.channel.connect();
    await startAndSettle(h);
    h.transport.calls.length = 0;
    h.channel.disconnect(); // schedules the recovery cycle at delay 0
    await h.scheduler.runNext();
    expect(h.transport.callsOf('poll')).toHaveLength(1);
    const hb = h.transport.callsOf('heartbeat')[0];
    expect(hb?.sample?.connection).toBe('poll');
  });

  it('a failed poll cycle keeps state online while the channel is connected', async () => {
    let pollCount = 0;
    const h = makeHarness({
      poll: () => {
        pollCount += 1;
        if (pollCount > 1) throw new CloudError('network');
        return makePollResponse([]);
      },
    });
    await startAndSettle(h);
    h.channel.connect();
    await h.scheduler.runNext(); // failing cycle
    expect(h.client.state()).toBe('online');
  });

  it('auth-failed runs a cycle; a successful refresh notifies the channel', async () => {
    const h = makeHarness({
      poll: [
        makePollResponse([]),
        new CloudError('unauthorized'), // triggers the refresh path
        makePollResponse([]),
      ],
    });
    await startAndSettle(h);
    h.channel.authFailed();
    await settle();
    expect(h.transport.callsOf('refresh')).toHaveLength(1);
    expect(h.channel.authChangedCalls).toBe(1);
  });

  it('start/stop/revoke manage the channel lifecycle', async () => {
    const h = makeHarness({});
    await startAndSettle(h);
    expect(h.channel.starts).toBe(1);
    h.client.stop();
    expect(h.channel.stops).toBeGreaterThanOrEqual(1);
  });
});
```

Note: the FakeTransport script array semantics — a plain array is treated by `resolve` as a non-function value, NOT consumed per call. Per-call consumption exists only for `acks`. So for the refresh test, use a function script instead:

```ts
  it('auth-failed runs a cycle; a successful refresh notifies the channel', async () => {
    let pollCalls = 0;
    const h = makeHarness({
      poll: (since: string) => {
        pollCalls += 1;
        if (pollCalls === 2) throw new CloudError('unauthorized');
        return makePollResponse([]);
      },
    });
    await startAndSettle(h);
    h.channel.authFailed();
    await settle();
    expect(h.transport.callsOf('refresh')).toHaveLength(1);
    expect(h.channel.authChangedCalls).toBe(1);
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run tests/cloud-poller.test.ts`
Expected: FAIL — `channel` is not a known dep / FakeChannel import unused.

- [ ] **Step 4: Implement in `poller.ts`**

1. Import the type:

```ts
import type {
  AgentTransport,
  CloudClient,
  CloudListener,
  ConnectionState,
  HeartbeatSample,
  AckBatch,
  WssChannelLike,
} from './types';
```

2. Extend `PollingClientDeps` (after `pollIntervalMs`):

```ts
  readonly pollIntervalMs?: number;
  /** Live WSS push channel (contract §1); envelopes share the poll pipeline. */
  readonly channel?: WssChannelLike;
  /** Healthy-cadence poll interval while the channel is connected. */
  readonly safetyPollIntervalMs?: number;
```

3. Add the constant and local bindings (near `DEFAULT_POLL_INTERVAL_MS` / in the factory preamble):

```ts
const DEFAULT_SAFETY_POLL_INTERVAL_MS = 5 * 60_000;
```

```ts
  const channel = deps.channel;
  const safetyPollIntervalMs = deps.safetyPollIntervalMs ?? DEFAULT_SAFETY_POLL_INTERVAL_MS;
```

4. `healthyDelayMs()` — channel-aware interval:

```ts
  function healthyDelayMs(): number {
    const interval = channel?.isConnected() === true ? safetyPollIntervalMs : pollIntervalMs;
    return Math.floor(interval * (0.9 + 0.2 * random()));
  }
```

5. `runCycle()` — skip the REST heartbeat while the channel carries heartbeats:

```ts
      try {
        if (sampleProvider !== undefined && channel?.isConnected() !== true) {
          await withAuth((auth) => transport.heartbeat(auth, sampleProvider()));
        }
```

6. `handleCycleError()` — stay online while the socket is up:

```ts
    backoffAttempt += 1;
    setState(channel?.isConnected() === true ? 'online' : 'offline');
    if (err instanceof CloudError) {
      log(`cloud: cycle failed (${err.code})`); // code + static detail only
    } else {
      log('cloud: cycle failed (unexpected error)');
    }
```

(Existing `malformed_response` / `not_paired` early-returns stay as they are.)

7. Channel wiring — add inside `createPollingCloudClient` after the `listeners` map is defined:

```ts
  channel?.on('message', (raw) => {
    handleServerMessage(raw);
  });
  channel?.on('state', (next) => {
    if (isStopped() || state === 'revoked') return;
    if (next === 'connected') {
      backoffAttempt = 0;
      setState('online');
      return;
    }
    if (next === 'disconnected') {
      scheduleCycle(0); // fast lane back to REST polling
    }
  });
  channel?.on('auth-failed', () => {
    if (isStopped()) return;
    void runCycle(); // 401 path performs the single-flight refresh → redial below
  });
```

8. Lifecycle hooks:
- `start()` — after `scheduleCycle(0)`: `channel?.start();`
- `stop()` — after `cancelTimer = null;`: `channel?.stop();`
- `handleRevocation()` — after `cancelTimer = null;`: `channel?.stop();`
- `refreshTokens()` — after `identity = next;`: `channel?.notifyAuthChanged();`

(`pair()` needs no extra hook: it calls `stop()` first, so the subsequent `start()` re-dials and the dial reads the freshly stored identity via `getAuth()`.)

- [ ] **Step 5: Run the full poller suite**

Run: `pnpm vitest run tests/cloud-poller.test.ts`
Expected: PASS (all existing + 9 new tests). Existing tests must not regress — they run without a channel (`deps.channel` undefined), so every `channel?.` path is inert.

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm typecheck`
Expected: PASS.

```bash
git add src/main/cloud-client/poller.ts tests/cloud-poller.test.ts tests/helpers/cloud.ts
git commit -m "feat(cloud): poller consumes the WSS channel — cadence, heartbeats, auth redial"
```

---

### Task 10: Composition wiring in agent-runtime

**Files:**
- Modify: `src/main/agent-runtime.ts`
- Test: `tests/agent-runtime.test.ts`

- [ ] **Step 1: Update the runtime test harness to inject a no-op channel**

Without an override the runtime would construct a real channel and attempt live dials in unit tests. In `tests/agent-runtime.test.ts`, add the import:

```ts
import type { WssChannelLike } from '../src/main/cloud-client/types';
```

Add the helper (near `manualSchedule`):

```ts
/** Inert channel: runtime tests exercise poll/engine behavior, not sockets. */
function noopChannel(): WssChannelLike {
  return {
    on: () => {},
    isConnected: () => false,
    start: () => {},
    stop: () => {},
    notifyAuthChanged: () => {},
  };
}
```

In `makeRuntime`, extend the `env` object (line ~281):

```ts
  const env: NonNullable<RuntimeDeps['env']> = {
    transportOverride: transport,
    kvOverride: overrides.kv ?? fakeKv(),
    transportsOverride: overrides.transports ?? stubTransports(),
    adapterOverride: memoryAdapter(),
    channelOverride: noopChannel(),
    schedule,
```

- [ ] **Step 2: Write a failing wiring test**

Append to `tests/agent-runtime.test.ts` (in the lifecycle describe or a new one):

```ts
import { FakeChannel } from './helpers/cloud';

describe('AgentRuntime WSS wiring', () => {
  it('passes the injected channel through to the cloud client', async () => {
    const channel = new FakeChannel();
    const { runtime } = await makeRuntime({ channel });
    runtime.start();
    await vi.waitFor(() => expect(channel.starts).toBe(1));
    runtime.stop();
    expect(channel.stops).toBeGreaterThanOrEqual(1);
  });
});
```

Extend `makeRuntime`'s overrides parameter with `channel?: FakeChannel` and use `channelOverride: overrides.channel ?? noopChannel()`. (Import `FakeChannel` from `./helpers/cloud`.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run tests/agent-runtime.test.ts`
Expected: FAIL — `channelOverride` not in `RuntimeDeps['env']` / `channel` not a known override.

- [ ] **Step 4: Wire the runtime**

In `src/main/agent-runtime.ts`:

1. Imports:

```ts
import { createWssChannel, deriveWssUrl } from './cloud-client/ws-channel';
```

and add `WssChannelLike` to the type import from `'./cloud-client/types'`.

2. `RuntimeDeps.cloud` gains the optional safety interval:

```ts
  readonly cloud: {
    readonly baseUrl: string;
    readonly pollIntervalMs?: number;
    readonly safetyPollIntervalMs?: number;
  };
```

3. `RuntimeDeps.env` gains:

```ts
    /** Test seam: replaces the default real WSS channel. */
    readonly channelOverride?: WssChannelLike;
```

4. Construct the channel before the client (after `engine` creation, before `client = createPollingCloudClient`):

```ts
  const channel: WssChannelLike =
    deps.env?.channelOverride ??
    createWssChannel({
      url: deriveWssUrl(deps.cloud.baseUrl),
      agentVersion: deps.agentVersion,
      getAuth: () => {
        const identity = readIdentity();
        return identity === null
          ? null
          : { deviceId: identity.deviceId, deviceToken: identity.deviceToken };
      },
      heartbeatSample: () => heartbeatSample(),
      log: (message) => {
        log.info(message);
      },
      now,
      schedule,
      random,
    });
```

5. Pass it to the client (extend the `createPollingCloudClient` call):

```ts
  client = createPollingCloudClient({
    transport,
    secrets,
    agentVersion: deps.agentVersion,
    log: (message) => {
      log.info(message);
    },
    now,
    schedule,
    random,
    channel,
    ...(deps.cloud.pollIntervalMs !== undefined
      ? { pollIntervalMs: deps.cloud.pollIntervalMs }
      : {}),
    ...(deps.cloud.safetyPollIntervalMs !== undefined
      ? { safetyPollIntervalMs: deps.cloud.safetyPollIntervalMs }
      : {}),
    heartbeatSample: () => heartbeatSample(),
    onRevoked: () => {
      void wipeLocalState();
    },
  });
```

6. Update the online wording in `CONNECTION_DETAILS`:

```ts
  online: 'Connected to the cloud. Jobs arrive in real time over a secure socket; polling backs this up.',
```

- [ ] **Step 5: Run the runtime suite**

Run: `pnpm vitest run tests/agent-runtime.test.ts`
Expected: PASS (all existing + the new wiring test).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm typecheck`
Expected: PASS.

```bash
git add src/main/agent-runtime.ts tests/agent-runtime.test.ts
git commit -m "feat(runtime): compose the WSS channel into the cloud client"
```

---

### Task 11: Documentation — contract + ADR

**Files:**
- Modify: `docs/api-contract.md`
- Modify: `docs/adr.md`

Docs are the source of truth for the Laravel team — this ships in the same change as the behavior (CLAUDE.md workflow rules).

- [ ] **Step 1: Update `docs/api-contract.md` §1**

Replace the WSS bullet (lines 11–12):

```markdown
- WSS endpoint: `wss://<saas-host>/agent/v1/ws` — agent-initiated, persistent, outbound.
  **Implemented 2026-10 (ADR-15).** The agent connects after pairing, sends §3.2
  heartbeats, and receives §2/§3.5/§4 envelopes. **Acks stay on REST (§3.3):** no WSS
  ack-ack format is defined, and the §7.1 per-ack results semantics are REST-only.
  Socket semantics: the server closes with **`4401`** for auth failures (invalid/
  expired/revoked token, or an HTTP 401 upgrade rejection); the agent then refreshes
  credentials and redials. All other closes reconnect with exponential backoff. The
  agent sends ws-level pings every ~30 s and treats 90 s without a pong as a dead
  connection. Jobs pushed over WSS are claimed on send (mirroring the pull-claim,
  §7 note 6); agent acks remain the only path to terminal states.
```

- [ ] **Step 2: Update §6 (validation matrix)**

Append to the §6 list:

```markdown
- WSS: upgrade with a valid token / with a bad token (4401 or 401 upgrade rejection) /
  job delivered over WSS == job delivered over the poll batch (idempotent by
  `job_id`+`attempt`) / revoke + config_update over WSS / oversized frame dropped /
  90 s silence → agent reconnects.
```

- [ ] **Step 3: Amend the §7 preamble**

After the §7 intro paragraph, add:

```markdown
**2026-10-27 amendment:** WSS push (§1) is now implemented on both sides. The REST
surface below remains the fallback + control plane; `connection: "wss"` heartbeats
replace `POST /heartbeat` while the socket is healthy.
```

- [ ] **Step 4: Append ADR-15 to `docs/adr.md`**

Add a table row after ADR-14:

```markdown
| ADR-15 | **WSS push primary + slow-poll safety net (5 min); acks stay REST; close `4401` = auth failure** | accepted | Real-time delivery per contract §1 with graceful degradation to the proven polling path; §7.1 per-ack results semantics exist only on REST and no WSS ack-ack format is defined (inventing one would be a contract change). `ws` (MIT, pure JS, no postinstall) — native WebSocket cannot set upgrade headers | Acks over WSS (undefined ack-ack format); WSS-only (no fallback if the socket drops); polling-only (status quo — delivery latency) |
```

- [ ] **Step 5: Commit**

```bash
git add docs/api-contract.md docs/adr.md
git commit -m "docs: WSS push channel contract semantics (4401, REST-only acks) + ADR-15"
```

---

### Task 12: Full verification

- [ ] **Step 1: Typecheck, lint, unit tests**

```bash
pnpm typecheck && pnpm lint && pnpm test
```
Expected: all PASS.

- [ ] **Step 2: No-listen smoke (security rule 1)**

```bash
pnpm no-listen
```
Expected: PASS — the channel is client-only; the app creates no listener.

- [ ] **Step 3: Format check**

```bash
pnpm format:check
```
Expected: known pre-existing prettier failures may appear (documented, out of scope); no NEW failures in files touched by this plan. Fix only new ones.

- [ ] **Step 4: Final commit (if any stragglers) and summary**

Verify `git status` is clean; report which tests cover each spec section.
