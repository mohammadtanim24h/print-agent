import { describe, expect, it } from 'vitest';
import { makeHarness, makeJob } from './helpers/job-engine-harness';
import { FakeTransport, FakeTransportRegistry } from './helpers/fake-transport';
import { TransportError } from '../src/main/transport/errors';
import type { PrinterProfile } from '../src/main/printers/profile';
import type { TransportRegistry } from '../src/main/transport/registry';

async function drained(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** FakeTransport whose open() consults a callback per call — needed when the
 *  outcome must change between retries (FakeTransportRegistry freezes the
 *  script object captured on first use). One transport per printer, reused. */
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

describe('engine failure semantics', () => {
  it('retries connect failures with backoff, then completes once the printer returns', async () => {
    let failFirst = 2; // first two opens fail
    const transports = new OpenScriptRegistry(() =>
      failFirst-- > 0 ? new TransportError('connect_refused', 'printer refused') : undefined,
    );
    const h = await makeHarness({ transports });
    try {
      h.engine.submit(makeJob(h.printerId));
      await drained();
      // attempt 1 failed → back to rendered, retry scheduled
      expect(h.engine.getJob('job-1')?.status).toBe('rendered');
      expect(h.acks.at(-1)?.status).toBe('rendered'); // no failed ack yet
      h.timers.shift()?.(); // fire retry 1 → open fails again
      await drained();
      expect(h.engine.getJob('job-1')?.status).toBe('rendered');
      h.timers.shift()?.(); // fire retry 2 → printer is back
      await drained();
      const row = h.engine.getJob('job-1');
      expect(row?.status).toBe('completed');
      expect(row?.attempts).toBe(3);
      expect(transports.get(h.printerId)?.opens).toBe(3);
      expect(transports.get(h.printerId)?.writes).toHaveLength(1); // printed exactly once
      expect(h.acks.at(-1)?.status).toBe('completed');
      // attempt history shows the two connect errors
      const outcomes = h.engine.listAttempts('job-1').map((a) => a.outcome);
      expect(outcomes).toEqual(['connect_error', 'connect_error', 'completed']);
    } finally {
      h.dispose();
    }
  });

  it('fails terminally after maxAttempts exhausted, without writing any bytes', async () => {
    const transports = new FakeTransportRegistry(() => ({
      openError: new TransportError('connect_timeout', 'no answer'),
    }));
    const h = await makeHarness({ transports, limits: { maxAttempts: 2 } });
    try {
      h.engine.submit(makeJob(h.printerId));
      await drained();
      h.timers.shift()?.(); // retry 1 → fails
      await drained();
      expect(h.engine.getJob('job-1')?.status).toBe('failed');
      expect(h.engine.getJob('job-1')?.lastError).toContain('connect_timeout');
      expect(transports.get(h.printerId)?.writes).toHaveLength(0); // never wrote a byte
      expect(h.acks.at(-1)).toMatchObject({ status: 'failed', error: { code: 'connect_timeout' } });
      expect(h.timers).toHaveLength(0); // no further retries scheduled
    } finally {
      h.dispose();
    }
  });

  it('marks ambiguous (never retries) when a write fails mid-stream', async () => {
    const transports = new FakeTransportRegistry(() => ({
      failWriteNumber: 1,
      writeError: new TransportError('write_timeout', 'printer vanished mid-ticket'),
    }));
    const h = await makeHarness({ transports });
    try {
      h.engine.submit(makeJob(h.printerId, { copies: 2 }));
      await drained();
      const row = h.engine.getJob('job-1');
      expect(row?.status).toBe('ambiguous');
      expect(transports.get(h.printerId)?.writes).toHaveLength(0); // second copy never attempted
      expect(transports.get(h.printerId)?.opens).toBe(1); // no reconnect
      expect(h.acks.at(-1)).toMatchObject({ status: 'ambiguous', error: { code: 'write_timeout' } });
      // ambiguous jobs are never auto-retried — flushing timers changes nothing
      h.timers.shift()?.();
      await drained();
      expect(h.engine.getJob('job-1')?.status).toBe('ambiguous');
      // attempt history records the ambiguous write
      const outcomes = h.engine.listAttempts('job-1').map((a) => a.outcome);
      expect(outcomes).toEqual(['write_ambiguous']);
    } finally {
      h.dispose();
    }
  });
});
