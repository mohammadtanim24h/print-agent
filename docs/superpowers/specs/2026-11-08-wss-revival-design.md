# WSS Revival (A3) — Agent Wiring + Server Endpoint Spec

Date: 2026-11-08 · Status: approved design, pending implementation plan

Revives the agent half of the descoped A3 (server-side WSS, api-contract §1) and
produces the servepro-api implementation spec for the server half. Polling stays
the v1 delivery path and the default; WSS becomes an opt-in transport that a
deployment enables once the server endpoint exists.

## Goals

1. **Agent**: wire the existing, in-tree `ws-channel.ts` into the runtime behind
   an app-level flag, default **off**. The runtime still constructs no socket
   unless the flag is set (api-contract §1, 2026-10-30 amendment wording).
2. **Server**: a self-contained implementation spec (`docs/wss-server-spec.md`)
   the Laravel team (or the user) can implement in servepro-api without further
   design work — §1/§6/§7 note 6 are its normative inputs, the §6 WSS matrix
   rows its acceptance checklist.

## Non-goals

- No server code in this repo; no servepro-api changes by the agent (standing
  rule: the user applies backend changes).
- No config-schema/contract change: the enable flag is app-level, not pushed by
  the server (a server without the daemon cannot push its own enable flag).
- No new WSS message types — §1/§2/§4/§3.5 envelopes are frozen; acks stay on
  REST.

## Agent design

### Flag and composition

- `RuntimeDeps.cloud` gains `wss?: { enabled?: boolean }`. `main.ts` sets it
  from `process.env.PRINT_AGENT_ENABLE_WSS === '1'` (same opt-in pattern as
  `PRINT_AGENT_ALLOW_HTTP`), default off. The renderer never sees it.
- Insecure escape hatch: the channel's existing `allowInsecureWs` follows
  `allowInsecureHttp` (local backend testing only; refused outright in
  production builds by `assertWssUrl`).

### Construction (Option 1 — inline in `agent-runtime.ts`)

When `deps.cloud.wss?.enabled === true`, construct the channel and pass it to
`createPollingCloudClient` via its existing `channel` slot:

- `url`: `deriveWssUrl(deps.cloud.baseUrl)` (https→wss, http→ws for local dev).
- `getAuth`: re-reads live secrets per dial (`readIdentity()` → deviceId/token,
  null when unpaired/paired-but-unreadable → the channel idles until
  `notifyAuthChanged`).
- `heartbeatSample`: the same `heartbeatSample()` closure the poller uses — the
  channel forces `connection: "wss"`; the poller skips its piggyback heartbeat
  while the channel is connected, so exactly one heartbeat path is live at a
  time.
- `allowInsecureWs`: mirrors `deps.cloud.allowInsecureHttp`.
- Test seam: `RuntimeDeps.env` gains `wsFactory` (forwarded to
  `createWssChannel`), so wiring tests script sockets without a network.

Everything else is already implemented and tested in the poller: frames funnel
through `parseServerMessage` (scope check, sig verify, revoke, config, job),
`state` transitions drive `online/offline` + catch-up polls, the safety poll
drops to 5 min while connected, token rotation calls `notifyAuthChanged`,
revoke calls `channel.stop()`. Backoff caps at 60 s; against an
endpoint-less server the channel simply keeps backing off while polling
continues unaffected.

### Lifecycle invariants

- `start()`: the poller starts the channel after the client starts (paired) —
  no dial while unpaired; `pair()` → poller's identity set → dial happens via
  the existing post-pair flow.
- `stop()` / revoke: the poller already stops the channel (never redials with
  wiped credentials).
- **No-listen AC-4 untouched**: the channel only dials outbound; the CI
  no-LISTEN test remains green with the flag on or off.

### Agent tests

- Wiring (unit, `tests/agent-runtime.test.ts`): flag off → no channel
  constructed, `RuntimeDeps.env.wsFactory` never invoked; flag on + paired →
  factory invoked once with the derived wss URL and auth headers; unpaired →
  no dial; revoke → factory's socket terminated, no redial.
- Integration (CI, mock WSS server on localhost): flag on against a local
  `ws`-package server exercising the §1 happy path — upgrade auth headers,
  pushed job envelope → engine → ack drain to `completed`, §3.2 heartbeat with
  `connection:"wss"` received server-side, `4401` close → refresh → redial.
- Existing channel/poller suites remain the protocol-level evidence; no
  duplication of their cases.

## Docs updated in the same change

- `docs/api-contract.md` §1 amendment note: agent is polling-first **unless**
  the app-level flag is set; everything else in §1 unchanged.
- `docs/production-readiness.md` A3 status: agent side wired (evidence refs),
  server side → `docs/wss-server-spec.md`.
- `docs/wss-server-spec.md` (new; content below).

## Server spec deliverable — `docs/wss-server-spec.md` outline

Written for servepro-api (php-fpm stays request-only; the socket is a separate
long-running process):

1. **Stack choice**: comparison table — **Workerman daemon (recommended, MIT,
   pure PHP)** vs Ratchet/ReactPHP vs Swoole/Octane; rationale: no C extension,
   fits the existing systemd + nginx deployment, active maintenance.
2. **Topology**: nginx WS-upgrade route `/agent/v1/ws` → unix-socket Workerman
   process (systemd unit); php-fpm publishes to it over **Redis pub/sub** —
   fpm workers never hold sockets.
3. **Upgrade auth**: daemon validates `Authorization` + `X-Device-Id` against
   the `agent_devices` token hash (cache with short TTL): reject upgrade with
   HTTP 401; mid-socket auth loss (revocation) → close `4401`. Rate-limit
   failed upgrades per IP (3/15 min, mirroring §7.1 pairing limits).
4. **Claim-on-send**: Laravel publishes a `print_job` envelope to the
   restaurant's Redis channel; the daemon sends it; on confirmed frame write it
   calls an internal Laravel endpoint that performs the §7 note 6
   `pending → claimed` transition with lease — mirrors GET /jobs claim
   semantics exactly; no ack ⇒ lease expiry re-claims, attempts ≥ 3 auto-fail.
5. **Heartbeats**: daemon ingests §3.2 (`connection:"wss"`, ~30 s ± jitter) →
   updates `last_seen_at` + printer health rows (same as POST /heartbeat);
   > 90 s silence marks offline (§7 note 7 unchanged).
6. **Push envelopes**: §2 job, §4 config_update, §3.5 revoke — byte-identical
   shapes; signatures over `canonical_json(job)` per §2 (server signs before
   transmit, agent verifies raw wire bytes). Ping envelope unused — ws-level
   pings per RFC 6455 (agent pings every ~30 s, 90 s dead-silence kill).
7. **Acks stay REST** (§1): no WSS ack-ack; agents keep POST /acks.
8. **Acceptance**: the §6 WSS matrix rows as the Laravel feature-test matrix
   (`tests/Feature/Agent/Wss*Test` against a Workerman test harness) + a >24 h
   live socket soak from a dev agent against staging — A3's revival criteria,
   verbatim.
9. **Open items**: signature-verified distribution is unaffected; ops §6
   production URL still required before any of this reaches a real restaurant.

## Acceptance criteria

- AC-1: flag off (default) → byte-for-byte current behavior: no socket
  constructed, all existing tests green unchanged.
- AC-2: flag on → wiring tests prove dial-after-pair, frame funnel, heartbeat
  swap, 4401 refresh-redial, revoke-stop.
- AC-3: mock-server integration test passes in CI (no external services).
- AC-4: no-LISTEN CI test still green with the flag on.
- AC-5: docs (§1 note, A3 status, server spec) committed in the same change.
