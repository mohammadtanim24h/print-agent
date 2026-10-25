# Threat Model — Print Agent

**Version:** 1.0 (2026-10-22) · Method: STRIDE-per-trust-boundary
Trust boundaries: (B1) Internet ↔ Agent, (B2) LAN ↔ Agent, (B3) Renderer ↔ Main (IPC),
(B4) Agent ↔ OS/printer, (B5) build/update pipeline ↔ Agent.

Standing mitigations across all threats: outbound-only networking (no listeners),
zod strict validation at every boundary, Ed25519 device identity, signed jobs,
DPAPI-protected secrets, minimal dependency surface, no dynamic code
execution anywhere (`eval`/`Function`/remote content banned by lint + CLAUDE.md).

## T1 — Stolen agent credentials (device token / keypair)

**Scenario:** laptop or disk image stolen from the restaurant; attacker extracts the
agent's identity and connects to the SaaS as the agent.

| Mitigation                                                                                             | Notes                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Private key + tokens stored encrypted with Windows DPAPI (user/machine scope)                          | Offline extraction requires the same Windows user/machine; not a defense against running malware on the same box, but defeats disk-image theft |
| Short access-token TTL (≤ 15 min) + rotating refresh token; refresh rotation invalidates stolen chains | Server-side detection of concurrent refresh = auto-revoke                                                                                      |
| Manager-initiated revocation (web app) with server-side enforcement on every call                      | Agent-side wipe is belt-and-braces; the server is authoritative                                                                                |
| Agent actions are low-value by design                                                                  | Can read its own restaurant's job queue and ack jobs; cannot read other tenants, cannot query arbitrary data                                   |
| Optional: certificate-pinned TLS + public-key pinning of the server signing key                        | Prevents token reuse against a phishing endpoint                                                                                               |

**Residual:** a stolen live machine (unlocked) is out of scope — equivalent to stolen
cashier session. Rate-limit + anomaly alarms (new IP/geo) on the SaaS side.

## T2 — Malicious job payloads (from compromised SaaS or MitM)

**Scenario:** attacker controls a job (compromised SaaS admin account, SQLi, or TLS
break) and attempts: printer control-byte injection, DoS of the agent, or exploit of
the renderer.

| Mitigation                                                                                                    | Notes                                                                                                |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Strict schema validation with hard size caps (32 KiB payload, line/count limits) — reject, don't sanitize     | Oversized/deep structures rejected before parse into objects used for rendering                      |
| Control characters (0x00–0x1F, 0x7F) stripped/escaped in every text field before ESC/POS encoding             | Prevents ESC/POS command injection (`ESC @` reset, `GS V` cut, DLE sequences) smuggled inside "text" |
| Amounts are integers (minor units), enumerated emphasis/align values, whitelisted doc types                   | No free-form numerics/format strings reach the renderer                                              |
| Server `sig` (Ed25519) verified against pairing-pinned key                                                    | A rogue backend instance or MitM cannot mint jobs                                                    |
| Renderer is a pure, fuzzed function (property tests: any input ⇒ valid byte stream ≤ bounded size, no panics) | Fuzzing is part of the renderer's definition-of-done                                                 |
| Per-transport byte budget + connect/write timeouts                                                            | Payload can't wedge the job engine                                                                   |

**Residual:** a fully compromised SaaS signing key can print garbage — treated as a
server-side key-ceremony problem; key rotation endpoint exists (§3.3 api-contract).

## T3 — Arbitrary LAN connections to the agent

**Scenario:** attacker on the restaurant Wi-Fi scans and attacks the cashier PC.

| Mitigation                                                                                                                                                     | Notes                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No listening sockets by design** — no local HTTP server, no debug port in production builds, WSS is outbound                                                 | `netstat -an                                                                                                                                               | findstr LISTEN` must show only unrelated OS entries; asserted by an automated test (AC-4) |
| Chromium debug port disabled (`--remote-debugging-port` never set; fuses: `EnableNodeCliInspectArguments=false`, `EnableNodeOptionsEnvironmentVariable=false`) | electron fuses hardened at build                                                                                                                           |
| Local UI is served from packaged files only, over a privileged `app://` custom scheme (fs-level asar reads; `GrantFileProtocolExtraPrivileges` fuse stays off), no `loadURL(http...)` | No drive-by web content in the renderer; CSP: default-src 'self'                                                                                           |
| LAN printer traffic (TCP 9100) is agent → printer only                                                                                                         | Agent never opens inbound; ARP/DNS spoofing of the printer IP is a printer-availability risk, not an agent-compromise path (bytes validated anyway per T2) |

**Residual:** cashier PC's other software is out of scope; recommend SaaS docs advise
segmenting POS LAN.

## T4 — Duplicate printing (integrity, not secrecy)

**Scenario:** network flap or agent crash causes double-print of a kitchen ticket →
two dishes cooked; or receipt duplicated → refund-fraud vector.

| Mitigation                                                                                                               | Notes                                                                              |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Idempotency: server never resends a job with the same `(restaurant_id, idempotency_key)`; agent de-dupes on unique index | PRD AC-3                                                                           |
| Ack-driven at-least-once delivery: server retries until `accepted` (durability boundary), **not** until print            | Prevents the classic "retry until printed" duplicate bomb                          |
| Ambiguity window: crash between send and record ⇒ `ambiguous`, never silent reprint                                      | FR-14: `ask_operator` (default) / `auto_reprint` (with DUPLICATE banner) / `never` |
| `attempt` counter on every ack; reprints are separate jobs with a `reprint_of` reference (audit trail)                   | Makes duplicates visible and attributable                                          |

**Residual:** a printer power-cycle after spooler hand-off can re-print from driver
queue — mitigated operationally (driver setting "print spooled documents first" off /
direct printing) and documented in `printer-compatibility.md` §6. **We never promise
exactly-once physical printing** (PRD G8) — the model is at-most-once per attempt with
auditable ambiguity.

## T5 — Dependency compromise (supply chain)

**Scenario:** a transitive npm package is hijacked (protestware, credential stealer,
postinstall malware).

| Mitigation                                                                                                                                                 | Notes                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Minimal dependency tree; every direct dependency license+maintenance vetted at adoption (`.research/dependency-research.md`) and re-vetted at each upgrade | Abandoned packages (e.g. `escpos*`) rejected even though popular |
| `package-lock.json` committed; exact versions; CI `npm ci` only                                                                                            | No floating ranges                                               |
| `ignore-scripts` in CI installs; `postinstall` reviewed for every new dep (N-API prebuilds preferred so no rebuild scripts needed)                         | Blocks the most common install-time payload                      |
| `npm audit` + `osv-scanner` on SBOM (CycloneDX via `@cyclonedx/cyclonedx-npm`) in CI; release blocked on high/critical                                     |                                                                  |
| Native modules limited to: `better-sqlite3` (prebuilt N-API), our own small spooler shim, optional `usb`/`serialport`                                      | Each is a known, small, auditable surface                        |
| Renovate/Dependabot with manual review; no same-day auto-bump of runtime deps                                                                              |                                                                  |
| License gate in CI: reject GPL/AGPL/SSPL into the distribution (script reads SBOM)                                                                         | Keeps commercial distribution clean (G6)                         |

**Residual:** a compromised popular build tool is a ecosystem-wide risk; pinned,
reproducible CI (`npm ci` + fixed Node/Electron versions) limits blast radius and
enables rebuild-from-source.

## T6 — Insecure updates

**Scenario:** attacker serves a malicious update (MitM on update channel, hijacked
feed, downgrade attack).

| Mitigation                                                                                                                 | Notes                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| No update channel exists at all (ADR-14): no auto-updater, no feed — CLAUDE.md rule 11 forbids any update channel that is not signature-verified end to end | The update-feed RCE surface (compromised feed, fake `latest.yml`, MitM'd updater) is eliminated by absence, not by signature validation |
| Installer distribution is manual: download from the SaaS download page; SHA-256 checksum published with the GitHub Release | Checksum is verified by the release engineer at publish time — a publish-time integrity check, not an end-user cryptographic guarantee      |
| On-device mitigations unchanged: DPAPI-protected identity store; Electron fuses (RunAsNode off, asar integrity validation on, onlyLoadAppFromAsar); no listening sockets | Limits blast radius if a tampered installer is ever run                              |

**Residual:** accepted and reviewed at ADR-14 — no downgrade protection (installing an
older installer file simply reverts the version), no kill switch, no staged rollout; a
broken release is pulled from the download page and restaurants reinstall the previous
installer (operations.md §3). A malicious or compromised download page serving a
tampered installer is an honest residual risk — checksum verification is not an
end-user guarantee. Revisit trigger: SmartScreen becomes an operational support
burden, or any decision to add an update channel.

## T7 — Local privilege / data exposure on the cashier PC (secondary)

- Job payloads (order data) at rest in SQLite: filesystem ACL to the service user;
  consider SQLCipher only if a compliance driver emerges (deferred — DPAPI on identity
  covers the high-value secret; order data is also present in the POS backend anyway).
- Log redaction: no customer PII (names, phones) in logs; log-bundle upload is
  agent-user-confirmed.

## Risk register (top)

| #   | Risk                                                            | Sev  | Mitigation anchor                                   |
| --- | --------------------------------------------------------------- | ---- | --------------------------------------------------- |
| R1  | Real printers deviate from ESC/POS baseline (codepages, cut/QR) | High | printer-compatibility §6, physical validation phase |
| R2  | "Sent ≠ printed" confusion in support/UI                        | Med  | api-contract §3.1 wording table (normative)         |
| R3  | npm supply-chain incident                                       | Med  | T5 gates                                            |
| R4  | Win32 spooler RAW shim Windows-version variance                 | Med  | physical validation phase; TCP is primary path      |
| R5  | Restaurant networks block outbound WSS (proxy/firewall)         | Med  | operations runbook; HTTPS fallback                  |
