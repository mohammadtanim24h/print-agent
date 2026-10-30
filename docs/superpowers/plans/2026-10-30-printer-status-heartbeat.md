# Printer Status Polling in Heartbeats (C1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded `health: 'unknown'` in heartbeats and `printer_status: 'unknown'` in acks with real best-effort DLE EOT status for tcp_raw printers that opt in (`profile.statusPolling === 'auto'`), via a slow background poller + TTL cache. The print path's behavior is unchanged.

**Architecture:** Three pieces: (1) `tcp-raw` gains `status()` probing DLE EOT 1+2 on a *separate ephemeral socket* per poll (never the job socket, so poll bytes cannot interleave with job writes); (2) new `printers/status-poller.ts` owns a pure response parser, a TTL cache and the injected ~30 s timer; (3) `agent-runtime.ts` wires the poller into `heartbeatSample()`, the lifecycle, and an injected engine ack lookup. spooler_raw printers always report `'unknown'` (one-way pipe).

**Tech Stack:** TypeScript strict, vitest, zod (no new schemas needed). Node `net` socket adapter gains a `data` event overload.

**Spec:** `docs/superpowers/specs/2026-10-30-printer-status-heartbeat-design.md`

**Test commands:** `pnpm vitest run <file>` for a single file; `pnpm test` for the suite; `pnpm typecheck` and `pnpm lint` before each commit.

---

## File Structure

- Modify `src/main/transport/types.ts` — `PrinterTransport.status?()` signature becomes raw-bytes tuple (parser stays out of the transport).
- Modify `src/main/transport/socket.ts` — `TransportSocket` gains a required `on('data')` overload; production adapter unchanged (contextual typing must still pass typecheck).
- Modify `src/main/transport/errors.ts` — new code `'status_failed'`.
- Modify `src/main/transport/tcp-raw.ts` — `status()` implementation + `statusTimeoutMs` option.
- Create `src/main/printers/status-poller.ts` — pure parser `parseDleEotStatus` + `createStatusPoller` + gate helper `statusPollingEnabled`.
- Modify `src/main/jobs/engine.ts` — optional `printerStatus` dep used when building acks.
- Modify `tests/helpers/job-engine-harness.ts` — pass-through `printerStatus` option.
- Modify `src/main/agent-runtime.ts` — construct poller, wire heartbeat + lifecycle + engine.
- Create `tests/status-poller.test.ts`.
- Modify `tests/tcp-raw.test.ts`, `tests/job-engine-execution.test.ts`, `tests/agent-runtime.test.ts`.
- Modify `docs/architecture.md` (§3.4), `docs/printer-compatibility.md` (§6 R-VAL-3 row), `docs/production-readiness.md` (C1 status note).

Test helpers that already exist and are reused below:
- `tests/helpers/mock-socket.ts` — `MockSocket` extends `EventEmitter`, so `sock.emit('data', buffer)` works with no helper changes; `mockSocketFactory(script)` runs the script on a microtask.
- `tests/helpers/printers.ts` — `makeDraft(overrides)` / `makeProfile(overrides)`; default transport is `tcp_raw` to `192.168.1.50:9100`.
- `tests/helpers/job-engine-harness.ts` — `makeHarness` / `makeJob`.
- `tests/helpers/memory-adapter.ts` — `memoryAdapter(null)`.

---

### Task 1: DLE EOT response parser (pure function)

**Files:**
- Create: `src/main/printers/status-poller.ts`
- Test: `tests/status-poller.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/status-poller.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { parseDleEotStatus } from '../src/main/printers/status-poller';

/**
 * Bit semantics per the ESC/POS R&P spec (DLE EOT 1 = printer status,
 * DLE EOT 2 = paper sensor). Byte examples use realistic raw values —
 * e.g. many models set bit 6 (0x40) of the DLE EOT 1 response to 1.
 */
describe('parseDleEotStatus', () => {
  it.each([
    ['ok when nothing is flagged', 0x12, 0x00, 'ok'],
    ['ok with reserved bit 6 set', 0x40, 0x00, 'ok'],
    ['printer error bit → offline', 0x20, 0x00, 'offline'],
    ['error bit beats every other condition', 0x24, 0x38, 'offline'],
    ['cover open bit → cover_open', 0x04, 0x00, 'cover_open'],
    ['paper-out bits (0x38) → paper_out', 0x00, 0x08, 'paper_out'],
    ['paper-out + near-end → paper_out wins', 0x00, 0x09, 'paper_out'],
    ['near-end bits (0x07) → paper_low', 0x00, 0x01, 'paper_low'],
    ['paper_out beats cover_open on severity', 0x04, 0x38, 'paper_out'],
    ['all zero → ok', 0x00, 0x00, 'ok'],
  ])('%s', (_name, printerByte, paperByte, expected) => {
    expect(parseDleEotStatus(printerByte, paperByte)).toBe(expected);
  });

  it('fuzz: deterministic 5000-pair corpus never throws and stays in the status enum', () => {
    const allowed = new Set(['ok', 'unknown', 'offline', 'paper_out', 'paper_low', 'cover_open']);
    let seed = 0x12345678;
    const nextByte = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 16) & 0xff;
    };
    for (let i = 0; i < 5_000; i += 1) {
      const status = parseDleEotStatus(nextByte(), nextByte());
      expect(allowed.has(status)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/status-poller.test.ts`
Expected: FAIL — cannot resolve `parseDleEotStatus` (module is empty).

- [ ] **Step 3: Write the parser**

Create `src/main/printers/status-poller.ts` (parser only; the poller lands in Task 3 in this same file):

```typescript
import type { PrinterStatus } from '../transport/types';

/**
 * DLE EOT response → health mapping (production-readiness C1, R-VAL-3).
 * Bit semantics follow the ESC/POS R&P spec; exact fleet behavior is what
 * R-VAL-3 must confirm on hardware, hence the profile-level gate defaults
 * to off (`statusPolling` undefined or 'off').
 */

/** DLE EOT 1 (printer status) bit 2: cover open. */
const COVER_OPEN_BIT = 0x04;
/** DLE EOT 1 bit 5: printer error (offline-class). */
const PRINTER_ERROR_BIT = 0x20;
/** DLE EOT 2 bits 0–2: roll paper near-end (any sensor). */
const PAPER_NEAR_END_MASK = 0x07;
/** DLE EOT 2 bits 3–5: roll paper end (any sensor). */
const PAPER_OUT_MASK = 0x38;

/** Severity precedence: paper_out > cover_open > paper_low > ok; the error
 *  bit beats everything. */
export function parseDleEotStatus(printerByte: number, paperByte: number): PrinterStatus {
  if ((printerByte & PRINTER_ERROR_BIT) !== 0) return 'offline';
  if ((paperByte & PAPER_OUT_MASK) !== 0) return 'paper_out';
  if ((printerByte & COVER_OPEN_BIT) !== 0) return 'cover_open';
  if ((paperByte & PAPER_NEAR_END_MASK) !== 0) return 'paper_low';
  return 'ok';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/status-poller.test.ts`
Expected: PASS (all rows + fuzz).

- [ ] **Step 5: Typecheck + lint + commit**

Run: `pnpm typecheck && pnpm lint`

```bash
git add src/main/printers/status-poller.ts tests/status-poller.test.ts
git commit -m "feat(printers): pure DLE EOT status parser with fuzz corpus (C1)"
```

---

### Task 2: `status_failed` error code + socket `data` event + tcp-raw `status()`

**Files:**
- Modify: `src/main/transport/errors.ts`
- Modify: `src/main/transport/socket.ts`
- Modify: `src/main/transport/types.ts`
- Modify: `src/main/transport/tcp-raw.ts`
- Test: `tests/tcp-raw.test.ts` (new describe block)

- [ ] **Step 1: Write the failing tests**

Append to `tests/tcp-raw.test.ts` (imports of `mockSocketFactory`/`MockSockets` already exist at the top of the file):

```typescript
import { TransportError } from '../src/main/transport/errors';

/** Status-probe script: connects, then answers each poll write with the next
 *  queued byte via the socket's data event (MockSocket is an EventEmitter). */
function scriptedStatusSocket(
  responses: Array<Buffer | 'never'>,
): MockSockets {
  return mockSocketFactory((sock) => {
    sock.connect();
    const queue = [...responses];
    const write = sock.write.bind(sock);
    sock.write = (data, cb) => {
      write(data, cb);
      const next = queue.shift();
      if (next === 'never') return; // stay silent
      if (next !== undefined) queueMicrotask(() => sock.emit('data', next));
    };
  });
}

describe('tcp-raw transport — status probe (DLE EOT, C1)', () => {
  const HOST = '192.168.1.50';

  function makeStatusTransport(
    sockets: MockSockets,
    statusTimeoutMs = 500,
  ) {
    return createTcpRawTransport({
      host: HOST,
      port: 9100,
      socketFactory: sockets.factory,
      statusTimeoutMs,
    });
  }

  it('sends DLE EOT 1 + 2 on an ephemeral socket and returns the two response bytes', async () => {
    const sockets = scriptedStatusSocket([Buffer.from([0x12]), Buffer.from([0x00])]);
    const transport = makeStatusTransport(sockets);

    await expect(transport.status()).resolves.toEqual([0x12, 0x00]);

    expect(sockets.last()?.written).toEqual([
      Buffer.from([0x10, 0x04, 0x01]),
      Buffer.from([0x10, 0x04, 0x02]),
    ]);
    expect(sockets.last()?.destroyed).toBe(true);
  });

  it('never touches the job socket — probes open their own connection', async () => {
    const sockets = scriptedStatusSocket([Buffer.from([0x12]), Buffer.from([0x00])]);
    const transport = makeStatusTransport(sockets);
    await transport.open(); // job connection is open
    const jobSockets = sockets.sockets.length;

    await transport.status();

    expect(sockets.sockets.length).toBe(jobSockets + 1); // probe = separate socket
    await transport.close();
    expect(sockets.sockets.at(-1)?.destroyed).toBe(true); // probe already destroyed
  });

  it('connect refusal rejects with the connect code (poller maps it to offline)', async () => {
    const sockets = mockSocketFactory((sock) => {
      sock.refuse();
    });
    const transport = makeStatusTransport(sockets);
    await expect(transport.status()).rejects.toMatchObject({ code: 'connect_refused' });
  });

  it('no answer within the timeout rejects with status_failed', async () => {
    const sockets = scriptedStatusSocket(['never', 'never']);
    const transport = makeStatusTransport(sockets, 20);
    await expect(transport.status()).rejects.toMatchObject({ code: 'status_failed' });
  });

  it('trickled bytes (one per chunk) accumulate into the two-byte answer', async () => {
    const sockets = mockSocketFactory((sock) => {
      sock.connect();
      const write = sock.write.bind(sock);
      let nth = 0;
      sock.write = (data, cb) => {
        write(data, cb);
        nth += 1;
        const byte = nth === 1 ? 0x12 : 0x00;
        queueMicrotask(() => sock.emit('data', Buffer.from([byte])));
      };
    });
    const transport = makeStatusTransport(sockets);
    await expect(transport.status()).resolves.toEqual([0x12, 0x00]);
  });

  it('socket error mid-probe rejects with the classified code', async () => {
    const sockets = mockSocketFactory((sock) => {
      sock.connect();
      const write = sock.write.bind(sock);
      sock.write = (data, cb) => {
        write(data, cb);
        queueMicrotask(() => sock.failWithCode('ECONNRESET'));
      };
    });
    const transport = makeStatusTransport(sockets);
    await expect(transport.status()).rejects.toMatchObject({ code: 'disconnected' });
  });
});
```

Note: `MockSocket.failWithCode` emits `'error'` with a raw `ECONNRESET` errno; the probe's `error` handler classifies through `classifyConnectError`, which maps unknown errno values to `connect_refused`… but `ECONNRESET` is not in the classify map — check `classifyConnectError` in `src/main/transport/tcp-raw.ts`: it defaults to `'connect_refused'`. Adjust the last test's expectation to `{ code: 'connect_refused' }` (or assert only that it rejects with a `TransportError`). The version above asserting `disconnected` is wrong — use:

```typescript
  it('socket error mid-probe rejects with a classified transport code', async () => {
    const sockets = mockSocketFactory((sock) => {
      sock.connect();
      const write = sock.write.bind(sock);
      sock.write = (data, cb) => {
        write(data, cb);
        queueMicrotask(() => sock.failWithCode('ECONNRESET'));
      };
    });
    const transport = makeStatusTransport(sockets);
    await expect(transport.status()).rejects.toBeInstanceOf(TransportError);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/tcp-raw.test.ts`
Expected: FAIL — `status` is undefined on the transport; `statusTimeoutMs` is not in the options type; `TransportError` import fine.

- [ ] **Step 3: Add the error code**

In `src/main/transport/errors.ts`, extend the union (after `'write_failed'`):

```typescript
export type TransportErrorCode =
  | 'connect_refused'
  | 'connect_timeout'
  | 'host_unreachable'
  | 'dns_unsupported'
  | /** spooler_raw only: OpenPrinterW found no such printer on this machine. */ 'printer_not_found'
  | 'write_timeout'
  | 'write_failed'
  | /** status probe: no/garbage answer within the probe timeout (C1). */ 'status_failed'
  | 'disconnected'
  | 'not_open';
```

- [ ] **Step 4: Add the socket `data` event**

In `src/main/transport/socket.ts`, extend the interface (keep the existing factory body unchanged — `socket.on(event, listener)` forwards all four events; run typecheck to confirm contextual typing still holds):

```typescript
export interface TransportSocket {
  write(data: Uint8Array, cb: (err: Error | null) => void): void;
  destroy(): void;
  on(event: 'connect', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'close', listener: (hadError: boolean) => void): unknown;
  /** Inbound bytes (DLE EOT status responses). Job writes are
   *  fire-and-forget and never read; only status() consumes data events. */
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
}
```

If `pnpm typecheck` now fails in `createNetSocketFactory` (node `net` emits `Buffer`, which is a `Uint8Array` subtype, so it should pass), adapt the forwarder to explicit overloads rather than casting.

- [ ] **Step 5: Change the reserved transport signature**

In `src/main/transport/types.ts`, replace the reserved optional method:

```typescript
export interface PrinterTransport {
  /** Resolves when the connection is established; rejects with TransportError. */
  open(): Promise<void>;
  /** Resolves on kernel/driver acceptance — "sent to printer", NOT "printed". */
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  /** Cheap connect(+close) probe; rejects with TransportError on failure. */
  healthCheck(): Promise<void>;
  /** Best-effort DLE EOT probe (R-VAL-3): raw `[printerByte, paperByte]` from
   *  a dedicated ephemeral connection. Response interpretation lives in the
   *  status-poller module, not here. Implementations without a return channel
   *  (spooler_raw) leave this undefined. */
  status?(): Promise<readonly [printer: number, paper: number]>;
}
```

- [ ] **Step 6: Implement `status()` in tcp-raw**

In `src/main/transport/tcp-raw.ts`:

6a. Add to the constants at the top:

```typescript
export const DEFAULT_STATUS_TIMEOUT_MS = 2_000;
```

6b. Add module-level command constants (below the classify helpers):

```typescript
/** DLE EOT realtime status transmission (ESC/POS R&P). Probes run on their own
 *  ephemeral connection: poll bytes never interleave with job writes and the
 *  job path's writeTail ordering is untouched. */
const DLE_EOT_PRINTER_STATUS = new Uint8Array([0x10, 0x04, 0x01]);
const DLE_EOT_PAPER_SENSOR = new Uint8Array([0x10, 0x04, 0x02]);
```

6c. Extend `TcpRawTransportOptions` and the destructuring defaults inside `createTcpRawTransport`:

```typescript
export interface TcpRawTransportOptions {
  host: string;
  port: number;
  socketFactory: SocketFactory;
  connectTimeoutMs?: number;
  writeTimeoutMs?: number;
  /** Whole-probe budget for status(): connect + both DLE EOT answers. */
  statusTimeoutMs?: number;
}
```

```typescript
const statusTimeoutMs = options.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS;
```

6d. Add the `status` function before the `healthCheck` definition (inside `createTcpRawTransport`, so it closes over `host`, `port`, `target`, `socketFactory`, `statusTimeoutMs`):

```typescript
  /** One status probe: ephemeral connect → DLE EOT 1 → byte → DLE EOT 2 →
   *  byte → destroy. Connect-phase failures surface with the connect codes;
   *  a silent/garbage printer surfaces as 'status_failed' (the poller maps
   *  that to 'unknown' — never to 'offline', R-VAL-3). */
  const status = (): Promise<readonly [number, number]> =>
    new Promise((resolve, reject) => {
      const sock = socketFactory({ host, port });
      const bytes: number[] = [];
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const finish = (
        error: TransportError | null,
        result?: readonly [number, number],
      ): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        sock.destroy();
        if (error !== null) reject(error);
        else resolve(result as readonly [number, number]);
      };

      timer = setTimeout(() => {
        finish(
          new TransportError(
            'status_failed',
            `${target}: status probe timed out after ${String(statusTimeoutMs)}ms`,
          ),
        );
      }, statusTimeoutMs);

      sock.on('connect', () => {
        sock.write(DLE_EOT_PRINTER_STATUS, (err) => {
          if (settled) return;
          if (err !== null) {
            finish(classifyWriteError(err));
            return;
          }
          sock.write(DLE_EOT_PAPER_SENSOR, (err2) => {
            if (settled) return;
            if (err2 !== null) finish(classifyWriteError(err2));
          });
        });
      });
      sock.on('error', (err) => {
        finish(classifyConnectError(err, target));
      });
      sock.on('close', () => {
        finish(new TransportError('disconnected', `${target}: closed during status probe`));
      });
      sock.on('data', (chunk: Uint8Array) => {
        for (const byte of chunk) {
          bytes.push(byte);
          if (bytes.length === 2) {
            finish(null, [bytes[0] as number, bytes[1] as number]);
            return;
          }
        }
      });
    });
```

6e. Extend the returned object (last line of `createTcpRawTransport`):

```typescript
  return { open, write, close, healthCheck, status };
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run tests/tcp-raw.test.ts`
Expected: PASS — all pre-existing tests still green (the `data` overload changes no job-path behavior), new status block green.

- [ ] **Step 8: Full suite + typecheck + lint + commit**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all green (spooler transports never implemented `status`, and the interface change is additive).

```bash
git add src/main/transport tests/tcp-raw.test.ts
git commit -m "feat(transport): tcp-raw DLE EOT status probe on an ephemeral socket (C1)"
```

---

### Task 3: `createStatusPoller` — timer, gating, TTL cache, error mapping

**Files:**
- Modify: `src/main/printers/status-poller.ts` (append to the Task 1 file)
- Test: `tests/status-poller.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/status-poller.test.ts`:

```typescript
import { TransportError } from '../src/main/transport/errors';
import type { TransportRegistry } from '../src/main/transport/registry';
import { createPrinterStore } from '../src/main/printers/store';
import { memoryAdapter } from './helpers/memory-adapter';
import { makeDraft } from './helpers/printers';
import {
  createStatusPoller,
  statusPollingEnabled,
} from '../src/main/printers/status-poller';
import { vi } from 'vitest';

const drained = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

/** Manual timer wheel: tick() fires every armed timer once. */
function manualSchedule() {
  const timers: Array<{ fn: () => void; cancelled: boolean }> = [];
  return {
    schedule: (fn: () => void, _delayMs: number) => {
      const t = { fn, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    async tick() {
      const due = timers.filter((t) => !t.cancelled);
      for (const t of due) t.cancelled = true;
      for (const t of due) t.fn();
      await drained();
    },
  };
}

/** Registry stub whose transports answer status() with `behavior`. */
function fakeRegistry(behavior: () => Promise<readonly [number, number]>) {
  let polls = 0;
  const registry: TransportRegistry = {
    forPrinter: () => {
      polls += 1;
      return {
        open: () => Promise.resolve(),
        write: () => Promise.resolve(),
        close: () => Promise.resolve(),
        healthCheck: () => Promise.resolve(),
        status: behavior,
      };
    },
  };
  return { registry, count: (): number => polls };
}

async function makeStore(statusPolling?: 'auto' | 'off', transportKind: 'tcp_raw' | 'spooler_raw' = 'tcp_raw') {
  const printers = await createPrinterStore({
    filePath: 'printers.json',
    adapter: memoryAdapter(null),
    newId: (): string => '018f0000-0000-7000-8000-000000000001',
  });
  await printers.add(
    makeDraft(
      transportKind === 'tcp_raw'
        ? { statusPolling }
        : {
            statusPolling,
            transport: { kind: 'spooler_raw', windowsPrinterName: 'POS-80' },
          },
    ),
  );
  return printers;
}

describe('statusPollingEnabled (R-VAL-3 gate)', () => {
  it('requires statusPolling === auto AND tcp_raw transport', () => {
    const base = { ...makeDraft({ statusPolling: 'auto' }), printerId: '018f0000-0000-7000-8000-000000000001', source: 'local' as const };
    expect(statusPollingEnabled(base)).toBe(true);
    expect(statusPollingEnabled({ ...base, statusPolling: undefined })).toBe(false);
    expect(statusPollingEnabled({ ...base, statusPolling: 'off' })).toBe(false);
    expect(
      statusPollingEnabled({
        ...base,
        transport: { kind: 'spooler_raw', windowsPrinterName: 'POS-80' },
      }),
    ).toBe(false);
  });
});

describe('createStatusPoller', () => {
  it('start() polls immediately and caches the parsed status', async () => {
    const printers = await makeStore('auto');
    const profile = printers.list()[0];
    const fake = fakeRegistry(() => Promise.resolve([0x12, 0x00] as const));
    const timer = manualSchedule();
    const poller = createStatusPoller({
      printers,
      registry: fake.registry,
      schedule: timer.schedule,
    });

    poller.start();
    await drained();

    expect(fake.count()).toBe(1);
    expect(poller.get(profile.printerId)).toBe('ok');
    poller.stop();
  });

  it('never polls printers without the gate', async () => {
    const printers = await makeStore(undefined);
    const fake = fakeRegistry(() => Promise.resolve([0x12, 0x00] as const));
    const timer = manualSchedule();
    const poller = createStatusPoller({ printers, registry: fake.registry, schedule: timer.schedule });

    poller.start();
    await drained();
    await timer.tick();
    await drained();

    expect(fake.count()).toBe(0);
    poller.stop();
  });

  it('never polls spooler_raw printers even when gated on', async () => {
    const printers = await makeStore('auto', 'spooler_raw');
    const fake = fakeRegistry(() => Promise.resolve([0x12, 0x00] as const));
    const timer = manualSchedule();
    const poller = createStatusPoller({ printers, registry: fake.registry, schedule: timer.schedule });

    poller.start();
    await drained();

    expect(fake.count()).toBe(0);
    poller.stop();
  });

  it('connect-class failure caches offline; status_failed caches unknown', async () => {
    const printers = await makeStore('auto');
    const profile = printers.list()[0];
    let answer: Promise<readonly [number, number]> = Promise.reject(
      new TransportError('connect_refused', 'refused'),
    );
    const fake = fakeRegistry(() => answer);
    const timer = manualSchedule();
    const poller = createStatusPoller({ printers, registry: fake.registry, schedule: timer.schedule });

    poller.start();
    await drained();
    expect(poller.get(profile.printerId)).toBe('offline');

    answer = Promise.reject(new TransportError('status_failed', 'no answer'));
    await timer.tick();
    await drained();
    expect(poller.get(profile.printerId)).toBe('unknown');
    poller.stop();
  });

  it('expired cache entries read as unknown (TTL)', async () => {
    const printers = await makeStore('auto');
    const profile = printers.list()[0];
    let clock = 1_000;
    const fake = fakeRegistry(() => Promise.resolve([0x12, 0x00] as const));
    const timer = manualSchedule();
    const poller = createStatusPoller({
      printers,
      registry: fake.registry,
      schedule: timer.schedule,
      now: () => clock,
      ttlMs: 90_000,
    });

    poller.start();
    await drained();
    expect(poller.get(profile.printerId)).toBe('ok');

    clock += 91_000;
    expect(poller.get(profile.printerId)).toBe('unknown');
    poller.stop();
  });

  it('re-arms after each cycle and stop() ends the loop', async () => {
    const printers = await makeStore('auto');
    const fake = fakeRegistry(() => Promise.resolve([0x12, 0x00] as const));
    const timer = manualSchedule();
    const poller = createStatusPoller({ printers, registry: fake.registry, schedule: timer.schedule });

    poller.start();
    await drained();
    expect(fake.count()).toBe(1);
    await timer.tick();
    await drained();
    expect(fake.count()).toBe(2);

    poller.stop();
    await timer.tick();
    await drained();
    expect(fake.count()).toBe(2); // no further polls
  });

  it('skips a printer whose previous poll is still in flight', async () => {
    const printers = await makeStore('auto');
    const profile = printers.list()[0];
    let release: ((value: readonly [number, number]) => void) | null = null;
    const fake = fakeRegistry(
      () => new Promise<readonly [number, number]>((resolve) => {
        release = resolve;
      }),
    );
    const timer = manualSchedule();
    const poller = createStatusPoller({ printers, registry: fake.registry, schedule: timer.schedule });

    poller.start();
    await drained();
    expect(fake.count()).toBe(1);

    await timer.tick(); // first poll still unresolved
    await drained();
    expect(fake.count()).toBe(1);

    release?.([0x12, 0x00]);
    await drained();
    expect(poller.get(profile.printerId)).toBe('ok');
    poller.stop();
  });

  it('a poller fault never escapes start()/tick (start is safe to call twice)', () => {
    const fake = fakeRegistry(() => Promise.reject(new Error('boom')));
    const timer = manualSchedule();
    const printers = createStatusPoller.__never; // placeholder guard: see note
  });
});
```

**Note on the last sketch test:** drop it — "fault never escapes" is already covered by the `connect-class failure` test (rejections are caught inside `pollOne`); a second `start()` idempotency test is enough:

```typescript
  it('start() is idempotent', async () => {
    const printers = await makeStore('auto');
    const fake = fakeRegistry(() => Promise.resolve([0x12, 0x00] as const));
    const timer = manualSchedule();
    const poller = createStatusPoller({ printers, registry: fake.registry, schedule: timer.schedule });
    poller.start();
    poller.start();
    await drained();
    expect(fake.count()).toBe(1); // one immediate cycle, one timer
    poller.stop();
  });
```

Also remove the stray unused import if lint flags it (`vi` is not needed in this file).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/status-poller.test.ts`
Expected: FAIL — `createStatusPoller` / `statusPollingEnabled` not exported yet (parser tests from Task 1 still pass).

- [ ] **Step 3: Implement the poller**

Append to `src/main/printers/status-poller.ts`:

```typescript
import type { PrinterProfile } from './profile';
import type { PrinterStore } from './store';
import type { TransportRegistry } from '../transport/registry';
import { TransportError, type TransportErrorCode } from '../transport/errors';

export const DEFAULT_STATUS_INTERVAL_MS = 30_000;
export const DEFAULT_STATUS_TTL_MS = 90_000;

/** Connect-class failures mean the printer is unreachable → 'offline'.
 *  Response-class failures ('status_failed') and anything unexpected map to
 *  'unknown' — a model that silently ignores DLE EOT is never declared
 *  offline (R-VAL-3's core uncertainty). */
const OFFLINE_CODES: ReadonlySet<TransportErrorCode> = new Set([
  'connect_refused',
  'connect_timeout',
  'host_unreachable',
  'disconnected',
  'not_open',
  'printer_not_found',
  'dns_unsupported',
]);

/** Effective R-VAL-3 gate: explicit opt-in on a transport that has a return
 *  channel. spooler_raw is a one-way pipe and never polls. */
export function statusPollingEnabled(profile: PrinterProfile): boolean {
  return profile.statusPolling === 'auto' && profile.transport.kind === 'tcp_raw';
}

export interface StatusPollerDeps {
  readonly printers: PrinterStore;
  readonly registry: TransportRegistry;
  readonly intervalMs?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
  /** Returns a cancel function (same seam as the runtime/poller). */
  readonly schedule?: (fn: () => void, delayMs: number) => () => void;
  readonly log?: (message: string) => void;
}

export interface StatusPoller {
  /** Idempotent. Runs the first cycle immediately, then re-arms on the timer. */
  start(): void;
  /** Idempotent. In-flight probes settle into the cache but no new cycle is armed. */
  stop(): void;
  /** Sync read for the heartbeat/ack path; expired or never-polled → 'unknown'. */
  get(printerId: string): PrinterStatus;
}

interface CacheEntry {
  status: PrinterStatus;
  at: number;
}

export function createStatusPoller(deps: StatusPollerDeps): StatusPoller {
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? DEFAULT_STATUS_INTERVAL_MS;
  const ttlMs = deps.ttlMs ?? DEFAULT_STATUS_TTL_MS;
  const schedule =
    deps.schedule ??
    ((fn: () => void, delayMs: number): (() => void) => {
      const t = setTimeout(fn, delayMs);
      return () => {
        clearTimeout(t);
      };
    });
  const log = deps.log ?? ((): void => {});
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Set<string>();
  let cancelTimer: (() => void) | null = null;
  let stopped = true;

  function pollOne(printerId: string, profile: PrinterProfile): void {
    if (inFlight.has(printerId)) return; // serialize per printer
    inFlight.add(printerId);
    const transport = deps.registry.forPrinter(profile);
    const probe = transport.status;
    if (probe === undefined) {
      inFlight.delete(printerId);
      return;
    }
    void Promise.resolve()
      .then(() => probe.call(transport))
      .then(
        ([printerByte, paperByte]) => {
          cache.set(printerId, { status: parseDleEotStatus(printerByte, paperByte), at: now() });
        },
        (err: unknown) => {
          const offline = err instanceof TransportError && OFFLINE_CODES.has(err.code);
          cache.set(printerId, { status: offline ? 'offline' : 'unknown', at: now() });
          log(`status poll failed for ${printerId}: ${err instanceof Error ? err.message : String(err)}`);
        },
      )
      .finally(() => {
        inFlight.delete(printerId);
      });
  }

  function tick(): void {
    for (const p of deps.printers.list()) {
      if (statusPollingEnabled(p)) pollOne(p.printerId, p);
    }
    rearm();
  }

  function rearm(): void {
    if (stopped) return;
    cancelTimer?.();
    cancelTimer = schedule(tick, intervalMs);
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      tick();
    },
    stop() {
      stopped = true;
      cancelTimer?.();
      cancelTimer = null;
    },
    get(printerId) {
      const entry = cache.get(printerId);
      if (entry === undefined || now() - entry.at > ttlMs) return 'unknown';
      return entry.status;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/status-poller.test.ts`
Expected: PASS — parser tests (Task 1) + all poller tests.

- [ ] **Step 5: Typecheck + lint + commit**

Run: `pnpm typecheck && pnpm lint`

```bash
git add src/main/printers/status-poller.ts tests/status-poller.test.ts
git commit -m "feat(printers): status poller with TTL cache, R-VAL-3 gate, offline/unknown mapping (C1)"
```

---

### Task 4: Engine acks carry the cached status (injected lookup)

**Files:**
- Modify: `src/main/jobs/engine.ts`
- Modify: `tests/helpers/job-engine-harness.ts`
- Test: `tests/job-engine-execution.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/helpers/job-engine-harness.ts`, add to `HarnessOptions`:

```typescript
  /** C1 seam: cached printer status source for acks (default: always 'unknown'). */
  readonly printerStatus?: (printerId: string) => PrinterStatus;
```

…and the import at the top:

```typescript
import type { PrinterStatus } from '../../src/main/transport/types';
```

…and pass it into `createJobEngine` (after `limits`):

```typescript
  const engine = createJobEngine({
    store,
    printers,
    transports:
      options.transports ??
      ({
        forPrinter: (): never => {
          throw new Error('no transport configured');
        },
      } satisfies TransportRegistry),
    acks: { submit: (a) => acks.push(a) },
    now,
    schedule,
    limits: options.limits ?? {},
    ...(options.printerStatus !== undefined ? { printerStatus: options.printerStatus } : {}),
  });
```

Append to `tests/job-engine-execution.test.ts`:

```typescript
describe('engine acks — printer status (C1)', () => {
  it('acks carry the injected cached status at ack-build time', async () => {
    const transports = new FakeTransportRegistry();
    const h = await makeHarness({ transports, printerStatus: () => 'paper_low' });
    try {
      h.engine.submit(makeJob(h.printerId));
      await drained();
      expect(h.acks.length).toBeGreaterThan(0);
      for (const a of h.acks) expect(a.printerStatus).toBe('paper_low');
    } finally {
      h.dispose();
    }
  });

  it('without the injection acks stay unknown (back-compat)', async () => {
    const transports = new FakeTransportRegistry();
    const h = await makeHarness({ transports });
    try {
      h.engine.submit(makeJob(h.printerId));
      await drained();
      for (const a of h.acks) expect(a.printerStatus).toBe('unknown');
    } finally {
      h.dispose();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/job-engine-execution.test.ts`
Expected: FAIL — first test gets `'unknown'` instead of `'paper_low'` (engine hardcodes it).

- [ ] **Step 3: Implement the injection**

In `src/main/jobs/engine.ts`:

3a. Add the import:

```typescript
import type { PrinterStatus } from '../transport/types';
```

3b. Extend `JobEngineDeps`:

```typescript
  readonly limits?: Partial<EngineLimits>;
  /** C1: best-effort cached printer status for acks; omitted → always 'unknown'. */
  readonly printerStatus?: (printerId: string) => PrinterStatus;
```

3c. Below the existing dep destructuring (near `const transports = deps.transports;`):

```typescript
  const statusFor: (printerId: string) => PrinterStatus =
    deps.printerStatus ?? ((): PrinterStatus => 'unknown');
```

3d. Replace all four hardcoded occurrences of `printerStatus: 'unknown',` in the ack builders — `emit`, `rejectAck`, `ackFromStoredError`, `duplicateAck`:

```typescript
      printerStatus: statusFor(row.printerId),
```

(`rejectAck` uses `statusFor(job.printerId)`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/job-engine-execution.test.ts && pnpm vitest run tests/job-engine-`
Expected: PASS — including all pre-existing engine suites (they don't inject, so `'unknown'` behavior is unchanged).

- [ ] **Step 5: Full suite + typecheck + lint + commit**

Run: `pnpm test && pnpm typecheck && pnpm lint`

```bash
git add src/main/jobs/engine.ts tests/helpers/job-engine-harness.ts tests/job-engine-execution.test.ts
git commit -m "feat(jobs): acks carry cached printer status via injected lookup (C1)"
```

---

### Task 5: Runtime wiring — poller lifecycle + heartbeat + engine

**Files:**
- Modify: `src/main/agent-runtime.ts`
- Test: `tests/agent-runtime.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/agent-runtime.test.ts` (the file already imports `makeDraft`-style helpers? — check its imports; if `makeDraft` is not imported, add `import { makeDraft } from './helpers/printers';`). New describe block:

```typescript
/** Transport registry whose tcp transports answer DLE EOT with ok bytes. */
function statusTransports(answer: Promise<readonly [number, number]>): TransportRegistry {
  return {
    forPrinter: () => ({
      open: () => Promise.resolve(),
      write: () => Promise.resolve(),
      close: () => Promise.resolve(),
      healthCheck: () => Promise.resolve(),
      status: () => answer,
    }),
  };
}

describe('AgentRuntime printer status polling (C1)', () => {
  it('heartbeat reports cached DLE EOT status for gated printers', async () => {
    const { runtime, transport } = await makeRuntime({
      transports: statusTransports(Promise.resolve([0x12, 0x00] as const)),
    });
    runtime.start();
    expect((await runtime.pair(PAIRING_CODE)).ok).toBe(true);
    await runtime.printers.add(makeDraft({ statusPolling: 'auto', name: 'Kitchen-1' }));

    await vi.waitFor(() => {
      const sample = transport.heartbeats.at(-1);
      expect(sample?.printers[0]).toMatchObject({ health: 'ok' });
    });
  });

  it('ungated printers keep reporting unknown', async () => {
    const { runtime, transport } = await makeRuntime({
      transports: statusTransports(Promise.resolve([0x12, 0x00] as const)),
    });
    runtime.start();
    expect((await runtime.pair(PAIRING_CODE)).ok).toBe(true);
    await runtime.printers.add(makeDraft({ name: 'Kitchen-2' })); // statusPolling unset

    await vi.waitFor(() => {
      const sample = transport.heartbeats.at(-1);
      expect(sample?.printers[0]).toMatchObject({ health: 'unknown' });
    });
  });

  it('an unreachable gated printer reports offline (connect-class mapping)', async () => {
    const { runtime, transport } = await makeRuntime({
      transports: statusTransports(
        Promise.reject(new TransportError('connect_refused', 'refused')),
      ),
    });
    runtime.start();
    expect((await runtime.pair(PAIRING_CODE)).ok).toBe(true);
    await runtime.printers.add(makeDraft({ statusPolling: 'auto', name: 'Kitchen-3' }));

    await vi.waitFor(() => {
      const sample = transport.heartbeats.at(-1);
      expect(sample?.printers[0]).toMatchObject({ health: 'offline' });
    });
  });

  it('stop() halts the poll loop (no status probes after stop)', async () => {
    const { runtime } = await makeRuntime({
      transports: statusTransports(Promise.resolve([0x12, 0x00] as const)),
    });
    runtime.start();
    expect((await runtime.pair(PAIRING_CODE)).ok).toBe(true);
    await runtime.printers.add(makeDraft({ statusPolling: 'auto', name: 'Kitchen-4' }));
    await runtime.stop();
    // No assertion beyond stop() not throwing; the deterministic proof of
    // stopped timers lives in the poller unit tests (Task 3).
    expect(runtime.agentInfo().connectionState).not.toBe('online');
  });
});
```

Imports this block needs at the top of the test file (add only what's missing):
`TransportError` from `../src/main/transport/errors`; `makeDraft` from `./helpers/printers`. `makeRuntime`, `PAIRING_CODE`, `vi` already exist there.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/agent-runtime.test.ts`
Expected: FAIL — heartbeats always carry `'unknown'` (health is hardcoded).

- [ ] **Step 3: Wire the runtime**

In `src/main/agent-runtime.ts`:

3a. Add the import:

```typescript
import { createStatusPoller, type StatusPoller } from './printers/status-poller';
```

3b. After the `registry`/`printerService` creation (before the ack buffer — the engine below consumes the poller):

```typescript
  // Printer status polling (C1, R-VAL-3-gated): background DLE EOT probes
  // feeding the heartbeat `health` and ack `printer_status`. With no gated
  // printers this is an inert timer; ungated and spooler printers report
  // 'unknown' as before.
  const statusPoller: StatusPoller = createStatusPoller({
    printers,
    registry,
    now,
    schedule,
    log: (message) => {
      log.warn(message);
    },
  });
```

3c. Extend the `createJobEngine` call with the lookup:

```typescript
  const engine: JobEngine = createJobEngine({
    store: jobStore,
    printers,
    transports: registry,
    acks: ackSink,
    now,
    printerStatus: (printerId) => statusPoller.get(printerId),
    // The engine's schedule seam returns void; the env seam returns a cancel fn.
    schedule: (fn, delayMs) => {
      void schedule(fn, delayMs);
    },
  });
```

3d. Replace `heartbeatSample()`'s hardcoded health (and its stale comment):

```typescript
  /** §3.2 in-cycle heartbeat facts; health comes from the C1 status poller's
   *  TTL cache ('unknown' unless the printer opts in via statusPolling). */
  function heartbeatSample(): HeartbeatSample {
    return {
      uptime_s: Math.floor(process.uptime()),
      queue_depth: engine.pendingCount(),
      connection: 'poll',
      printers: printers.list().map((p) => ({
        printer_id: p.printerId,
        health: statusPoller.get(p.printerId),
      })),
    };
  }
```

3e. Lifecycle — in `start()`, start the poller unconditionally (gating is per-printer; with no gated printers the tick is a no-op, and starting it here covers pair-after-start):

```typescript
  let started = false;
  function start(): void {
    if (started) return;
    started = true;
    statusPoller.start();
    engine.recover(); // crash recovery BEFORE the first poll (architecture §5)
    ...
```

In `stop()`:

```typescript
  async function stop(): Promise<void> {
    if (!started) return;
    started = false;
    client.stop();
    statusPoller.stop();
    await ackBuffer.stop(); // best-effort final flush; never blocks on a dead network
  }
```

In `wipeLocalState()` (inside the `try`, first line — a wiped device must not keep probing):

```typescript
    try {
      statusPoller.stop();
      client.stop();
      secrets.clear();
      ...
```

3f. Pair-after-start: `pair()` succeeds → start the poller (idempotent) so a runtime that booted unpaired still begins probing:

```typescript
      const identity = await client.pair({ pairingCode: code, deviceName });
      const pairedAt = new Date(now()).toISOString();
      await deps.settings.set({ pairedAt });
      statusPoller.start();
      fetchConfigOnce(); // fire-and-forget; the fleet also arrives via poll/push
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/agent-runtime.test.ts`
Expected: PASS — new C1 block green, all pre-existing runtime tests green (their stub transports have no `status`, so gated printers are the only change and they gate on `statusPolling: 'auto'` which no fixture sets).

- [ ] **Step 5: Full suite + typecheck + lint + commit**

Run: `pnpm test && pnpm typecheck && pnpm lint`

```bash
git add src/main/agent-runtime.ts tests/agent-runtime.test.ts
git commit -m "feat(runtime): heartbeat + acks report polled printer status (C1, R-VAL-3-gated)"
```

---

### Task 6: Docs updates + readiness note

**Files:**
- Modify: `docs/architecture.md` (§3.4)
- Modify: `docs/printer-compatibility.md` (§6, R-VAL-3 row)
- Modify: `docs/production-readiness.md` (C1)

- [ ] **Step 1: architecture.md §3.4**

In the `### 3.4 transport-registry + transports` section, update the interface bullet:

```markdown
- `Transport` interface: `open()`, `write(bytes)`, `status?()` (best-effort DLE EOT probe
  on a dedicated ephemeral connection — raw `[printerByte, paperByte]`; implemented by
  `tcp-raw` only), `close()`, `healthCheck()`. `write()` resolves on kernel/driver
  acceptance — this is by definition "sent to printer", never "physically printed".
```

And add a bullet after the `spooler-raw` bullet:

```markdown
- `printers/status-poller.ts` (C1): background DLE EOT poller (~30 s) with a TTL cache;
  per-printer gate `statusPolling === 'auto'` **and** `tcp_raw` transport (R-VAL-3 —
  default off until hardware validation). Connect-class probe failures report
  `offline`; silent/garbage answers report `unknown` (never offline). Feeds the
  heartbeat `printers[].health` (§3.2 of api-contract) and ack `printer_status`.
  spooler_raw printers always report `unknown` (one-way pipe).
```

- [ ] **Step 2: printer-compatibility.md §6 R-VAL-3 row**

Update the R-VAL-3 row's description to note the agent side is implemented:

```markdown
3. **R-VAL-3 DLE EOT reality check:** which fleet models actually answer status polls
   (and under ASB config); determines whether `printer_status` can ever graduate from
   "unknown". Agent side implemented (C1): tcp_raw-only, per-printer gate
   `status_polling: "auto"`, default off — validation flips models on via config.
```

(Keep the row's other columns as they are.)

- [ ] **Step 3: production-readiness.md C1 status**

Update C1's `**Status:**` line to reflect agent-side completion while the item stays open:

```markdown
- **Status:** agent implemented (2026-10-30) — `status()` DLE EOT probe on an
  ephemeral socket in `tcp-raw`, `printers/status-poller.ts` (TTL cache, ~30 s,
  `statusPolling === 'auto'` + tcp_raw gate default off), runtime heartbeat/ack
  wiring. Evidence: `tests/status-poller.test.ts` (parser + fuzz + poller),
  `tests/tcp-raw.test.ts` (probe), `tests/agent-runtime.test.ts` ("printer status
  polling (C1)"). Still open: the emulator- or hardware-level status assertion
  (emulator not yet in the tree — hermetic mock-socket integration is the current
  CI-able equivalent) and the R-VAL-3 fleet validation in B1 that decides which
  models get flipped to `auto`.
```

- [ ] **Step 4: Commit**

```bash
git add docs/architecture.md docs/printer-compatibility.md docs/production-readiness.md
git commit -m "docs: C1 printer status polling — module map, R-VAL-3 note, readiness status"
```

---

## Self-Review Notes (already applied)

- **Spec coverage:** parser (Task 1), ephemeral-socket probe + socket seam (Task 2), poller/gating/TTL/error mapping (Task 3), ack injection (Task 4), runtime wiring incl. lifecycle + pair-after-start (Task 5), docs (Task 6). Spooler = always `'unknown'` is asserted by the gate test in Task 3.
- **Type consistency:** `status?(): Promise<readonly [printer: number, paper: number]>` on `PrinterTransport` matches the tcp-raw implementation, the fake registries in Tasks 3/5, and `parseDleEotStatus(printerByte, paperByte)`. `createStatusPoller` deps match the runtime wiring (Task 5) exactly.
- **Errata:** the spec's paper-sensor masks were corrected before planning (near-end 0x07, out 0x38); this plan uses the corrected masks.
- **Test-code caveat (Task 2):** an earlier draft of the "socket error mid-probe" test asserted `code: 'disconnected'`; `ECONNRESET` is not in `classifyConnectError`'s map, so the final version asserts `instanceof TransportError` instead — use that version.
