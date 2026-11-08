# WSS Revival (A3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the in-tree WSS push channel into the agent runtime behind an opt-in flag (default off) and write the servepro-api WSS endpoint implementation spec.

**Architecture:** The poller already accepts an optional `channel: WssChannelLike` and owns all channel interactions (frame funnel, safety-poll cadence, rotation redial, revoke stop) — the runtime change is pure assembly: construct `createWssChannel` when `cloud.wss.enabled` and pass it in. The server side is a docs deliverable (`docs/wss-server-spec.md`) for the Laravel repo; no server code here.

**Tech Stack:** TypeScript (strict), Electron main process, vitest, `ws` 8.22.0 (already a dependency).

**Spec:** `docs/superpowers/specs/2026-11-08-wss-revival-design.md`

**Pre-existing coverage the plan relies on (do NOT duplicate):**
- Channel protocol over a real socket (§1 headers, frame delivery, 4401, 401 upgrade, frame cap): `tests/cloud-ws-integration.test.ts`
- Channel unit behavior (notifyAuthChanged, auth-failed routing): `tests/cloud-ws-channel.test.ts`
- Poller×channel (auth-failed → cycle → refresh → notifyAuthChanged redial, safety cadence): `tests/cloud-poller.test.ts:856`

**Commands:** `pnpm test` (vitest run), `pnpm typecheck`, `pnpm lint`, `pnpm no-listen` (AC-4 smoke).

---

### Task 1: Runtime type surface + channel construction

**Files:**
- Modify: `src/main/agent-runtime.ts` (imports ~line 3-4; `RuntimeDeps.cloud` ~line 74-79; `RuntimeDeps.env` ~line 85-100; channel construction before `client = createPollingCloudClient` ~line 236-258)
- Modify: `tests/helpers/runtime-harness.ts` (`makeRuntime` overrides ~line 257-268, env assembly ~line 295-305, cloud arg ~line 318)
- Modify: `tests/agent-runtime.test.ts` (imports ~line 1-18; new describe at end of file)

- [ ] **Step 1: Write the failing wiring tests**

Append to `tests/agent-runtime.test.ts`. Add imports at the top of the file: extend the harness import block with nothing new (all names already imported), and add:

```ts
import type { WsFactory, WsLike } from '../src/main/cloud-client/ws-channel';
```

Add this helper block after `manualSchedule()` (line ~88), before the first `describe`:

```ts
// ---- WSS wiring seams (A3 revival) ---------------------------------------------

const WS_OPEN = 1;

class FakeWs implements WsLike {
  readyState = 0;
  readonly sent: string[] = [];
  terminated = false;
  private readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>();

  constructor(
    readonly url: string,
    readonly options: { headers: Record<string, string>; maxPayload: number },
  ) {}

  send(data: string): void {
    this.sent.push(data);
  }
  ping(callback?: () => void): void {
    callback?.();
  }
  close(_code?: number, _reason?: string): void {
    this.readyState = 3;
    this.emit('close');
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
    this.emit('close');
  }
  on(event: 'open' | 'pong', cb: () => void): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'close', cb: (code: number) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: string, cb: (...args: unknown[]) => void): void {
    let set = this.handlers.get(event);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(cb);
  }
  open(): void {
    this.readyState = WS_OPEN;
    this.emit('open');
  }
  private emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }
}

function fakeWsFactory(): { factory: WsFactory; sockets: FakeWs[] } {
  const sockets: FakeWs[] = [];
  const factory = vi.fn<WsFactory>((url, options) => {
    const ws = new FakeWs(url, options);
    sockets.push(ws);
    return ws;
  });
  return { factory, sockets };
}
```

Append the describe block at the end of the file:

```ts
describe('AgentRuntime WSS channel wiring (A3 revival)', () => {
  const wssCloud = {
    baseUrl: 'https://api.test',
    pollIntervalMs: 20,
    wss: { enabled: true },
  };

  it('flag off: poll cycles run but the ws factory is never invoked', async () => {
    const { factory } = fakeWsFactory();
    const { runtime, transport } = await makeRuntime({ wsFactory: factory });
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    await runtime.printers.add(makeDraft());
    await vi.waitFor(() => {
      expect(transport.heartbeats.length).toBeGreaterThanOrEqual(1); // cycles are live
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it('flag on: unpaired start never dials; pairing dials the derived §1 URL with paired auth headers', async () => {
    const { factory, sockets } = fakeWsFactory();
    const { runtime, transport } = await makeRuntime({ wsFactory: factory, cloud: wssCloud });
    runtime.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(factory).not.toHaveBeenCalled(); // unpaired → getAuth null → idle
    expect(transport.heartbeats.length).toBe(0); // no cycles ran unpaired either
    await runtime.pair(PAIRING_CODE);
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    expect(sockets[0]?.url).toBe('wss://api.test/agent/v1/ws');
    expect(sockets[0]?.options.headers['authorization']).toBe('Bearer device-token-test');
    expect(sockets[0]?.options.headers['x-device-id']).toBe(makeUuid(3));
    expect(sockets[0]?.options.headers['x-protocol-version']).toBe('1');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail (type error)**

Run: `pnpm vitest run tests/agent-runtime.test.ts`
Expected: TypeScript error — `wss` / `wsFactory` do not exist on `RuntimeDeps` (the harness override `cloud`/`wsFactory` also missing). Compile failure counts as the red step.

- [ ] **Step 3: Extend the harness (`tests/helpers/runtime-harness.ts`)**

In `makeRuntime`'s `overrides` parameter type (line ~258), add two entries after `spoolerBridge?: SpoolerBridge;`:

```ts
    /** Runtime cloud-deps override; defaults to https://api.test + 20 ms poll. */
    cloud?: { baseUrl: string; allowInsecureHttp?: boolean; wss?: { enabled?: boolean } };
    /** Socket factory seam forwarded to the runtime's §1 channel (default: real ws client). */
    wsFactory?: WsFactory;
```

Add the import at the top of the file:

```ts
import type { WsFactory } from '../../src/main/cloud-client/ws-channel';
```

In the `env` object assembly (line ~295), add after the `spoolerBridge` spread:

```ts
    ...(overrides.wsFactory !== undefined ? { wsFactory: overrides.wsFactory } : {}),
```

In the `createAgentRuntime` call (line ~318), replace:

```ts
    cloud: { baseUrl: 'https://api.test', pollIntervalMs: 20 },
```

with:

```ts
    cloud: overrides.cloud ?? { baseUrl: 'https://api.test', pollIntervalMs: 20 },
```

- [ ] **Step 4: Implement the runtime change (`src/main/agent-runtime.ts`)**

Add the import after the poller import (line 3):

```ts
import { createWssChannel, deriveWssUrl, type WsFactory } from './cloud-client/ws-channel';
```

In `RuntimeDeps.cloud` (line 74-79), add the `wss` field after `allowInsecureHttp`:

```ts
  readonly cloud: {
    readonly baseUrl: string;
    readonly pollIntervalMs?: number;
    /** Dev-only: permits http:// base URLs for a local backend (main.ts gates it on !app.isPackaged). */
    readonly allowInsecureHttp?: boolean;
    /** Opt-in §1 push channel (main.ts: PRINT_AGENT_ENABLE_WSS=1). Default off —
     *  polling is the v1 delivery path (api-contract §1, amended). */
    readonly wss?: {
      readonly enabled?: boolean;
    };
  };
```

In `RuntimeDeps.env` (line 85-100), add after `fetchOverride`:

```ts
    /** Test seam: socket factory for the §1 WSS channel (default: real ws client). */
    readonly wsFactory?: WsFactory;
```

Replace the polling-first comment block + `client = createPollingCloudClient({...})` (lines 236-258) with:

```ts
  // §1 push channel — opt-in behind the app-level flag; default OFF (polling
  // remains the v1 delivery path, api-contract §1 amendment 2026-10-30, agent
  // revival 2026-11-08). Disabled: no channel is constructed and the agent
  // never dials wss://. Enabled: the poller owns start/stop/notifyAuthChanged
  // and funnels frames through the same pipeline as poll batches; this
  // constructor only assembles the socket. getAuth re-reads live secrets per
  // dial so an unpaired runtime idles and post-rotation credentials are
  // picked up by the poller's notifyAuthChanged. allowInsecureWs follows
  // allowInsecureHttp (local-backend testing only; ws:// is refused outright
  // in production builds).
  const wssChannel =
    deps.cloud.wss?.enabled === true
      ? createWssChannel({
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
          ...(deps.cloud.allowInsecureHttp === true ? { allowInsecureWs: true } : {}),
          ...(deps.env?.wsFactory !== undefined ? { wsFactory: deps.env.wsFactory } : {}),
        })
      : undefined;

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
    ...(deps.cloud.pollIntervalMs !== undefined
      ? { pollIntervalMs: deps.cloud.pollIntervalMs }
      : {}),
    ...(wssChannel !== undefined ? { channel: wssChannel } : {}),
    heartbeatSample: () => heartbeatSample(),
    onRevoked: () => {
      void wipeLocalState();
    },
  });
```

(`readIdentity` and `heartbeatSample` are hoisted function declarations — referencing them here is safe and matches the existing forward-reference style used by `ackBuffer` → `client`.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run tests/agent-runtime.test.ts`
Expected: PASS — the two new tests plus all existing suites green.

- [ ] **Step 6: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add src/main/agent-runtime.ts tests/helpers/runtime-harness.ts tests/agent-runtime.test.ts
git commit -m "feat: construct the §1 WSS channel behind cloud.wss.enabled (A3 revival)"
```

---

### Task 2: Revoke-stop pinning test

**Files:**
- Modify: `tests/agent-runtime.test.ts` (inside the new describe block)

- [ ] **Step 1: Write the test**

Add to the `AgentRuntime WSS channel wiring (A3 revival)` describe:

```ts
  it('flag on: revocation terminates the socket and never redials with wiped credentials', async () => {
    const { factory, sockets } = fakeWsFactory();
    const { runtime, transport } = await makeRuntime({ wsFactory: factory, cloud: wssCloud });
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    transport.failNextPoll = new CloudError(
      'unauthorized',
      'device revoked',
      undefined,
      'device_revoked',
    );
    await vi.waitFor(async () => {
      expect((await runtime.snapshot()).connection).toBe('revoked');
    });
    expect(sockets[0]?.terminated).toBe(true); // poller stop() → channel.stop() → disposeSocket
    expect(sockets.length).toBe(1); // the terminated socket's close never schedules a redial
  });
```

This pins existing poller behavior (`revoke → channel.stop()`, poller.ts:539) through the new wiring — a regression guard, so it may pass immediately. That is acceptable for a pinning test; the Task 1 tests were the red/green pair.

- [ ] **Step 2: Run the test**

Run: `pnpm vitest run tests/agent-runtime.test.ts`
Expected: PASS (all suites).

- [ ] **Step 3: Commit**

```bash
git add tests/agent-runtime.test.ts
git commit -m "test: pin revoke→channel-stop wiring for the §1 channel"
```

---

### Task 3: main.ts opt-in flag

**Files:**
- Modify: `src/main/main.ts` (~line 105-108 after `ALLOW_INSECURE_HTTP`; `cloud` deps ~line 127-130)

- [ ] **Step 1: Add the env flag**

After the `ALLOW_INSECURE_HTTP` block (line 108), add:

```ts
  // §1 push channel opt-in (A3 revival). Default OFF — polling is the v1
  // delivery path and the servepro-api WSS endpoint does not exist yet (see
  // docs/wss-server-spec.md). Same discipline as PRINT_AGENT_ALLOW_HTTP:
  // launcher-controlled, never the machine's global environment.
  const ENABLE_WSS = process.env['PRINT_AGENT_ENABLE_WSS'] === '1';
  if (ENABLE_WSS) {
    log.info('PRINT_AGENT_ENABLE_WSS=1 — §1 push channel enabled');
  }
```

In the `createAgentRuntime` call's `cloud` object (line 127-130), add the spread after `allowInsecureHttp`:

```ts
    cloud: {
      baseUrl: API_BASE_URL,
      ...(ALLOW_INSECURE_HTTP ? { allowInsecureHttp: true } : {}),
      ...(ENABLE_WSS ? { wss: { enabled: true } } : {}),
    },
```

- [ ] **Step 2: Verify**

Run: `pnpm typecheck && pnpm lint`
Expected: clean. (main.ts is composition-only; its behavior is covered by Tasks 1/4 tests — no new unit test for an env-var read.)

- [ ] **Step 3: Commit**

```bash
git add src/main/main.ts
git commit -m "feat: PRINT_AGENT_ENABLE_WSS opt-in for the §1 push channel"
```

---

### Task 4: Full-stack integration test over a real loopback socket

**Files:**
- Create: `tests/runtime-wss-integration.test.ts`

- [ ] **Step 1: Write the test file**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';
import {
  PAIRING_CODE,
  makeCloudConfig,
  makeCloudPrinterConfig,
  makeRuntime,
  makeUuid,
  signedJobEnvelope,
} from './helpers/runtime-harness';

/**
 * Full-stack §1 check with the runtime flag ON (A3 revival): pairing dials a
 * loopback WSS server, a pushed signed envelope flows through the SAME funnel
 * as poll batches (scope check → sig verify → intake), acks drain over REST,
 * and the channel's own §3.2 heartbeat (connection:"wss") is seen server-side.
 * Protocol-level legs (4401 routing, refresh redial, frame caps) are covered
 * in cloud-ws-channel.test.ts / cloud-poller.test.ts / cloud-ws-integration.test.ts.
 * Loopback listener — tests only (ADR-2 governs the shipped app, which never listens).
 */

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

function startServer(): Promise<{
  httpBaseUrl: string;
  connections: WebSocket[];
  headers: IncomingHttpHeaders[];
  frames: unknown[];
}> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const connections: WebSocket[] = [];
    const headers: IncomingHttpHeaders[] = [];
    const frames: unknown[] = [];
    wss.on('connection', (ws, req) => {
      connections.push(ws);
      headers.push(req.headers);
      ws.on('message', (data) => {
        frames.push(JSON.parse(String(data)));
      });
    });
    wss.on('listening', () => {
      const addr = wss.address() as AddressInfo;
      servers.push({ close: () => new Promise<void>((r) => wss.close(() => r())) });
      resolve({ httpBaseUrl: `http://127.0.0.1:${String(addr.port)}`, connections, headers, frames });
    });
  });
}

describe('AgentRuntime §1 push channel over a real socket (A3 revival)', () => {
  it('pairs, dials, renders a pushed job, drains acks over REST, and heartbeats over wss', async () => {
    const server = await startServer();
    const { runtime, transport } = await makeRuntime({
      cloud: { baseUrl: server.httpBaseUrl, allowInsecureHttp: true, wss: { enabled: true } },
    });
    transport.configResponse = makeCloudConfig(1, [makeCloudPrinterConfig(1)]);
    runtime.start();
    await runtime.pair(PAIRING_CODE);

    await vi.waitFor(() => expect(server.headers.length).toBe(1));
    expect(server.headers[0]?.['authorization']).toBe('Bearer device-token-test');
    expect(server.headers[0]?.['x-device-id']).toBe(makeUuid(3));
    expect(server.headers[0]?.['x-protocol-version']).toBe('1');

    // The pair-time REST config fetch applied the fleet → intake accepts its jobs.
    await vi.waitFor(() => expect(runtime.printers.list()).toHaveLength(1));
    const printerId = runtime.printers.list()[0]?.config.printerId ?? '';

    server.connections[0]?.send(JSON.stringify(signedJobEnvelope(printerId)));
    await vi.waitFor(() => {
      const statuses = transport.acks.flatMap((b) => b.acks.map((a) => a.status));
      expect(statuses).toContain('accepted');
      // Stub transport hand-off succeeds: 'completed' = hand-off, never 'printed' (§3.1).
      expect(statuses).toContain('completed');
      expect(statuses).not.toContain('rejected');
    });

    // The channel's §3.2 heartbeat (connection forced to 'wss') reaches the server.
    await vi.waitFor(() => {
      const beat = server.frames.find((f) => (f as { type?: string }).type === 'heartbeat');
      expect(beat).toMatchObject({ type: 'heartbeat', connection: 'wss' });
    });
    runtime.stop();
  });
});
```

Note: the harness's default schedule clamps all delays to 5 ms, so the channel's ~30 s heartbeat and the safety-poll cadence fire almost immediately — no real-time waits anywhere.

- [ ] **Step 2: Run the test**

Run: `pnpm vitest run tests/runtime-wss-integration.test.ts`
Expected: PASS. If the pushed job is rejected `not_found`, the config fetch lost the race — confirm `runtime.printers.list()` is non-empty before the send (the `vi.waitFor` above already guarantees it).

- [ ] **Step 3: Full suite + typecheck + lint**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add tests/runtime-wss-integration.test.ts
git commit -m "test: full-stack §1 push delivery through the wired runtime channel"
```

---

### Task 5: Docs — contract note, readiness status, server spec

**Files:**
- Modify: `docs/api-contract.md` (§1 WSS bullet ~line 11-29; §7 amendment ~line 309-316)
- Modify: `docs/production-readiness.md` (A3 status block ~line 54-74)
- Create: `docs/wss-server-spec.md`

- [ ] **Step 1: api-contract.md §1 amendment note**

In the §1 WSS bullet, immediately after the sentence ending "…reviving WSS = implementing the server endpoint per §1/§6 and re-wiring the agent's channel (no protocol change)." insert:

> **Amended 2026-11-08 (agent-side revival):** the agent's WSS client is re-wired — gated behind the app-level `PRINT_AGENT_ENABLE_WSS=1` flag (default off; polling remains the delivery path until the server daemon ships per `docs/wss-server-spec.md`). No protocol change; the §1 semantics below are exactly what the wired client implements.

- [ ] **Step 2: api-contract.md §7 amendment note**

In the §7 "2026-10-30 amendment" paragraph, change "The agent is polling-first — its WSS client (ADR-15) stays in-tree, unwired;" to:

> The agent is polling-first by default — its WSS client (ADR-15) is re-wired 2026-11-08 behind the app-level `PRINT_AGENT_ENABLE_WSS=1` flag, default off;

- [ ] **Step 3: production-readiness.md A3 status**

Replace the A3 `**Status:** descoped (2026-10-30). …` paragraph (lines 54-65) with:

```markdown
- **Status:** agent side revived (2026-11-08, spec
  `docs/superpowers/specs/2026-11-08-wss-revival-design.md`) — the runtime
  constructs the §1 channel behind `PRINT_AGENT_ENABLE_WSS=1` (default off;
  polling unchanged) and passes it to the poller's existing `channel` slot.
  Evidence: `tests/agent-runtime.test.ts` ("AgentRuntime WSS channel wiring
  (A3 revival)"), `tests/runtime-wss-integration.test.ts` (full stack over a
  loopback socket), protocol legs pre-existing in `tests/cloud-ws-channel.test.ts`,
  `tests/cloud-poller.test.ts`, `tests/cloud-ws-integration.test.ts`. The
  **server side** is specified in `docs/wss-server-spec.md` for servepro-api
  (implementation happens in that repo); the flag stays off in production
  until that endpoint ships and clears the §6 WSS matrix + 24 h soak.
```

- [ ] **Step 4: Write `docs/wss-server-spec.md`**

Full content:

````markdown
# servepro-api WSS Endpoint Spec — `wss://<host>/agent/v1/ws`

Implementation spec for the server half of api-contract §1 (print-agent repo;
`docs/api-contract.md` is normative — where this doc overlaps §1/§2/§4/§6, those
win). Prepared 2026-11-08 for the A3 revival: the agent's WSS client is wired
behind `PRINT_AGENT_ENABLE_WSS=1` (default off); the flag stays off until this
endpoint ships and clears the acceptance criteria in §9.

Cross-team rule: this doc is written by the print-agent side; all
implementation happens in the servepro-api repo by its owners.

## 1. Stack choice

| Option | Verdict | Why |
| --- | --- | --- |
| **Workerman daemon** | **Recommended** | Pure-PHP long-running process, MIT, no C extension, first-class WS support; runs under systemd behind the existing nginx without touching the fpm deployment. |
| Ratchet (ReactPHP) | Viable fallback | Same shape; thinner maintenance momentum. |
| Swoole / Laravel Octane | Rejected | Runtime-wide change (C extension, new process model) to serve one socket endpoint. |
| Laravel Reverb | Rejected | Speaks the Pusher broadcast protocol; §1's token auth, custom envelopes and claim-on-send don't fit it. |

## 2. Topology

```
POS → Laravel (php-fpm, unchanged) → Redis pub/sub → agent-ws daemon (Workerman, systemd)
                                                          ↑
nginx: Location /agent/v1/ws → WS upgrade → unix socket → ┘
agent (outbound wss) ──────────────────────────────────────┘
```

- fpm workers NEVER hold sockets; they publish to Redis and read job state
  from MySQL exactly as today.
- The daemon is stateless across restarts: credentials live in MySQL
  (`agent_devices` token hashes), delivery state in MySQL (jobs table) — a
  daemon restart drops sockets only; agents redial with backoff and the
  safety poll covers the gap.
- systemd unit: `ExecStart=php artisan agent:ws:serve` (a Workerman wrapper
  command), `Restart=always`, memory cap generous (one event loop, no per-
  connection workers).

## 3. Upgrade auth (§1)

On upgrade request to `/agent/v1/ws`:

1. Read `Authorization: Bearer <token>`, `X-Device-Id`, `X-Agent-Version`,
   `X-Protocol-Version: 1`.
2. Look up the device by `X-Device-Id`; compare SHA-256(token) against the
   stored access-token hash (cache the hash → device map in-process with a
   ≤ 60 s TTL; invalidate on rotation/revocation via a Redis invalidation
   channel).
3. Mismatch / unknown device / revoked → respond **HTTP 401** to the upgrade.
   The agent treats this exactly like a 4401 (refresh → redial).
4. Rate-limit failed upgrades per IP: 3 / 15 min (mirrors §7.1 pairing limits).
5. Protocol version ≠ 1 → HTTP 400.

Mid-socket auth loss (revocation while connected): the daemon closes with
**`4401`** after the Redis invalidation message arrives. The agent refreshes
and redials; a revoked device gets 401 forever and falls back to the REST
revocation flow (§3.5).

## 4. Push delivery & claim-on-send (§7 note 6 semantics)

When a POS job (or a lease-expired reclaim) reaches `pending` for a restaurant
with a connected agent:

1. Laravel builds the §2 envelope and **signs it before transmit** —
   `sig = base64url(ed25519(server_signing_key, canonical_json(job)))` over the
   exact JSON bytes pushed on the wire (§2: the agent verifies raw wire bytes;
   never re-serialize after signing).
2. Publish to Redis channel `agent-ws:{restaurant_uid}`:
   `{ kind: "print_job", device_ids?: [...], envelope: {...} }` (device_ids
   omitted = all connected agents of the restaurant — §7 note 5, printers are
   restaurant-scoped).
3. The daemon sends the envelope frame to the connected agent(s).
4. **The send IS the claim**: on confirmed frame write, the daemon calls an
   internal Laravel endpoint `POST /internal/agent-ws/claimed`
   `{ job_ids: [...], via: "wss" }` (shared-secret or mTLS authed, never
   exposed publicly) which performs the same atomic `pending → claimed` +
   lease (300 s) + attempts++ transition as `GET /api/agent/v1/jobs`.
   - Daemon-send failure → no claim call → job stays `pending` for the normal
     poll/pull path.
   - No ack → lease expiry re-claims (poll or push); attempts ≥ 3 auto-fail
     with `max_attempts_exceeded` — identical to §7 note 6.
5. Cursor semantics: pushed jobs bypass `next_cursor`; the poll cursor only
   advances on REST pulls. A WSS-pushed job must therefore never also appear
   in a later pull — the claim transition guarantees it (claimed rows are
   filtered from `GET /jobs`).

## 5. Heartbeats & offline detection (§3.2)

- The agent sends §3.2 frames every ~30 s ± 10 % jitter, `connection: "wss"`.
- The daemon validates and applies them exactly like `POST /heartbeat`:
  update `last_seen_at`, `agent_version`, `queue_depth`, and the per-printer
  `health` rows. Implementation: enqueue to a Redis list drained by an
  fpm-side worker OR write directly to MySQL from the daemon (choose direct
  MySQL: same upsert SQL as the heartbeat controller, keeps a single writer
  path).
- Offline detection stays §7 note 7: no heartbeat (REST or WSS) for > 90 s →
  `last_seen_at` staleness → `online: false`. No per-socket session registry
  is authoritative for online state.
- Silence handling: the agent pings every ~30 s and kills the socket after
  90 s without a pong; the daemon must answer ws-level pings (RFC 6455
  default in Workerman) and may ping outbound too. No app-level `ping`
  envelope is used.

## 6. Other push envelopes

- **config_update (§4)** — same Redis channel, `kind: "config_update"`, fired
  whenever dashboard printer config changes for the restaurant. Byte-shape
  identical to `GET /api/agent/v1/config` (including `restaurant_uid` and the
  `config_version` monotonicity the agent enforces).
- **revoke (§3.5)** — `kind: "revoke"` → daemon sends the envelope, then
  closes `4401`. The agent wipes local state; subsequent redials get 401.
- **Acks: none over WSS.** Agents keep `POST /api/agent/v1/acks` (§1: "Acks
  stay on REST"). The daemon never accepts agent→server frames other than
  §3.2 heartbeats; anything else → close `1008` (policy violation).

## 7. Frame limits

- Inbound (agent → server): only heartbeats; cap frames at 32 KiB, reject
  unknown types with 1008.
- Outbound (server → agent): job/config/revoke envelopes; respect the agent's
  1 MiB inbound cap (§2 payloads are ≤ 32 KiB, so this is never binding).

## 8. Observability

- Log per connection: device id, connect/disconnect, close code, claim-call
  results — static fields only, never tokens or envelope payloads.
- Counters (prometheus or log-aggregated): upgrades accepted/rejected,
  active sockets per restaurant, claim success/failure, heartbeat age
  distribution. Alert if any connected restaurant's heartbeat age > 90 s
  while a socket is open (daemon-side liveness bug signature).

## 9. Acceptance criteria

1. **Contract matrix**: the §6 WSS rows of `docs/api-contract.md`, as Laravel
   feature tests (`tests/Feature/Agent/Wss*Test`) against a Workerman test
   harness: upgrade auth (401 paths), 4401 on revocation, job push + claim
   (pending → claimed with lease), claim-on-send failure fallback to pull,
   heartbeat ingestion (`last_seen_at`, printer health), config push,
   revoke push, acks-rejected-on-socket (1008).
2. **Soak**: a dev agent build with `PRINT_AGENT_ENABLE_WSS=1` holding a
   socket > 24 h against staging — no unbounded memory, reconnects clean
   after daemon restart, jobs delivered end-to-end during the soak.
   (This is A3's revival criterion, verbatim.)
3. **Fallback integrity**: with the daemon stopped, flagged agents keep
   printing over the REST poll path at the ~3 s cadence — push being down
   must be invisible except for latency.

## 10. Open items (owners: servepro-api team)

- Production API URL is still a placeholder on the agent side (ops §6 item 4)
  — must be resolved before any of this reaches a real restaurant.
- Internal claim endpoint auth mechanism: shared secret vs mTLS — pick at
  implementation time; both are acceptable, it must never be public.
- `config.applied` / `config.rejected` telemetry (§7 note 9) remains
  undefined — out of scope here; do not add WSS acks for it.
````

- [ ] **Step 5: Commit all docs**

```bash
git add docs/api-contract.md docs/production-readiness.md docs/wss-server-spec.md
git commit -m "docs: A3 revival — §1 agent wiring note, readiness status, servepro-api WSS endpoint spec"
```

---

### Task 6: Final verification

- [ ] **Step 1: Full suite**

Run: `pnpm test`
Expected: all suites green, including the new `runtime-wss-integration.test.ts`.

- [ ] **Step 2: No-listen smoke (AC-4)**

Run: `pnpm no-listen`
Expected: zero LISTEN sockets — the §1 channel dials outbound only; the smoke proves the wiring didn't introduce a listener.

- [ ] **Step 3: Typecheck + lint + format check**

Run: `pnpm typecheck && pnpm lint && pnpm format:check`
Expected: clean (prettier failures on pre-existing files are a known issue — only new/modified files must pass).

- [ ] **Step 4: Update production-readiness if any status changed during execution**

If Tasks 1-4 revealed deviations, update `docs/production-readiness.md` A3 accordingly in a final docs commit:

```bash
git add -A
git commit -m "docs: post-execution status corrections for A3 revival"
```

(Skip if nothing changed.)

---

## Spec coverage map

| Spec requirement | Task |
| --- | --- |
| `cloud.wss.enabled` app-level flag, default off | Task 1 (types/construction), Task 3 (main.ts) |
| `allowInsecureWs` follows `allowInsecureHttp` | Task 1 (construction spread) |
| Inline channel construction, poller owns interactions | Task 1 |
| `env.wsFactory` test seam | Task 1 (types + harness) |
| Flag off → no socket (AC-1) | Task 1 test 1 |
| Dial-after-pair, derived URL, auth headers (AC-2) | Task 1 test 2 |
| Revoke → stop, no redial (AC-2) | Task 2 |
| Full-stack push → acks → wss heartbeat (AC-2/AC-3) | Task 4 |
| 4401 refresh-redial (AC-2) | Pre-existing: cloud-poller.test.ts:856, cloud-ws-integration.test.ts (documented, not duplicated) |
| No-LISTEN untouched (AC-4) | Task 6 step 2 |
| api-contract §1 + §7 amendment notes (AC-5) | Task 5 steps 1-2 |
| production-readiness A3 status (AC-5) | Task 5 step 3 |
| `docs/wss-server-spec.md` (AC-5) | Task 5 step 4 |
