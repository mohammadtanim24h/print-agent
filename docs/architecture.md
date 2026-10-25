# Architecture — Print Agent

**Version:** 1.0 (2026-10-22) · **Status:** Approved for planning
**Companion docs:** `PRD.md`, `api-contract.md`, `threat-model.md`, `adr.md`

## 1. System overview

```
                       ┌──────────────────────────────┐
                       │  Laravel SaaS (existing)     │
                       │  REST /api/agent/*           │
                       │  WSS push (Reverb or eq.)    │
                       └──────┬───────────────────────┘
                              │ outbound TLS only (wss/https)
┌─────────────────────────────┼──────────────────────────────────────┐
│  Print Agent (Electron, Windows x64)  cashier PC                  │
│  ┌───────────────────────────────────────────────────────────┐    │
│  │ MAIN PROCESS                                              │    │
│  │  cloud-client ─── job-engine ─── renderer (doc→ESC/POS)   │    │
│  │      │                │                │                  │    │
│  │      │           local-store (SQLite) │                  │    │
│  │      │                │        transport-registry         │    │
│  │      │                │        ├─ tcp-raw (:9100)         │    │
│  │      │                │        ├─ spooler-raw (Win32)     │    │
│  │      │                │        ├─ usb (v1.1)              │    │
│  │      │                │        └─ mock (tests)            │    │
│  │      │                │                                   │    │
│  │  pairing · config-sync · heartbeat · diagnostics          │    │
│  └───────────────────────┬───────────────────────────────────┘    │
│            contextBridge (typed IPC, schema-validated)            │
│  ┌───────────────────────┴───────────────────────────────────┐    │
│  │ RENDERER (local tray UI + pairing wizard + test print)    │    │
│  └───────────────────────────────────────────────────────────┘    │
└──────────────┬──────────────────────────────┬─────────────────────┘
        outbound LAN TCP 9100            Windows spooler (RAW)
        ┌────────┴────────┐              ┌──────┴──────┐
        │ 80mm ESC/POS    │              │ shared ESC/ │
        │ thermal printer │              │ POS driver  │
        └─────────────────┘              └─────────────┘
```

Hard rule: **the agent opens only outbound connections.** No HTTP/other server binds any
port on the cashier PC — not even on localhost — so nothing on the LAN can connect in
(AC-4). The renderer never talks to the network or printers directly.

## 2. Technology choices (evidence in `adr.md` + `.research/`)

| Concern                  | Choice                                                                                                                                                          | Alternative rejected / deferred                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell                    | Electron 45 (MIT) — Node 24 runtime, USB/serial access; chosen for Node APIs + local UI (ADR-14 dropped auto-update: cert cost + feed infra not justified, an unsigned updater is forbidden) | Tauri (WebView2 variance, weaker native-module story for usb/serial); plain Node service (no local UI)                                       |
| ESC/POS generation       | `node-thermal-printer` 4.x (MIT, active Aug 2026) for byte generation                                                                                           | `escpos`* packages (abandoned ~2020, alphas only)                                                                                            |
| Transports               | Own thin adapters: Node `net` (TCP 9100), custom Win32 spooler-RAW N-API shim (~100 lines, `OpenPrinter→StartDocPrinter("RAW")→WritePrinter`), `usb` 3.x (v1.1) | No maintained npm package wraps Win32 RAW spooler (verified); `pdf-to-printer` bundles GPLv3 SumatraPDF → **license-incompatible, rejected** |
| Local store              | `better-sqlite3` 13.x (MIT, N-API prebuilds — no electron-rebuild)                                                                                              | `sql.js` (WASM, slower, no true durability guarantees)                                                                                       |
| Schema validation        | `zod` 4.x at every trust boundary (WS messages, IPC, config files)                                                                                              | Hand-rolled validators (error-prone)                                                                                                         |
| Socket                   | `ws` 8.x (MIT) client in main process                                                                                                                           | Browser WebSocket in renderer (breaks isolation)                                                                                             |
| Packaging/update         | `electron-builder` 26.x only — unsigned NSIS, manual distribution, no updater (ADR-14)                                                                          | `@electron/forge` (equivalent viable); `electron-updater` (ADR-12 — superseded: an unsigned updater is forbidden)                            |
| Images (logo/QR preview) | `@napi-rs/canvas` + `qrcode`                                                                                                                                    | `sharp` (heavier native deps), `node-canvas` (build friction)                                                                                |
| Virtual printer          | `escpos-emulator` (MIT, 2026): TCP :9100 + REST for assertions                                                                                                  | USB device emulation (not CI-feasible; optional Pi-Zero gadget for manual smoke tests)                                                       |
| Logging                  | `electron-log` (MIT) structured + rotation                                                                                                                      | —                                                                                                                                            |

## 3. Module boundaries (main process)

Each module is a folder under `src/main/` with an explicit public interface; modules
communicate via injected interfaces or an in-process event bus — never via ambient
requires reaching into another module's internals.

### 3.1 `cloud-client`

- Owns the outbound `wss` connection (with exponential-backoff reconnect + jitter),
  REST fallback polling, TLS, auth token attach/rotation, and outbound/inbound message
  schema validation (zod).
- Emits domain events (`job.received`, `config.changed`, `revoked`, `connected`).
- Exposes: `send(msg)`, `connectionState$`. Knows nothing about printing.

### 3.2 `job-engine`

- The state machine owner (§5). Consumes `job.received`; validates + persists jobs in
  `local-store`; schedules execution; invokes `renderer` then `transport-registry`;
  records transitions; reports acks via `cloud-client`.
- Handles duplicate suppression (`idempotency_key`), expiry, retry policy with backoff,
  ambiguity detection (crash-recovery: jobs found in `sending` state at startup are
  moved to `ambiguous`), and duplicate-reprint policy.

  Implementation: `docs/job-engine.md`.

### 3.3 `renderer`

- Pure function: validated doc model (JSON) → ESC/POS command stream (Buffer) via
  `node-thermal-printer`, plus a preview (raster via `@napi-rs/canvas`) for the local UI.
- Doc version v1 only; unknown versions rejected upstream. Deterministic, unit-testable,
  no I/O except reading logo assets from the local store.

Implementation: `src/main/render/` — see `docs/render-pipeline.md` (module map,
encodability policy, raster fallback design, diagnostic summary contract).

### 3.4 `transport-registry` + transports

- `Transport` interface: `open()`, `write(bytes)`, `status?()` (best-effort DLE EOT),
  `close()`, `healthCheck()`. `write()` resolves on kernel/driver acceptance — this is
  by definition "sent to printer", never "physically printed".
- `tcp-raw`: Node `net` to `<ip>:9100`, connect timeout + write timeout.
- `spooler-raw`: N-API shim to Win32 spooler with RAW datatype; pairs with a shared
  ESC/POS driver (e.g. Epson TM-series driver or the generic ESC/POS driver shipped by
  the printer vendor — vendor drivers are free downloads, not paid middleware).
- `usb`: `usb` 3.x, claim printer-class interface (v1.1).
- `mock`: in-memory buffer for unit tests; `escpos-emulator` serves as the integration
  virtual printer.

### 3.5 `local-store`

- SQLite (WAL mode) via `better-sqlite3`. Tables: `jobs`, `printers` (cached config),
  `identity` (device keys, tokens — see threat model §T1 for at-rest handling),
  `settings`, `logs_meta`. Single owner of all disk I/O; other modules use its API.

### 3.6 `pairing` & `config-sync`

- Pairing: device keypair generation, pairing-code exchange, token storage.
- Config-sync: printer/station config from SaaS → validated (zod) → persisted → applied.

### 3.7 `diagnostics`

- Heartbeat construction, electron-log setup, redacted log-bundle export, queue
  introspection for the support view.

### 3.8 `preload` / IPC

- `contextIsolation: true`, `nodeIntegration: false`, sandboxed renderer.
- Typed, per-channel whitelisted API over `contextBridge`; every message zod-validated
  in the preload/main boundary. The renderer can: show status, run pairing, trigger test
  print, view queue. It cannot: touch filesystem, network, or printers directly.

### 3.9 `renderer` (UI)

- Local-only UI: tray icon, agent status, pairing wizard, printer test-print buttons,
  ambiguous-job resolution prompt. Reads state via IPC events.

### 3.10 Composition root

`AgentRuntime` (`src/main/agent-runtime.ts`) is the **only** place modules are
instantiated: it wires the stores, engine, transports and cloud client with injected
dependencies and owns the app lifecycle (pairing, wipe-on-revoke/unpair, snapshot
assembly, cloud-event plumbing). `main.ts` opens + migrates the SQLite database and
closes it on quit; the runtime never touches the db handle's lifetime.

Event flow:

- **Jobs:** poller (`cloud-client`) validates + scope-checks envelopes →
  `job-engine.submit()` → acks flow engine → `ack-buffer` → poller
  (`submitAcks` batched; the buffer reaches the client through a forward
  reference created before the client exists — the first submit only happens
  after `start()`/`pair()`).
- **Connection state:** on `state → 'online'` the runtime drains retained acks
  immediately (`flushNow()`) — offline-held acks never wait out the buffer's
  delay timer after a reconnect.
- **Config:** `config` events are persisted to the `cloud_config` table only;
  application is a later phase (FR-16).

Recovery ordering: `runtime.start()` runs `engine.recover()` **before**
`client.start()` — crash-recovered jobs (incl. `sending` → `ambiguous`) must be
settled before the first poll can deliver new work (§5).

Wipe path (revocation from the server or operator unpair, §7): the runtime stops
the client and clears secrets, jobs, printers, cached cloud config and
`pairedAt`. The wipe is best-effort — a failed step is logged, never thrown, so
a wipe failure cannot wedge the caller; the UI's revoked-state wording claims
only that the wipe was *triggered*.

## 4. Job flow (happy path)

1. SaaS enqueues job (server-side durable queue) → pushes over WSS.
2. `cloud-client` validates envelope → emits `job.received`.
3. `job-engine` re-validates payload, checks `idempotency_key` + `expires_at`, writes
   `jobs` row (status `accepted`) → ack `job.accepted`.
4. Renderer produces ESC/POS bytes → status `rendered`.
5. Transport opened, bytes written → status `sent_to_printer`.
6. Optional status poll (`printer_ack`) if transport+printer support it.
7. Write accepted by OS/driver → status `completed` → ack `job.completed`
   with `status: "completed"` and `printed: false-claim-avoided`: the ack conveys
   _hand-off success_, never a physical-print guarantee (§5, PRD FR-13/G8).

Failure paths: connect-phase transport errors are retried with bounded backoff before
transmission; failures after transmission begins mark the job `ambiguous` (ADR-5/6 —
no automatic reprint). Crash between 5 and 7 → on restart, `sending` rows →
`ambiguous` → report + policy.

## 5. Job state machine (authoritative)

```
              ┌───────────┐  invalid/expired    ┌──────────┐
  pushed ───▶ │ validated ├───────────────────▶ │ rejected │ (reported, terminal)
              └─────┬─────┘                     └──────────┘
                    │ persist(accepted)
                    ▼
              ┌───────────┐  render error       ┌──────────┐
              │ rendered  ├───────────────────▶ │  failed  │◀──── retry exhausted
              └─────┬─────┘                     └────┬─────┘ (terminal; manual reprint)
                    │ transport open+write issued
                    ▼
              ┌───────────┐   connect failure (retryable — nothing written yet):
              │  sending  │◀───── retry with bounded backoff (ADR-6,
              │           │       pre-transmission only), then re-issue
              │           │   crash/power loss while in flight (on restart)
              │           ├──────────────────▶ ┌───────────┐
              └─────┬─────┘                    │ ambiguous │ (reported; operator or
                    │ write accepted            └───────────┘  duplicate-policy reprint)
                    ▼
              ┌───────────┐   transport error after transmission has started:
              │ sent_to_  ├──────────────────▶ ambiguous (outcome unknowable —
              │ printer   │                    never auto-retried, ADR-5/6)
              └─────┬─────┘
                    │ hand-off confirmed (optional: printer_ack first)
                    ▼
              ┌───────────┐
              │ completed │ (terminal — means "handed to printer/driver OK")
              └───────────┘
```

**Semantics (contract with the SaaS):**

| State             | Meaning                                                         | Physical print guaranteed?               |
| ----------------- | --------------------------------------------------------------- | ---------------------------------------- |
| `accepted`        | Agent durably stored the job                                    | No                                       |
| `rejected`        | Schema/expiry/tenant check failed                               | No — never will print                    |
| `rendered`        | ESC/POS stream produced                                         | No                                       |
| `sending`         | Write in flight (transient; only observable via crash recovery) | Unknown                                  |
| `sent_to_printer` | Bytes written to transport socket/driver                        | **No** — printer may be off/paper-jammed |
| `printer_ack`     | Best-effort printer status says "received OK" (DLE EOT)         | Likely, not guaranteed                   |
| `completed`       | Hand-off to printer/driver confirmed                            | **No — never claimed as proof of print** |
| `failed`          | Terminal error after bounded retries                            | No                                       |
| `ambiguous`       | Outcome unknown (crash window, timeout on result)               | Unknown                                  |

Exactly-once physical printing is **impossible** to promise over fire-and-forget
interfaces (TCP 9100 has no app-level ack; spooler ACK means spooled, not printed).
The system therefore provides: **at-least-once delivery to the agent** (server retries
until `accepted`), **at-most-once print attempt per job-execution**, and a **bounded,
auditable ambiguity window** with a restaurant-configurable duplicate policy
(PRD FR-14). The web app UI wording must reflect this ("Sent to printer" ≠ "Printed").

## 6. Data model (local SQLite, abbreviated)

```sql
jobs(
  id TEXT PRIMARY KEY,                 -- job_id (uuidv7 from server)
  idempotency_key TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  restaurant_id TEXT NOT NULL,
  printer_id TEXT NOT NULL,
  doc_type TEXT NOT NULL, doc_version INT NOT NULL,
  payload_json TEXT NOT NULL,          -- validated v1 doc
  status TEXT NOT NULL,                -- §5 states
  attempts INT DEFAULT 0,
  created_at INT, expires_at INT,
  sent_at INT, completed_at INT,
  last_error TEXT
);
CREATE UNIQUE INDEX ux_jobs_idem ON jobs(restaurant_id, idempotency_key);
printers(id TEXT PRIMARY KEY, config_json TEXT NOT NULL, updated_at INT);
identity(k TEXT PRIMARY KEY, v BLOB);   -- keys/tokens; DPAPI-protected (threat model T1)
```

Server-side (Laravel) tables are out of scope here except `agents`, `printers`,
`print_jobs` mirror the same IDs (see `api-contract.md`).

## 7. Multi-tenancy & isolation

- One agent ↔ one restaurant. `tenant_id` + `restaurant_id` are embedded in the device
  token claims; the server only ever sends jobs matching the token's scope, and the
  agent independently enforces scope on every job (defense in depth).
- Local DB is single-restaurant by construction; no cross-tenant query path exists.
- Revocation wipes credentials + jobs (PRD FR-4) and requires re-pairing.
- Future multi-restaurant agents (hub mode) are explicitly deferred; the schema keeps
  `restaurant_id` on every row so a hub variant needs no migration of contracts.

## 8. Connections summary

| Direction        | Protocol                           | Purpose                                            |
| ---------------- | ---------------------------------- | -------------------------------------------------- |
| Agent → SaaS     | `wss` :443 (persistent)            | Job push, acks, heartbeat, config push, revocation |
| Agent → SaaS     | HTTPS REST (fallback + bulk)       | Poll jobs, ack batches, pairing, log upload        |
| Agent → printers | outbound TCP :9100 / spooler / USB | Print streams                                      |
| Renderer ↔ main  | Electron IPC only                  | UI state and commands                              |

Nothing listens. Ever. (Enforced by a startup assertion test, AC-4.)

## 9. Key risks requiring physical-printer validation

Detailed list in `printer-compatibility.md` §6 — headline items: real-world ESC/POS
dialect differences (codepages, cut/QR command variants), DLE EOT support heterogeneity,
USB endpoint/claim quirks, spooler driver RAW passthrough behavior, print-speed timing
assumptions for kitchen rush, and aut cutter noise/partial-cut behavior.
