import { describe, expect, it } from 'vitest';
import { makeHarness, makeJob } from './helpers/job-engine-harness';
import { FakeTransportRegistry } from './helpers/fake-transport';
import { decodeEscpos } from './helpers/escpos-decode';

async function drained(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('engine execution', () => {
  it('happy path: accepted → rendered → sending → sent_to_printer → completed, one write per copy', async () => {
    const transports = new FakeTransportRegistry();
    const h = await makeHarness({ transports });
    try {
      h.engine.submit(makeJob(h.printerId, { copies: 2 }));
      await drained();
      const transport = transports.get(h.printerId);
      expect(transport?.writes).toHaveLength(2); // copies loop: one write per copy
      expect(transport?.opens).toBe(1);
      expect(transport?.closes).toBe(1);
      expect(h.acks.map((a) => a.status)).toEqual([
        'accepted',
        'rendered',
        'sent_to_printer',
        'completed',
      ]);
      const row = h.engine.getJob('job-1');
      expect(row?.status).toBe('completed');
      expect(row?.sentAt).not.toBeNull();
      expect(row?.completedAt).not.toBeNull();
      expect(row?.attempts).toBe(1);
      for (const a of h.acks) expect(a.printed).toBe(false); // security rule 8
      const events = decodeEscpos(transport?.writes[0] ?? new Uint8Array());
      expect(events.length).toBeGreaterThan(0);
    } finally {
      h.dispose();
    }
  });

  it('emits no sending/printer_ack acks (api-contract §3.1)', async () => {
    const transports = new FakeTransportRegistry();
    const h = await makeHarness({ transports });
    try {
      h.engine.submit(makeJob(h.printerId));
      await drained();
      expect(h.acks.map((a) => a.status)).not.toContain('sending');
      expect(h.acks.map((a) => a.status)).not.toContain('printer_ack');
    } finally {
      h.dispose();
    }
  });

  it('does not re-execute a job whose idempotency key already completed (repeated delivery)', async () => {
    const transports = new FakeTransportRegistry();
    const h = await makeHarness({ transports });
    try {
      h.engine.submit(makeJob(h.printerId));
      await drained();
      const writesAfterFirst = transports.get(h.printerId)?.writes.length ?? 0;
      expect(writesAfterFirst).toBeGreaterThan(0);
      // Same idempotency key, new jobId: the duplicate ack is returned from
      // stored state (Task 5 semantics), never re-executed nor re-sunk.
      const dupAck = h.engine.submit(makeJob(h.printerId, { jobId: 'dup-1' }));
      await drained();
      expect(dupAck).toMatchObject({ jobId: 'job-1', status: 'completed', printed: false });
      expect(transports.get(h.printerId)?.writes.length).toBe(writesAfterFirst); // no second print
      expect(h.engine.getJob('dup-1')).toBeNull();
      expect(h.acks.filter((a) => a.status === 'completed')).toHaveLength(1);
    } finally {
      h.dispose();
    }
  });
});
