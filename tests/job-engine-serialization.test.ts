import { describe, expect, it } from 'vitest';
import { makeHarness, makeJob } from './helpers/job-engine-harness';
import { FakeTransport, FakeTransportRegistry } from './helpers/fake-transport';
import type { FakeTransportScript } from './helpers/fake-transport';
import { TransportError } from '../src/main/transport/errors';
import type { PrinterProfile } from '../src/main/printers/profile';
import type { TransportRegistry } from '../src/main/transport/registry';

async function drained(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** FakeTransport whose open() consults a counter per call — the
 *  OpenScriptRegistry pattern from job-engine-failures.test.ts, needed because
 *  FakeTransportRegistry freezes the script captured on first use and the
 *  failure must apply to only the first attempt. One transport per printer. */
class RetryScriptTransport extends FakeTransport {
  constructor(script: FakeTransportScript, private readonly failNext: () => number) {
    super(script);
  }

  override open(): Promise<void> {
    this.opens += 1;
    return this.failNext() > 0
      ? Promise.reject(new TransportError('connect_refused', 'printer refused'))
      : Promise.resolve();
  }
}

class FirstOpenFailuresRegistry implements TransportRegistry {
  private readonly byPrinter = new Map<string, FakeTransport>();

  constructor(private readonly failFirst: () => number) {}

  forPrinter(profile: PrinterProfile): FakeTransport {
    const existing = this.byPrinter.get(profile.printerId);
    if (existing !== undefined) return existing;
    const t = new RetryScriptTransport({}, this.failFirst);
    this.byPrinter.set(profile.printerId, t);
    return t;
  }

  get(printerId: string): FakeTransport | undefined {
    return this.byPrinter.get(printerId);
  }
}

describe('per-printer serialization (R-VAL-6)', () => {
  it('single-flight: jobs on one printer never interleave transport writes', async () => {
    const transports = new FakeTransportRegistry();
    const h = await makeHarness({ transports });
    try {
      // Three jobs, 3 copies each → 9 writes total, strictly sequential.
      for (let i = 1; i <= 3; i += 1) {
        h.engine.submit(
          makeJob(h.printerId, {
            jobId: `job-${String(i)}`,
            idempotencyKey: `key-${String(i)}`,
            copies: 3,
          }),
        );
      }
      for (let i = 0; i < 3; i += 1) await drained();
      const t = transports.get(h.printerId);
      expect(t).toBeDefined();
      // maxConcurrentWrites accumulates the max across all jobs on the shared
      // transport instance — 1 proves no two writes ever overlapped.
      expect(t?.maxConcurrentWrites).toBe(1);
      expect(t?.writes).toHaveLength(9);
      for (let i = 1; i <= 3; i += 1) {
        expect(h.engine.getJob(`job-${String(i)}`)?.status).toBe('completed');
      }
    } finally {
      h.dispose();
    }
  });

  it('priority ordering: a job pushed back by a connect retry renders after lower-latency higher-priority jobs', async () => {
    // 'low' (priority 9) is submitted first and therefore dequeued first —
    // the queue only reorders jobs still pending, so its first attempt starts
    // immediately. Its open fails and a manual retry timer pushes it to the
    // back; 'high' (1) and 'mid' (5), submitted while it waits, must render
    // before it. This deterministically exercises byRank over pending jobs.
    let failFirst = 1;
    const transports = new FirstOpenFailuresRegistry(() => failFirst--);
    const h = await makeHarness({ transports, scheduling: 'manual' });
    try {
      h.engine.submit(
        makeJob(h.printerId, { jobId: 'job-low', idempotencyKey: 'key-low', priority: 9 }),
      );
      await drained();
      // First attempt failed at open → retry scheduled, nothing written.
      expect(h.timers.length).toBe(1);
      expect(h.engine.getJob('job-low')?.status).toBe('rendered');
      expect(h.engine.getJob('job-low')?.attempts).toBe(1);

      // From here on, only the execution-driven acks matter — 'low' already
      // emitted its (failed-attempt) rendered ack above.
      const baseline = h.acks.length;
      h.engine.submit(
        makeJob(h.printerId, { jobId: 'job-high', idempotencyKey: 'key-high', priority: 1 }),
      );
      h.engine.submit(
        makeJob(h.printerId, { jobId: 'job-mid', idempotencyKey: 'key-mid', priority: 5 }),
      );
      await drained(); // high and mid complete; low still waits on its timer
      expect(h.engine.getJob('job-high')?.status).toBe('completed');
      expect(h.engine.getJob('job-mid')?.status).toBe('completed');
      expect(h.engine.getJob('job-low')?.status).toBe('rendered'); // not yet retried

      h.timers.shift()?.(); // fire the retry → 'low' re-enqueues behind nothing pending
      await drained();
      for (const id of ['job-high', 'job-mid', 'job-low']) {
        expect(h.engine.getJob(id)?.status).toBe('completed');
      }
      // Execution order reads off the rendered acks (emitted when each job's
      // execution starts): high, mid, then the retried low.
      const renderOrder = h.acks
        .slice(baseline)
        .filter((a) => a.status === 'rendered')
        .map((a) => a.jobId);
      expect(renderOrder).toEqual(['job-high', 'job-mid', 'job-low']);
    } finally {
      h.dispose();
    }
  });

  it('cross-printer independence: printers execute concurrently, each writing only its own jobs', async () => {
    const transports = new FakeTransportRegistry();
    const h = await makeHarness({ transports, printerCount: 2 });
    try {
      const [printerA, printerB] = h.printerIds;
      if (printerA === undefined || printerB === undefined) throw new Error('unreachable: printerCount is 2');
      h.engine.submit(
        makeJob(printerA, { jobId: 'job-a', idempotencyKey: 'key-a', copies: 2 }),
      );
      h.engine.submit(
        makeJob(printerB, { jobId: 'job-b', idempotencyKey: 'key-b', copies: 1 }),
      );
      for (let i = 0; i < 2; i += 1) await drained();
      const rowA = h.engine.getJob('job-a');
      const rowB = h.engine.getJob('job-b');
      expect(rowA?.status).toBe('completed');
      expect(rowB?.status).toBe('completed');
      // B's rendered ack exists — B was never blocked behind A's in-flight job.
      expect(h.acks.some((a) => a.jobId === 'job-a' && a.status === 'rendered')).toBe(true);
      expect(h.acks.some((a) => a.jobId === 'job-b' && a.status === 'rendered')).toBe(true);
      // Each transport wrote exactly its own job's copies.
      const tA = transports.get(printerA);
      const tB = transports.get(printerB);
      expect(tA?.writes).toHaveLength(2);
      expect(tB?.writes).toHaveLength(1);
      expect(tA?.maxConcurrentWrites).toBe(1);
      expect(tB?.maxConcurrentWrites).toBe(1);
    } finally {
      h.dispose();
    }
  });
});
