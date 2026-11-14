# servepro-api WSS Endpoint Spec — `wss://<host>/agent/v1/ws`

Implementation spec for the server half of api-contract §1 (print-agent repo;
`docs/api-contract.md` is normative — where this doc overlaps §1/§2/§4/§6, those
win). Prepared 2026-11-08 for the A3 revival: the agent's WSS client was
flag-gated (`PRINT_AGENT_ENABLE_WSS`, default off) until this endpoint shipped
and cleared §9 — since 2026-11-14 WSS is the agent's DEFAULT delivery path and
the flag is removed (api-contract §1 amendment).

> **Status 2026-11-09: IMPLEMENTED** in servepro-api (`feat/implement-one-click-print-using-agent`) —
> Workerman v5.2.3 + workerman/redis v2.1.0 daemon (`php artisan agent:ws:serve`),
> internal claim endpoint `POST /internal/agent-ws/claimed`, Redis publisher hooks,
> §6-matrix feature tests. Deployment: `docs/deploy-agent-ws.md`. **§9 acceptance
> CLEARED 2026-11-13** — §9.2 soak PASSED (recorded in §10 as-built follow-ups;
> caveat: over plain `ws://` on Docker staging — the production `wss://` topology
> still awaits a real Linux host). Amendments to §4/§5/§10 below record the
> as-built decisions (also mirrored in api-contract §7 notes 12–13).

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
   exact JSON bytes pushed on the wire (§2: the agent verifies
   `canonical_json(parsed job)` — §2 note 13 ruling — so verbatim transmission
   of the signed bytes is the safe form; never re-serialize after signing).
2. Publish to Redis channel `agent-ws:{restaurant_uid}`:
   `{ kind: "print_job", device_ids?: [...], envelope: "<pre-serialized signed
   wire bytes>" }`.
   **Amended 2026-11-09 (as-built):** (a) `envelope` carries the EXACT signed
   JSON bytes as a string — the daemon transmits it verbatim and never
   re-serializes after signing (api-contract §2 hard rule). (b) `device_ids`
   omitted → the daemon delivers `print_job` frames to ONE connected agent per
   restaurant (earliest-connected), not all of them: claim-on-send delivers
   before claiming, so broadcasting to N agents would let N−1 devices hold a
   frame their claim never won (double-print risk). `config_update` and
   `revoke` still broadcast to all connected agents (§7 note 5 unchanged).
   Carries over to the api-contract §7 note 12; agent impact: none — the agent
   protocol is unchanged, it just never sees duplicate job frames from
   same-restaurant siblings.
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
  **Amended 2026-11-09 (as-built):** "per-printer `health` rows" was
  aspirational — no printer-health table exists and the REST path
  (`POST /heartbeat`) validates `printers.*` health without persisting it.
  The socket path mirrors REST EXACTLY: `last_seen_at`, `last_ip`,
  `agent_version`, `queue_depth` are upserted; `printers.*` health is
  validated with the same rule set but not stored (api-contract §7 note 12).
  If/when printer-health persistence is wanted, it must be added to BOTH
  paths in the same change.
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
  **Resolved 2026-11-09:** shared secret — `X-Internal-Token` vs
  `AGENT_WS_INTERNAL_SECRET` (`hash_equals`, fail-closed when unset), route
  `POST /internal/agent-ws/claimed`, additionally host-blocked at nginx
  (`allow 127.0.0.1; deny all`). Payload is
  `{ job_ids, via: "wss", device_id }` — `device_id` is additive on this
  internal-only surface so `claimed_by_device_id` and printer_disabled
  attribution stay correct.
- `config.applied` / `config.rejected` telemetry (§7 note 9) remains
  undefined — out of scope here; do not add WSS acks for it.

### As-built follow-ups (servepro-api, non-blocking)

- The §9.2 soak **PASSED 2026-11-13** on Docker staging (Windows host,
  Docker Desktop; plain `ws://` via the agent's `PRINT_AGENT_ALLOW_HTTP=1`
  local-testing flag — the production `wss://` topology still needs a real
  Linux host per docs/deploy-agent-ws.md). Device
  `01a1cfb6-31f1-7017-ac44-f4ffa7bcc58c`, 2026-11-12 12:23:08 UTC →
  2026-11-13 ~12:40 UTC (> 24 h): memory plateaued twice (71.2 MiB first
  boot, ~53.6 MiB after a daemon restart; peak 21% of the 256 MiB cap);
  clean redials after two deliberate daemon restarts plus 13 hourly
  token-rotation reconnects; E2E delivery proven on both paths (WSS job
  claim-on-send confirmed 2026-11-12 18:46:26 UTC; REST-poll claims while
  the daemon was stopped — §9.3 held).
- workerman/redis daemon client consumes only `database.redis.default`
  host/port/password/database — `REDIS_URL` and Redis ACL usernames are not
  applied (see docs/deploy-agent-ws.md).
- `ClaimOnSendClient` is a synchronous ≤3 s HTTP call inside the daemon event
  loop — fine at this fleet's scale; revisit if restaurants gain many agents.
  As-built 2026-11-13: the request MUST set `CURLOPT_NOSIGNAL` — cURL
  implements connect/total timeouts via SIGALRM, which Workerman's Timer
  handler owns, so every claim-on-send aborted with ConnectionException
  until the fix (3562c63). Delivered-but-unclaimed frames re-arm the poll
  path, so this was a double-delivery window, not a cosmetic bug.
- `UpgradeGuard`'s in-process auth cache evicts only lazily/on invalidation —
  a periodic sweep would be cheap if soak shows growth.
- REST wire-encoding item (api-contract §2 note + §7 note 13): **RESOLVED
  2026-11-09** — the print-agent side ruled option (a): the agent verifies
  over `canonical_json(parsed job)`, so the REST path's framework
  re-encoding is conformant and no servepro-api change is needed.
