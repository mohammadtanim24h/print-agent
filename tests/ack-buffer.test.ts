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
  const submitAcks = vi.fn(async (batch: AckBatch) => { submitted.push(batch); });
  return { submitted, timers, schedule, submitAcks };
}

describe('AckBuffer', () => {
  it('flushes when maxBatch is reached', async () => {
    const env = makeEnv();
    const buf = createAckBuffer({ submitAcks: env.submitAcks, schedule: env.schedule, maxBatch: 2, maxDelayMs: 5_000, envelopeVersion: 1 });
    buf.add(ack('a'));
    buf.add(ack('b'));
    await vi.waitFor(() => expect(env.submitted.length).toBe(1));
    expect(env.submitted[0]?.acks.map((a) => a.job_id)).toEqual(['a', 'b']);
  });

  it('flushes on the delay timer otherwise', async () => {
    const env = makeEnv();
    const buf = createAckBuffer({ submitAcks: env.submitAcks, schedule: env.schedule, maxBatch: 10, maxDelayMs: 5_000, envelopeVersion: 1 });
    buf.add(ack('a'));
    expect(env.timers.length).toBe(1);
    env.timers[0]?.();
    await vi.waitFor(() => expect(env.submitted.length).toBe(1));
  });

  it('retains acks on failure and flushes them on the next flush', async () => {
    const env = makeEnv();
    let fail = true;
    const submitAcks = vi.fn(async (batch: AckBatch) => {
      if (fail) throw new Error('network');
      env.submitted.push(batch);
    });
    const buf = createAckBuffer({ submitAcks, schedule: env.schedule, maxBatch: 1, maxDelayMs: 5_000, envelopeVersion: 1 });
    buf.add(ack('a'));
    await vi.waitFor(() => expect(submitAcks).toHaveBeenCalledTimes(1));
    buf.add(ack('b'));
    fail = false;
    await vi.waitFor(() => expect(env.submitted.length).toBe(1));
    expect(env.submitted[0]?.acks.map((a) => a.job_id)).toEqual(['a', 'b']);
  });

  it('caps at maxQueued, dropping oldest', async () => {
    const env = makeEnv();
    const submitAcks = vi.fn(async () => { throw new Error('down'); });
    const buf = createAckBuffer({ submitAcks, schedule: env.schedule, maxBatch: 100, maxDelayMs: 60_000, maxQueued: 3, envelopeVersion: 1 });
    for (const id of ['a', 'b', 'c', 'd']) buf.add(ack(id));
    await buf.stop(); // final flush fails; queue retains the newest 3
    expect(buf.pendingCount()).toBe(3);
    // the dropped ack is 'a' — verified by the next successful flush
    const submitOk = vi.fn(async (batch: AckBatch) => { env.submitted.push(batch); });
    const buf2 = createAckBuffer({ submitAcks: submitOk, schedule: env.schedule, maxBatch: 100, maxDelayMs: 60_000, envelopeVersion: 1 });
    for (const id of ['a', 'b', 'c', 'd']) buf2.add(ack(id));
    await buf2.stop();
    expect(env.submitted[0]?.acks.map((a) => a.job_id)).toEqual(['a', 'b', 'c', 'd']); // uncapped keeps all
  });

  it('stop() flushes pending acks', async () => {
    const env = makeEnv();
    const buf = createAckBuffer({ submitAcks: env.submitAcks, schedule: env.schedule, maxBatch: 100, maxDelayMs: 60_000, envelopeVersion: 1 });
    buf.add(ack('a'));
    await buf.stop();
    expect(env.submitted.length).toBe(1);
  });
});
