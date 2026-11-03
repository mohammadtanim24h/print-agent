# Testing the print pipeline with a virtual ESC/POS printer

How to exercise the full chain — **restaurant dashboard (Laravel) → print agent →
ESC/POS byte stream** — without physical hardware. Two routes:

| Route | What it covers | Effort |
|---|---|---|
| **A. Automated E2E harness** | Pairing → online → config apply → job → render → tcp_raw send → acks → backend `completed`, all in one `vitest` run | Low (env vars + `php artisan serve`) |
| **B. Manual, real Electron app** | Same chain driven through the actual installed/dev app UI, with the `escpos-emulator` package listening on :9100 | Medium (manual pairing + dashboard clicks) |

Both use the same principle: the agent's `tcp_raw` transport just opens a TCP
socket to `<ip>:9100` and writes the ESC/POS stream — anything that accepts
bytes on that port "is" a printer. The in-house helper
`tests/helpers/virtual-printer.ts` is such a listener; the decoder in
`tests/helpers/escpos-decode.ts` turns captured bytes back into semantic
events (`text`, `cut`, `qr`, …) for assertions.

**Key gotcha up front:** the agent's approved-destination policy
(`src/main/printers/profile.ts` → `isApprovedEndpointHost`) only allows IP
literals and **blocks loopback**. Your emulator must bind to the machine's LAN
IPv4 address, not `127.0.0.1`, and the dashboard/agent config must reference
that LAN IP.

---

## Route A — automated live-backend E2E (recommended)

Harness: `tests/local-backend.e2e.test.ts` (env-gated, skipped in CI). It
starts a real `AgentRuntime` (real HTTP transport, kv file, printer store, job
store, tcp_raw transport) with a capture printer, pairs against the real
Laravel backend, and drives a POS-side job all the way to backend `completed`.

### 1. Start the Laravel backend locally

In the servepro-api repo (never modify it — this is read/run only):

```bash
php artisan serve   # http://localhost:8000
```

Local dev `.env` should have `PRINT_PAIRING_MAX_ATTEMPTS=100` to avoid the
prod-default pair rate limit (3 attempts / 15 min per IP).

### 2. Generate a pairing code in the dashboard

Log into the restaurant web app served by the backend:
`Settings → Printing → Add agent` → copy the 8-character code.
Codes are **single-use** and expire after **10 minutes** — generate a fresh
one per run.

### 3. Run the harness

From the print-agent repo root:

```bash
E2E_BACKEND_URL=http://localhost:8000 \
E2E_PAIRING_CODE=XXXXXXXX \
E2E_ADMIN_EMAIL=print@first.test \
E2E_ADMIN_PASSWORD=secret123 \
pnpm exec vitest run tests/local-backend.e2e.test.ts
```

The admin credentials are optional but enable the full POS → agent → ack leg
(create cloud printer → wait for config stream to apply it → enqueue a job for
an existing order → watch the backend reach `completed`, which only an agent
ack drives).

### 4. What you should see

Console lines prefixed `[e2e]` walk the whole flow:

1. `capture printer on <lan-ip>:<port>` — the virtual printer's ephemeral port
2. `pair result: {...}` — device identity issued (UUID device id)
3. reused-code replay rejected server-side (`code_invalid` / 4xx)
4. `connectionState: online` — poll + heartbeat cycle working
5. `GET /config → 200` — payload validates against the agent's strict zod schema
6. `testPrint: ...` then `captured N bytes of ESC/POS` — the captured stream
   must start with `1b 40` (`ESC @`, ESC/POS init)
7. (with admin creds) job claims, acks `accepted → sent_to_printer → completed`,
   and the backend order job reaching `completed`

### 5. Optional: inspect the bytes semantically

The harness asserts raw bytes. To decode a capture into human-readable events,
use the existing decoder in a scratch script:

```ts
import { readFileSync } from 'node:fs';
import { decodeEscpos } from './tests/helpers/escpos-decode';

const bytes = new Uint8Array(readFileSync('capture.bin'));
for (const ev of decodeEscpos(bytes)) console.log(ev);
// → { kind: 'init' }, { kind: 'text', text: '...' }, { kind: 'cut', full: false }, ...
```

---

## Route B — manual run with the real Electron app + a standalone emulator

Use this when you want to click through the actual app (pairing wizard, tray
UI, Test print) or demo the flow end-to-end.

### 1. Run the `escpos-emulator` package on :9100

[`escpos-emulator`](https://www.npmjs.com/package/escpos-emulator) (MIT, v0.3.0)
is an ESC/POS thermal receipt printer emulator: it accepts raw byte streams on a
TCP port like a real printer, **parses** them, and serves the decoded receipt as
a live HTML preview plus a REST API — no hexdump squinting required.

```bash
npx escpos-emulator   # no install needed; or: npm i -g escpos-emulator
```

Startup output:

- **TCP printer**: port `9100` (env `TCP_PORT` to change) — point the agent here
- **Web UI / REST API**: port `3000` (env `HTTP_PORT`) — open
  `http://localhost:3000` in a browser to watch receipts render live

Notes:

- It is a separate process — the agent's "no listening sockets" security rule
  applies to the agent itself, not to your test tooling.
- It binds **all interfaces** (no host restriction), so it is reachable on your
  LAN IPv4 automatically. The agent's approved-destination policy still blocks
  loopback, so the printer config must reference the **LAN IPv4**, never
  `127.0.0.1`. Expect a Windows Firewall prompt on first run — allow Node on
  private networks.
- It emulates an **Epson TM-M30III** (80 mm paper, 42 chars/line) — matches the
  default agent receipt profile.
- It never talks back on the socket (no DLE EOT status replies) — keep
  `statusPolling: false` on test printers.
- Unsupported commands are skipped with a console warning; notably **QR codes
  (`GS ( k`) and raster bit images (`GS v 0`) are not rendered** in the preview.
  Cut, bold, size, alignment, feed, and CODE128 barcodes all render.

Useful knobs and REST endpoints (in single-printer mode the printer id is
`default`; `GET /api/printers` lists all ids):

```bash
# Multiple virtual printers (kitchen/bar at different ports)
PRINTERS='[
  {"id":"counter","name":"Counter","tcpPort":9100},
  {"id":"kitchen","name":"Kitchen","tcpPort":9101}
]' npx escpos-emulator

# Semantic verification from the shell (decoded receipt as JSON)
curl http://localhost:3000/api/printers/default/receipts/last

# Reset between test runs
curl -X DELETE http://localhost:3000/api/printers/default/receipts
```

There is also a Docker image (`ghcr.io/lezram/escpos-emulator`) if you prefer
not to run Node directly — publish both `9100` and `3000`.

### 2. Run the agent dev app and pair

```bash
pnpm dev
```

- The dev app needs `PRINT_AGENT_ALLOW_HTTP` set to talk to a plain-`http://`
  local backend, and `PRINT_AGENT_API_URL` must include the `/api/agent/v1`
  path prefix.
- Tray → Setup → enter a fresh pairing code from the dashboard
  (`Settings → Printing → Add agent`). Single-use, 10-minute TTL.

### 3. Add the printer in the dashboard, pointed at the emulator

Dashboard: `Settings → Printers` → add a printer with:

- Transport kind: `tcp_raw`
- Host: your **LAN IPv4** (run `ipconfig`), e.g. `192.168.1.42` — never
  `127.0.0.1` (loopback is blocked by the approved-destination policy)
- Port: `9100`
- Role/paper width per your test scenario (80 mm receipt is the default)

The agent picks it up via the config stream (push, or within the 60 s periodic
config refresh). Verify it appears in the agent tray UI printer list.

### 4. Trigger prints

1. **Test print** from the agent tray UI → the emulator console logs the
   connection, and the receipt appears live in the web UI at
   `http://localhost:3000` (a blank/absent receipt means the stream was
   rejected — check the console for skipped-command warnings).
2. **Real job**: place an order / trigger the print action in the dashboard
   (POS side) → watch the job status march `accepted → sent_to_printer →
   completed` in the dashboard job log, and the receipt land in the emulator.
   `completed` means *hand-off to the transport succeeded* — it never means
   "physically printed".

### 5. Verify the receipt content

The emulator decodes the stream for you — three ways, cheapest first:

1. **Web UI** (`http://localhost:3000`): the receipt renders as it would on
   paper — check alignment, bold/size, order lines, feed and cut.
2. **REST API**: `GET /api/printers/:id/receipts/last` returns the decoded
   receipt as JSON (text lines with their style state). `DELETE
   /api/printers/:id/receipts` clears history between runs.
3. **Raw bytes**: for byte-exact assertions, decode a capture with
   `tests/helpers/escpos-decode.ts` (see Route A step 5). For a receipt you
   should see: `init` → alignment/bold/size commands → your order text lines →
   `feed` → `cut`.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Printer connect fails / refused | Printer host is `127.0.0.1` — approved-destination policy blocks loopback; use the LAN IPv4 (the emulator itself listens on all interfaces) |
| Printer connect fails / Windows Firewall prompt | Node blocked on private networks — allow it, or the agent's outbound connection is dropped |
| Receipt missing from web UI | Stream rejected or all commands skipped — check the emulator console; QR (`GS ( k`) and raster images (`GS v 0`) are not rendered |
| Config (printer) never appears in agent | Cloud config applies on push or the 60 s refresh — wait one cycle, check agent connection state is `online` |
| Pairing fails `code_invalid`/`code_expired` | Code already used or >10 min old — generate a fresh one; also watch the 3/15 min rate limit on a prod-default backend |
| Pair attempt returns an HTML 429 page | Pair rate limiter — set `PRINT_PAIRING_MAX_ATTEMPTS=100` in the backend `.env` or wait 15 min |
| Job stuck at `sent_to_printer` | Agent wrote bytes but got no app-level ack — TCP 9100 has none by design; this is the documented ambiguity window, not a bug |
| Backend never reaches `completed` | Only an agent ack drives it — confirm the agent is online and paired to the right restaurant |

## What this setup does *not* cover

- Physical print outcomes (paper-out, cover-open) and `ambiguous`-state drills
  need real hardware or the spooler capture path (`tests/spooler-raw-capture.test.ts`).
- Status polling (`printer_ack`) requires a printer that answers DLE EOT — the
  plain capture listener does not; keep `statusPolling: false` on test printers.
