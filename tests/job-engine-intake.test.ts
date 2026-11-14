import { describe, expect, it } from 'vitest';
import { makeHarness, makeJob, HARNESS_T0 } from './helpers/job-engine-harness';
import { makeDoc } from './helpers/render';
import { FakeTransport, FakeTransportRegistry } from './helpers/fake-transport';
import { TransportError } from '../src/main/transport/errors';
import type { PrinterProfile } from '../src/main/printers/profile';
import type { TransportRegistry } from '../src/main/transport/registry';
import type { JobStore } from '../src/main/local-store/job-store';
import { JobEngineError } from '../src/main/jobs/errors';

/** FakeTransport whose open() consults a callback per call (first-use script
 *  freezing in FakeTransportRegistry makes per-call outcomes impossible there). */
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

async function drained(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('engine intake', () => {
  it('durably accepts a valid job and emits exactly one accepted ack', async () => {
    const h = await makeHarness();
    try {
      const ack = h.engine.submit(makeJob(h.printerId));
      expect(ack).toMatchObject({ jobId: 'job-1', status: 'accepted', printed: false, attempt: 1 });
      expect(ack.at).toBe(new Date(HARNESS_T0).toISOString());
      expect(h.acks).toHaveLength(1);
      const row = h.engine.getJob('job-1');
      expect(row).not.toBeNull();
      expect(row?.status).toBe('accepted');
      expect(row?.docType).toBe('customer_receipt');
    } finally {
      h.dispose();
    }
  });

  it('rejects jobs for an unknown printer without persisting them', async () => {
    const h = await makeHarness();
    try {
      const ack = h.engine.submit(makeJob('ghost'));
      expect(ack.status).toBe('rejected');
      expect(ack.error?.code).toBe('unknown_printer');
      expect(h.engine.getJob('job-1')).toBeNull();
      // The pull is the claim: intake rejections MUST be submitted.
      expect(h.acks).toHaveLength(1);
      expect(h.acks[0]).toMatchObject({ jobId: 'job-1', status: 'rejected' });
    } finally {
      h.dispose();
    }
  });

  it('rejects expired jobs', async () => {
    const h = await makeHarness();
    try {
      const ack = h.engine.submit(makeJob(h.printerId, { expiresAt: HARNESS_T0 - 1 }));
      expect(ack.status).toBe('rejected');
      expect(ack.error?.code).toBe('expired_job');
      expect(h.engine.getJob('job-1')).toBeNull();
    } finally {
      h.dispose();
    }
  });

  it('rejects unsupported doc versions', async () => {
    const h = await makeHarness();
    try {
      const ack = h.engine.submit(makeJob(h.printerId, { docVersion: 2 }));
      expect(ack.status).toBe('rejected');
      expect(ack.error?.code).toBe('unsupported_doc_version');
      expect(h.engine.getJob('job-1')).toBeNull();
    } finally {
      h.dispose();
    }
  });

  it('rejects payloads that violate the doc model (api-contract §2: invalid_doc)', async () => {
    const h = await makeHarness();
    try {
      const ack = h.engine.submit(makeJob(h.printerId, { payload: { nope: true } }));
      expect(ack.status).toBe('rejected');
      expect(ack.error?.code).toBe('invalid_doc');
      expect(h.engine.getJob('job-1')).toBeNull();
    } finally {
      h.dispose();
    }
  });

  it('rejects copies outside 1..4 with invalid_envelope (api-contract §2 agent cap)', async () => {
    const h = await makeHarness();
    try {
      for (const copies of [0, 5]) {
        const ack = h.engine.submit(makeJob(h.printerId, { copies }));
        expect(ack.status).toBe('rejected');
        expect(ack.error?.code).toBe('invalid_envelope');
        expect(ack.error?.message).toBe('copies must be an integer between 1 and 4');
        expect(h.engine.getJob('job-1')).toBeNull(); // not persisted
      }
      // The pull is the claim: intake rejections MUST be submitted.
      expect(h.acks).toHaveLength(2);
    } finally {
      h.dispose();
    }
  });

  it('rejects priority outside 1..9 with invalid_envelope (api-contract §2 agent cap)', async () => {
    const h = await makeHarness();
    try {
      for (const priority of [0, 10]) {
        const ack = h.engine.submit(makeJob(h.printerId, { priority }));
        expect(ack.status).toBe('rejected');
        expect(ack.error?.code).toBe('invalid_envelope');
        expect(ack.error?.message).toBe('priority must be an integer between 1 and 9');
        expect(h.engine.getJob('job-1')).toBeNull(); // not persisted
      }
      // The pull is the claim: intake rejections MUST be submitted.
      expect(h.acks).toHaveLength(2);
    } finally {
      h.dispose();
    }
  });

  it('rejects payloads over the 32 KiB serialized cap at intake with invalid_doc, not persisted', async () => {
    // Doc-model-VALID doc whose JSON still exceeds 32 KiB (200 lines, each
    // within the per-field byte caps) — same shape the render taxonomy used
    // before the intake cap made the render-stage guard unreachable via intake.
    const payload = makeDoc({
      lines: Array.from({ length: 200 }, (_, i) => ({
        text: `${String(i).padStart(3, '0')}-`.padEnd(96, 'x'),
        note: 'n'.padEnd(64, 'y'),
        qty: 1,
        unit_price: 1,
      })),
    });
    const h = await makeHarness();
    try {
      expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeGreaterThan(32 * 1024);
      const ack = h.engine.submit(makeJob(h.printerId, { payload }));
      expect(ack.status).toBe('rejected');
      expect(ack.error?.code).toBe('invalid_doc');
      expect(ack.error?.message).toBe('payload exceeds the 32 KiB cap');
      expect(h.engine.getJob('job-1')).toBeNull(); // not persisted
      expect(h.acks).toHaveLength(1);
    } finally {
      h.dispose();
    }
  });

  it('suppresses duplicate delivery per (restaurant_id, idempotency_key) without re-execution', async () => {
    const h = await makeHarness();
    try {
      const first = h.engine.submit(makeJob(h.printerId));
      expect(first.status).toBe('accepted');
      const dup = h.engine.submit(makeJob(h.printerId, { jobId: 'job-1-dup' }));
      expect(dup.status).toBe('accepted');
      // Only the original accept reaches the ack sink — the duplicate re-ack is
      // returned to the caller without a second sink delivery or re-execution.
      expect(h.acks).toHaveLength(1);
      expect(h.engine.getJob('job-1-dup')).toBeNull();
      expect(h.engine.pendingCount()).toBe(1);
    } finally {
      h.dispose();
    }
  });

  it('enforces the bounded queue size', async () => {
    const h = await makeHarness({ limits: { maxPending: 1 } });
    try {
      const first = h.engine.submit(makeJob(h.printerId));
      expect(first.status).toBe('accepted');
      const second = h.engine.submit(
        makeJob(h.printerId, { jobId: 'job-2', idempotencyKey: 'key-2' }),
      );
      expect(second.status).toBe('rejected');
      expect(second.error?.code).toBe('queue_full');
      expect(h.engine.getJob('job-2')).toBeNull();
    } finally {
      h.dispose();
    }
  });

  it('acks a re-delivery from stored state BEFORE re-evaluating printer/docVersion/expiry (T4/ADR-6)', async () => {
    const h = await makeHarness();
    try {
      const first = h.engine.submit(makeJob(h.printerId));
      expect(first.status).toBe('accepted');
      // Same idempotency key, but the re-delivered input is now invalid on its
      // own terms: unknown doc version AND already expired. The stored row
      // must win — the duplicate ack is derived from stored state alone.
      const redelivered = h.engine.submit(
        makeJob(h.printerId, {
          jobId: 'job-1-redelivery',
          docVersion: 2,
          expiresAt: HARNESS_T0 - 1,
        }),
      );
      expect(redelivered.status).toBe('accepted');
      expect(redelivered.jobId).toBe('job-1'); // stored row id, not the new jobId
      expect(h.engine.getJob('job-1-redelivery')).toBeNull();
      expect(h.acks).toHaveLength(1);
    } finally {
      h.dispose();
    }
  });

  it('surfaces store insert failures as store_unavailable without emitting an ack', async () => {
    const h = await makeHarness({
      wrapStore: (base: JobStore): JobStore => ({
        ...base,
        insert: () => {
          throw new Error('simulated db failure');
        },
      }),
    });
    try {
      let thrown: unknown;
      try {
        h.engine.submit(makeJob(h.printerId));
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(JobEngineError);
      expect((thrown as JobEngineError).code).toBe('store_unavailable');
      expect(h.acks).toHaveLength(0);
    } finally {
      h.dispose();
    }
  });

  // ---- GAP-2: strictly-greater epoch = server-initiated retry ------------

  it('re-executes a FAILED row when the incoming attempt is strictly greater (server retry)', async () => {
    let failFirst = 1; // first open only
    const transports = new OpenScriptRegistry(() =>
      failFirst-- > 0 ? new TransportError('connect_refused', 'printer refused') : undefined,
    );
    const h = await makeHarness({ transports, limits: { maxAttempts: 1 } });
    try {
      h.engine.submit(makeJob(h.printerId)); // attempt 1 — open fails → failed
      await drained();
      const failedRow = h.engine.getJob('job-1');
      expect(failedRow?.status).toBe('failed');
      expect(failedRow?.deliveryAttempt).toBe(1);

      // Operator retry server-side: same job id/key, epoch bumped to 2.
      const retry = h.engine.submit(makeJob(h.printerId, { attempt: 2 }));
      expect(retry.status).toBe('accepted');
      expect(retry.jobId).toBe('job-1'); // same stored row, not a new one
      await drained();

      const row = h.engine.getJob('job-1');
      expect(row?.status).toBe('completed'); // re-executed — paper
      expect(row?.deliveryAttempt).toBe(2); // epoch persisted
      expect(row?.attempts).toBe(1); // fresh local budget after resetAttempts
      expect(transports.get(h.printerId)?.writes).toHaveLength(1); // exactly one write (the retry cycle)
      // Every ack of the new cycle echoes the new epoch.
      const firstNew = h.acks.findIndex((a) => a.attempt === 2);
      expect(firstNew).toBeGreaterThan(-1);
      const newCycle = h.acks.slice(firstNew);
      expect(newCycle.length).toBeGreaterThan(0);
      expect(newCycle.every((a) => a.attempt === 2)).toBe(true);
      expect(newCycle.at(-1)?.status).toBe('completed');
    } finally {
      h.dispose();
    }
  });

  it('re-prints a COMPLETED row on a higher-attempt re-delivery (lost-ack retry gap)', async () => {
    const transports = new FakeTransportRegistry(() => ({}));
    const h = await makeHarness({ transports });
    try {
      h.engine.submit(makeJob(h.printerId));
      await drained();
      expect(h.engine.getJob('job-1')?.status).toBe('completed'); // printed; completion ack lost server-side
      const acksBefore = h.acks.length;

      // The server never learned of the completion, so the operator retried
      // → epoch 2 re-delivery of the already-printed row.
      const retry = h.engine.submit(makeJob(h.printerId, { attempt: 2 }));
      expect(retry.status).toBe('accepted');
      await drained();

      expect(h.engine.getJob('job-1')?.status).toBe('completed');
      expect(h.engine.getJob('job-1')?.deliveryAttempt).toBe(2);
      expect(transports.get(h.printerId)?.writes).toHaveLength(2); // original + retry — paper twice, on purpose
      expect(h.acks).toHaveLength(acksBefore + 4); // accepted/rendered/sent_to_printer/completed for the new cycle
      expect(h.acks.at(-1)).toMatchObject({ status: 'completed', attempt: 2 });
    } finally {
      h.dispose();
    }
  });

  it('never re-executes on an EQUAL-attempt re-delivery (lease re-claim dedup)', async () => {
    const transports = new FakeTransportRegistry(() => ({}));
    const h = await makeHarness({ transports });
    try {
      h.engine.submit(makeJob(h.printerId));
      await drained();
      expect(h.engine.getJob('job-1')?.status).toBe('completed');
      const acksBefore = h.acks.length;

      // Lease-expiry re-claim re-delivers the SAME epoch — transport-level dedup.
      const dup = h.engine.submit(makeJob(h.printerId, { jobId: 'job-1-again', attempt: 1 }));
      expect(dup.status).toBe('completed'); // duplicateAck from stored state
      expect(dup.jobId).toBe('job-1');
      expect(dup.attempt).toBe(1); // echoes the STORED epoch
      await drained();

      expect(transports.get(h.printerId)?.writes).toHaveLength(1); // no second print
      expect(h.acks).toHaveLength(acksBefore); // no sink delivery either
      expect(h.engine.getJob('job-1')?.deliveryAttempt).toBe(1);
    } finally {
      h.dispose();
    }
  });

  it('acks an OLDER-attempt re-delivery as a duplicate without re-execution', async () => {
    const transports = new FakeTransportRegistry(() => ({}));
    const h = await makeHarness({ transports });
    try {
      h.engine.submit(makeJob(h.printerId));
      await drained();
      h.engine.submit(makeJob(h.printerId, { attempt: 2 })); // epoch → 2
      await drained();
      expect(h.engine.getJob('job-1')?.deliveryAttempt).toBe(2);
      const acksBefore = h.acks.length;

      const stale = h.engine.submit(makeJob(h.printerId, { attempt: 1 }));
      expect(stale.status).toBe('completed'); // duplicateAck — stored state
      await drained();

      expect(transports.get(h.printerId)?.writes).toHaveLength(2); // no third print
      expect(h.acks).toHaveLength(acksBefore);
      expect(h.engine.getJob('job-1')?.deliveryAttempt).toBe(2);
    } finally {
      h.dispose();
    }
  });

  it('re-validates the bypass: unknown printer → rejected WITH the incoming attempt (existing-row path)', async () => {
    const transports = new FakeTransportRegistry(() => ({}));
    const h = await makeHarness({ transports });
    try {
      h.engine.submit(makeJob(h.printerId));
      await drained();
      expect(h.engine.getJob('job-1')?.status).toBe('completed');
      await h.printers.remove(h.printerId); // printer drifted away before the retry arrived

      const retry = h.engine.submit(makeJob(h.printerId, { attempt: 2 }));
      expect(retry.status).toBe('rejected');
      expect(retry.error?.code).toBe('unknown_printer');
      expect(retry.attempt).toBe(2); // the INCOMING epoch, not the stale row's 1
      expect(h.acks.at(-1)).toMatchObject({ jobId: 'job-1', status: 'rejected', attempt: 2 });
      // The stored row is untouched by the failed bypass.
      expect(h.engine.getJob('job-1')?.status).toBe('completed');
      expect(h.engine.getJob('job-1')?.deliveryAttempt).toBe(1);
    } finally {
      h.dispose();
    }
  });

  it('re-validates the bypass: expired re-delivery → rejected WITH the incoming attempt', async () => {
    const transports = new FakeTransportRegistry(() => ({}));
    const h = await makeHarness({ transports });
    try {
      h.engine.submit(makeJob(h.printerId));
      await drained();
      expect(h.engine.getJob('job-1')?.status).toBe('completed');

      const retry = h.engine.submit(
        makeJob(h.printerId, { attempt: 2, expiresAt: HARNESS_T0 - 1 }),
      );
      expect(retry.status).toBe('rejected');
      expect(retry.error?.code).toBe('expired_job');
      expect(retry.attempt).toBe(2);
      expect(h.engine.getJob('job-1')?.deliveryAttempt).toBe(1); // untouched
    } finally {
      h.dispose();
    }
  });

  it('re-validates the bypass: queue full → rejected WITH the incoming attempt', async () => {
    const transports = new FakeTransportRegistry(() => ({ hang: true }));
    const h = await makeHarness({ transports, limits: { maxPending: 1 } });
    try {
      h.engine.submit(makeJob(h.printerId)); // hangs mid-transmission → sending (non-terminal)
      await drained();
      expect(h.engine.getJob('job-1')?.status).toBe('sending');

      const retry = h.engine.submit(makeJob(h.printerId, { attempt: 2 }));
      expect(retry.status).toBe('rejected');
      expect(retry.error?.code).toBe('queue_full');
      expect(retry.attempt).toBe(2);
      expect(h.engine.getJob('job-1')?.status).toBe('sending'); // untouched
      expect(h.engine.getJob('job-1')?.deliveryAttempt).toBe(1);
    } finally {
      h.dispose();
    }
  });
});
