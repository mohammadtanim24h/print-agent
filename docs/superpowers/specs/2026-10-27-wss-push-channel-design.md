# WSS Push Channel — Design

**Date:** 2026-10-27
**Status:** Approved
**Scope:** Agent-side WebSocket delivery channel per `docs/api-contract.md` §1–§3.2.
The Laravel server (servepro-api) implements the `wss://<host>/agent/v1/ws`
endpoint in the same train.

## Goals

- Jobs, config updates, revocations and pings arrive in real time over an
  agent-initiated, outbound-only WSS connection (contract §1).
- REST polling remains as a safety net (slow cadence while the socket is
  healthy) and takes over fully when the socket is down.
- The token/revocation/backoff state machine in `poller.ts` stays intact;
  the socket is an additive channel feeding the existing envelope pipeline.

## Non-goals

- Acks over WSS. §3.1's heading says "Acks (WSS, also batchable via REST)"
  but no WSS ack-ack format is defined anywhere, and the per-ack result
  semantics (`applied|duplicate|stale|not_found|rejected`, §7.1) exist only
  on REST. Acks stay REST-only in v1 — documented deviation.
- A disable flag for WSS. A missing/broken endpoint degrades into polling,
  which is the correct behavior; a toggle would be dead weight.

## Architecture

### New module: `src/main/cloud-client/ws-channel.ts`

`createWssChannel(deps)` factory (constructor-injected deps, no singletons):

- **Dial**: `wss://` URL derived from the existing `baseUrl`
  (https→wss, path `/agent/v1/ws`). The upgrade request carries
  `Authorization: Bearer <device_token>`, `X-Device-Id`, `X-Agent-Version`,
  `X-Protocol-Version: 1` (§1), read via a `getAuth()` callback at dial time
  so a redial always uses the live token. TLS verification stays at platform
  defaults; `ws://` is refused in production (test-only escape hatch, same
  posture as `http-transport.allowInsecureHttp`).
- **Client**: the `ws` npm package — exact-pinned, MIT, pure JS, no
  postinstall scripts (dependency admission rules). Node's native WebSocket
  cannot set upgrade-request headers.
- **Reconnect**: exponential backoff + half-jitter (reuses `backoff.ts`
  policy), cap 60 s. The safety poll covers long outages, so recovery bias
  beats a large cap.
- **Heartbeat**: §3.2 JSON every 30 s ± 10 % jitter while connected, with
  `connection: "wss"` and queue/printer facts injected as a sample provider.
  Doubles as the keepalive. A failed send (socket not open) → terminate and
  reconnect.
- **Dead-connection watchdog**: no inbound frame or pong for 90 s →
  terminate and reconnect (matches the server's 90 s offline window).
- **Frame limits**: inbound frames larger than 1 MiB are dropped and logged
  (largest legitimate frame: config snapshot with 50 printers or a job
  envelope batch). Frames are `JSON.parse`d and handed to the consumer raw —
  validation stays in `parseServerMessage` (zod strict, single funnel).
- **Close handling**: any close → backoff-redial. Close code `4401`
  (additive contract constant: auth failure) → emit `auth-failed` so the
  consumer refreshes credentials before the next dial.
- **Events**: `message(raw: unknown)`, `state('connecting'|'connected'|
  'disconnected')`, `auth-failed`. Logs carry close codes and static
  messages only — never headers or payloads.
- **Lifecycle**: `start()` / `stop()` / `notifyAuthChanged()` (immediate
  redial after a token rotation). All idempotent.

### Poller integration (`poller.ts`)

The polling client owns identity, tokens and envelope handling; the channel
is an optional injected dependency (interface `WssChannelLike` in
`types.ts`):

- Channel `message` → the existing `handleServerMessage(raw)`. WSS and
  poll-batch envelopes share one path: scope check → signature verify →
  engine. Malformed-but-nameable print jobs get the same REST `rejected`
  ack as poll-batch ones.
- **Cadence**: channel connected → safety poll every 5 min; channel down →
  the existing 30 s cadence. The immediate first cycle after start/reconnect
  is unchanged.
- **Heartbeats**: channel connected → WSS heartbeat only; channel down →
  REST heartbeat inside the cycle (`connection: "poll"`). Never both.
- **Auth**: on channel `auth-failed` → run a poll cycle (the existing 401
  path performs the single-flight refresh); a successful `refreshTokens()`
  calls `channel.notifyAuthChanged()` → immediate redial with the rotated
  token.
- **Connection state**: channel connect → `online` immediately; channel
  disconnect → immediate poll cycle whose outcome sets `online`/`offline`.
  Revocation, pairing and `stop()` also stop the channel. A `revoke`
  envelope delivered over the socket takes the existing wipe path unchanged.
- `pollNow()` semantics unchanged (network-online seam).

### Composition (`agent-runtime.ts`)

- The runtime constructs the channel from `deps.cloud.baseUrl` and passes it
  into `createPollingCloudClient`.
- New `env.channelOverride` test seam, alongside `transportsOverride`.
- `CONNECTION_DETAILS.online` wording reflects push delivery.
- `heartbeatSample()` keeps `connection: 'poll'` — the channel overrides to
  `'wss'` on its own sends.

## Data flow

```
Laravel WSS ──frame──▶ ws-channel (size cap, JSON parse, raw hand-off)
                          │
                          ▼
             poller.handleServerMessage (zod strict, scope, sig, revoke)
                          │
                          ▼
                 job / config / revoked events ──▶ job engine (unchanged)

Engine acks ──▶ ack-buffer ──▶ POST /acks (REST, unchanged)
```

## Security

- Outbound-only; the agent never listens (the no-listen smoke is
  unaffected; loopback `ws` servers exist only in tests).
- Token travels in the upgrade `Authorization` header per §1 and is never
  logged; the channel logs close codes and static messages only.
- Untrusted frames are size-capped, JSON-parsed defensively, and validated
  by the existing strict zod pipeline before any consumer sees them.
- TLS verification is never disabled; plaintext `ws://` is refused in
  production builds.

## Documentation (same change)

- `api-contract.md` §1: WSS is implemented; acks stay REST-only in v1
  (documented deviation from §3.1's heading); additive close-code note
  (`4401` = auth failure); server-side note that WSS push claims jobs
  (delivered-on-send) and acks still drive finals.
- New ADR: WSS primary + slow-poll safety net; acks stay REST; `ws`
  dependency admission rationale.

## Server-side alignment items (out of agent scope, must be written down)

1. The server uses close code `4401` for auth failures on the socket.
2. WSS push claim semantics: delivered-on-send, mirroring the pull-claim
   lease behavior; acks remain the only path to terminal states.

## Testing (PRD AC-7)

- **Channel unit tests** against an in-process `ws` server (loopback
  listener in tests only): upgrade headers present; envelope → `message`
  event; malformed and oversized frames dropped; heartbeat cadence with
  ± jitter and `connection: "wss"`; watchdog fires on silence; backoff on
  repeated dial failures; `4401` close → `auth-failed` → redial after
  `notifyAuthChanged()`.
- **Poller tests**: cadence switching (5 min vs 30 s); state transitions on
  channel connect/disconnect; token-rotation redial; heartbeat mode switch
  (WSS-only vs REST-in-cycle); a job delivered over both WSS and poll batch
  is deduplicated by the engine's idempotency handling.
- **Contract tests**: bad token → close `4401`; revoke / config_update /
  print_job envelopes over the socket behave identically to the poll batch
  path; §6 matrix additions recorded in `api-contract.md`.
- Crash/ambiguity coverage for the engine is untouched (no engine changes).

## Risks

- Server endpoint timing: until the Laravel side ships, the channel backs
  off into polling — no functional regression, only latency.
- Proxy/network middleboxes that break long-lived sockets: the watchdog and
  safety poll keep delivery correct; worst case is the pre-WSS status quo.
