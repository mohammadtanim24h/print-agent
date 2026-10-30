import { describe, expect, it } from 'vitest';
import { TransportError } from '../src/main/transport/errors';
import type { TransportRegistry } from '../src/main/transport/registry';
import {
  createStatusPoller,
  parseDleEotStatus,
  statusPollingEnabled,
} from '../src/main/printers/status-poller';
import { createPrinterStore } from '../src/main/printers/store';
import { memoryAdapter } from './helpers/memory-adapter';
import { makeDraft } from './helpers/printers';

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
    ['cover_open beats paper_low on severity', 0x04, 0x01, 'cover_open'],
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

const drained = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

/** Manual timer wheel: tick() fires every armed timer once. */
function manualSchedule() {
  const timers: Array<{ fn: () => void; cancelled: boolean }> = [];
  return {
    schedule: (fn: () => void) => {
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

/** Deferred for gating a status probe's resolution from the test body. */
function deferredStatus() {
  let resolve!: (value: readonly [number, number]) => void;
  const promise = new Promise<readonly [number, number]>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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
    if (profile === undefined) throw new Error('unreachable: test printer missing');
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
    if (profile === undefined) throw new Error('unreachable: test printer missing');
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
    if (profile === undefined) throw new Error('unreachable: test printer missing');
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
    if (profile === undefined) throw new Error('unreachable: test printer missing');
    const pending = deferredStatus();
    const fake = fakeRegistry(() => pending.promise);
    const timer = manualSchedule();
    const poller = createStatusPoller({ printers, registry: fake.registry, schedule: timer.schedule });

    poller.start();
    await drained();
    expect(fake.count()).toBe(1);

    await timer.tick(); // first poll still unresolved
    await drained();
    expect(fake.count()).toBe(1);

    pending.resolve([0x12, 0x00]);
    await drained();
    expect(poller.get(profile.printerId)).toBe('ok');
    poller.stop();
  });

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

  it('prunes cache entries for printers removed from the store', async () => {
    const printers = await makeStore('auto');
    const profile = printers.list()[0];
    if (profile === undefined) throw new Error('unreachable: test printer missing');
    const fake = fakeRegistry(() => Promise.resolve([0x12, 0x00] as const));
    const timer = manualSchedule();
    const poller = createStatusPoller({ printers, registry: fake.registry, schedule: timer.schedule });

    poller.start();
    await drained();
    expect(poller.get(profile.printerId)).toBe('ok');

    expect(await printers.remove(profile.printerId)).toBe(true);
    await timer.tick();
    await drained();
    expect(poller.get(profile.printerId)).toBe('unknown');
    poller.stop();
  });

  it('a plain (non-TransportError) rejection caches unknown, not offline', async () => {
    const printers = await makeStore('auto');
    const profile = printers.list()[0];
    if (profile === undefined) throw new Error('unreachable: test printer missing');
    const fake = fakeRegistry(() => Promise.reject(new Error('boom')));
    const timer = manualSchedule();
    const poller = createStatusPoller({ printers, registry: fake.registry, schedule: timer.schedule });

    poller.start();
    await drained();
    expect(poller.get(profile.printerId)).toBe('unknown');
    poller.stop();
  });
});
