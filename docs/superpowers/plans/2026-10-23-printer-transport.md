# Printer Transport Layer (TCP ESC/POS) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Main-process printer transport per `docs/superpowers/specs/2026-10-23-printer-transport-design.md` — `PrinterTransport` interface, TCP transport with classified errors, validated printer profile store, connection tests and test prints.

**Architecture:** Two modules under `src/main/`: `transport/` (pure connection concern — interface, errors, socket abstraction, TCP implementation, registry) and `printers/` (configuration concern — zod schemas + approved-destination policy, persisted store, test-page builder, service). Transports are built **only** from stored, validated profiles; no code path runs from a raw payload to a host/port.

**Tech Stack:** TypeScript strict (ES2023, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zod 4 (`z.strictObject` everywhere), Node `node:net`/`node:crypto` (no new dependencies), Vitest (node project, `tests/**/*.test.ts`). Test style follows `tests/settings.test.ts` (injected memory adapter).

**Repo conventions that matter here:**

- `TypedError` (`src/shared/errors.ts`): every error carries a stable machine `code`.
- Node-glue adapters (like `settings-fs.ts`) are thin and untested; unit tests inject fakes.
- No listening sockets, ever; transports are outbound-only.
- Never claim physical printing — wording is normative (`docs/api-contract.md` §3.1).
- Run tools via pnpm from repo root: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format`.

**File structure:**

| File | Responsibility |
| --- | --- |
| `src/main/transport/types.ts` | `PrinterTransport` interface, `PrinterStatus` union |
| `src/main/transport/errors.ts` | `TransportError`, `TransportErrorCode` |
| `src/main/transport/socket.ts` | `TransportSocket`/`SocketFactory` abstraction + `node:net` adapter (glue) |
| `src/main/transport/tcp-raw.ts` | `createTcpRawTransport` — connect/write timeouts, classification |
| `src/main/transport/registry.ts` | `createTransportRegistry` — profile → transport |
| `src/main/printers/profile.ts` | zod schemas, `isApprovedEndpointHost` policy |
| `src/main/printers/store.ts` | `PrinterStore` — atomic JSON persistence |
| `src/main/printers/test-page.ts` | `buildTestPage` — ESC/POS connectivity payload |
| `src/main/printers/service.ts` | `PrinterService` — save/testConnection/testPrint |
| `tests/helpers/mock-socket.ts` | Mock print socket + scripted factory |
| `tests/helpers/memory-adapter.ts` | In-memory `SettingsFileAdapter` |
| `tests/helpers/printers.ts` | Valid `PrinterDraft`/`PrinterProfile` builders |
| `tests/tcp-raw.test.ts`, `tests/transport-registry.test.ts`, `tests/printer-profile.test.ts`, `tests/printer-store.test.ts`, `tests/test-page.test.ts`, `tests/printer-service.test.ts` | Unit tests |
| `docs/transport-adapters.md` | TCP limits + future-adapter checklist |

Out of scope (do not build): IPC/renderer wiring, SQLite, DLE EOT status, spooler/USB transports, cloud integration.

---

### Task 1: Transport foundation — types, errors, socket abstraction, mock socket helper

No unit tests yet (pure types + node glue); the next task exercises everything. `pnpm typecheck` is the gate.

**Files:**
- Create: `src/main/transport/types.ts`
- Create: `src/main/transport/errors.ts`
- Create: `src/main/transport/socket.ts`
- Create: `tests/helpers/mock-socket.ts`

- [ ] **Step 1: Create `src/main/transport/types.ts`**

```ts
/**
 * Transport contract (architecture.md §3.4). `write()` resolving means the
 * OS/driver accepted the bytes — "sent to printer", never "physically
 * printed" (api-contract.md §3.1 wording is normative).
 */

/** Mirrors the UI `PrinterHealth` union (renderer types.ts); unified when the
 *  IPC contract grows printer channels. */
export type PrinterStatus = 'ok' | 'unknown' | 'offline' | 'paper_out' | 'paper_low' | 'cover_open';

export interface PrinterTransport {
  /** Resolves when the connection is established; rejects with TransportError. */
  open(): Promise<void>;
  /** Resolves on kernel/driver acceptance — "sent to printer", NOT "printed". */
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  /** Cheap connect(+close) probe; rejects with TransportError on failure. */
  healthCheck(): Promise<void>;
  /** Reserved for best-effort DLE EOT status (R-VAL-3). Not implemented by
   *  tcp-raw in v1 — leave undefined. */
  status?(): Promise<PrinterStatus>;
}
```

- [ ] **Step 2: Create `src/main/transport/errors.ts`**

```ts
import type { TypedError } from '../../shared/errors';

export type TransportErrorCode =
  | 'connect_refused'
  | 'connect_timeout'
  | 'host_unreachable'
  | 'dns_unsupported'
  | 'write_timeout'
  | 'write_failed'
  | 'disconnected'
  | 'not_open';

/** Stable machine code; surfaces in logs and future acks (CLAUDE.md). */
export class TransportError extends Error implements TypedError {
  readonly code: TransportErrorCode;

  constructor(code: TransportErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'TransportError';
    this.code = code;
  }
}
```

- [ ] **Step 3: Create `src/main/transport/socket.ts`**

```ts
import { createConnection } from 'node:net';

/**
 * Minimal async surface of a print socket; `node:net` semantics for events.
 * Injected so unit tests run mock sockets with zero network I/O. The
 * production adapter below is node glue and untested (like settings-fs.ts).
 */
export interface TransportSocket {
  write(data: Uint8Array, cb: (err: Error | null) => void): void;
  destroy(): void;
  on(event: 'connect', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'close', listener: (hadError: boolean) => void): unknown;
}

export type SocketFactory = (endpoint: {
  readonly host: string;
  readonly port: number;
}) => TransportSocket;

/** Production adapter: outbound node:net connection. The factory initiates
 *  the connection; nothing listens (AC-4). */
export function createNetSocketFactory(): SocketFactory {
  return ({ host, port }) => createConnection({ host, port });
}
```

- [ ] **Step 4: Create `tests/helpers/mock-socket.ts`**

```ts
import { EventEmitter } from 'node:events';
import type { SocketFactory, TransportSocket } from '../../src/main/transport/socket';

/**
 * Mock print socket: no network. A script decides how the connection behaves.
 * Scripts run on a microtask after creation so the transport's event handlers
 * are attached before the connection outcome is simulated.
 */
export class MockSocket extends EventEmitter implements TransportSocket {
  readonly written: Buffer[] = [];
  destroyed = false;

  constructor(
    readonly host: string,
    readonly port: number,
  ) {
    super();
  }

  write(data: Uint8Array, cb: (err: Error | null) => void): void {
    this.written.push(Buffer.from(data));
    cb(null);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close', false);
  }

  connect(): void {
    this.emit('connect');
  }

  failWithCode(code: string): void {
    const err: NodeJS.ErrnoException = Object.assign(
      new Error(`${code} on ${this.host}:${this.port}`),
      { code },
    );
    this.emit('error', err);
    this.emit('close', true);
  }

  refuse(): void {
    this.failWithCode('ECONNREFUSED');
  }

  unreachable(): void {
    this.failWithCode('EHOSTUNREACH');
  }
}

export interface MockSockets {
  factory: SocketFactory;
  /** Every socket the factory created, in creation order. */
  sockets: MockSocket[];
  last(): MockSocket | undefined;
}

export function mockSocketFactory(script: (socket: MockSocket) => void): MockSockets {
  const sockets: MockSocket[] = [];
  return {
    factory: ({ host, port }) => {
      const sock = new MockSocket(host, port);
      sockets.push(sock);
      queueMicrotask(() => script(sock));
      return sock;
    },
    sockets,
    last: () => sockets.at(-1),
  };
}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0 (new files compile; strict-mode clean).

- [ ] **Step 6: Commit**

```bash
git add src/main/transport/types.ts src/main/transport/errors.ts src/main/transport/socket.ts tests/helpers/mock-socket.ts
git commit -m "feat: transport foundation — PrinterTransport contract, typed transport errors, socket abstraction"
```

---

### Task 2: TcpRawTransport — happy path (TDD)

**Files:**
- Create: `src/main/transport/tcp-raw.ts`
- Test: `tests/tcp-raw.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/tcp-raw.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createTcpRawTransport } from '../src/main/transport/tcp-raw';
import { mockSocketFactory, type MockSockets } from './helpers/mock-socket';

const HOST = '192.168.1.50';

function makeTransport(sockets: MockSockets) {
  return createTcpRawTransport({
    host: HOST,
    port: 9100,
    socketFactory: sockets.factory,
  });
}

describe('tcp-raw transport — happy path', () => {
  it('connects, writes bytes in order, and closes', async () => {
    const sockets = mockSocketFactory((sock) => sock.connect());
    const transport = makeTransport(sockets);

    await expect(transport.open()).resolves.toBeUndefined();

    await transport.write(new Uint8Array([0x1b, 0x40]));
    await transport.write(new Uint8Array([0x1d, 0x56, 0x01]));

    expect(sockets.last()?.written).toEqual([Buffer.from([0x1b, 0x40]), Buffer.from([0x1d, 0x56, 0x01])]);

    await expect(transport.close()).resolves.toBeUndefined();
    expect(sockets.last()?.destroyed).toBe(true);
  });

  it('targets the configured endpoint', async () => {
    const sockets = mockSocketFactory((sock) => sock.connect());
    const transport = makeTransport(sockets);
    await transport.open();
    expect(sockets.last()?.host).toBe(HOST);
    expect(sockets.last()?.port).toBe(9100);
  });

  it('open() is idempotent while already open', async () => {
    const sockets = mockSocketFactory((sock) => sock.connect());
    const transport = makeTransport(sockets);
    await transport.open();
    await transport.open();
    expect(sockets.sockets).toHaveLength(1);
  });

  it('close() is idempotent', async () => {
    const sockets = mockSocketFactory((sock) => sock.connect());
    const transport = makeTransport(sockets);
    await expect(transport.close()).resolves.toBeUndefined();
  });

  it('write() before open() fails with not_open and never touches the network', async () => {
    const sockets = mockSocketFactory((sock) => sock.connect());
    const transport = makeTransport(sockets);
    await expect(transport.write(new Uint8Array([0x0a]))).rejects.toMatchObject({ code: 'not_open' });
    expect(sockets.sockets).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/tcp-raw.test.ts`
Expected: FAIL — cannot resolve `../src/main/transport/tcp-raw`.

- [ ] **Step 3: Implement `src/main/transport/tcp-raw.ts`**

```ts
import { isIP } from 'node:net';
import { TransportError, type TransportErrorCode } from './errors';
import type { SocketFactory, TransportSocket } from './socket';
import type { PrinterTransport } from './types';

export const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
export const DEFAULT_WRITE_TIMEOUT_MS = 5_000;

export interface TcpRawTransportOptions {
  host: string;
  port: number;
  socketFactory: SocketFactory;
  connectTimeoutMs?: number;
  writeTimeoutMs?: number;
}

function classifyConnectError(err: NodeJS.ErrnoException, target: string): TransportError {
  const code: TransportErrorCode =
    err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH' ? 'host_unreachable' : 'connect_refused';
  return new TransportError(code, `${target}: ${err.message}`, { cause: err });
}

function classifyWriteError(err: Error): TransportError {
  return new TransportError('write_failed', err.message, { cause: err });
}

/**
 * Outbound TCP raw transport (architecture §3.4): Node `net` to <ip>:9100.
 * Fire-and-forget — a resolved `write()` means kernel acceptance, never a
 * physical print. Hosts must be IP literals; DNS is rejected (spec §3).
 */
export function createTcpRawTransport(options: TcpRawTransportOptions): PrinterTransport {
  const { host, port, socketFactory } = options;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const writeTimeoutMs = options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
  const target = `${host}:${port}`;

  let socket: TransportSocket | null = null;
  /** Rejects the operation currently in flight (invoked by the close/error watchers). */
  let failInFlight: ((error: TransportError) => void) | null = null;

  const socketDied = (error: TransportError): void => {
    socket = null;
    const fail = failInFlight;
    failInFlight = null;
    fail?.(error);
  };

  const open = async (): Promise<void> => {
    if (socket !== null) return; // idempotent
    if (isIP(host) === 0) {
      throw new TransportError('dns_unsupported', `${target}: host must be an IPv4/IPv6 literal`);
    }
    const sock = socketFactory({ host, port });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(
        () =>
          settle(
            new TransportError('connect_timeout', `${target}: connect timed out after ${connectTimeoutMs}ms`),
          ),
        connectTimeoutMs,
      );
      const settle = (error?: TransportError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error === undefined) {
          // Adopt persistent watchers for the write phase.
          sock.on('error', (err) => socketDied(classifyWriteError(err)));
          sock.on('close', () => socketDied(new TransportError('disconnected', `${target}: connection lost`)));
          socket = sock;
          resolve();
        } else {
          reject(error);
          sock.destroy(); // emits 'close'; settle is already a no-op
        }
      };
      sock.on('connect', () => settle());
      sock.on('error', (err) => settle(classifyConnectError(err, target)));
      sock.on('close', () => settle(new TransportError('disconnected', `${target}: closed before connect completed`)));
    });
  };

  const write = async (bytes: Uint8Array): Promise<void> => {
    const sock = socket;
    if (sock === null) throw new TransportError('not_open', `${target}: transport is not open`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        failInFlight = null;
        sock.destroy(); // 'close' watcher clears socket state
        reject(new TransportError('write_timeout', `${target}: write timed out after ${writeTimeoutMs}ms`));
      }, writeTimeoutMs);
      failInFlight = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      sock.write(bytes, (err) => {
        if (failInFlight === null) return; // already timed out or connection died
        failInFlight = null;
        clearTimeout(timer);
        if (err !== null) reject(classifyWriteError(err));
        else resolve();
      });
    });
  };

  const close = async (): Promise<void> => {
    const sock = socket;
    if (sock === null) return; // idempotent
    // 'close' watcher → socketDied → any in-flight op rejects with 'disconnected'.
    sock.destroy();
  };

  const healthCheck = async (): Promise<void> => {
    await open();
    await close();
  };

  return { open, write, close, healthCheck };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/tcp-raw.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/main/transport/tcp-raw.ts tests/tcp-raw.test.ts
git commit -m "feat: tcp-raw transport — connect/write lifecycle with timeouts and typed errors"
```

---

### Task 3: TcpRawTransport — failure classification (TDD)

**Files:**
- Modify: `tests/tcp-raw.test.ts` (append)

- [ ] **Step 1: Append failing tests to `tests/tcp-raw.test.ts`**

Also add `vi` to the vitest import at the top: `import { describe, expect, it, vi } from 'vitest';`

```ts
describe('tcp-raw transport — failures', () => {
  it('classifies ECONNREFUSED as connect_refused', async () => {
    const sockets = mockSocketFactory((sock) => sock.refuse());
    const transport = makeTransport(sockets);
    await expect(transport.open()).rejects.toMatchObject({ code: 'connect_refused' });
    expect(sockets.last()?.destroyed).toBe(true);
  });

  it('classifies EHOSTUNREACH as host_unreachable', async () => {
    const sockets = mockSocketFactory((sock) => sock.unreachable());
    const transport = makeTransport(sockets);
    await expect(transport.open()).rejects.toMatchObject({ code: 'host_unreachable' });
  });

  it('times out when the printer never accepts the connection', async () => {
    vi.useFakeTimers();
    try {
      const sockets = mockSocketFactory(() => {
        /* never connects */
      });
      const transport = makeTransport(sockets);
      const pending = transport.open();
      const expectation = expect(pending).rejects.toMatchObject({ code: 'connect_timeout' });
      await vi.advanceTimersByTimeAsync(3_000);
      await expectation;
      expect(sockets.last()?.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects non-IP hosts without touching the network (dns_unsupported)', async () => {
    const sockets = mockSocketFactory((sock) => sock.connect());
    const transport = createTcpRawTransport({
      host: 'printer.local',
      port: 9100,
      socketFactory: sockets.factory,
    });
    await expect(transport.open()).rejects.toMatchObject({ code: 'dns_unsupported' });
    expect(sockets.sockets).toHaveLength(0);
  });

  it('classifies a write callback error as write_failed', async () => {
    const sockets = mockSocketFactory((sock) => {
      sock.connect();
      sock.write = (_data, cb) => cb(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    });
    const transport = makeTransport(sockets);
    await transport.open();
    await expect(transport.write(new Uint8Array([0x0a]))).rejects.toMatchObject({ code: 'write_failed' });
  });

  it('classifies a lost connection mid-write as disconnected', async () => {
    const sockets = mockSocketFactory((sock) => {
      sock.connect();
      sock.write = () => {
        sock.destroy(); // drop the link without invoking the write callback
      };
    });
    const transport = makeTransport(sockets);
    await transport.open();
    await expect(transport.write(new Uint8Array([0x0a]))).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('rejects an in-flight write with disconnected when close() is called', async () => {
    const sockets = mockSocketFactory((sock) => {
      sock.connect();
      sock.write = () => {
        /* never calls cb */
      };
    });
    const transport = makeTransport(sockets);
    await transport.open();
    const pending = transport.write(new Uint8Array([0x0a]));
    await transport.close();
    await expect(pending).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('times out when the socket never accepts written bytes (write_timeout)', async () => {
    vi.useFakeTimers();
    try {
      const sockets = mockSocketFactory((sock) => {
        sock.connect();
        sock.write = () => {
          /* never calls cb — buffer full / link dead */
        };
      });
      const transport = makeTransport(sockets);
      await transport.open();
      const pending = transport.write(new Uint8Array([0x0a]));
      const expectation = expect(pending).rejects.toMatchObject({ code: 'write_timeout' });
      await vi.advanceTimersByTimeAsync(5_000);
      await expectation;
      expect(sockets.last()?.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('write() after a lost connection fails with not_open', async () => {
    const sockets = mockSocketFactory((sock) => {
      sock.connect();
      queueMicrotask(() => queueMicrotask(() => sock.failWithCode('ECONNRESET')));
    });
    const transport = makeTransport(sockets);
    await transport.open();
    await vi.waitFor(() => expect(transport.write(new Uint8Array([0x0a]))).rejects.toMatchObject({ code: 'not_open' }));
  });
});

describe('tcp-raw transport — healthCheck', () => {
  it('opens and closes a probe connection', async () => {
    const sockets = mockSocketFactory((sock) => sock.connect());
    const transport = makeTransport(sockets);
    await expect(transport.healthCheck()).resolves.toBeUndefined();
    expect(sockets.last()?.destroyed).toBe(true);
  });

  it('propagates classified failures', async () => {
    const sockets = mockSocketFactory((sock) => sock.refuse());
    const transport = makeTransport(sockets);
    await expect(transport.healthCheck()).rejects.toMatchObject({ code: 'connect_refused' });
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail or expose gaps**

Run: `pnpm vitest run tests/tcp-raw.test.ts`
Expected: mostly PASS — the Task 2 implementation was written with the failure paths; if any test fails, fix `tcp-raw.ts` minimally (e.g. the double-microtask `ECONNRESET` test exercises the persistent watchers installed at connect time). All must pass before commit.

- [ ] **Step 3: Typecheck and full test run**

Run: `pnpm typecheck && pnpm test`
Expected: exit 0; all suites pass.

- [ ] **Step 4: Commit**

```bash
git add tests/tcp-raw.test.ts src/main/transport/tcp-raw.ts
git commit -m "test: tcp-raw failure classification — refused, unreachable, timeouts, disconnect, write errors"
```

---

### Task 4: Transport registry (TDD)

**Files:**
- Create: `src/main/transport/registry.ts`
- Test: `tests/transport-registry.test.ts`

- [ ] **Step 1: Create `tests/helpers/printers.ts`** (needed by this and later tests)

```ts
import type { PrinterDraft, PrinterProfile } from '../../src/main/printers/profile';

export function makeDraft(overrides: Partial<PrinterDraft> = {}): PrinterDraft {
  return {
    name: 'Kitchen',
    role: 'kitchen',
    paperWidthMm: 80,
    printableDots: 576,
    charsPerLine: 48,
    capabilities: { cut: true, qrCode: false, barcode128: false, statusPolling: false, cashDrawer: false },
    transport: { kind: 'tcp_raw', host: '192.168.1.50', port: 9100 },
    ...overrides,
  };
}

export function makeProfile(overrides: Partial<PrinterProfile> = {}): PrinterProfile {
  return {
    ...makeDraft(),
    printerId: '018f0000-0000-7000-8000-000000000001',
    ...overrides,
  };
}
```

- [ ] **Step 2: Write the failing tests — `tests/transport-registry.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createTransportRegistry } from '../src/main/transport/registry';
import { mockSocketFactory } from './helpers/mock-socket';
import { makeProfile } from './helpers/printers';

describe('transport registry', () => {
  it('builds a tcp transport from the approved profile endpoint', async () => {
    const sockets = mockSocketFactory((sock) => sock.connect());
    const registry = createTransportRegistry({ socketFactory: sockets.factory });
    const transport = registry.forPrinter(
      makeProfile({ transport: { kind: 'tcp_raw', host: '10.1.2.3', port: 9100 } }),
    );
    await transport.open();
    expect(sockets.last()?.host).toBe('10.1.2.3');
    expect(sockets.last()?.port).toBe(9100);
  });

  it('honors configured timeouts on created transports', async () => {
    vi.useFakeTimers();
    try {
      const sockets = mockSocketFactory(() => {
        /* never connects */
      });
      const registry = createTransportRegistry({ socketFactory: sockets.factory, connectTimeoutMs: 1_234 });
      const transport = registry.forPrinter(makeProfile());
      const pending = transport.open();
      const expectation = expect(pending).rejects.toMatchObject({ code: 'connect_timeout' });
      await vi.advanceTimersByTimeAsync(1_234);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run tests/transport-registry.test.ts`
Expected: FAIL — cannot resolve `../src/main/transport/registry`.

- [ ] **Step 4: Implement `src/main/transport/registry.ts`**

```ts
import type { PrinterProfile } from '../printers/profile';
import { createNetSocketFactory, type SocketFactory } from './socket';
import {
  createTcpRawTransport,
  type TcpRawTransportOptions,
} from './tcp-raw';
import type { PrinterTransport } from './types';

export interface TransportRegistry {
  /**
   * Builds a transport from an APPROVED stored profile. Endpoints enter the
   * system only through PrinterStore validation (spec §3) — there is no API
   * that accepts a bare host/port.
   */
  forPrinter(profile: PrinterProfile): PrinterTransport;
}

export interface TransportRegistryOptions {
  /** Defaults to the production node:net factory. */
  socketFactory?: SocketFactory;
  connectTimeoutMs?: number;
  writeTimeoutMs?: number;
}

export function createTransportRegistry(options: TransportRegistryOptions = {}): TransportRegistry {
  return {
    forPrinter(profile) {
      const endpoint = profile.transport;
      switch (endpoint.kind) {
        case 'tcp_raw': {
          const tcpOptions: TcpRawTransportOptions = {
            host: endpoint.host,
            port: endpoint.port,
            socketFactory: options.socketFactory ?? createNetSocketFactory(),
          };
          if (options.connectTimeoutMs !== undefined) tcpOptions.connectTimeoutMs = options.connectTimeoutMs;
          if (options.writeTimeoutMs !== undefined) tcpOptions.writeTimeoutMs = options.writeTimeoutMs;
          return createTcpRawTransport(tcpOptions);
        }
      }
    },
  };
}
```

Note: the exhaustive `switch` makes adding `spooler_raw`/`usb` a compile error until handled — the future-adapter path documented in `docs/transport-adapters.md` (Task 9). Timeouts default to the `tcp-raw` constants.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run tests/transport-registry.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/main/transport/registry.ts tests/transport-registry.test.ts tests/helpers/printers.ts
git commit -m "feat: transport registry — profile-approved endpoints only"
```

---

### Task 5: Printer profile schemas + approved-host policy (TDD)

**Files:**
- Create: `src/main/printers/profile.ts`
- Test: `tests/printer-profile.test.ts`

- [ ] **Step 1: Write the failing tests — `tests/printer-profile.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import {
  isApprovedEndpointHost,
  PrinterDraftSchema,
  PrinterProfileSchema,
} from '../src/main/printers/profile';
import { makeDraft, makeProfile } from './helpers/printers';

describe('approved endpoint host policy', () => {
  it.each([
    ['192.168.1.50', true],
    ['10.0.0.7', true],
    ['172.16.0.9', true],
    ['fd12:3456::1', true],
    ['127.0.0.1', false],
    ['0.0.0.0', false],
    ['224.0.0.1', false],
    ['240.0.0.1', false],
    ['255.255.255.255', false],
    ['::', false],
    ['::1', false],
    ['ff02::1', false],
    ['printer.local', false],
    ['example.com', false],
    ['', false],
  ])('%s → %s', (host, approved) => {
    expect(isApprovedEndpointHost(host)).toBe(approved);
  });
});

describe('printer profile schema', () => {
  it('accepts a valid 80mm profile', () => {
    expect(() => PrinterProfileSchema.parse(makeProfile())).not.toThrow();
  });

  it('accepts a 58mm profile with narrower per-printer values', () => {
    const profile = PrinterProfileSchema.parse(
      makeProfile({ paperWidthMm: 58, printableDots: 384, charsPerLine: 32 }),
    );
    expect(profile.paperWidthMm).toBe(58);
    expect(profile.printableDots).toBe(384);
  });

  it('rejects unknown fields (strict)', () => {
    expect(PrinterProfileSchema.safeParse({ ...makeProfile(), extra: 1 }).success).toBe(false);
  });

  it('derives a draft schema without printerId', () => {
    expect(() => PrinterDraftSchema.parse(makeDraft())).not.toThrow();
    expect(PrinterDraftSchema.safeParse(makeProfile()).success).toBe(false); // extra printerId field
  });

  it.each([
    ['unknown role', { role: 'pantry' }],
    ['invalid paper width', { paperWidthMm: 100 }],
    ['dots too low', { printableDots: 100 }],
    ['dots too high', { printableDots: 1024 }],
    ['chars too low', { charsPerLine: 8 }],
    ['chars too high', { charsPerLine: 128 }],
    ['empty name', { name: '' }],
    ['name too long', { name: 'x'.repeat(65) }],
    ['port zero', { transport: { kind: 'tcp_raw', host: '192.168.1.50', port: 0 } }],
    ['port too high', { transport: { kind: 'tcp_raw', host: '192.168.1.50', port: 65536 } }],
    ['hostname endpoint', { transport: { kind: 'tcp_raw', host: 'printer.local', port: 9100 } }],
    ['loopback endpoint', { transport: { kind: 'tcp_raw', host: '127.0.0.1', port: 9100 } }],
    ['unspecified endpoint', { transport: { kind: 'tcp_raw', host: '0.0.0.0', port: 9100 } }],
    ['unknown transport kind', { transport: { kind: 'bluetooth', host: '192.168.1.50', port: 9100 } }],
  ])('rejects %s', (_label, overrides) => {
    expect(PrinterDraftSchema.safeParse(makeDraft(overrides as never)).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/printer-profile.test.ts`
Expected: FAIL — cannot resolve `../src/main/printers/profile`.

- [ ] **Step 3: Implement `src/main/printers/profile.ts`**

```ts
import { isIP } from 'node:net';
import { z } from 'zod';

export const PRINTER_ROLES = ['kitchen', 'receipt', 'bar', 'custom'] as const;
export type PrinterRole = (typeof PRINTER_ROLES)[number];

/**
 * Approved-destination policy (spec §3): hosts must be IPv4/IPv6 literals.
 * Rejected: unspecified, loopback, multicast and reserved ranges. Private LAN
 * ranges (10/8, 172.16/12, 192.168/16, IPv6 ULA fc00::/7) are the normal case
 * and allowed. No DNS — there is no name-resolution surface in v1, and no
 * network scanning anywhere.
 */
export function isApprovedEndpointHost(host: string): boolean {
  const version = isIP(host);
  if (version === 4) {
    const first = Number.parseInt(host.split('.')[0] ?? '', 10);
    return first !== 0 && first !== 127 && first < 224;
  }
  if (version === 6) {
    const h = host.toLowerCase();
    return h !== '::' && h !== '::1' && !h.startsWith('ff');
  }
  return false;
}

const EndpointTcpRawSchema = z.strictObject({
  kind: z.literal('tcp_raw'),
  host: z
    .string()
    .refine((h) => isIP(h) !== 0, 'host must be an IPv4 or IPv6 literal (no hostnames)')
    .refine(isApprovedEndpointHost, 'host is loopback, unspecified, multicast or otherwise not approved'),
  port: z.number().int().min(1).max(65535),
});

export const PrinterCapabilitiesSchema = z.strictObject({
  cut: z.boolean(),
  qrCode: z.boolean(),
  barcode128: z.boolean(),
  statusPolling: z.boolean(),
  cashDrawer: z.boolean(),
});
export type PrinterCapabilities = z.output<typeof PrinterCapabilitiesSchema>;

/** Conservative capability defaults (printer-compatibility.md §4 policy). */
export const PRINTER_CAPABILITIES_DEFAULTS: PrinterCapabilities = {
  cut: false,
  qrCode: false,
  barcode128: false,
  statusPolling: false,
  cashDrawer: false,
};

export const PrinterProfileSchema = z.strictObject({
  printerId: z.uuid(),
  name: z.string().min(1).max(64),
  role: z.enum(PRINTER_ROLES),
  paperWidthMm: z.union([z.literal(58), z.literal(80)]),
  // Per-printer physical values — never derived from paper width (spec §4).
  printableDots: z.number().int().min(192).max(800),
  charsPerLine: z.number().int().min(16).max(96),
  capabilities: PrinterCapabilitiesSchema,
  transport: EndpointTcpRawSchema,
});
export type PrinterProfile = z.output<typeof PrinterProfileSchema>;

export const PrinterDraftSchema = PrinterProfileSchema.omit({ printerId: true });
export type PrinterDraft = z.output<typeof PrinterDraftSchema>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/printer-profile.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/main/printers/profile.ts tests/printer-profile.test.ts
git commit -m "feat: printer profile schemas — roles, 80/58mm widths, approved-destination policy"
```

---

### Task 6: Printer store (TDD)

**Files:**
- Create: `src/main/printers/store.ts`
- Create: `tests/helpers/memory-adapter.ts`
- Test: `tests/printer-store.test.ts`

- [ ] **Step 1: Create `tests/helpers/memory-adapter.ts`**

```ts
import type { SettingsFileAdapter } from '../../src/main/services/settings';

/** In-memory SettingsFileAdapter recording every atomic write (test double). */
export function memoryAdapter(initial: string | null = null): SettingsFileAdapter & { written: string[] } {
  let content = initial;
  const written: string[] = [];
  return {
    get written() {
      return written;
    },
    read: () => Promise.resolve(content),
    writeAtomic: (_path, contents) => {
      written.push(contents);
      content = contents;
      return Promise.resolve();
    },
  };
}
```

- [ ] **Step 2: Write the failing tests — `tests/printer-store.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { createPrinterStore } from '../src/main/printers/store';
import type { SettingsFileAdapter } from '../src/main/services/settings';
import { memoryAdapter } from './helpers/memory-adapter';
import { makeDraft } from './helpers/printers';

let idCounter = 0;
function createStore(adapter: SettingsFileAdapter, report?: (message: string) => void) {
  return createPrinterStore({
    filePath: 'printers.json',
    adapter,
    newId: () => `id-${String(++idCounter).padStart(3, '0')}`,
    report,
  });
}

describe('printer store', () => {
  it('starts empty when no file exists', async () => {
    const store = await createStore(memoryAdapter(null));
    expect(store.list()).toEqual([]);
  });

  it('adds a printer, assigns an id, persists atomically', async () => {
    const adapter = memoryAdapter(null);
    const store = await createStore(adapter);
    const profile = await store.add(makeDraft());
    expect(adapter.written).toHaveLength(1);
    expect(JSON.parse(adapter.written[0]!)).toEqual([profile]);
    expect(store.get(profile.printerId)?.name).toBe('Kitchen');
  });

  it('round-trips a saved file', async () => {
    const first = await createStore(memoryAdapter(null));
    const saved = await first.add(makeDraft());
    const raw = JSON.stringify([saved]);
    const second = await createStore(memoryAdapter(raw));
    expect(second.get(saved.printerId)?.printableDots).toBe(576);
  });

  it('starts empty on a corrupt file and reports it', async () => {
    const reported: string[] = [];
    const store = await createStore(memoryAdapter('{not json'), (m) => reported.push(m));
    expect(store.list()).toEqual([]);
    expect(reported).toHaveLength(1);
  });

  it('starts empty when the file has unknown fields (strict)', async () => {
    const store = await createStore(memoryAdapter(JSON.stringify([{ ...makeDraft(), printerId: 'x', admin: true }])));
    expect(store.list()).toEqual([]);
  });

  it('rejects invalid drafts and persists nothing', async () => {
    const adapter = memoryAdapter(null);
    const store = await createStore(adapter);
    await expect(store.add(makeDraft({ name: '' }))).rejects.toThrow();
    await expect(store.add(makeDraft({ transport: { kind: 'tcp_raw', host: '127.0.0.1', port: 9100 } }))).rejects.toThrow();
    expect(store.list()).toHaveLength(0);
    expect(adapter.written).toHaveLength(0);
  });

  it('updates a printer and persists', async () => {
    const adapter = memoryAdapter(null);
    const store = await createStore(adapter);
    const saved = await store.add(makeDraft());
    const updated = await store.update(saved.printerId, { name: 'Bar', role: 'bar' });
    expect(updated.name).toBe('Bar');
    expect(updated.role).toBe('bar');
    expect(JSON.parse(adapter.written.at(-1)!)).toEqual([updated]);
  });

  it('rejects an invalid update without persisting', async () => {
    const store = await createStore(memoryAdapter(null));
    const saved = await store.add(makeDraft());
    await expect(store.update(saved.printerId, { printableDots: 9999 })).rejects.toThrow();
    expect(store.get(saved.printerId)?.printableDots).toBe(576);
  });

  it('throws when updating an unknown id', async () => {
    const store = await createStore(memoryAdapter(null));
    await expect(store.update('missing', { name: 'X' })).rejects.toThrow('printer not found');
  });

  it('removes a printer and persists; returns false for unknown ids', async () => {
    const adapter = memoryAdapter(null);
    const store = await createStore(adapter);
    const saved = await store.add(makeDraft());
    expect(await store.remove('missing')).toBe(false);
    expect(await store.remove(saved.printerId)).toBe(true);
    expect(adapter.written.at(-1)).toBe('[]');
    expect(store.get(saved.printerId)).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run tests/printer-store.test.ts`
Expected: FAIL — cannot resolve `../src/main/printers/store`.

- [ ] **Step 4: Implement `src/main/printers/store.ts`**

```ts
import { z } from 'zod';
import type { SettingsFileAdapter } from '../services/settings';
import {
  PrinterDraftSchema,
  PrinterProfileSchema,
  type PrinterDraft,
  type PrinterProfile,
} from './profile';

/**
 * Durable printer profiles — the `printers` table of architecture.md §3.5 in
 * file form until SQLite lands (same injected-adapter pattern as settings.ts;
 * migrates to SQLite with local-store). Profiles contain no secrets → plain
 * atomic JSON is sufficient (spec §3); the DPAPI identity store is untouched.
 */
export interface PrinterStore {
  list(): PrinterProfile[];
  get(printerId: string): PrinterProfile | null;
  add(draft: PrinterDraft): Promise<PrinterProfile>;
  update(printerId: string, patch: Partial<PrinterDraft>): Promise<PrinterProfile>;
  remove(printerId: string): Promise<boolean>;
}

export async function createPrinterStore(options: {
  filePath: string;
  adapter: SettingsFileAdapter;
  /** Injected UUID source (crypto.randomUUID in production). */
  newId: () => string;
  /** Sink for recoverable problems (corrupt/invalid file). */
  report?: (message: string) => void;
}): Promise<PrinterStore> {
  const { filePath, adapter, newId, report } = options;
  let cached: PrinterProfile[] = [];

  const raw = await adapter.read(filePath);
  if (raw !== null) {
    try {
      const parsed = z.array(PrinterProfileSchema).safeParse(JSON.parse(raw) as unknown);
      if (parsed.success) {
        cached = parsed.data;
      } else {
        report?.(`printers file invalid, starting empty (${filePath})`);
      }
    } catch {
      report?.(`printers file unreadable, starting empty (${filePath})`);
    }
  }

  const persist = async (): Promise<void> => {
    await adapter.writeAtomic(filePath, JSON.stringify(cached));
  };

  return {
    list: () => [...cached],
    get: (printerId) => cached.find((p) => p.printerId === printerId) ?? null,
    async add(draft) {
      const validated = PrinterDraftSchema.parse(draft);
      const profile: PrinterProfile = { ...validated, printerId: newId() };
      cached = [...cached, profile];
      await persist();
      return profile;
    },
    async update(printerId, patch) {
      const current = cached.find((p) => p.printerId === printerId);
      if (current === undefined) throw new Error(`printer not found: ${printerId}`);
      const next = PrinterProfileSchema.parse({ ...current, ...patch });
      cached = cached.map((p) => (p.printerId === printerId ? next : p));
      await persist();
      return next;
    },
    async remove(printerId) {
      const before = cached.length;
      cached = cached.filter((p) => p.printerId !== printerId);
      if (cached.length === before) return false;
      await persist();
      return true;
    },
  };
}
```

Note: `update` re-parses the merged profile, so `printerId` cannot be changed via `patch` (strict schema rejects the extra key if someone tries `patch.printerId`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run tests/printer-store.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm typecheck` — exit 0.

```bash
git add src/main/printers/store.ts tests/printer-store.test.ts tests/helpers/memory-adapter.ts
git commit -m "feat: printer store — validated, atomically persisted printer profiles"
```

---

### Task 7: ESC/POS test page builder (TDD)

**Files:**
- Create: `src/main/printers/test-page.ts`
- Test: `tests/test-page.test.ts`

- [ ] **Step 1: Write the failing tests — `tests/test-page.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { buildTestPage } from '../src/main/printers/test-page';
import { makeProfile } from './helpers/printers';

const NOW = new Date('2026-10-23T12:00:00.000Z');

function textOf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('ascii');
}

describe('test page', () => {
  it('starts with ESC @ init followed by center alignment', () => {
    const bytes = buildTestPage(makeProfile(), NOW);
    expect([...bytes.slice(0, 5)]).toEqual([0x1b, 0x40, 0x1b, 0x61, 0x01]);
  });

  it('contains the printer name, profile facts, and honest wording', () => {
    const text = textOf(buildTestPage(makeProfile(), NOW));
    expect(text).toContain('Kitchen');
    expect(text).toContain('role: kitchen');
    expect(text).toContain('80mm, 576 dots, 48 cols');
    expect(text).toContain('2026-10-23T12:00:00');
    expect(text).toContain('sent to printer');
    expect(text).not.toContain('printed');
  });

  it('sanitizes control characters from configured text (threat T2)', () => {
    const text = textOf(buildTestPage(makeProfile({ name: 'Kitch\u001ben' }), NOW));
    expect(text).toContain('Kitch?en');
  });

  it('ends with a partial cut only when the capability is on', () => {
    const withCut = [...buildTestPage(makeProfile(), NOW)];
    const capabilitiesOff = { cut: false, qrCode: false, barcode128: false, statusPolling: false, cashDrawer: false };
    const withoutCut = [...buildTestPage(makeProfile({ capabilities: capabilitiesOff }), NOW)];
    expect(withCut.slice(-3)).toEqual([0x1d, 0x56, 0x01]);
    expect(withoutCut.includes(0x1d)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/test-page.test.ts`
Expected: FAIL — cannot resolve `../src/main/printers/test-page`.

- [ ] **Step 3: Implement `src/main/printers/test-page.ts`**

```ts
import type { PrinterProfile } from './profile';

/**
 * Minimal ESC/POS connectivity page for transport validation. NOT the document
 * pipeline (the doc renderer is a separate future module) — a small fixed
 * payload proving the transport delivers bytes end to end. All configured text
 * is sanitized to printable ASCII (threat-model T2: no control-character
 * injection). Wording stays honest: this page says "sent to printer", never
 * claims a physical print.
 */
export function buildTestPage(profile: PrinterProfile, now: Date = new Date()): Uint8Array {
  const sanitize = (text: string): string => text.replace(/[^\x20-\x7E]/g, '?');
  const lines = [
    sanitize(profile.name),
    `role: ${profile.role}`,
    `paper: ${profile.paperWidthMm}mm, ${profile.printableDots} dots, ${profile.charsPerLine} cols`,
    `test print - ${now.toISOString()}`,
    'sent to printer (not a print confirmation)',
  ];
  const bytes: number[] = [
    0x1b, 0x40, // ESC @ — initialize printer
    0x1b, 0x61, 0x01, // ESC a 1 — center alignment
  ];
  for (const line of lines) {
    bytes.push(...Buffer.from(line, 'ascii'), 0x0a);
  }
  bytes.push(
    0x1b, 0x61, 0x00, // ESC a 0 — left alignment
    0x1b, 0x64, 0x02, // ESC d 2 — feed 2 lines
  );
  if (profile.capabilities.cut) {
    bytes.push(0x1d, 0x56, 0x01); // GS V 1 — partial cut
  }
  return Uint8Array.from(bytes);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/test-page.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/printers/test-page.ts tests/test-page.test.ts
git commit -m "feat: ESC/POS connectivity test page — sanitized, capability-aware, honest wording"
```

---

### Task 8: Printer service (TDD)

**Files:**
- Create: `src/main/printers/service.ts`
- Test: `tests/printer-service.test.ts`

- [ ] **Step 1: Write the failing tests — `tests/printer-service.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { createPrinterService } from '../src/main/printers/service';
import { createTransportRegistry } from '../src/main/transport/registry';
import { buildTestPage } from '../src/main/printers/test-page';
import { mockSocketFactory, type MockSocket } from './helpers/mock-socket';
import { memoryAdapter } from './helpers/memory-adapter';
import { makeDraft } from './helpers/printers';
import { createPrinterStore } from '../src/main/printers/store';

const NOW = new Date('2026-10-23T12:00:00.000Z');

async function setup(script: (socket: MockSocket) => void = (sock) => sock.connect()) {
  const sockets = mockSocketFactory(script);
  const store = await createPrinterStore({
    filePath: 'printers.json',
    adapter: memoryAdapter(null),
    newId: () => 'id-fixed',
  });
  const registry = createTransportRegistry({ socketFactory: sockets.factory });
  const service = createPrinterService({ store, registry, now: () => NOW });
  return { sockets, store, service };
}

describe('printer service', () => {
  it('saves a validated printer and returns it with an id', async () => {
    const { service } = await setup();
    const profile = await service.savePrinter(makeDraft());
    expect(profile.printerId).toBe('id-fixed');
    expect(profile.transport).toEqual({ kind: 'tcp_raw', host: '192.168.1.50', port: 9100 });
  });

  it('refuses disapproved destinations — the policy decides, not the caller', async () => {
    const { service } = await setup();
    await expect(
      service.savePrinter(makeDraft({ transport: { kind: 'tcp_raw', host: '10.0.0.1', port: 31337 } })),
    ).resolves.toBeDefined(); // private-LAN endpoints are the normal case
    await expect(
      service.savePrinter(makeDraft({ transport: { kind: 'tcp_raw', host: '127.0.0.1', port: 9100 } })),
    ).rejects.toThrow(); // loopback is rejected at the store boundary
  });

  it('runs a connection test against the stored endpoint', async () => {
    const { service, sockets } = await setup();
    const profile = await service.savePrinter(makeDraft());
    await expect(service.testConnection(profile.printerId)).resolves.toEqual({ ok: true });
    expect(sockets.last()?.destroyed).toBe(true);
  });

  it('classifies connection-test failures with a stable code', async () => {
    const { service } = await setup((sock) => sock.refuse());
    const profile = await service.savePrinter(makeDraft());
    const result = await service.testConnection(profile.printerId);
    expect(result).toMatchObject({ ok: false, code: 'connect_refused' });
  });

  it('throws for a connection test on an unknown printer', async () => {
    const { service } = await setup();
    await expect(service.testConnection('missing')).rejects.toThrow('printer not found');
  });

  it('test print writes the ESC/POS page through the transport', async () => {
    const { service, sockets } = await setup();
    const profile = await service.savePrinter(makeDraft());
    const result = await service.testPrint(profile.printerId);
    expect(result).toEqual({ ok: true, bytesWritten: buildTestPage(profile, NOW).byteLength });
    expect(sockets.last()?.written).toEqual([Buffer.from(buildTestPage(profile, NOW))]);
    expect(sockets.last()?.destroyed).toBe(true);
  });

  it('test print reports classified failures instead of throwing', async () => {
    const { service } = await setup((sock) => sock.refuse());
    const profile = await service.savePrinter(makeDraft());
    const result = await service.testPrint(profile.printerId);
    expect(result).toMatchObject({ ok: false, code: 'connect_refused' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/printer-service.test.ts`
Expected: FAIL — cannot resolve `../src/main/printers/service`.

- [ ] **Step 3: Implement `src/main/printers/service.ts`**

```ts
import type { PrinterDraft, PrinterProfile } from './profile';
import type { PrinterStore } from './store';
import { buildTestPage } from './test-page';
import type { TransportRegistry } from '../transport/registry';
import { TransportError, type TransportErrorCode } from '../transport/errors';

export type ConnectionTestResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: TransportErrorCode; readonly detail: string };

export type TestPrintResult =
  | { readonly ok: true; readonly bytesWritten: number }
  | { readonly ok: false; readonly code: TransportErrorCode; readonly detail: string };

interface TransportFailure {
  readonly ok: false;
  readonly code: TransportErrorCode;
  readonly detail: string;
}

/**
 * Operations other modules (and later the IPC layer) call. Endpoints come
 * only from the validated store via the registry (spec §3) — a caller can
 * never hand the service a raw host/port.
 */
export interface PrinterService {
  savePrinter(draft: PrinterDraft): Promise<PrinterProfile>;
  testConnection(printerId: string): Promise<ConnectionTestResult>;
  testPrint(printerId: string): Promise<TestPrintResult>;
}

export function createPrinterService(options: {
  store: PrinterStore;
  registry: TransportRegistry;
  /** Injected clock for deterministic test-page timestamps. */
  now?: () => Date;
}): PrinterService {
  const { store, registry } = options;
  const now = options.now ?? (() => new Date());

  const loadProfile = (printerId: string): PrinterProfile => {
    const profile = store.get(printerId);
    if (profile === null) throw new Error(`printer not found: ${printerId}`);
    return profile;
  };

  const toFailure = (error: unknown): TransportFailure | null => {
    if (error instanceof TransportError) {
      return { ok: false, code: error.code, detail: error.message };
    }
    return null;
  };

  return {
    async savePrinter(draft) {
      // Validation (schema + approved-destination policy) happens inside the store.
      return store.add(draft);
    },
    async testConnection(printerId) {
      const transport = registry.forPrinter(loadProfile(printerId));
      try {
        await transport.healthCheck();
        return { ok: true };
      } catch (error) {
        const failure = toFailure(error);
        if (failure === null) throw error;
        return failure;
      }
    },
    async testPrint(printerId) {
      const profile = loadProfile(printerId);
      const transport = registry.forPrinter(profile);
      const bytes = buildTestPage(profile, now());
      try {
        await transport.open();
        await transport.write(bytes);
        return { ok: true, bytesWritten: bytes.byteLength };
      } catch (error) {
        const failure = toFailure(error);
        if (failure === null) throw error;
        return failure;
      } finally {
        await transport.close();
      }
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/printer-service.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Full test suite + typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: exit 0; all suites pass (including pre-existing UI tests).

- [ ] **Step 6: Commit**

```bash
git add src/main/printers/service.ts tests/printer-service.test.ts
git commit -m "feat: printer service — validated saves, connection tests, test prints"
```

---

### Task 9: Transport adapters doc + full verification

**Files:**
- Create: `docs/transport-adapters.md`

- [ ] **Step 1: Create `docs/transport-adapters.md`**

````markdown
# Transport Adapters — TCP limits & future transports

**Scope:** how the agent talks to printers. Companions: `architecture.md` §3.4
(module boundaries), `printer-compatibility.md` §3 (transport reliability
model), spec `docs/superpowers/specs/2026-10-23-printer-transport-design.md`.

## v1 shipped transport: TCP raw (:9100)

- **Fire-and-forget.** ESC/POS over TCP has no application-level ack. A
  resolved `write()` means the kernel accepted the bytes — nothing more.
- **"Sent to printer" ≠ "printed".** `completed` means hand-off to the
  socket/driver succeeded (api-contract.md §3.1 wording is normative). No code
  path, log, or ack may claim a physical print.
- **Invisible failures.** Paper-out, cover-open, or power loss mid-stream are
  undetectable over TCP (R-VAL-8) — this is why the UI wording exists.
- **Status polling not implemented (v1).** DLE EOT stays deferred until the
  hardware-validation phase closes R-VAL-3; the `PrinterTransport.status?()`
  hook is reserved.
- **Approved destinations only.** Hosts are IPv4/IPv6 literals validated by
  `isApprovedEndpointHost` (loopback/unspecified/multicast/reserved rejected),
  ports 1–65535 (default 9100), persisted exclusively in the printer store.
  No DNS resolution, no network scanning, and no code path from a cloud job
  payload to a host/port — jobs reference `printerId`, the store supplies the
  endpoint.
- **Outbound only.** The transport never listens; the existing AC-4 no-listen
  guard stays in force.

## Adding a future transport adapter (`spooler_raw`, `usb`)

Follow this checklist; do not fork the interface.

1. **Implement `PrinterTransport`** in `src/main/transport/<kind>.ts`
   (`open`/`write`/`close`/`healthCheck`; `status?` only if the transport can
   actually answer it). Inject the OS handle factory (socket, printer handle,
   USB device) the same way `SocketFactory` is injected — unit tests run
   against fakes with no hardware.
2. **Map OS errors to `TransportErrorCode`.** Keep the existing codes; add a
   new one only when no existing code fits — codes are contract-visible (logs,
   future acks), so additions are a documented change.
3. **Extend the profile schema** (`src/main/printers/profile.ts`): add the
   endpoint variant (e.g. `spooler_raw` carries `windowsPrinterName`, not a
   host/port) under the same strict-validation + approved-destination policy.
4. **Register it** in `createTransportRegistry` — the exhaustive `switch`
   makes an unhandled kind a compile error.
5. **Gate hardware behavior.** Spooler RAW behind R-VAL-4 (driver RAW
   passthrough, buffering/reprint risk), USB behind R-VAL-5 (endpoint/claim
   quirks). No transport ships claims its validation phase hasn't closed.
6. **Update docs in the same change:** `printer-compatibility.md` §3/§5 and
   this file.

Transport-specific limits to respect:

- **spooler-raw:** success = job spooled by Windows; the vendor driver may
  buffer (R-VAL-4 duplicate risk — feeds the ambiguity/duplicate-policy flow).
- **usb (v1.1):** not promised in v1 — no UI, ack, or doc may claim USB
  support until that phase lands.
````

- [ ] **Step 2: Format, lint, typecheck, full tests**

```bash
pnpm format
pnpm lint
pnpm typecheck
pnpm test
```

Expected: all exit 0. Fix any finding before committing.

- [ ] **Step 3: Commit**

```bash
git add docs/transport-adapters.md
git commit -m "docs: transport adapter limits (TCP) and future spooler/USB adapter checklist"
```

---

## Self-review notes (resolved during planning)

- **Spec coverage:** interface+semantics (Tasks 1–2), error table (Tasks 2–3), endpoint policy & store-only invariant (Tasks 5–6, 8), profile fields incl. roles/widths/capabilities (Task 5), timeouts (Task 2, registry override Task 4), connection tests + test print (Tasks 7–8), mock-socket tests incl. disconnects/timeouts (Tasks 2–3), persistence safety (Task 6), docs on TCP limits + adapter path (Task 9). DLE EOT deliberately reserved, not implemented.
- **Type consistency:** `PrinterDraft` = `PrinterProfile` minus `printerId` (single source: `PrinterProfileSchema.omit`); error codes match the spec table exactly.
- **No new dependencies** (`node:net`, `node:crypto` via injected `newId`).
