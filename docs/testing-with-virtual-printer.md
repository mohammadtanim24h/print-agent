# Testing the print pipeline with a virtual ESC/POS printer

How to exercise the full chain — **restaurant dashboard (Laravel) → print agent →
ESC/POS byte stream** — without physical hardware. Two routes:

| Route | What it covers | Effort |
|---|---|---|
| **A. Automated E2E harness** | Pairing → online → config apply → job → render → tcp_raw send → acks → backend `completed`, all in one `vitest` run | Low (env vars + `php artisan serve`) |
| **B. Manual, real Electron app** | Same chain driven through the actual installed/dev app UI, with a standalone emulator listening on :9100 | Medium (manual pairing + dashboard clicks) |

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

### 1. Run a standalone ESC/POS capture listener on :9100

Save as `emulator.mjs` anywhere **outside** the agent repo and run it with
`node emulator.mjs`. It binds your LAN IP (loopback is blocked by the
approved-destination policy), accepts one connection at a time, and dumps the
stream to `capture.bin` + a hex/text log:

```js
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';

const LAN_IP = Object.values(os.networkInterfaces())
  .flat()
  .find((i) => i?.family === 'IPv4' && !i.internal)?.address;
if (!LAN_IP) throw new Error('no LAN IPv4 interface');

const chunks = [];
net
  .createServer((socket) => {
    console.log(`[${new Date().toISOString()}] connection from ${socket.remoteAddress}`);
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      console.log(`<${chunk.length} bytes> ${chunk.toString('hex').slice(0, 120)}...`);
    });
    socket.on('close', () => {
      fs.writeFileSync('capture.bin', Buffer.concat(chunks));
      const text = Buffer.concat(chunks)
        .toString('latin1')
        .replace(/[\x00-\x1f\x7f]/g, '.');
      console.log('--- stream (control chars as dots) ---\n' + text);
      console.log(`saved ${Buffer.concat(chunks).length} bytes to capture.bin`);
    });
  })
  .listen(9100, LAN_IP, () => console.log(`ESC/POS emulator on ${LAN_IP}:9100`));
```

Notes:

- This listener is a separate process — the agent's "no listening sockets"
  security rule applies to the agent itself, not to your test tooling.
- Port 9100 semantics = plain socket, no protocol; the emulator never talks back.
- Alternatively, a third-party emulator such as the MIT-licensed `escpos-emulator`
  npm package (TCP :9100 + REST for decoded-output assertions) works the same
  way — bind it to the LAN IP and point the printer config at it. Check license
  and install scripts before adopting it permanently (dependency admission rules).

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
- Host: your **LAN IPv4** (from the emulator's startup line), e.g. `192.168.1.42`
- Port: `9100`
- Role/paper width per your test scenario (80 mm receipt is the default)

The agent picks it up via the config stream (push, or within the 60 s periodic
config refresh). Verify it appears in the agent tray UI printer list.

### 4. Trigger prints

1. **Test print** from the agent tray UI → emulator console should log a
   connection and `capture.bin` should start with `1b 40`.
2. **Real job**: place an order / trigger the print action in the dashboard
   (POS side) → watch the job status march `accepted → sent_to_printer →
   completed` in the dashboard job log, and the bytes land in the emulator.
   `completed` means *hand-off to the transport succeeded* — it never means
   "physically printed".

### 5. Verify the stream

Open `capture.bin` in a hex viewer, or decode it with
`tests/helpers/escpos-decode.ts` (see Route A step 5). For a receipt you
should see: `init` → alignment/bold/size commands → your order text lines →
`feed` → `cut`.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Printer connect fails / refused | Emulator bound to `127.0.0.1` — approved-destination policy blocks loopback; bind the LAN IP |
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
