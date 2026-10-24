import { describe, expect, it } from 'vitest';
import { makeHarness, makeJob } from './helpers/job-engine-harness';
import { FakeTransportRegistry } from './helpers/fake-transport';
import { TransportError } from '../src/main/transport/errors';

async function drained(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('engine retention cleanup', () => {
  it('deletes only terminal rows past the cutoff, with attempt history', async () => {
    let t = 1_000_000;
    const h = await makeHarness({
      now: () => t,
      transports: new FakeTransportRegistry(() => ({})),
      limits: { retentionDays: 1, retentionMaxRows: 100 },
    });
    try {
      h.engine.submit(makeJob(h.printerId, { jobId: 'old', idempotencyKey: 'key-old' }));
      await drained();
      // Completed at t; cutoff will be t - 1 day (evaluated after the advance).
      expect(h.engine.getJob('old')?.status).toBe('completed');
      expect(h.engine.getJob('old')?.updatedAt).toBe(1_000_000);

      t += 3 * 86_400_000; // 3 days later — 'old' is now > retentionDays old
      h.engine.submit(makeJob(h.printerId, { jobId: 'new', idempotencyKey: 'key-new' }));
      await drained();
      expect(h.engine.getJob('new')?.status).toBe('completed');

      expect(h.engine.cleanup()).toBe(1);
      expect(h.engine.getJob('old')).toBeNull();
      expect(h.engine.listAttempts('old')).toEqual([]); // history deleted with the job
      expect(h.engine.getJob('new')?.status).toBe('completed');
    } finally {
      h.dispose();
    }
  });

  it('never deletes non-terminal rows regardless of age', async () => {
    let t = 1_000_000;
    const transports = new FakeTransportRegistry(() => ({ hang: true }));
    const h = await makeHarness({
      now: () => t,
      transports,
      limits: { retentionDays: 0, retentionMaxRows: 100 },
    });
    try {
      h.engine.submit(makeJob(h.printerId));
      await drained();
      // Durably 'sending' — mid-transmission, not safe to delete (safe-deletion rule).
      expect(h.engine.getJob('job-1')?.status).toBe('sending');

      t += 400 * 86_400_000; // over a year — age alone must not matter
      expect(h.engine.cleanup()).toBe(0);
      expect(h.engine.getJob('job-1')?.status).toBe('sending');
    } finally {
      h.dispose();
    }
  });

  it('caps the number of terminal rows kept (retentionMaxRows), keeping the newest', async () => {
    let t = 1_000_000;
    const h = await makeHarness({
      now: () => t,
      transports: new FakeTransportRegistry(() => ({})),
      limits: { retentionDays: 0, retentionMaxRows: 2 },
    });
    try {
      // Each iteration: submit at t, advance 1s, then drain — completion stamps
      // updated_at with the post-advance t, so ordering is strict and exact:
      // j1=1_001_000, j2=1_002_000, j3=1_003_000, j4=1_004_000.
      for (let i = 1; i <= 4; i += 1) {
        h.engine.submit(makeJob(h.printerId, { jobId: `j${String(i)}`, idempotencyKey: `key-${String(i)}` }));
        t += 1_000;
        await drained();
      }
      const remaining = (): string[] =>
        (['j1', 'j2', 'j3', 'j4'] as const).filter((id) => h.engine.getJob(id) !== null);
      expect(remaining()).toEqual(['j1', 'j2', 'j3', 'j4']);

      // retentionDays 0 ⇒ cutoff = now; all four updated_at values are strictly
      // below it, so exactly the limit (2) oldest rows are eligible.
      t += 86_400_000;
      expect(h.engine.cleanup()).toBe(2);
      expect(remaining()).toEqual(['j3', 'j4']); // the two oldest were deleted
      expect(h.engine.getJob('j3')?.status).toBe('completed');
      expect(h.engine.getJob('j4')?.status).toBe('completed');
    } finally {
      h.dispose();
    }
  });

  it('deletes an unresolved ambiguous job past the cutoff (ambiguous is terminal)', async () => {
    let t = 1_000_000;
    const transports = new FakeTransportRegistry(() => ({
      failWriteNumber: 1,
      writeError: new TransportError('write_timeout', 'printer vanished mid-ticket'),
    }));
    const h = await makeHarness({
      now: () => t,
      transports,
      limits: { retentionDays: 1, retentionMaxRows: 100 },
    });
    try {
      h.engine.submit(makeJob(h.printerId));
      await drained();
      // Ambiguous = terminal: operator resolution is expected within retentionDays.
      expect(h.engine.getJob('job-1')?.status).toBe('ambiguous');

      t += 3 * 86_400_000; // 3 days later — past the cutoff, still unresolved
      expect(h.engine.cleanup()).toBe(1); // retention silently reaps it
      expect(h.engine.getJob('job-1')).toBeNull();
      expect(h.engine.listAttempts('job-1')).toEqual([]); // history deleted with the job
    } finally {
      h.dispose();
    }
  });
});
