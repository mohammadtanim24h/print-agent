import WebSocket from 'ws';
import { CloudError } from './errors';
import { HeartbeatSchema, PROTOCOL_VERSION } from './schemas';
import type { HeartbeatSample, TransportAuth, WssChannelLike, WssChannelState } from './types';

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

/**
 * REST base URL → §1 WSS endpoint (https→wss; http→ws for local dev).
 * Precondition: `baseUrl` has already been validated by the HTTP transport's
 * `assertSecureBaseUrl` (https/http only) — any other scheme maps blindly to ws.
 */
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

/** Structural surface of a `ws` WebSocket the channel touches. Injectable so
 *  unit tests script sockets without a network. */
export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  ping(callback?: () => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: 'open' | 'pong', cb: () => void): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'close', cb: (code: number) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

export type WsFactory = (
  url: string,
  options: { headers: Record<string, string>; maxPayload: number },
) => WsLike;

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

const realWsFactory: WsFactory = (url, options) => new WebSocket(url, options);

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
      // Transport-level frame cap: ws buffers the whole frame before the
      // app-level size check in onMessage can run (ws default is 100 MiB).
      maxPayload: maxFrameBytes,
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

  /** Re-reads the live flags after a listener dispatch: control-flow narrowing
   *  can't see that listeners (notifyAuthChanged/stop) mutate them. */
  const dialInvalidated = (): boolean => stopped || socket !== null;

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
      // A listener may have redialed (notifyAuthChanged) or stopped us —
      // never schedule a dial that would tear down that fresh socket.
      if (dialInvalidated()) return;
    }
    backoffAttempt += 1;
    scheduleDial();
  }

  function onSocketError(err: Error): void {
    // Failed upgrades surface as the exact ws message "Unexpected server
    // response: 401" with no close frame — never log the text (it may echo
    // server internals), and never substring-match a bare "401" (URLs/ports).
    if (err.message.includes('Unexpected server response: 401')) {
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
    try {
      const sample = deps.heartbeatSample?.();
      const heartbeat = HeartbeatSchema.parse({
        type: 'heartbeat' as const,
        agent_version: deps.agentVersion,
        uptime_s: sample?.uptime_s ?? 0,
        queue_depth: sample?.queue_depth ?? 0,
        connection: 'wss' as const,
        printers: sample?.printers ?? [],
      });
      socket.send(JSON.stringify(heartbeat));
    } catch {
      log('wss: heartbeat failed'); // static; the cadence must survive a bad sample
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
