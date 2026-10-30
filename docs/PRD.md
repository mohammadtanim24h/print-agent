# PRD — Print Agent

**Version:** 1.0 (2026-10-22) · **Status:** Approved for planning · **Owner:** Platform team

## 1. Problem

Restaurant operators using the SaaS (Laravel backend, React web, Flutter clients) need
reliable, unattended printing of kitchen tickets and customer receipts on the cashier PC.
Browser-based printing is unreliable (print dialogs, spooler dialogs, no ESC/POS, no
offline queue). We need a dedicated desktop agent that receives print jobs from the cloud
and drives 80mm ESC/POS thermal printers directly.

## 2. Goals

| #   | Goal                                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Print kitchen tickets and customer receipts on 80mm ESC/POS thermal printers, unattended                                                                                                |
| G2  | Outbound connections only — no inbound HTTP server on the cashier PC                                                                                                                    |
| G3  | Survive network outages: jobs queue durably on the server and replay on reconnect                                                                                                       |
| G4  | Survive app/PC restarts: in-flight job state is durable locally (SQLite)                                                                                                                |
| G5  | Multiple restaurants (tenants), multiple agents, multiple printers per agent                                                                                                            |
| G6  | Fully self-developed; commercially compatible open-source deps (MIT/Apache/BSD/ISC); **no paid printing middleware, cloud print service, subscription, or proprietary runtime license** |
| G7  | Development and CI fully testable without physical hardware (virtual ESC/POS printer)                                                                                                   |
| G8  | Honest printing semantics: distinguish "sent to printer" from "physically printed"; never promise exactly-once physical printing                                                        |

## 3. Non-goals (v1)

- macOS / Linux builds (Windows x64 only initially; architecture must not preclude them)
- Document types other than kitchen tickets and customer receipts (bar/station tickets are
  a config-driven extension of the same schema, designed for but not shipped in v1)
- Printer firmware management and cash-drawer control (no drawer kick command in the agent)
- Mobile printing from Flutter directly to printers (Flutter clients print _via the SaaS_,
  which routes jobs to this agent)
- Label printers (ZPL/EPL), A4 documents, cloud print services

## 4. Users and personas

- **Cashier/waiter** (React web / Flutter): presses "Print receipt". Never interacts with
  the agent directly. Sees job status in the web app (queued / sent / printed / failed).
- **Restaurant manager**: pairs a new agent, names printers, assigns stations
  (kitchen / bar / cashier), reprints a lost ticket.
- **SaaS support engineer**: remotely diagnoses an agent — sees version, connectivity,
  printer health, last jobs, can pull logs on request.

## 5. Functional requirements

### 5.1 Pairing & identity

- FR-1: Agent is paired once per installation using a short-lived, single-use pairing
  code generated in the web app (`Settings → Printers → Add agent`).
- FR-2: Pairing binds the agent to exactly one restaurant (tenant scope).
- FR-3: Pairing exchange establishes a device identity (Ed25519 keypair generated on the
  device, private key never leaves the PC) and a rotating device token.
- FR-4: SaaS can revoke an agent at any time; a revoked agent stops accepting jobs and
  wipes credentials and local job data on next sync.

### 5.2 Job intake & queueing

- FR-5: Agent receives jobs over an outbound, authenticated, TLS-encrypted WebSocket,
  with HTTPS REST polling as fallback.
- FR-6: Jobs are validated against a versioned schema (v1) before any processing;
  invalid jobs are rejected with a structured error, never partially processed.
- FR-7: Every job carries an `idempotency_key`; duplicate deliveries are detected and
  de-duplicated locally before printing.
- FR-8: Jobs are persisted in a local SQLite queue _before_ printing and removed from
  the active queue only after a terminal outcome.
- FR-9: Jobs carry `expires_at`; expired jobs are never printed.

### 5.3 Printing

- FR-10: Structured document payloads are rendered locally to ESC/POS byte streams.
  The server never sends raw printer bytes.
- FR-11: Supported transports (configurable per printer): raw TCP 9100, Windows print
  spooler (RAW datatype via a shared ESC/POS driver), USB (best-effort, v1.1).
- FR-12: Transports are pluggable behind a common `Transport` interface.
- FR-13: Agent reports distinct statuses: `accepted`, `sent_to_printer`,
  `completed` (hand-off to printer/driver succeeded), `failed`, `ambiguous`
  (outcome unknown — e.g. crash between send and record), and best-effort
  `printer_ack` where the printer supports bidirectional status (DLE EOT).
- FR-14: After an `ambiguous` outcome the agent does **not** silently reprint; it either
  (a) marks the job `ambiguous` for operator decision, or (b) reprints per a
  restaurant-configurable duplicate policy with a printed "DUPLICATE" banner.
- FR-15: Customer receipts support logo, QR code, bold/emphasis, alignment, cut
  commands; kitchen tickets prioritize speed and large-font item lines.

### 5.4 Printer configuration

- FR-16: Printer configuration (name, transport type, address/port, station role,
  copies, character set/codepage, paper-width assumptions) is managed in the SaaS web
  app, synced to the agent as config, and cached locally for offline use.
- FR-17: The agent can run a test print per printer and report transport-level health.

### 5.5 Observability & ops

- FR-18: Agent sends a periodic heartbeat (version, connectivity, per-printer health,
  queue depth) over the same socket.
- FR-19: Structured local logs with rotation; support can request a redacted log bundle.
- FR-20: Signed auto-updates (electron-updater against a pinned, HTTPS-served manifest).
  *(Superseded by ADR-14, 2026-10-25 — unsigned manual distribution: no auto-updater;
  installers are published as GitHub Release artifacts and restaurants reinstall to
  update.)*

## 6. Acceptance criteria (phase-level, verifiable without hardware)

- AC-1: With the virtual ESC/POS printer (`escpos-emulator`, TCP :9100) the agent prints
  a customer receipt whose decoded output contains header, line items, tax, total (bold),
  QR placeholder, and cut command — asserted via the emulator's REST API.
- AC-2: Killing the agent between "send" and "ack" and restarting results in the job
  being marked `ambiguous` (or reprinted per policy), never silently lost.
- AC-3: Replaying the same job (`idempotency_key`) results in exactly one print.
- AC-4: Agent works with zero inbound listeners (`netstat` shows no LISTEN sockets).
- AC-5: Revoked agent credentials are rejected and local data is wiped on next connect.
- AC-6: A malicious job payload (oversized, wrong types, unknown doc version, injected
  control bytes in text fields) is rejected with a structured error and never printed.
- AC-7: All phases ship with passing automated tests; no phase is "done" untested.

## 7. Constraints

- Windows 10/11 x64. Cashier PCs are often low-spec, sometimes offline-ish; agent must be
  lightweight (< ~200 MB RAM idle) and resilient to sleep/resume.
- No public IP, no port forwarding at restaurant sites. Outbound 443 (and outbound LAN
  TCP 9100 to printers) only.
- Distribution: commercially distributable installer under permissive licenses only.
  Code-signing certificate is an operational cost, not a runtime license — acceptable.
  *(Later accepted per ADR-14, 2026-10-25: no certificate was purchased — unsigned
  manual distribution was adopted instead.)*
- Dependencies must be verified for license + maintenance at adoption time; see
  `docs/printer-compatibility.md` §5 and `.research/dependency-research.md`.

## 8. Success metrics

- ≥ 99% of jobs reaching `completed` (or `ambiguous`+operator-resolved) within 5 s of
  issuance while the agent is online.
- < 1 duplicate-print complaint per restaurant per month.
- Support tickets requiring on-site visit: near zero (remote diagnosis + log bundles).

## 9. Open questions

| Question                                                           | Default until answered                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Do target printers support DLE EOT status polling?                 | Treat `printer_ack` as best-effort; do not gate on it                           |
| ESC/POS codepage for non-ASCII (restaurant names in local script)? | UTF-8-capable codepage where supported; ASCII-safe fallback; per-printer config |
| Flutter clients printing directly to LAN printers?                 | Out of scope; route via SaaS → agent                                            |
