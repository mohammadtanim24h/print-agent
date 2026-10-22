# Architecture Decision Record — Print Agent v1

Status legend: `accepted` · context/evidence in linked docs. Supersedes none; may be
superseded by future ADRs (append, don't edit).

| # | Decision | Status | Rationale & evidence | Alternatives considered |
|---|---|---|---|---|
| ADR-1 | **Electron (main process owns everything; sandboxed renderer is UI-only)** | accepted | Need Node APIs (net/usb/spooler) + local UI + signed auto-update on Win10/11. MIT. Electron 45 = Node 24. `architecture.md` §2 | Tauri (WebView2 variance; weaker native-module story); plain background Node service + manual UI (no packaged updater/UX); .NET (relicense & rewrite risk for team stack) |
| ADR-2 | **Outbound-only networking: persistent WSS to SaaS + REST fallback; zero listeners** | accepted | PRD G2/AC-4; cashier PCs are unmanaged, NAT'd, untrusted-LAN. Removes a whole attack class (T3) | Local HTTP API + cloud tunnel (inbound exposure, firewall prompts); MQTT (extra broker infra, no gain — SaaS already Laravel) |
| ADR-3 | **Server sends structured doc JSON (v1) only; agent renders ESC/POS locally** | accepted | Keeps SaaS printer-agnostic, enables per-printer dialect/codepage config, allows renderer fixes without re-issuing jobs; raw bytes from server = injection + dialect-lock risk (T2) | Server-rendered ESC/POS bytes (smaller agent, but couples dialect to server and widens T2); HTML→raster via Chromium print (no ESC/POS fidelity, no speed) |
| ADR-4 | **Transports: TCP raw :9100 primary; Win32 spooler RAW (own N-API shim) fallback; USB deferred to v1.1** | accepted | 9100 is the universal thermal-printer path (verified fire-and-forget). No maintained npm package wraps spooler RAW (verified 2026-10); shim is ~100 lines. `webContents.print` rasterizes (rejected) | All-spooler (driver dependency per model, buffering duplicates); `pdf-to-printer` (bundles GPLv3 SumatraPDF → license-incompatible + raster-only) |
| ADR-5 | **State machine without a `printed` state; `completed` = hand-off confirmed; explicit `ambiguous` state** | accepted | TCP 9100/spooler give no physical ack; honesty beats optimism (PRD G8, api-contract §3.1 normative wording). DLE EOT is best-effort `printer_status`, not a state | Claiming `printed` from DLE EOT (printer-dependent, will lie on most of the fleet); silently retrying sends (duplicate bomb, T4) |
| ADR-6 | **At-least-once to agent, at-most-once print attempt per execution; idempotency key + ambiguity window + configurable duplicate policy** | accepted | Exactly-once physical printing is impossible over these transports; auditable ambiguity + `DUPLICATE` banner is the best safe substitute (T4) | At-least-once printing (unbounded duplicates during outages); fire-and-forget (silent loss) |
| ADR-7 | **Pairing = single-use short-TTL code + Ed25519 device keypair + rotating device tokens; server-signed jobs; DPAPI at-rest** | accepted | No user passwords on devices; key stays on device; `sig` defends against rogue backend/MitM (T1/T2); revocation server-authoritative | Shared static API key (theft-prone, no rotation); mTLS client certs (cert provisioning at restaurants is operationally heavy) |
| ADR-8 | **Multi-tenant isolation: one agent ↔ one restaurant; scope in token + re-checked per job** | accepted | Simplest strong isolation; hub-mode deferred with schema ready (`restaurant_id` on all rows) | Hub agent for chains (v2+; adds cross-tenant blast radius) |
| ADR-9 | **`better-sqlite3` local durable queue; jobs persisted before print; WAL mode** | accepted | Survives crash/power loss (G4, AC-2); N-API prebuilds (no electron-rebuild — verified) | JSON file queue (no crash atomicity at volume); IndexedDB (renderer-side — wrong trust domain) |
| ADR-10 | **Testing via layered virtual printing: in-memory mock transport (unit), `escpos-emulator` TCP+REST (integration/CI), file-port spooler capture, mocked USB + optional Pi-Zero gadget smoke** | accepted | USB cannot be CI-simulated (usbipd-win can't create devices — verified); escpos-emulator (MIT, 2026) gives semantic assertions; Generic/Text-Only driver mangles bytes (verified) → fixed local port instead | Hardware-only QA (blocks CI, PRD G7); Android emulators (wrong OS) |
| ADR-11 | **Strict zod schemas at every boundary; unknown payload fields rejected; control bytes stripped pre-ESC/POS; renderer fuzzed** | accepted | Boundaries: WSS in/out, IPC, config files (T2, T3). Cheap to enforce, catches supply-chain/compromise payloads early | Validate-only-at-server (agent trusts cloud — fails T2 threat model) |
| ADR-12 | **electron-builder + electron-updater, Authenticode-signed, append-only feed, downgrade refusal, staged rollout + kill switch** | accepted | T6; current electron-updater addresses GHSA-9jxc-qjr9-vjxq class issues | electron-forge (viable, weaker updater story); no auto-update (restaurants won't patch manually) |
| ADR-13 | **Dependency admission policy: license gate (MIT/Apache/BSD/ISC only), maintenance check, `ignore-scripts`, SBOM + audit in CI, minimal tree** | accepted | G6; verified rejections: `escpos*` (abandoned), `pdf-to-printer` (GPLv3 bundle). `.research/dependency-research.md` | "Popular = safe" (explicitly rejected by requirements) |

## Implementation order (phases; each phase ships tested, PRD AC-7)

| Phase | Deliverable | Key exit test |
|---|---|---|
| **P0 — Scaffolding & guardrails** | Electron skeleton (hardened fuses, CSP, no listeners assertion), CI (npm ci, lint, test, SBOM/license gate), CLAUDE.md conventions live | AC-4 test passes in CI; license gate blocks a seeded GPL dep |
| **P1 — Local store + job engine core** | SQLite schema, state machine, idempotency, expiry, crash-recovery→`ambiguous`, mock transport | AC-2, AC-3 (unit + integration) |
| **P2 — Renderer** | Doc model v1 → ESC/POS via node-thermal-printer; preview raster; fuzz corpus | AC-1 render half: byte assertions vs mock; fuzz zero-panic |
| **P3 — TCP transport + virtual printer integration** | `tcp-raw`, timeouts, retries; CI runs `escpos-emulator` | AC-1 end-to-end: decoded REST assertions on emulator |
| **P4 — Cloud client + API contract** | WSS client, REST fallback, zod schemas both directions, contract test matrix (`api-contract.md` §6); Laravel-side contract fixtures | Full §6 matrix green against a mock server + Laravel fixture tests |
| **P5 — Pairing, identity, config, revocation** | Pairing wizard, DPAPI identity, token rotation, config-sync, revoke+wipe | AC-5; T1/T2 test cases |
| **P6 — Local UI & diagnostics** | Tray, status, test print, ambiguous-resolution prompt, log bundle, heartbeat | FR-18/19; runbook §4.1 walkthrough |
| **P7 — Spooler transport (Windows)** | N-API shim, file-port capture tests, driver inventory | Byte-exact capture vs mock; flagged §6 R-VAL-4 pending hardware |
| **P8 — Packaging, updates, ops** | electron-builder, signing pipeline (cert required), staged feed, kill switch, installer upgrade tests | T6 checklist; upgrade smoke Win10/11 |
| **P9 — Hardware validation phase** | Physical matrix: R-VAL-1…10 (`printer-compatibility.md` §6), per-model config presets | Exit criteria in §6; produce preset catalog |
| **P10 — Hardening & pilot** | Threat-model test sweep (T1–T7), load burst (R-VAL-6), staged pilot with 2–3 restaurants | Monitoring alerts live; success metrics from PRD §8 |

Critical path note: P4/P5 require mirrored Laravel-side work (endpoints, signing keys,
agent registry) — contract fixtures in P4 are designed so both teams can build
in parallel against `api-contract.md` as the single source of truth.
