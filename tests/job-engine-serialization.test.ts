import { describe, expect, it } from 'vitest';
import { makeHarness, makeJob } from './helpers/job-engine-harness';
import { FakeTransport, FakeTransportRegistry } from './helpers/fake-transport';

async function drained(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** FakeTransport whose FIRST write blocks until released. The per-printer
 *  queue only holds more than one job while the printer is busy — drain()
 *  shifts synchronously otherwise — so a gate that stays hung across
 *  macrotasks is what lets jobs pile up in the pending queue, which is where
 *  byRank ordering is actually exercised. */
class GatedTransport extends FakeTransport {
  private release: (() => void) | null = null;
  private hung = false;

  constructor() {
    super({});
  }

  override async write(bytes: Uint8Array): Promise<void> {
    if (!this.hung) {
      this.hung = true;
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    await super.write(bytes);
  }

  /** Release the hung first write. */
  unblock(): void {
    this.release?.();
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

  it('priority ordering: jobs queued behind an in-flight job execute high-priority first', async () => {
    // 'inflight' occupies the printer, hung in its first write. While it is
    // busy, 'low' (priority 9) then 'high' (priority 1) are submitted — both
    // land in the pending queue in that insertion order. When the gate opens,
    // drain() re-selects over the queue: byRank must pick high first. Under
    // pure FIFO the insertion order would win and low would render first, so
    // this assertion fails if byRank is deleted.
    const gated = new GatedTransport();
    const h = await makeHarness({ transports: { forPrinter: () => gated } });
    try {
      h.engine.submit(
        makeJob(h.printerId, { jobId: 'job-inflight', idempotencyKey: 'key-inflight', copies: 1 }),
      );
      await drained(); // 'inflight' is now stuck in its first write
      expect(h.engine.getJob('job-inflight')?.status).toBe('sending');
      expect(gated.writes).toHaveLength(0); // write never completed

      const baseline = h.acks.length; // 'inflight' already emitted accepted + rendered
      h.engine.submit(
        makeJob(h.printerId, { jobId: 'job-low', idempotencyKey: 'key-low', priority: 9 }),
      );
      h.engine.submit(
        makeJob(h.printerId, { jobId: 'job-high', idempotencyKey: 'key-high', priority: 1 }),
      );
      // The busy printer must not run them: only the two intake acks appear,
      // and neither row leaves 'accepted'.
      expect(h.acks.slice(baseline).map((a) => a.status)).toEqual(['accepted', 'accepted']);
      expect(h.engine.getJob('job-low')?.status).toBe('accepted');
      expect(h.engine.getJob('job-high')?.status).toBe('accepted');

      gated.unblock();
      await drained(); // inflight completes, then the queue drains by rank
      for (const id of ['job-inflight', 'job-low', 'job-high']) {
        expect(h.engine.getJob(id)?.status).toBe('completed');
      }
      // Execution order reads off the rendered acks (emitted when each job's
      // execution starts): high before low despite the reversed submit order.
      const renderOrder = h.acks
        .slice(baseline)
        .filter((a) => a.status === 'rendered')
        .map((a) => a.jobId);
      expect(renderOrder).toEqual(['job-high', 'job-low']);
    } finally {
      h.dispose();
    }
  });

  it('cross-printer independence: a short job on printer B acks before a long job on printer A', async () => {
    const transports = new FakeTransportRegistry();
    const h = await makeHarness({ transports, printerCount: 2 });
    try {
      const [printerA, printerB] = h.printerIds;
      if (printerA === undefined || printerB === undefined) throw new Error('unreachable: printerCount is 2');
      h.engine.submit(
        makeJob(printerA, { jobId: 'job-a', idempotencyKey: 'key-a', copies: 3 }),
      );
      h.engine.submit(
        makeJob(printerB, { jobId: 'job-b', idempotencyKey: 'key-b', copies: 1 }),
      );
      await drained();
      const rowA = h.engine.getJob('job-a');
      const rowB = h.engine.getJob('job-b');
      expect(rowA?.status).toBe('completed');
      expect(rowB?.status).toBe('completed');
      // Ack interleaving: B's single copy finishes while A still has writes
      // pending, so B's completed ack must land BEFORE A's. A global drain
      // lock shared across printers would serialize B behind A and reverse
      // (or suppress) B's completed ack — this ordering is the discrimination.
      const aCompleted = h.acks.findIndex((a) => a.jobId === 'job-a' && a.status === 'completed');
      const bCompleted = h.acks.findIndex((a) => a.jobId === 'job-b' && a.status === 'completed');
      expect(bCompleted).toBeGreaterThanOrEqual(0);
      expect(aCompleted).toBeGreaterThan(bCompleted);
      // Each transport wrote exactly its own job's copies.
      const tA = transports.get(printerA);
      const tB = transports.get(printerB);
      expect(tA?.writes).toHaveLength(3);
      expect(tB?.writes).toHaveLength(1);
      expect(tA?.maxConcurrentWrites).toBe(1);
      expect(tB?.maxConcurrentWrites).toBe(1);
    } finally {
      h.dispose();
    }
  });
});
