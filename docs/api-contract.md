# API Contract — Laravel ⇄ Print Agent

**Version:** v1 · **Status:** Draft for implementation
All messages are JSON over TLS. Every message at every boundary is schema-validated
(zod on the agent; Laravel Form Requests / DTOs server-side). Unknown fields are
rejected, not ignored, within `data` payloads (envelope may gain additive fields).

## 1. Conventions

- Base URL: `https://<saas-host>/api/agent/v1` (versioned path; v1 frozen once shipped).
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
- Auth: `Authorization: Bearer <device_token>` (pairing-issued, rotated; short TTL
  access token + rotating refresh token). WSS passes the token in the `Authorization`
  header on the upgrade request.
- IDs: UUIDv7 strings. Timestamps: RFC 3339 UTC.
- All requests include `X-Agent-Version`, `X-Device-Id`, `X-Protocol-Version: 1`.
- Errors: RFC 7807-style `{ "error": { "code", "message", "details?" } }`.
- **Ordering rule:** the server may not finalize a job as terminal (`completed`/
  `failed`) without an agent ack, except after an operator override.

## 2. Job envelope (server → agent)

```jsonc
{
  "envelope_version": 1,
  "type": "print_job", // | "config_update" | "revoke" | "ping"
  "job": {
    "job_id": "018f3c2e-...", // uuidv7
    "idempotency_key": "ord_8842-receipt-1",
    "tenant_id": "018f...",
    "restaurant_id": "018f...",
    "printer_id": "018f...", // restaurant-scoped — NOT per-agent (§7 note 5)
    "priority": 5, // 1 (highest) .. 9; kitchen tickets typically 1-2
    "copies": 1, // 1..4
    "doc_type": "customer_receipt", // | "kitchen_ticket" | "bar_ticket" | "station_ticket"
    "doc_version": 1,
    "issued_at": "2026-10-22T10:00:00Z",
    "expires_at": "2026-10-22T10:10:00Z",
    "payload": {/* doc model v1, §2 — structured, never raw ESC/POS bytes */},
  },
  "sig": "base64url(ed25519(server-signing-key, canonical_json(job)))",
}
```

- `sig`: server-signs job payloads; the agent verifies against a pinned server public
  key fetched at pairing. Protects against a compromised/rogue backend instance
  injecting jobs and is a mitigation for replay of stolen envelopes (threat T2/T4).
  **Canonical form (normative for v1):** `canonical_json(job)` = JSON serialized with
  object keys sorted recursively by UTF-16 code unit, no whitespace, UTF-8 bytes;
  numbers as `JSON.stringify` emits them (v1 amounts are safe integers, so no float
  formatting ambiguity). The agent verifies the signature over the **raw wire bytes**
  of `job` — the server must sign the exact JSON it transmits, before any
  server-side re-serialization with injected defaults.
- `idempotency_key` uniqueness scope: `(restaurant_id, idempotency_key)`.

### Document model v1 (common fields)

```jsonc
{
  "header": { "restaurant_name": "string<=64", "address_lines": ["string<=48"],
              "tax_id": "string<=32?", "logo_asset_id": "uuid?" },
  "meta":   { "title": "KITCHEN" | "RECEIPT" | "string<=24",
              "order_ref": "string<=24", "created_at": "rfc3339",
              "server_name": "string<=32?", "table": "string<=16?" },
  "lines": [ { "text": "string<=96", "qty": "number?", "unit_price": "integer-minor-units?",
               "note": "string<=64?", "emphasis": "none|bold|double_height|double",
               "align": "left|center|right" } ],
  "totals": [ { "label": "string<=24", "amount_minor": "integer",
                "emphasis": "none|bold" } ],
  "payments": [ { "method": "string<=16", "amount_minor": "integer",
                  "change_minor": "integer?" } ],
  "footer": { "text_lines": ["string<=48"], "qr_data": "string<=512?",
              "barcode_data": "string<=48?" },
  "station_hints": { "copies": "1..4", "cut": "full|partial|none" }
}
```

Hard limits (bytes, UTF-8): `lines` ≤ 200, total payload ≤ 32 KiB. Amounts are integer
minor units (cents) — no floats. Text fields are printable text only; the renderer
strips/escapes any bytes in `0x00–0x1F` and `0x7F` before ESC/POS encoding (T2).

Additional limits the agent enforces (server must validate identically):
`header.address_lines` ≤ 6 entries, `footer.text_lines` ≤ 8 entries, `qty` ≥ 0,
and all numeric fields (`qty`, `unit_price`, `amount_minor`, `change_minor`) within
the safe-integer range (≤ 2^53−1). Payloads exceeding these are rejected with
`rejected{code:"invalid_doc"}`.

## 3. Agent → server messages

### 3.1 Acks (WSS, also batchable via REST)

```jsonc
{ "envelope_version": 1, "type": "ack",
  "acks": [ {
    "job_id": "018f...",
    "status": "accepted" | "rejected" | "rendered" | "sent_to_printer"
            | "completed" | "failed" | "ambiguous",
    "printer_status": "ok|unknown|offline|paper_out|paper_low|cover_open", // best-effort
    "printed": false,          // ALWAYS false in v1 — see semantics table below
    "error": { "code": "transport_timeout", "message": "...?" },  // required when failed/rejected
    "attempt": 1,
    "at": "2026-10-22T10:00:01.250Z"
  } ] }
```

**Semantic contract (normative):**

| Ack status        | Server UI wording              | Meaning                                                    |
| ----------------- | ------------------------------ | ---------------------------------------------------------- |
| `accepted`        | "Queued on device"             | Stored durably on the agent                                |
| `rejected`        | "Rejected by device"           | Failed validation/expiry/scope; never prints               |
| `sent_to_printer` | "Sent to printer"              | Bytes handed to transport — **no print guarantee**         |
| `completed`       | "Sent to printer" (✓ hand-off) | Driver/OS accepted the job. **Not "printed"**              |
| `failed`          | "Failed"                       | Terminal after bounded retries; manual reprint available   |
| `ambiguous`       | "Outcome unknown — verify"     | Crash/timeout window; operator resolves or policy reprints |

The contract deliberately has **no `printed: true`** in v1. If physical-print
confirmation is later added (printer-dependent DLE EOT / ASB), it arrives as an
additive `printer_status` refinement and a new `doc_version`/protocol minor — never by
overloading `completed`.

### 3.2 Heartbeat (WSS, every 30 s ± jitter)

```jsonc
{
  "type": "heartbeat",
  "agent_version": "1.4.2",
  "uptime_s": 8452,
  "queue_depth": 2,
  "connection": "wss", // | "poll" — additive value for polling-mode agents (see §3.3)
  "printers": [{ "printer_id": "018f...", "health": "ok", "last_print_at": "...?" }],
}
```

Missed heartbeats (≥ 3) mark the agent `offline` server-side.
**§7 note 7 supersedes the miss counter:** offline = no heartbeat for > 90 s
(`last_seen_at` staleness).

### 3.3 REST endpoints (fallback + control plane)

| Method | Path                             | Purpose                                                              |
| ------ | -------------------------------- | -------------------------------------------------------------------- |
| `POST` | `/pair`                          | Exchange pairing code (once, pre-token)                              |
| `POST` | `/token/refresh`                 | Rotate device token                                                  |
| `GET`  | `/jobs?since=<cursor>&limit=100` | Fallback long-poll/pull of pending jobs                              |
| `POST` | `/acks`                          | Batch acks (idempotent, keyed by `job_id`+`attempt`)                 |
| `POST` | `/heartbeat`                     | Polling-mode heartbeat (additive — see below)                        |
| `GET`  | `/config`                        | Printer/station config snapshot + `config_version`                   |
| `POST` | `/diagnostics`                   | Upload redacted log bundle (support-initiated, agent-user-confirmed). **Deferred — not implemented in v1** (§7 note 4) |
| `GET`  | `/server-keys`                   | Current server signing public key(s), pinned at pairing              |

**Additive v1 clarifications (documented + tested with the agent's cloud-client,
2026-10-24):**

- `POST /pair` request: `{ pairing_code, device_pubkey(ed25519 raw, base64url),
  device_name, agent_version }`. Response: §3.4 payload.
- `POST /token/refresh` request: `{ refresh_token }` (no `Authorization` header — the
  refresh token travels only in the body). Response:
  `{ device_token, refresh_token, token_ttl_s }` (rotated pair).
- `GET /jobs` response: `{ "jobs": [ <envelope, §2/§4/§3.5>, ... ],
  "next_cursor"?: string≤128 }` — `jobs` ≤ 100 items; envelopes may be any
  server → agent type (`print_job` | `config_update` | `revoke` | `ping`), so
  polling-only agents receive control messages without WSS. Server marks the
  batch delivered; agent acks (idempotent by `job_id`+`attempt`) drive final states.
- `POST /acks` request body: the §3.1 ack batch envelope
  (`{ envelope_version, type: "ack", acks: [...] }`, ≤ 100 acks). Response:
  **200 with a per-ack results array** (§7.1 deviation — not the bare `204`):
  `{ "results": [{ "job_id", "result": "applied|duplicate|stale|not_found|rejected" }] }`.
- `POST /heartbeat` — **additive endpoint for polling-mode agents** (no WSS
  connection to carry §3.2 heartbeats): request body is the §3.2 heartbeat with
  `"connection": "poll"`. Response: `204`. Not sent by WSS-connected agents;
  WSS agents keep §3.2 semantics unchanged.
- `GET /config` response: the §4 config-update body
  (`{ config_version, printers: [...] }`, with optional `envelope_version`).
- `GET /server-keys` response:
  `{ "keys": [{ "kid": string≤64, "public_key": ed25519-raw-base64url, "active": bool }], }`
  ≤ 5 keys; the agent pins the `active` key returned at pairing and refreshes it
  from this endpoint on key rotation.

### 3.4 Pairing flow

```
Web app:  manager clicks "Add agent" → server issues pairing_code (8 chars, TTL 10 min, single use)
Agent:    user enters code in local wizard
Agent:    POST /pair { pairing_code, device_pubkey(ed25519), device_name, agent_version }
Server:   verifies code unused+unexpired → creates agent row (tenant, restaurant)
          → returns { device_id, device_token, refresh_token, server_signing_pubkey,
                      restaurant_id, tenant_id, token_ttl_s }
Agent:    stores identity (DPAPI-protected), starts polling (§7: REST-only), first heartbeat confirms pairing
```

Pairing codes are single-use and short-lived; three failed attempts rate-limits the
endpoint per IP (T3).

### 3.5 Revocation

Server pushes `{ "type": "revoke", "reason": "manager_initiated" }` on the WSS and
refuses token refresh. **§7 supersedes the WSS transport:** v1 delivers the revoke
envelope inside `GET /jobs` batches (and refuses refresh with
`{error:{code:"device_revoked"}}`). Agent behavior: stop accepting jobs → send final heartbeat →
wipe `identity` + `jobs` + cached `printers` → exit to a "Device revoked, contact
support" screen. If the agent never reconnects, token TTL expiry (≤ 24 h) neutralizes
stolen tokens; revocation is also enforced server-side on every REST call.

## 4. Config update (server → agent)

```jsonc
{ "type": "config_update", "config_version": 41,
  "printers": [ {
    "printer_id": "018f...", "name": "Kitchen-1",
    "transport": { "kind": "tcp_raw", "host": "192.168.1.87", "port": 9100,
                   "connect_timeout_ms": 3000, "write_timeout_ms": 5000 },
                 // | { "kind": "spooler_raw", "windows_printer_name": "EPSON TM-T88" }
                 // | { "kind": "usb", "vid": "04b8", "pid": "0202" }
    "station": "kitchen" | "bar" | "cashier" | "string<=24",
    "copies_default": 1,
    "codepage": "cp437" | "cp850" | "utf8_double_byte" | "string",
    "cut_default": "partial",
    "duplicate_policy": "ask_operator" | "auto_reprint" | "never",
    "status_polling": "auto" | "off"
  } ] }
```

Agent applies atomically on `config_version` increase; acks `config.applied` or
`config.rejected{error}`. Offline agents apply on reconnect.

## 5. Versioning & compatibility rules

1. `envelope_version` major = breaking; agent refuses unknown majors with a structured
   error (server can then hold or route to upgrade).
2. Additive optional fields in v1 = non-breaking; unknown fields inside `payload` are
   **rejected** (strict), unknown fields at envelope top level are ignored (forward-safe).
3. `doc_version` is per-document-type; agents accept the versions they ship with and
   report `rejected{code:"unsupported_doc_version"}` otherwise.
4. Agent versions advertise via `X-Agent-Version`; server may gate new payload features
   by version floor.

## 6. Validation test matrix (contract tests, no hardware)

- Envelope: valid / unknown envelope_version / missing fields / oversized payload /
  control characters in text / bad `sig` / expired job / wrong tenant job / duplicate
  idempotency key / unknown printer_id.
- Ack: all statuses / batch idempotency (same ack twice = same result server-side).
- Pairing: expired code / reused code / rate limit.
- Config: version regression ignored / invalid transport address rejected.
- WSS: upgrade with a valid token / with a bad token (4401 or 401 upgrade rejection) /
  job delivered over WSS == job delivered over the poll batch (idempotent by
  `job_id`+`attempt`) / revoke + config_update over WSS / oversized frame dropped /
  90 s silence → agent reconnects.

## 7. Server implementation notes & deviations (servepro-api, 2026-10-24)

Implemented surface: §3.3 REST only (polling-mode agents). WSS push is NOT
implemented in v1 — §3.2 heartbeats arrive via `POST /heartbeat` with
`connection: "poll"`. Everything below is covered by
`tests/Feature/Agent` + `tests/Feature/Printing` (executable contract examples:
`ContractExamplesTest`).

**2026-10-27 amendment:** WSS push (§1) is now implemented on both sides. The REST
surface below remains the fallback + control plane; `connection: "wss"` heartbeats
replace `POST /heartbeat` while the socket is healthy.

1. **Restaurant identity** — deployments are single-restaurant. A stable
   `restaurant_uid` (UUIDv7, server-minted on the singleton `restaurant_settings`
   row) is the `restaurant_id` in every envelope; `tenant_id` is set to the same
   value. All scoping is enforced server-side from the device row — request
   fields can never widen it (proven by `AgentTenantIsolationTest`).
2. **Server job status vocabulary**: `pending, claimed, sent_to_printer,
   completed, failed, outcome_unknown`. Ack mapping: `accepted`/`rendered` →
   stays `claimed`; `sent_to_printer` → `sent_to_printer`; `completed` →
   `completed` (driver hand-off); `failed`/`rejected` → `failed`; `ambiguous`
   → `outcome_unknown`. There is NO `printed` state or column; `printed:true`
   in an ack is rejected 422. Jobs are `pending` when the create-API responds —
   acceptance is never delivery, and nothing is terminal without an agent ack
   (exception: dashboard retry/operator override).
3. **Error envelope** — agent surface (`/api/agent/v1/*`) uses this contract's
   `{ "error": { "code", "message" } }`; POS endpoints (`/api/print-jobs`,
   `/api/printers`, `/api/agent-devices`, `/api/agent-pairing-codes`) keep the
   platform envelope `{ status, success, message, data }`. Both are normative.
4. **`/diagnostics` deferred** — no support tooling exists yet; the endpoint is
   not implemented in v1 (additive later).
5. **Printers are restaurant-scoped, not per-agent** — any active agent of a
   restaurant may claim all of its jobs; the printers schema keeps a nullable
   `agent_device_id` for future binding.
6. **Claim semantics (§3.3 GET /jobs)** — the pull IS the claim: atomic
   transition `pending → claimed` with a lease (`lease_ttl` 300 s), attempt
   counter, and per-batch locking; expired leases are re-claimable; attempts
   ≥ 3 auto-fail with `max_attempts_exceeded`; a job whose printer was disabled
   fails at claim time with `printer_disabled` instead of being delivered.
7. **Offline detection** — `last_seen_at` staleness (> 90 s) replaces the
   3-missed-heartbeat counter (no WSS). Surface: `GET /api/agent-devices`
   `online: bool`.
8. **Refresh rotation hardening** — replaying an already-rotated refresh token
   REVOKES the device (stolen-token containment; the previous rotation's hash
   is retained solely for detection). Revoked devices get
   `{error:{code:"device_revoked"}}` on refresh and 401 on every call.

### 7.1 Credential & endpoint summary (agent implementers)

- Pairing codes: issued by a dashboard admin (`POST /api/agent-pairing-codes`),
  8 chars, TTL 10 min, single use; server stores only the SHA-256 hash.
- Device tokens: 64-char random hex; server stores SHA-256 hashes only. Access
  TTL 3600 s; refresh TTL 14 d, single-use rotated pair (§7 note 8).
- Required headers on authenticated calls: `Authorization: Bearer`,
  `X-Device-Id` (must match the token's device), `X-Agent-Version`,
  `X-Protocol-Version: 1`.
- Rate limits: `POST /pair` and `POST /token/refresh` — 3 attempts / 15 min per
  IP (429 otherwise); agent surface — 120 req/min per device.
- `POST /acks` responses 200 with per-ack results
  (`applied | duplicate | stale | not_found | rejected`), not the §3.3 bare
  `204` — the results array lets the agent distinguish poisoning from replays
  without re-fetching (documented deviation).
- Retention: terminal jobs + events pruned after 30 days
  (`php artisan printing:prune`).

### 7.2 Wire examples

`GET /api/agent/v1/jobs` → 200:

```jsonc
{
  "jobs": [{
    "envelope_version": 1,
    "type": "print_job",
    "job": {
      "job_id": "019a1c...",            // uuidv7
      "idempotency_key": "order_58_customer_receipt",
      "tenant_id": "0198fe...",         // == restaurant_id (§7 note 1)
      "restaurant_id": "0198fe...",
      "printer_id": "01990a...",
      "priority": 5, "copies": 1,
      "doc_type": "customer_receipt", "doc_version": 1,
      "issued_at": "2026-10-24T10:00:00+00:00",
      "expires_at": "2026-10-24T10:10:00+00:00",
      "payload": { /* §2 document model v1 — server-built snapshot */ }
    },
    "sig": "base64(ed25519 detached signature over canonical_json(job))"
  }],
  "next_cursor": "2026-10-24T10:00:00.000000+00:00"
}
```

`POST /api/agent/v1/acks` → 200:

```jsonc
// request: §3.1 batch envelope (printed:true → 422)
{ "results": [
  { "job_id": "019a1c...", "result": "applied" }   // applied|duplicate|stale|not_found|rejected
] }
```

`POST /api/agent/v1/heartbeat` → 204 (empty body).
`GET /api/agent/v1/config` → 200 `{ envelope_version, type: "config_update",
config_version, printers: [...] }` (§4 printer shape).
`GET /api/agent/v1/server-keys` → 200 `{ keys: [{ kid, public_key, active }] }`.

Error example (agent surface):

```jsonc
// 401 from any authenticated agent endpoint
{ "error": { "code": "invalid_token", "message": "Invalid or expired device token" } }
```
