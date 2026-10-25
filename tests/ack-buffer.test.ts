import { describe, expect, it, vi } from 'vitest';
import { createAckBuffer } from '../src/main/ack-buffer';
import type { JobAck } from '../src/main/jobs/types';
import type { AckBatch } from '../src/main/cloud-client/types';

const ack = (jobId: string, status: JobAck['status'] = 'completed'): JobAck => ({
  jobId, status, printerStatus: 'unknown', printed: false, attempt: 1,
  at: new Date(0).toISOString(),
});

function makeEnv() {
  const submitted: AckBatch[] = [];
  const timers: (() => void)[] = [];
  const schedule = (fn: () => void): (() => void) => { timers.push(fn); return () => {}; };
  const submitAcks = vi.fn((batch: AckBatch): Promise<void> => {
    submitted.push(batch);
    return Promise.resolve();
  });
  return { submitted, timers, schedule, submitAcks };
}

describe('AckBuffer', () => {
  it('flushes when maxBatch is reached', async () => {
    const env = makeEnv();
    const buf = createAckBuffer({ submitAcks: env.submitAcks, schedule: env.schedule, maxBatch: 2, maxDelayMs: 5_000, envelopeVersion: 1 });
    buf.add(ack('a'));
    buf.add(ack('b'));
    await vi.waitFor(() => { expect(env.submitted.length).toBe(1); });
    expect(env.submitted[0]?.acks.map((a) => a.job_id)).toEqual(['a', 'b']);
  });

  it('flushes on the delay timer otherwise', async () => {
    const env = makeEnv();
    const buf = createAckBuffer({ submitAcks: env.submitAcks, schedule: env.schedule, maxBatch: 10, maxDelayMs: 5_000, envelopeVersion: 1 });
    buf.add(ack('a'));
    expect(env.timers.length).toBe(1);
    env.timers[0]?.();
    await vi.waitFor(() => { expect(env.submitted.length).toBe(1); });
  });

  it('retains acks on failure and flushes them on the next flush', async () => {
    const env = makeEnv();
    let fail = true;
    const submitAcks = vi.fn((batch: AckBatch): Promise<void> => {
      if (fail) throw new Error('network');
      env.submitted.push(batch);
      return Promise.resolve();
    });
    const buf = createAckBuffer({ submitAcks, schedule: env.schedule, maxBatch: 1, maxDelayMs: 5_000, envelopeVersion: 1 });
    buf.add(ack('a'));
    await vi.waitFor(() => { expect(submitAcks).toHaveBeenCalledTimes(1); });
    buf.add(ack('b'));
    fail = false;
    // maxBatch is 1, so the retained ack and the new one go as separate chunks.
    await vi.waitFor(() => { expect(env.submitted.length).toBe(2); });
    expect(env.submitted.flatMap((b) => b.acks.map((a) => a.job_id))).toEqual(['a', 'b']);
  });

  it('caps at maxQueued, dropping oldest', async () => {
    const env = makeEnv();
    let fail = true;
    const submitAcks = vi.fn((batch: AckBatch): Promise<void> => {
      if (fail) throw new Error('down');
      env.submitted.push(batch);
      return Promise.resolve();
    });
    const buf = createAckBuffer({ submitAcks, schedule: env.schedule, maxBatch: 100, maxDelayMs: 60_000, maxQueued: 3, envelopeVersion: 1 });
    for (const id of ['a', 'b', 'c', 'd']) buf.add(ack(id));
    await buf.stop(); // final flush fails; queue retains the newest 3
    expect(buf.pendingCount()).toBe(3);
    fail = false;
    await buf.stop(); // the same buffer drains the retained acks on a later flush
    expect(env.submitted[0]?.acks.map((a) => a.job_id)).toEqual(['b', 'c', 'd']); // 'a' was dropped by the cap
  });

  it('stop() flushes pending acks', async () => {
    const env = makeEnv();
    const buf = createAckBuffer({ submitAcks: env.submitAcks, schedule: env.schedule, maxBatch: 100, maxDelayMs: 60_000, envelopeVersion: 1 });
    buf.add(ack('a'));
    await buf.stop();
    expect(env.submitted.length).toBe(1);
  });

  it('flushNow() flushes without firing (or waiting for) the delay timer', async () => {
    const env = makeEnv();
    const buf = createAckBuffer({ submitAcks: env.submitAcks, schedule: env.schedule, maxBatch: 100, maxDelayMs: 60_000, envelopeVersion: 1 });
    buf.add(ack('a'));
    buf.add(ack('b'));
    expect(env.submitted.length).toBe(0);
    buf.flushNow();
    await vi.waitFor(() => { expect(env.submitted.length).toBe(1); });
    expect(env.submitted[0]?.acks.map((a) => a.job_id)).toEqual(['a', 'b']);
    expect(buf.pendingCount()).toBe(0);
    // The delay timer was armed but never fired — flushNow must not depend on it.
    for (const timer of env.timers) timer(); // firing the stale timer afterwards is a no-op
    expect(env.submitted.length).toBe(1);
  });

  it('flushNow() after a flush failure retains and re-delivers the batch', async () => {
    const env = makeEnv();
    let fail = true;
    const submitAcks = vi.fn((batch: AckBatch): Promise<void> => {
      if (fail) throw new Error('down');
      env.submitted.push(batch);
      return Promise.resolve();
    });
    const buf = createAckBuffer({ submitAcks, schedule: env.schedule, maxBatch: 1, maxDelayMs: 60_000, envelopeVersion: 1 });
    buf.add(ack('a'));
    await vi.waitFor(() => { expect(submitAcks).toHaveBeenCalledTimes(1); });
    // The failed chunk must be back in the queue before flushing again.
    await vi.waitFor(() => { expect(buf.pendingCount()).toBe(1); });
    fail = false;
    buf.flushNow();
    await vi.waitFor(() => { expect(submitAcks).toHaveBeenCalledTimes(2); });
    expect(env.submitted.length).toBe(1); // only the successful attempt is recorded
    expect(env.submitted[0]?.acks.map((a) => a.job_id)).toEqual(['a']);
    expect(buf.pendingCount()).toBe(0);
  });

  it('tolerates a degenerate maxBatch of 0 — stop() still delivers every ack', async () => {
    const env = makeEnv();
    const buf = createAckBuffer({ submitAcks: env.submitAcks, schedule: env.schedule, maxBatch: 0, maxDelayMs: 5_000, envelopeVersion: 1 });
    buf.add(ack('a'));
    buf.add(ack('b'));
    buf.add(ack('c'));
    await buf.stop();
    expect(env.submitted.flatMap((b) => b.acks.map((a) => a.job_id))).toEqual(['a', 'b', 'c']);
    expect(buf.pendingCount()).toBe(0);
  });

  it('drains a queue larger than the wire cap in chunks that each satisfy AckBatchSchema', async () => {
    const env = makeEnv();
    let fail = true;
    const submitAcks = vi.fn((batch: AckBatch): Promise<void> => {
      if (fail) throw new Error('down');
      env.submitted.push(batch);
      return Promise.resolve();
    });
    // maxBatch 20 (default), maxQueued 500 (default). Deterministic split of
    // 250 adds while failing: the chunked flush empties the queue synchronously,
    // so threshold flushes fire at adds #20, #40, …, #240 — exactly 12 failing
    // submissions of 20 acks each — and adds #241–#250 leave 10 queued. All
    // failing chunks re-queue (250 < maxQueued 500): nothing is dropped.
    const buf = createAckBuffer({ submitAcks, schedule: env.schedule, maxDelayMs: 60_000, envelopeVersion: 1 });
    for (let i = 0; i < 250; i++) buf.add(ack(`j${String(i)}`));
    await vi.waitFor(() => { expect(submitAcks).toHaveBeenCalledTimes(12); });
    fail = false;
    await buf.stop(); // drains the 250 queued acks as 12 × 20 + 1 × 10 = 13 chunks
    expect(env.submitted.length).toBe(13);
    expect(env.submitted.every((b) => b.acks.length <= 100)).toBe(true); // AckBatchSchema cap
    expect(env.submitted.every((b) => b.acks.length <= 20)).toBe(true); // and ≤ maxBatch
    const all = env.submitted.flatMap((b) => b.acks.map((a) => a.job_id));
    expect(all.length).toBe(250);
    expect(new Set(all)).toEqual(new Set(Array.from({ length: 250 }, (_, i) => `j${String(i)}`))); // all 250 delivered exactly once
  });
});
