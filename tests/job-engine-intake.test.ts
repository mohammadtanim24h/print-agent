import { describe, expect, it } from 'vitest';
import { makeHarness, makeJob, HARNESS_T0 } from './helpers/job-engine-harness';
import type { JobStore } from '../src/main/local-store/job-store';
import { JobEngineError } from '../src/main/jobs/errors';

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
      expect(h.acks).toHaveLength(0);
    } finally {
      h.dispose();
    }
  });

  it('rejects expired jobs', async () => {
    const h = await makeHarness();
    try {
      const ack = h.engine.submit(makeJob(h.printerId, { expiresAt: HARNESS_T0 - 1 }));
      expect(ack.status).toBe('rejected');
      expect(ack.error?.code).toBe('job_expired');
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
});
