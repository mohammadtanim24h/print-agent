# API Contract — Laravel ⇄ Print Agent

**Version:** v1 · **Status:** Draft for implementation
All messages are JSON over TLS. Every message at every boundary is schema-validated
(zod on the agent; Laravel Form Requests / DTOs server-side). Unknown fields are
rejected, not ignored, within `data` payloads (envelope may gain additive fields).

## 1. Conventions

- Base URL: `https://<saas-host>/api/agent/v1` (versioned path; v1 frozen once shipped).
- WSS endpoint: `wss://<saas-host>/agent/v1/ws` — agent-initiated, persistent, outbound.
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
    "printer_id": "018f...", // must be bound to this agent
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
  "connection": "wss",
  "printers": [{ "printer_id": "018f...", "health": "ok", "last_print_at": "...?" }],
}
```

Missed heartbeats (≥ 3) mark the agent `offline` server-side.

### 3.3 REST endpoints (fallback + control plane)

| Method | Path                             | Purpose                                                              |
| ------ | -------------------------------- | -------------------------------------------------------------------- |
| `POST` | `/pair`                          | Exchange pairing code (once, pre-token)                              |
| `POST` | `/token/refresh`                 | Rotate device token                                                  |
| `GET`  | `/jobs?since=<cursor>&limit=100` | Fallback long-poll/pull of pending jobs                              |
| `POST` | `/acks`                          | Batch acks (idempotent, keyed by `job_id`+`attempt`)                 |
| `GET`  | `/config`                        | Printer/station config snapshot + `config_version`                   |
| `POST` | `/diagnostics`                   | Upload redacted log bundle (support-initiated, agent-user-confirmed) |
| `GET`  | `/server-keys`                   | Current server signing public key(s), pinned at pairing              |

### 3.4 Pairing flow

```
Web app:  manager clicks "Add agent" → server issues pairing_code (8 chars, TTL 10 min, single use)
Agent:    user enters code in local wizard
Agent:    POST /pair { pairing_code, device_pubkey(ed25519), device_name, agent_version }
Server:   verifies code unused+unexpired → creates agent row (tenant, restaurant)
          → returns { device_id, device_token, refresh_token, server_signing_pubkey,
                      restaurant_id, tenant_id, token_ttl_s }
Agent:    stores identity (DPAPI-protected), opens WSS, first heartbeat confirms pairing
```

Pairing codes are single-use and short-lived; three failed attempts rate-limits the
endpoint per IP (T3).

### 3.5 Revocation

Server pushes `{ "type": "revoke", "reason": "manager_initiated" }` on the WSS and
refuses token refresh. Agent behavior: stop accepting jobs → send final heartbeat →
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
