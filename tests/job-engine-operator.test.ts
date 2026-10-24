import { describe, expect, it } from 'vitest';
import { makeHarness, makeJob } from './helpers/job-engine-harness';
import { FakeTransport, FakeTransportRegistry } from './helpers/fake-transport';
import { TransportError } from '../src/main/transport/errors';
import type { PrinterProfile } from '../src/main/printers/profile';
import type { TransportRegistry } from '../src/main/transport/registry';
import { JobEngineError } from '../src/main/jobs/errors';

async function drained(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** FakeTransport whose open() consults a callback per call (see
 *  tests/job-engine-failures.test.ts — the registry freezes the script object
 *  captured on first use, so per-call outcomes need an overriding open). */
class OpenScriptRegistry implements TransportRegistry {
  private readonly byPrinter = new Map<string, FakeTransport>();

  constructor(private readonly openErrorFor: (printerId: string) => Error | undefined) {}

  forPrinter(profile: PrinterProfile): FakeTransport {
    const existing = this.byPrinter.get(profile.printerId);
    if (existing !== undefined) return existing;
    const errFor = (): Error | undefined => this.openErrorFor(profile.printerId);
    const t = new (class extends FakeTransport {
      override open(): Promise<void> {
        this.opens += 1;
        const err = errFor();
        return err !== undefined ? Promise.reject(err) : Promise.resolve();
      }
    })({});
    this.byPrinter.set(profile.printerId, t);
    return t;
  }

  get(printerId: string): FakeTransport | undefined {
    return this.byPrinter.get(printerId);
  }
}

describe('engine operator actions', () => {
  it('retryJob re-runs a failed job and resets the attempt budget', async () => {
    let failFirst = 1; // first open only
    const transports = new OpenScriptRegistry(() =>
      failFirst-- > 0 ? new TransportError('connect_refused', 'printer refused') : undefined,
    );
    const h = await makeHarness({ transports, limits: { maxAttempts: 1 }, scheduling: 'manual' });
    try {
      h.engine.submit(makeJob(h.printerId));
      await drained();
      expect(h.engine.getJob('job-1')?.status).toBe('failed');
      expect(h.engine.getJob('job-1')?.attempts).toBe(1);

      h.engine.retryJob('job-1');
      // Retry enqueues directly — no backoff timer should be pending.
      expect(h.timers).toHaveLength(0);
      await drained();

      const row = h.engine.getJob('job-1');
      expect(row?.status).toBe('completed');
      expect(row?.attempts).toBe(1); // budget was reset before re-execution
      expect(transports.get(h.printerId)?.writes).toHaveLength(1); // exactly one write total
      expect(h.acks.filter((a) => a.status === 'failed')).toHaveLength(1); // no extra failed ack
      expect(h.acks.at(-1)?.status).toBe('completed');
    } finally {
      h.dispose();
    }
  });

  it('retryJob refuses non-failed jobs', async () => {
    const h = await makeHarness({ transports: new FakeTransportRegistry(() => ({})) });
    try {
      expect(() => { h.engine.retryJob('ghost'); }).toThrow(JobEngineError);
      h.engine.submit(makeJob(h.printerId));
      await drained();
      expect(h.engine.getJob('job-1')?.status).toBe('completed');
      expect(() => { h.engine.retryJob('job-1'); }).toThrow(JobEngineError);
    } finally {
      h.dispose();
    }
  });

  it('reprintJob creates a NEW row and prints it', async () => {
    const transports = new FakeTransportRegistry(() => ({}));
    const h = await makeHarness({ transports });
    try {
      h.engine.submit(makeJob(h.printerId));
      await drained();
      expect(h.engine.getJob('job-1')?.status).toBe('completed');

      const newId = h.engine.reprintJob('job-1');
      expect(newId).not.toBe('job-1');
      // An accepted ack goes out for the new row (not the original).
      expect(h.acks.at(-1)?.status).toBe('accepted');
      expect(h.acks.at(-1)?.jobId).toBe(newId);
      await drained();

      const reprint = h.engine.getJob(newId);
      expect(reprint?.reprintOf).toBe('job-1');
      expect(reprint?.status).toBe('completed');
      expect(reprint?.idempotencyKey).not.toBe('key-1');
      expect(transports.get(h.printerId)?.writes).toHaveLength(2); // original + reprint
      expect(transports.get(h.printerId)?.opens).toBe(2);
    } finally {
      h.dispose();
    }
  });

  it('reprintJob refuses to insert past the maxPending queue bound', async () => {
    const transports = new FakeTransportRegistry((printerId) =>
      printerId === h.printerIds[0] ? {} : { hang: true },
    );
    const h = await makeHarness({ transports, limits: { maxPending: 2 }, printerCount: 2 });
    try {
      // job-1 completes (terminal, reprintable); job-2 hangs mid-transmission
      // ('sending') and job-3 queues behind it ('accepted') → 2 non-terminal
      // rows, i.e. the queue is at capacity.
      h.engine.submit(makeJob(h.printerIds[0] ?? ''));
      await drained();
      expect(h.engine.getJob('job-1')?.status).toBe('completed');
      h.engine.submit(makeJob(h.printerIds[1] ?? '', { jobId: 'job-2', idempotencyKey: 'key-2' }));
      h.engine.submit(makeJob(h.printerIds[1] ?? '', { jobId: 'job-3', idempotencyKey: 'key-3' }));
      await drained();
      expect(h.engine.getJob('job-2')?.status).toBe('sending');
      expect(h.engine.getJob('job-3')?.status).toBe('accepted');

      expect(() => h.engine.reprintJob('job-1')).toThrow(JobEngineError);
      expect(() => h.engine.reprintJob('job-1')).toThrow(/capacity/);
    } finally {
      h.dispose();
    }
  });

  it('cancel during a backoff window wins: the retry timer fires but nothing is printed', async () => {
    let failFirst = 1; // first open only
    const transports = new OpenScriptRegistry(() =>
      failFirst-- > 0 ? new TransportError('connect_refused', 'printer refused') : undefined,
    );
    const h = await makeHarness({ transports, limits: { maxAttempts: 2 } });
    try {
      h.engine.submit(makeJob(h.printerId));
      await drained();
      // Connect failure #1 → back to 'rendered' with a pending retry timer.
      expect(h.engine.getJob('job-1')?.status).toBe('rendered');
      expect(h.timers).toHaveLength(1);

      expect(h.engine.cancel('job-1')).toBe(true);
      expect(h.engine.getJob('job-1')?.status).toBe('failed');

      // The queued retry still fires, but runJob bails on the terminal guard.
      for (const fire of h.timers) fire();
      await drained();
      expect(h.engine.getJob('job-1')?.status).toBe('failed');
      expect(transports.get(h.printerId)?.writes).toHaveLength(0);
    } finally {
      h.dispose();
    }
  });

  it('reprintJob allows ambiguous, refuses rejected and non-terminal jobs', async () => {
    const transports = new FakeTransportRegistry((printerId) =>
      printerId === h.printerIds[0]
        ? { failWriteNumber: 1, writeError: new TransportError('write_timeout', 'printer vanished') }
        : { hang: true }, // job-2 stays mid-transmission → non-terminal
    );
    const h = await makeHarness({ transports, printerCount: 2 });
    try {
      h.engine.submit(makeJob(h.printerIds[0] ?? ''));
      h.engine.submit(makeJob(h.printerIds[1] ?? '', { jobId: 'job-2', idempotencyKey: 'key-2' }));
      await drained();
      expect(h.engine.getJob('job-1')?.status).toBe('ambiguous');
      expect(h.engine.getJob('job-2')?.status).toBe('sending');

      const newId = h.engine.reprintJob('job-1'); // ambiguous is reprintable
      expect(h.engine.getJob(newId)?.reprintOf).toBe('job-1');

      expect(() => h.engine.reprintJob('ghost')).toThrow(JobEngineError);
      expect(() => h.engine.reprintJob('job-2')).toThrow(JobEngineError); // non-terminal
    } finally {
      h.dispose();
    }
  });

  it('cancel is refused once the job is sending (unsafe)', async () => {
    const transports = new FakeTransportRegistry(() => ({ hang: true }));
    const h = await makeHarness({ transports });
    try {
      h.engine.submit(makeJob(h.printerId));
      await drained();
      expect(h.engine.getJob('job-1')?.status).toBe('sending');
      expect(h.engine.cancel('job-1')).toBe(false);
      expect(h.engine.getJob('job-1')?.status).toBe('sending');
    } finally {
      h.dispose();
    }
  });

  it('cancel of a queued-not-started job works without any print', async () => {
    const transports = new FakeTransportRegistry(() => ({ hang: true }));
    const h = await makeHarness({ transports });
    try {
      h.engine.submit(makeJob(h.printerId, { jobId: 'a', idempotencyKey: 'ka' }));
      h.engine.submit(makeJob(h.printerId, { jobId: 'b', idempotencyKey: 'kb' }));
      await drained();
      expect(h.engine.getJob('a')?.status).toBe('sending');
      expect(h.engine.getJob('b')?.status).toBe('accepted'); // queued behind a

      const writesBefore = transports.get(h.printerId)?.writes.length ?? 0;
      expect(h.engine.cancel('b')).toBe(true);
      const row = h.engine.getJob('b');
      expect(row?.status).toBe('failed');
      expect(row?.lastError).toContain('cancelled');
      expect(h.acks.at(-1)).toMatchObject({
        jobId: 'b',
        status: 'failed',
        error: { code: 'cancelled', message: 'cancelled by operator before transmission' },
      });
      // No new bytes were written: the hung write for 'a' is all there ever was.
      await drained();
      await drained();
      expect(transports.get(h.printerId)?.writes.length).toBe(writesBefore);
    } finally {
      h.dispose();
    }
  });
});
