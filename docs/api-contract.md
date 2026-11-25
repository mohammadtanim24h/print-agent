# API Contract — Laravel ⇄ Print Agent

**Version:** v1 · **Status:** Draft for implementation
All messages are JSON over TLS. Every message at every boundary is schema-validated
(zod on the agent; Laravel Form Requests / DTOs server-side). Unknown fields are
rejected, not ignored, within `data` payloads (envelope may gain additive fields).

## 1. Conventions

- Base URL: `https://<saas-host>/api/agent/v1` (versioned path; v1 frozen once shipped).
- WSS endpoint: `wss://<saas-host>/agent/v1/ws` — agent-initiated, persistent, outbound.
  **Amended 2026-10-30: server-side WSS is DEFERRED — REST polling is the v1 delivery
  path** (§7 amendment). A WebSocket endpoint cannot run in php-fpm request workers
  (it requires a long-running daemon + WS-upgrade proxy), and polling at the amended
  ~3 s cadence gives counter-imperceptible delivery latency at this fleet's scale
  (single-restaurant deployments, 1–3 agents). The agent ships **polling-first**:
  with the flag unset it constructs no socket and never dials `wss://`. The WSS
  client (ADR-15) was unwired through 2026-11-07; it is re-wired behind
  `PRINT_AGENT_ENABLE_WSS=1` — see the amendment below; reviving WSS =
  implementing the server endpoint per §1/§6 and re-wiring the agent's channel
  (no protocol change).

  > **Amended 2026-11-08 (agent-side revival):** the agent's WSS client is re-wired —
  > gated behind the app-level `PRINT_AGENT_ENABLE_WSS=1` flag (default off; polling
  > remains the delivery path until the server daemon ships per
  > `docs/wss-server-spec.md`). No protocol change; the §1 semantics below are exactly
  > what the wired client implements.

  > **Amended 2026-11-09 (server-side revival):** the server WSS endpoint is
  > IMPLEMENTED in servepro-api — a Workerman daemon (`php artisan agent:ws:serve`,
  > systemd) behind an nginx WS-upgrade route; see `docs/wss-server-spec.md` for the
  > implementation spec and `docs/deploy-agent-ws.md` for deployment. No protocol
  > change. Server-implementation decisions that refine §1/§4/§7 (push targeting,
  > heartbeat parity, claim-on-send) are recorded in §7 notes 12–13 and in
  > wss-server-spec §4–§5. REST polling remains the fallback + control plane, and
  > agents keep working unchanged with the daemon stopped (§9.3 fallback integrity).
  > The §6 WSS matrix rows are now enforced server-side by feature tests
  > (`tests/Feature/Agent/Wss*Test`, `tests/Feature/Internal/InternalClaimTest`).

  > **Amended 2026-11-14 (WSS is the default delivery path):** the
  > `PRINT_AGENT_ENABLE_WSS` opt-in flag is REMOVED. Every agent constructs the
  > §1 channel unconditionally and dials `wss://` once paired; REST polling
  > remains the fallback + control plane (§9.3) and needs no env var either.
  > Gate history: the endpoint shipped 2026-11-09 and cleared §9 acceptance —
  > §6 matrix feature-tested server-side, 24 h soak PASSED 2026-11-13 (over
  > plain `ws://` on Docker staging; the production `wss://` topology on a
  > real Linux host remains a release step, not an agent gate). An unpaired
  > agent never dials; `wss.enabled: false` survives in the runtime deps as a
  > test-only opt-out.

  The §6 WSS matrix rows remain
  the acceptance checklist for that future work. Contract details below are retained
  normative for that eventuality. The agent connects after pairing, sends §3.2
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
  "attempt": 1, // additive 2026-11-13, epoch semantics 2026-11-14 (§5.2): server
                // delivery-attempt EPOCH, ≥ 1 — stable across lease re-claims and
                // bumped ONLY by operator retry of the job (§7 note 14). The agent
                // ECHOES this value in its §3.1 acks so `job_id`+`attempt`
                // idempotency is well-defined, and re-executes a known job only
                // when a re-delivered epoch is strictly greater. Never inside `job`
                // (would change the signed canonical bytes — §2 hard rule).
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
  formatting ambiguity). The agent verifies the signature over `canonical_json` of
  the **parsed `job` VALUE as received on the wire** (pre-schema, so zod defaults
  never leak into the verified form) — see the resolved note below for why this is
  transport-indifferent rather than a strict byte comparison.

  **RESOLVED 2026-11-09 (agent ruling on the 2026-11-09 OPEN ITEM — §7 note 13):**
  the agent implements **option (a): verification canonicalizes the parsed `job`
  before checking `sig`**. Rationale: `canonical_json` is normatively defined
  (key-sorted, no whitespace, `JSON.stringify` escaping), so re-serializing the
  parsed value reproduces the signed bytes exactly — `\/` / `\uXXXX` REST
  re-encoding normalizes away on `JSON.parse`, and the WSS path's verbatim
  canonical bytes round-trip identically. No server change is required; the REST
  path's framework re-encoding is contract-conformant. The server requirements
  that remain binding: (1) sign `canonical_json(job)` before transmission; (2)
  transmit the same VALUE on every path — no serializer may inject, drop, or
  default any field inside `job` (field-set changes still fail verification).
  Agent regression test: `tests/cloud-schemas.test.ts` (REST-re-encoded wire
  bytes case).
- `idempotency_key` uniqueness scope: `(restaurant_id, idempotency_key)`.
- `expires_at` is the QUEUE RETENTION BOUND (additive clarification
  2026-11-22, §7 note 17): a pending job not claimed before it expires is
  swept to `failed` with cause `job_expired` by the every-minute sweeper
  (`php artisan printing:expire-stale-jobs`; default TTL 600 s via
  `PRINT_JOB_TTL`). "Queued until the agent comes online" therefore means
  AT MOST the TTL window — an agent offline longer than that finds the
  job expired, and recovery is the operator retry endpoint
  (`POST /api/print-jobs/retry/{id}`), which grants a fresh window.
  The sweep only ever moves pending → failed; nothing reports "printed".

### Document model v1 (common fields)

```jsonc
{
  "header": { "restaurant_name": "string<=64", "address_lines": ["string<=48"],
              "phone": "string<=24?", "tax_id": "string<=32?", "logo_asset_id": "uuid?" },
  "meta":   { "title": "KITCHEN" | "RECEIPT" | "string<=24",
              "order_ref": "string<=24", "created_at": "rfc3339",
              "order_time": "string<=64 (server-formatted, REQUIRED)",
              "server_name": "string<=32?", "table": "string<=16?" },
  "lines": [ { "text": "string<=96", "qty": "number?", "unit_price": "integer-minor-units?",
               "note": "string<=64?", "emphasis": "none|bold|double_height|double|reverse",
               "align": "left|center|right" } ],
  "totals": [ { "label": "string<=64", "amount_minor": "integer",
                "currency": "string<=8? (ISO 4217 code, e.g. \"BDT\")",
                "emphasis": "none|bold" } ],
  "payments": [ { "method": "string<=16", "amount_minor": "integer",
                  "change_minor": "integer?" } ],
  "footer": { "text_lines": ["string<=96"], "qr_data": "string<=512?",
              "barcode_data": "string<=48?" },
  "station_hints": { "copies": "1..4", "cut": "full|partial|none" }
}
```

Hard limits (bytes, UTF-8): `lines` ≤ 200, total payload ≤ 32 KiB. Amounts are integer
minor units (cents) — no floats. ALL string caps in this schema are UTF-8 BYTES, not
characters (the agent schemas measure `Buffer.byteLength`), and the server clamps
byte-safely — never splitting a multi-byte sequence, never trailing a dangling
combining mark (quick 261125-rxb). Pre-cap-raise agents reject oversized localized
strings with `rejected{code:"invalid_doc"}` — measured localized content against the
old caps: bn/ja/ar-SA `order_time` up to 45 B vs 32, bn totals labels up to 54 B vs
24, bn delta chrome 82 B and footer lines 89 B vs 48 — so at an un-upgraded device
EVERY print fails at a bn/ja/ar-SA deployment (T-RXB-02), which is why the cap raise
carries the single combined agent-release DEPLOY-ORDER below. Text fields are
printable text only; the renderer strips/escapes any bytes in `0x00–0x1F` and `0x7F`
before ESC/POS encoding (T2).

Additional limits the agent enforces (server must validate identically):
`header.address_lines` ≤ 6 entries, `footer.text_lines` ≤ 8 entries, `qty` ≥ 0,
and all numeric fields (`qty`, `unit_price`, `amount_minor`, `change_minor`) within
the safe-integer range (≤ 2^53−1). Payloads exceeding these are rejected with
`rejected{code:"invalid_doc"}`.

Line `emphasis` semantics (agent rendering, additive 2026-11-22): `reverse`
prints the line as a white-on-black bar (GS B 1) combined with bold (ESC E 1)
— pure reverse prints faint on many thermal heads — at normal size, and is
the kitchen-delta void treatment: servers MUST put the verb in the line text
(e.g. `"VOID 1x Grilled Chicken"`), not in a note. Every other emphasis value
clears reverse (GS B 0); styles never leak across lines. Older agents reject
`reverse` payloads with `rejected{code:"invalid_doc"}` (strict schema) —
deploy updated agents before the server emits it.

Header `phone` (additive 2026-11-25, DEPLOY-ORDER): the header gained
optional `phone` (≤ 24 UTF-8 bytes, key omitted when absent). Customer
receipts render it centered as `Tel: <phone>` between the address lines and
the tax id; other stations accept and ignore it. Older agents reject `phone`
payloads with `rejected{code:"invalid_doc"}` (strict schema) — deploy
updated agents to every paired device BEFORE restaurants enable phone in
their ServePro settings.

Receipt totals labels (tax milestone): exclusive snapshots print
`Subtotal` → `VAT x%` → bold `Total` (Total = subtotal + tax, what the
customer paid); inclusive snapshots print bold `Total` → `VAT x% included`
(informational); zero tax prints a single bold `Total`. The renderer
iterates the labels verbatim (≤ 64 bytes, emphasis `none|bold`) with no
label allowlist — free strings, never a whitelist.

CURRENCY (quick 261125-myz; required/no-fallback amendment in quick
261125-nk4): receipt totals entries carry the per-deployment ISO 4217
code as the optional `currency` key (string<=8) on the wire; the agent
renders it as a suffix beside each total ("250.00 BDT") — never a
symbol (thermal-printer font safety). CURRENCY_CODE is a REQUIRED
deployment env variable with NO fallback value: a deployment that boots
with it unset or blank fails at boot with an error naming the variable
(HTTP, artisan, queue workers, and the agent WSS daemon all refuse to
start), so receipts can never print without currency. It must mirror
the web deployment's `VITE_CURRENCY_CODE` on the same host. Totals
only: line items and payments never carry the key. The blank-value
key-omit on the wire (contract rule: explicit nulls never hit the
wire) survives only as a builder-level safety, never reachable in a
booted app.

Localized-string cap raise (additive 2026-11-25): three byte caps were
RAISED to fit localized (RECEIPT_LOCALE en/bn/ja/ar-SA) server strings —
`meta.order_time` 32 → **64** bytes, totals `label` 24 → **64** bytes,
`footer.text_lines` entries 48 → **96** bytes. All other caps are unchanged.

DEPLOY-ORDER — single combined agent-release gate (quick 261125-rxb,
merging the currency gate with the raised byte caps and the
already-pending agent items): ONE print-agent release must carry ALL of
the following and reach every paired device BEFORE any server build
emitting the raised-cap strings or the `currency` key ships:
  (a) the raised byte caps mirrored in doc.ts `bytes()` — `order_time`
      64, totals `label` 64, `footer.text_lines` 96 (every other cap
      already matches the schema above);
  (b) the totals `currency` key + suffix render (quick 261125-myz);
  (c) the already-pending agent items this gate absorbs and supersedes
      (referenced, not re-opened): the `header.phone` render and the
      emphasis 'reverse' enum value.
Pre-raise agents reject the new content with
`rejected{code:"invalid_doc"}` — oversized localized strings (hard
limits above), the unknown totals `currency` key (strict schema), and
strict-enum/strict-schema rejections for 'reverse' and `phone`.

> **DEPLOY-ORDER (operative gate):** that release is agent v0.1.3. No
> servepro-api build that emits `currency`, localized labels/times/footers,
> or any over-the-old-cap string may deploy to a restaurant with paired
> devices until it is installed on EVERY paired device at that restaurant.
> The strict agent schema rejects unknown keys and over-cap strings with
> `rejected{code:"invalid_doc"}` — a newer server against older agents
> rejects ALL prints at that deployment.

RECEIPT FOOTER (quick 261125-myz): full customer receipts carry 1-2
customer footer lines in `footer.text_lines` (env
`RECEIPT_FOOTER_LINE1` / `RECEIPT_FOOTER_LINE2`, defaults follow the
deployment's RECEIPT LOCALE below — explicit env overrides always win
verbatim, blank values omitted, each control-byte-stripped and clamped
to string<=96 UTF-8 BYTES, raised in quick 261125-rxb); existing agents
render these verbatim — no NEW agent feature, but the raised cap rides
the single combined agent-release DEPLOY-ORDER (CURRENCY + CAPS note
above: pre-cap-raise agents reject lines over the old 48). Kitchen/bar/
station tickets keep their empty footer shell and delta tickets keep
their delta footer chrome.

RECEIPT LOCALE (quick 261125-pol): receipt/ticket label strings (totals
labels), `meta.order_time`, the delta footer chrome + printed-at stamp,
and the receipt footer defaults are deployment-LOCALIZED payload
content, driven by the REQUIRED per-deployment env `RECEIPT_LOCALE` —
accepted values exactly `en`, `bn`, `ja`, `ar-SA` (the web's accepted
set), mirroring the web deployment's `VITE_LOCALE` so screens and
printed receipts share one language. Boot hard-fails when the value is
unset/blank/out-of-set — the app refuses to start on every entry point
(HTTP, artisan, queue workers, the agent WSS daemon), same contract as
`CURRENCY_CODE`; no locale fallback may ever be assumed. The agent
renders these strings VERBATIM — the document-model schema above still
types them as free-form (totals `label` string<=64, `order_time`
string<=64, footer lines string<=96, no enum/whitelist). Quick
261125-rxb amendment: the schema stays free-form and ONLY the numeric
caps moved, but that move IS an agent change — the caps were raised
(bn/ja/ar-SA localized content provably overflowed the old string<=24 /
32 / 48 char-wise citations) and the cap-raise DEPLOY-ORDER (single
combined agent-release gate, CURRENCY + CAPS note above) SUPERSEDES
pol's earlier no-gate ruling. Dates
localize month/meridiem names only: digits stay ASCII (latn) in every
locale and ar-SA uses GREGORIAN Arabic months (never Hijri). Scope
split: `meta.title` doc-type identifiers (RECEIPT / KITCHEN TICKET /
BAR TICKET / STATION TICKET / KITCHEN ADDED / KITCHEN CHANGE / KITCHEN
VOID) and the delta section banners remain fixed English chrome — they
are doc-type identifiers with no dictionary equivalents. Receipt
wording is shared with the web dictionaries (screens and printed
receipts use identical translations); footer env overrides
(`RECEIPT_FOOTER_LINE1/2`) always win verbatim — operator copy is never
re-translated.

Unicode raster fallback (agent printer capability `unicodeRaster`, default
OFF): agents ≥ 0.1.3 can render non-ASCII text (bn/ja/ar-SA) by rasterizing
affected lines with bundled OFL fonts into GS v 0 bit images; ASCII lines stay
ESC/POS text (hybrid, per-line raster). The capability is per-printer, off by
default, and stays off until hardware validation closes R-VAL-1 (shaping
fidelity). With the capability off, non-ASCII text still fails with
`text_not_encodable` as before. This is an agent-local rendering detail — the
§2 payload contract is unchanged by it.

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
    "attempt": 1,  // MUST echo the delivery attempt from the §2 envelope
                   // (additive 2026-11-13) the ack refers to — NOT the
                   // agent's local print-retry counter.
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

### 3.2 Heartbeat (WSS; polling-mode cadence amended 2026-10-30)

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
**Amended 2026-10-30 (polling mode):** with WSS deferred, polling-mode agents
run the job poll every **~3 s ± 10 % jitter** and piggyback the §3.2 heartbeat
on each cycle via `POST /heartbeat` (`connection: "poll"`) — ~40 req/min per
device total, within the §7.1 rate limit. The > 90 s staleness rule is
unchanged (a 3 s cadence only makes it sharper). WSS-connected agents keep the
~30 s socket heartbeat cadence.

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
  (`{ config_version, restaurant_uid, printers: [...] }`, with optional
  `envelope_version`).
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
  // UUIDv7 of the restaurant the snapshot belongs to — scopes the
  // config_version counter. Additive optional (§5.2); the agent uses it to
  // detect a backend reset (DB reseed / server switch) where the counter
  // restarts LOW, and resets its monotonic apply guard instead of dropping
  // every later snapshot. Servers MUST send it.
  "restaurant_uid": "018f3c2e-...",
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

**2026-11-07 note (Phase 56 / PRINT-06, D-01/D-02):** printers carry a reserved,
nullable `fallback_printer_id` column. It appears **present-but-null on every
row of the dashboard printer resource** (`GET /api/printers`) and is **unused in
v1 resolution** — the job destination is fixed at creation (§7 note 10). The
write path rejects it: `POST/PATCH /api/printers` bodies carrying the field
fail 422 as an unknown field. The **agent-facing `config_update.printers[]`
entries intentionally omit the key in v1** (agent-parser strictness unverified);
additive exposure on the agent wire follows §5 rule 2 (additive optional =
non-breaking) and is deferred to FALLBACK-01, when the field gains rerouting
behavior and dangling references get resolution-time handling.

Agent applies atomically on `config_version` increase; acks `config.applied` or
`config.rejected{error}`. Offline agents apply on reconnect. The increase is
scoped per `restaurant_uid`: a snapshot whose `restaurant_uid` differs from the
last applied one resets the agent's version marker (the counter space changed),
so a reseeded/fresh backend is picked up instead of being silently ignored.

Agent-side merge policy (v1): profiles are source-tagged `local`/`cloud`; a
config_update manages only cloud-tagged entries (locally-added printers are
never removed by the sync). v1 applies `tcp_raw` with IP-literal hosts only
(no DNS surface) and `spooler_raw` (`windows_printer_name` ≤ 128 UTF-8 bytes,
non-empty; the printer must be installed on the agent machine at print time —
otherwise jobs fail with `printer_not_found`). A config containing a hostname,
a host on the non-approved list (loopback/multicast), `usb` (v1.1) printer,
a duplicate `printer_id`, or an empty
`name`/`windows_printer_name` is rejected whole (nothing applied). A
`codepage` value is stored as sent but rendering supports
cp437/cp850 (R-VAL-1).

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
- Doc schema (2026-11-25 additions): totals `currency` accepted ≤ 8 bytes /
  rejected > 8 bytes or unknown keys; raised caps (`order_time` 64, totals
  `label` 64, footer lines 96) accepted at-cap / rejected over-cap; renderer
  emits the `1,250.00 BDT`-style suffix when `currency` is present and is
  byte-identical to the legacy layout when absent; Unicode raster: non-ASCII
  lines → GS v 0 images and ASCII lines → text when the `unicodeRaster`
  capability is on, `text_not_encodable` when off; zero-panic fuzz corpus
  including bn/ar/ja strings (raster on and off).
- WSS: upgrade with a valid token / with a bad token (4401 or 401 upgrade rejection) /
  job delivered over WSS == job delivered over the poll batch (idempotent by
  `job_id`+`attempt`, where `attempt` is the §2 envelope's delivery-attempt
  counter echoed by the agent) / revoke + config_update over WSS / oversized frame dropped /
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

**2026-10-30 amendment (supersedes the 2026-10-27 amendment):** server-side WSS is
**deferred** — a socket endpoint cannot run in php-fpm (long-running daemon + proxy
required) and was descoped as unjustified infra for this fleet. **REST polling is
the v1 delivery path**, now at a ~3 s ± 10 % healthy cadence (§3.2 amendment;
worst-case job latency ≈ 3 s, ~40 req/min/device vs the 120/min §7.1 limit). The
agent is polling-first by default — its WSS client (ADR-15) is re-wired
2026-11-08 behind the app-level `PRINT_AGENT_ENABLE_WSS=1` flag, default off;
§1 semantics are unchanged for a future server implementation. `POST /heartbeat`
and the pull-claim (§7 note 6) remain the operative server surface.

**2026-11-09 amendment (supersedes the 2026-10-30 deferral):** the server-side
WSS endpoint is IMPLEMENTED — `php artisan agent:ws:serve` (Workerman daemon,
systemd) behind an nginx WS-upgrade route on `/agent/v1/ws`; REST polling
remains the fallback + control plane and must keep working unchanged. The
implementation spec is `docs/wss-server-spec.md`; deployment is
`docs/deploy-agent-ws.md`; server decisions are §7 notes 12–13.

**2026-11-14 amendment (supersedes the polling-first default):** WSS is the
agent's DEFAULT delivery path — the `PRINT_AGENT_ENABLE_WSS` opt-in flag is
removed and the §1 channel is constructed unconditionally (see the §1
amendment of the same date). REST polling remains the fallback + control
plane; an unpaired agent never dials.

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
9. **Config acks** (`config.applied` / `config.rejected{error}` in §4) have no
   REST/WSS surface yet; the agent logs rejections locally. Define the
   endpoint before relying on rejection telemetry.
10. **POS job creation — station-based destination resolution (2026-11-07
   amendment; supersedes the 2026-11-03 first-active note)** — on
   `POST /api/print-jobs` the body's required fields remain `order_id` +
   `doc_type`. When `printer_id` is omitted, the server resolves the
   destination via the doc_type → station map:

   | doc_type | station |
   |----------|---------|
   | `customer_receipt` | `cashier` |
   | `kitchen_ticket` | `kitchen` |
   | `bar_ticket` | `bar` |
   | `station_ticket` | `station` |

   The destination is the ACTIVE printer registered at the mapped station,
   name-ordered ascending — identical to the `GET /api/printers` ordering.
   Two distinct 422s, checked in this order: no active printer at all →
   `"No active printer configured for this restaurant"` (message
   unchanged); active printers exist but none at the mapped station →
   `"No printer configured for station {station}"` — fail-fast, never
   rerouted to another station's printer. An explicit `printer_id` still
   wins and keeps the existing restaurant-scoped lookup (404) +
   disabled-printer 422. Idempotent replays with the same key return the
   ORIGINAL job — the destination is fixed at creation, so printer-config
   changes between attempts never re-target an existing job. Printers now
   also carry a nullable, reserved `fallback_printer_id` column
   (present-but-null; documented in §4 — unused in v1 resolution).
   Clients never name hosts/ports either way (§7 note 5).
11. **Dashboard list — multi-status filter + server-computed `cause`
   (2026-11-07 amendment, PRINT-07)** — `GET /api/print-jobs` accepts
   multiple statuses via the bracket syntax, e.g.
   `?status[]=failed&status[]=outcome_unknown` (the failed-jobs panel's
   single request), returning one paginated newest-first list. The
   single-value `?status=` form remains valid and byte-unchanged for
   backward compatibility. Unknown/invalid status values are silently
   ignored — garbage never 422s; when no valid value remains, the list
   is simply unfiltered. Two additive serialized fields land on every
   row: `cause` — the server-computed failure cause, one of
   `printer_disabled`, `max_attempts_exceeded`, `job_expired`, or
   `null` (derivation:
   `failed` + a known server-written `last_error.code` wins; otherwise
   an unrecognized/absent code maps to `max_attempts_exceeded` only
   when `attempts >= printing.jobs.max_attempts` — the same ceiling
   note 6's abandoned-claim recovery writes; any non-failed status
   serializes `null`. Clients map the value to display labels and never
   derive causes themselves. `job_expired` (2026-11-22) marks a job
   swept to failed by the expiry sweeper after its `expires_at` elapsed
   — §7 note 17); and `printer_name` — the null-safe
   display name of the targeted printer, `null` after a printer
   hard-delete (printers carry no FK to `print_jobs` by design, so a
   deleted printer can never 500 the list). Reprint flows (panel
   action) create a NEW job via `POST /api/print-jobs` with an explicit
   `printer_id` and a DISTINCT `idempotency_key` — the default key
   `order_{id}_{doc_type}` belongs to the original job, so reusing it
   replays that job idempotently instead of creating the reprint
   (note 10's fixed-destination semantics). `POST
   /api/print-jobs/retry/{id}` remains the same-row requeue path — as of
   2026-11-14 it no longer merely resets the claim counter unchanged: it
   bumps the job's `delivery_attempt` epoch and re-delivers the envelope
   (WSS push, REST pull backstop) with the incremented attempt, which the
   agent re-executes (§7 note 14). As of 2026-11-21 the web's edit-order
   reprint flow additionally sends a DISTINCT `idempotency_key` AND
   `reprint_mode: "delta"` (note 15) — a delta ticket of only what changed.
12. **WSS push implemented (2026-11-09; details in `docs/wss-server-spec.md`)**
   — server-implementation decisions that refine §1 semantics, all
   feature-tested (`tests/Feature/Agent/Wss*Test`,
   `tests/Feature/Internal/InternalClaimTest`):
   - **Push targeting:** `print_job` envelopes are delivered to ONE
     connected agent per restaurant (earliest-connected) unless the Redis
     message pins `device_ids`; `config_update` and `revoke` broadcast to
     all connected agents. Rationale: claim-on-send delivers before
     claiming, so multi-device broadcast could double-print. This refines
     the wss-server-spec §4 step-2 parenthetical ("all connected agents").
   - **Claim-on-send transport:** the daemon calls the internal endpoint
     `POST /internal/agent-ws/claimed` `{ job_ids, via: "wss", device_id }`
     (shared-secret `X-Internal-Token` authed, host-blocked at nginx,
     never public) ONLY after a confirmed frame write; the endpoint
     performs the identical §7 note 6 transition (including the
     `expires_at` claimability guard and `printer_disabled` at claim).
     Pushed jobs are filtered from subsequent pulls (proven by test).
     `device_id` is additive on an internal-only surface — not contract
     surface.
   - **Heartbeat parity:** socket §3.2 heartbeats upsert exactly what
     `POST /heartbeat` upserts (`last_seen_at`, `last_ip`,
     `agent_version`, `queue_depth`). Offline detection stays §7 note 7.
   - **Printer health persistence (2026-11-20):** heartbeat
     `printers[]` entries are persisted, superseding the earlier
     "validated but NOT persisted" stance. Both ingestion paths — REST
     `POST /heartbeat` and the `agent:ws:serve` daemon's socket
     heartbeats — share `PrinterHealthService`, which writes
     `last_health` + `last_health_at` onto the printer row for known
     printers of the device's restaurant; unknown printer_ids and
     health-less entries are silently ignored and never fail the
     heartbeat. The dashboard `GET /api/printers` serialization derives
     a SERVER-side staleness verdict `health_state`: the raw
     `last_health` while `last_health_at` is within
     `printing.heartbeat.stale_after` (90 s — the §7 note 7
     device-offline threshold, config-referenced, never re-hardcoded),
     otherwise the literal string `stale`; `null` when never reported.
     Dashboard clients must key badges off `health_state` and never
     compare timestamps themselves — a stored `ok` older than the
     threshold never reads as current.
   - **Upgrade auth:** token SHA-256 vs `agent_devices` with a ≤60 s
     in-process cache (Redis invalidation on rotation/revocation);
     failed-upgrade rate limit 3/15 min per IP; protocol ≠ 1 → HTTP 400;
     mid-socket revocation closes `4401` after the revoke envelope;
     non-heartbeat or oversized (> 32 KiB) agent frames close `1008`.
   - **Lease-expiry reclaim push:** expired leases are re-pushed at most
     once per lease window by a daemon-side scan; the REST pull remains
     the authoritative recovery path (note 6 unchanged).
13. **REST wire-encoding (2026-11-09; RESOLVED — agent ruling, see §2)** —
   the REST pull serializes responses with the framework encoder, which can
   re-encode the signed `job` value (`\/` and `\uXXXX` escaping) after
   signing. The WSS path transmits the exact signed bytes. Ruling: the agent
   verifies over `canonical_json(parsed job)` — transport-indifferent — so
   option (a) is adopted and the REST re-encoding is conformant; no server
   change. Binding server requirements unchanged: sign `canonical_json(job)`
   before transmission; never let a serializer add/drop/default fields inside
   the wire `job`.
14. **Ack `attempt` semantics (2026-11-13; additive envelope field)** — the
   §3.1 ack `attempt` was left undefined in v1 and the two sides drifted:
   the server compared it against its claim counter while the agent sent its
   local print-retry counter (the wire carried no attempt at all), so acks
   could land `stale`/`rejected` spuriously. Resolution: the §2 envelope now
   carries `attempt` at the TOP LEVEL (additive per §5.2 — never inside the
   signed `job`, §2 hard rule) = the server's delivery-attempt counter (≥ 1);
   the agent echoes it in every ack. Idempotency `job_id`+`attempt` is now
   well-defined; old acks for a re-claimed job map to `stale` (success
   no-op). Agents that predate the field keep working (they ignore the
   additive field); their acks fall back to the pre-amendment behavior.
   **2026-11-14 amendment (retry epoch, GAP-2):** the `attempt` source is
   the server's dedicated `delivery_attempt` column — a retry-only epoch,
   stable across lease re-claims (which move only the claim counter) and
   bumped exclusively by operator retry. The server pins acks against
   `delivery_attempt`; duplicate-replay detection still honors equal-or-
   older attempts (`duplicate` for exact replays, `stale` for older). The
   agent re-executes a known `job_id` only when a re-delivered epoch is
   strictly greater and keeps deduping equal/older re-deliveries — the fix
   that makes dashboard retry actually produce paper. No new wire field.
15. **Kitchen-safe reprints — `reprint_mode` (2026-11-21 amendment; POS
   surface)** — `POST /api/print-jobs` accepts an OPTIONAL `reprint_mode`
   body field (`full` | `delta`, default `full`; unknown body fields still
   422 — it is in the rejectUnknown allowlist). `reprint_mode: "delta"` is
   valid ONLY for kitchen_ticket/bar_ticket/station_ticket (422 with
   `customer_receipt` — a receipt is always a full snapshot; it must total
   correctly). The agent-facing wire does NOT change: a delta ticket is an
   ordinary §2 envelope carrying an ordinary doc-v1 payload — the agent
   renderer already supports every construct used (emphasis, note, footer,
   title).

   Semantics (all server-side, feature-tested
   `tests/Feature/Printing/ReprintDeltaTest` + `AckTest`):

   - **Baseline bookkeeping:** every ticket job stores a nullable
     `item_snapshot` JSON at creation — per-product quantity sums over ALL
     batches, `[{product_id, name, qty}, ...]`. This is baseline
     bookkeeping ONLY; it is NOT print state and nothing ever reports
     "printed".
   - **Delta computation:** against the EFFECTIVE BASELINE for
     (order_id, doc_type): the `order_print_snapshots` row (written ONLY
     when an ack reaches `applied` + `completed` — driver hand-off, still
     never "printed") OVERLAID newest-wins by the `item_snapshot` of every
     in-flight job (pending/claimed/sent_to_printer — created after the
     snapshot, still due to fire). Full sums overlay additively-safe:
     each in-flight job's snapshot describes the FULL order at its
     creation, so newest wins per product (additive folding would
     double-count). The new job's own `item_snapshot` always stores the
     CURRENT FULL sums — never the delta — so the next computation
     baselines correctly.
   - **Exclusion rule:** failed/rejected/outcome_unknown jobs are NEVER
     folded into the baseline. An outcome_unknown ticket may or may not
     have fired; excluding it means the delta may re-send a line the
     kitchen already got (a harmless duplicate) but can never MISS a line
     (missing prep is the worse failure).
   - **Delta payload:** lines are the diff only — added lines carry the
     BARE product name in `text` + the count in `qty` (the agent's kitchen
     renderer prefixes `{qty}x ` itself, so embedding qty in text would
     double it), normal emphasis, no prices (kitchen tickets cook items,
     not money). Voided lines are VERB-FIRST (2026-11-22 amendment,
     mirroring agent commit 3167ff2): `text` IS `VOID {qty}x {name}` —
     the qty inside the verb is the AMOUNT TO REMOVE (the delta), never
     the remaining total, and the prefix counts inside the ≤96 clamp —
     with emphasis `reverse` (white-on-black, §2 line enum) and NO `qty`
     key on the line (the agent's kitchen renderer prefixes `{qty}x `
     itself when `qty` is present — a present qty would print
     `1x VOID 1x Name`) and no `note` (the verb lives in the text), so a
     silent removal can never masquerade as a never-ordered line.
     `meta.title` is `KITCHEN ADDED` / `KITCHEN
     VOID` / `KITCHEN CHANGE` (≤24 bytes, §2 schema limit).

     Section banners: when BOTH the added and voided sections are
     non-empty, the payload brackets them — `*** NEW ITEMS ***` before
     the added lines and `*** REMOVE THESE ***` before the voided lines
     (align center, emphasis bold, no `qty`/`note`); single-section
     deltas emit no banner (`meta.title` `KITCHEN ADDED` / `KITCHEN
     VOID` already carries it). Banner lines count against the
     `lines` ≤ 200 hard limit like item lines.
     `footer.text_lines` carries `ONLY CHANGES SINCE THE LAST TICKET` +
     a human-format printed-at stamp in the deployment's local-calendar
     timezone (`app.stats_timezone`, env-driven per deployment — the
     agent renders footer strings verbatim and localizes nothing) —
     `meta.created_at` stays the ORDER date by contract and is never
     repurposed. As of 2026-11-21 the order time has a SINGLE SOURCE OF
     TRUTH: `meta.order_time` (`string<=64` UTF-8 BYTES, REQUIRED, e.g.
     `"21 Nov 2026, 10:09 PM"`) — the server formats it in the
     deployment's local-calendar timezone (`app.stats_timezone`,
     env-driven per deployment) and the agent renders it VERBATIM
     (labeled `Order:` on tickets), never re-converting to the device
     clock. There is deliberately NO fallback: the platform is
     pre-production with one server implementation, so payloads without
     `order_time` are contract violations and reject (`invalid_doc`).
     `meta.created_at` remains the machine-readable instant, emitted
     with an explicit ±hh:mm local offset (offset form is
     contract-conformant RFC 3339 — the agent schema accepts Z and
     ±hh:mm alike). The delta footer's `Printed …` stamp is the print
     time and stays distinct.
   - **Empty delta:** when the diff is empty the endpoint answers
     `200` with the standard success envelope and `data: null` (message
     `no_print_changes`) and creates NO job. Clients must key off
     `data === null`, never by parsing messages.
   - **First-print fallback (2026-11-22 amendment):** when
     `reprint_mode: "delta"` finds NO effective baseline for
     (order_id, doc_type) — no `order_print_snapshots` row AND no
     in-flight pending/claimed/sent_to_printer job carrying a non-null
     `item_snapshot` — the endpoint renders the FULL document layout
     (title `KITCHEN TICKET`, full-order lines with qty + unit_price, no
     delta footer) instead of delta chrome. A first ticket is a full
     document, not a change notice: with nothing to diff against, the
     whole order comes back as "added", and a whole-order ticket titled
     `KITCHEN ADDED` under the "ONLY CHANGES SINCE THE LAST TICKET"
     footer lies to the kitchen. The fallback job still records the
     current full `item_snapshot` (baseline bookkeeping is unchanged), so
     the NEXT delta enqueue folds that pending job into the effective
     baseline and renders the normal delta layout as usual. The
     empty-delta no-changes path is unchanged: a delta on a no-baseline
     EMPTY order still answers `200` with `data: null` and creates NO
     job.
   - **Client flow:** EVERY kitchen-ticket print from the web is now a
     delta — the edit-order reprint (note 11) AND the plain
     "Print Kitchen Ticket" button send a distinct per-confirm
     `idempotency_key` plus `reprint_mode: "delta"` (the button's old
     D-02 default-key replay silently 200-replayed the original ticket —
     nothing sent — while the client toasted "queued"). A first-ever
     ticket has NO effective baseline — per the first-print fallback
     above (2026-11-22 amendment) it renders as a FULL-layout ticket
     (title `KITCHEN TICKET`, no delta footer), never as the whole order
     wearing `KITCHEN ADDED` chrome. The failed-jobs panel reprint keeps
     its distinct-key FULL snapshot (it is the lost-ticket recovery
     path); customer receipts keep the D-02 default-key replay unchanged.
16. **`agent_online` on the POS enqueue response (2026-11-22; additive,
   informational)** — successful `POST /api/print-jobs` responses (201
   created AND 200 idempotent replay) carry an additive `agent_online`
   boolean alongside the unchanged body keys (`id`, `status`,
   `printer_id`, `order_id`, `doc_type`, `idempotency_key`):
   `true` when at least one ACTIVE `agent_devices` row of the restaurant
   has a fresh heartbeat per the §7 note 7 staleness definition
   (`last_seen_at` within `printing.heartbeat.stale_after`, 90 s — the
   same `AgentDevice::isOnline()` verdict that drives
   `GET /api/agent-devices` `online`); `false` when the device is stale,
   revoked (only `status = active` counts), or when the restaurant has no
   paired devices at all. Derivation is server-side — one cheap indexed
   lookup by `restaurant_uid`, no caching, computed after/independent of
   the successful enqueue. The flag is BEST-EFFORT INFORMATIONAL ONLY:
   the server NEVER refuses, delays, or alters enqueue based on it —
   acceptance semantics (pending-not-printed, note 2) are unchanged, and
   clients surface it only as staff-facing guidance ("queued, will print
   when it reconnects"), never as an error. The delta no-changes response
   (200, `data: null`, note 15) is byte-unchanged and carries NO
   `agent_online` key — the 422 validation path does not either.
   **TTL caveat (2026-11-22, additive):** "queued" retention is BOUNDED
   by the job's `expires_at` (default 600 s) — an agent that stays
   offline past it finds the job swept to `failed` (cause `job_expired`,
   note 17) instead of queued. Staff-facing offline messaging must state
   the ~10-minute bound honestly, and the recovery path is the operator
   retry endpoint.
17. **Expiry sweep — `job_expired` (2026-11-22; additive cause + event)**
   — a pending job whose `expires_at` (§2) has elapsed can never be
   claimed (the claim paths hard-filter `expires_at > now`) and previous
   to this amendment stayed pending forever: invisible on the
   failed-jobs panel and rejected by retry. The scheduler now runs
   `php artisan printing:expire-stale-jobs` EVERY MINUTE (Laravel
   `Schedule::command(...)->everyMinute()` in `routes/console.php`; the
   Docker staging deployment executes it via a long-lived
   `php artisan schedule:work` scheduler container). Semantics
   (feature-tested `tests/Feature/Printing/PrintJobExpirySweepTest`):

   - Only `pending` rows with a non-null `expires_at <= now()` are
     swept; rows are iterated in bounded chunks and each row is mutated
     by a CONDITIONAL update whose WHERE re-asserts `status = pending`,
     so a concurrent claim that wins the race keeps its state and the
     sweep count excludes it. `claimed`/`sent_to_printer` rows are
     never touched (abandoned-claim recovery stays note 6's lease
     mechanism); lease fields are untouched.
   - Each swept row is failed with the SERVER-written
     `last_error {code: "job_expired", message: "job expired before
     delivery"}` — the known-code-wins rule (note 11) serializes cause
     `job_expired` on the list/show rows — and gains a `expired`
     lifecycle event (`agent_device_id` null, mirroring the `requeued`
     event shape of retry). Re-running the sweeper changes nothing
     (idempotent). Nothing ever reports "printed" from the sweep:
     only pending → failed, ever.
   - Recovery: the swept job is retried through the EXISTING
     `POST /api/print-jobs/retry/{id}` — no new endpoint and no retry
     code change; the retry grants a fresh `expires_at` (now + default
     TTL), resets `attempts` to 0, and bumps the `delivery_attempt`
     epoch (note 14), so the agent re-executes on the strictly-greater
     attempt.
18. **Reprint supersession (2026-11-23 amendment; dashboard failed-jobs
   panel)** — reprinting a failed/outcome-ambiguous job creates a NEW job
   (note 11) and leaves the original untouched (terminal states never
   mutate). The linkage that lets the UI show "this failure is already
   being handled" now lives ON THE REPRINT JOB: a nullable `reprinted_from`
   uuid column on `print_jobs` (plain uuid + index, NO FK constraint —
   same style as `printer_id`/`restaurant_uid`; `print_jobs.id` is uuid).
   Written ONLY when `POST /api/print-jobs` carries the OPTIONAL
   `reprinted_from` body field (uuid, in the rejectUnknown allowlist —
   unknown fields still 422):

   - **Validation:** the referenced job must EXIST, belong to the SAME
     restaurant, and be in a terminal failure state (`failed` |
     `outcome_unknown`) — otherwise 422 with a violation-naming message
     (nonexistent / other restaurant / not a failed or ambiguous job).
     Idempotent replays of a reprint key return the ORIGINAL reprint job
     unchanged — its `reprinted_from` was fixed at creation. Pointing the
     field at an already-superseded job is NOT hard-blocked (harmless —
     newest-reprint resolution still wins; the UI prevents the flow).
   - **Row serialization:** every list/show row of `GET /api/print-jobs`
     (and `/show/{id}`) additionally carries `reprint_job_id` (uuid|null)
     and `reprint_status` (string|null) = the NEWEST reprint job (by
     `created_at` desc); both keys are null when the job was never
     reprinted. Server-resolved (the same D-14 philosophy as `cause`) —
     clients never derive supersession themselves. Newest-wins display:
     a NEWEST reprint in `failed`/`outcome_unknown` serializes that
     status, signaling the original is NOT superseded even if an OLDER
     reprint completed.
   - **The single superseded definition (shared by panel and badge):** a
     failed/outcome-ambiguous row is SUPERSEDED when at least one reprint
     job (`reprinted_from` = the row's id) has status in
     {pending, claimed, sent_to_printer, completed} — EXISTS-ANY. A
     reprint that itself failed/outcome_unknown does NOT supersede (both
     rows stay actionable), so the expiry sweeper (note 17) sweeping a
     pending reprint to `failed` automatically un-supersedes the original.
   - **Badge filter:** `GET /api/print-jobs` accepts the optional
     `exclude_superseded` query flag (boolean, silent-ignore convention —
     applied only when present and truthy, never a 422). When set,
     superseded failed/outcome-ambiguous rows are excluded from BOTH the
     data rows and `meta.total` (the same whereNotExists runs on the
     pagination count). Used by the sidebar failed-count badge
     (`pageSize: 1`, reads `meta.total`); the failed-jobs PANEL omits it
     so dimmed rows stay visible.
   - **UI consequence:** superseded panel rows render dimmed and
     non-actionable — the Reprint trigger is replaced by a
     "Reprinted → job #…" badge; the details dialog stays reachable (the
     audit trail is never hidden). Reprint-failed originals (and every
     non-reprinted row) render exactly as before. The immutable-original
     design, terminal-state contract, delta-reprint baseline (note 15)
     and destination-override semantics (note 10) are unchanged.

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
- Expiry sweep: pending jobs past `expires_at` are failed with cause
  `job_expired` every minute by the scheduler
  (`php artisan printing:expire-stale-jobs`, §7 note 17).

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
    "sig": "base64url(ed25519 detached signature over canonical_json(job))"
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
config_version, restaurant_uid, printers: [...] }` (§4 printer shape).
`GET /api/agent/v1/server-keys` → 200 `{ keys: [{ kid, public_key, active }] }`.

Error example (agent surface):

```jsonc
// 401 from any authenticated agent endpoint
{ "error": { "code": "invalid_token", "message": "Invalid or expired device token" } }
```
