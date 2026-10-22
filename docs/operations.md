# Operations Guide — Print Agent

**Version:** 1.0 (2026-10-22) · Audience: SaaS support engineers, restaurant IT,
release engineers.

## 1. Installation (per restaurant)

1. Download installer (`PrintAgent-Setup-x.y.z.exe`) from the SaaS download page
   (Authenticode-signed; verify signature before run).
2. Run installer (per-user install, no admin required unless the spooler transport is
   used — driver installation is a separate vendor step).
3. Launch → tray icon → pairing wizard → enter pairing code from web app
   (`Settings → Printing → Add agent`, code TTL 10 min, single use).
4. Add printers in the web app (transport kind, IP/port or Windows printer name,
   station), then run **Test print** per printer from the agent tray UI.
5. Health is visible in web app `Settings → Printing → Agents` (heartbeat ≤ 90 s old).

Site network prerequisites: outbound TCP 443 (wss+https) to `*.saas-host`; outbound TCP
9100 to printer IPs on the local LAN; no inbound rules; NTP-synchronized clock
(expiry checks depend on it; RTC skew > 5 min raises a diagnostic warning).

## 2. Daily operation

- Agent autostarts at login (documented registry `Run` key), single-instance lock.
- Job statuses appear in the web app per the normative wording table
  (`api-contract.md` §3.1). Support scripts must never tell customers "printed" —
  the strongest supported claim is "sent to printer / handed off".
- `ambiguous` jobs surface in the agent tray UI ("Verify printer — outcome of last
  ticket unknown") and in the web app; resolution per printer `duplicate_policy`
  (`ask_operator` default).

## 3. Updates

| Aspect | Policy |
|---|---|
| Channel | Stable only; staged rollout 5% → 25% → 100% over 72 h |
| Feed | HTTPS feed, append-only `latest.yml`, publisher-signed installer |
| Downgrades | Refused by agent (T6) |
| Kill switch | Feed can pin `max_version`; support can freeze a broken release |
| Pre-req | Electron major upgrades (8-week cadence) tested against our contract test suite before release-train inclusion |

Rollback procedure: kill switch to previous manifest + silent reinstall of prior
signed installer (downgrade-guard override is a support-tool flag, never a default).

## 4. Diagnostics & support runbooks

### 4.1 Diagnostics surface (local UI)
Tray menu: agent status, connection state, queue depth, per-printer last outcome,
"Export diagnostics bundle" (zip: redacted logs, config snapshot without secrets,
recent 50 job outcomes, OS/print-driver inventory). Upload is user-confirmed.

### 4.2 Runbook: printer not printing
1. Web app: job status? `failed` → error code; `sent_to_printer` stuck → §4.3;
   `ambiguous` → resolve prompt.
2. Agent tray → printer health; run Test print.
3. TCP transport: `Test-NetConnection <printer-ip> -Port 9100` from the cashier PC.
4. Spooler transport: Windows queue paused? driver datatype RAW? (printer-compat §6).
5. Paper/cover LEDs; power-cycle printer (expect possible `ambiguous` on in-flight job).
6. Collect diagnostics bundle → attach to ticket.

### 4.3 Runbook: jobs stuck in "sent_to_printer" / duplicated
- Known physical ambiguity (PRD G8): a stuck `sent_to_printer` with a healthy printer
  usually means paper-out mid-stream — check printer, use manual reprint.
- Duplicates: capture job `idempotency_key` + `attempt` values from the web app job
  log; check printer-driver spool-reprint setting (T4 residual); file issue with
  diagnostics bundle.

### 4.4 Runbook: compromised/lost device
1. Web app → Agents → **Revoke** (immediate server-side enforcement).
2. If device returns: fresh install + re-pair; local wipe happens on next connect of
   the old install (or uninstall manually).
3. Rotate nothing on the SaaS side beyond the agent identity (tenants are unaffected).

### 4.5 Runbook: restaurant network blocks WSS
- Fallback REST polling engages automatically (60 s interval, degraded latency).
- Ask site IT to allow outbound 443 to the SaaS host; proxy with TLS interception is
  unsupported for WSS (cert pinning) — REST polling still works.

## 5. Monitoring (SaaS side)

| Signal | Alert |
|---|---|
| Agent heartbeat absent ≥ 5 min | Warn (per agent) |
| `failed` ack rate > 5% / 15 min per restaurant | Page |
| `ambiguous` rate > 2% | Page (indicates crashes/power loss) |
| Queue age (issued → accepted) > 60 s with agent online | Warn |
| Token-refresh conflicts (possible theft, T1) | Immediate revoke + notify |

## 6. Build & release checklist

1. CI: `npm ci` (ignore-scripts), unit + contract tests (virtual printer), fuzz corpus
   for renderer, `npm audit` + SBOM license gate, packaging, installer signing.
2. Upgrade smoke on: Win10 19045, Win11 23H2, clean profile + upgrade path.
3. Sign installer → upload feed → stage 5%.
4. Verify update telemetry (version adoption, crash-free rate) before advancing.

## 7. Support data retention

- Agent local logs: 14 days rolling, PII-redacted (threat T7).
- Diagnostics bundles: stored in SaaS support ticket scope, 90 days.
- Job outcome history: server-side per tenant retention policy (SaaS concern).
