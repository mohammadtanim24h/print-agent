import { describe, expect, it, vi } from 'vitest';
import { FakeTransportRegistry } from './helpers/fake-transport';
import { decodeEscpos } from './helpers/escpos-decode';
import { makeDoc } from './helpers/render';
import {
  PAIRING_CODE,
  makeCloudConfig,
  makeCloudPrinterConfig,
  makeRuntime,
  signedJobEnvelope,
} from './helpers/runtime-harness';

/**
 * C2 load burst (R-VAL-6): 10 jobs in 5 s over the poll delivery path.
 * The schedule seam clamps every timer to 5 ms, so the "5 s" window is
 * virtual — the stress is intake depth (ONE pollJobs response carries the
 * whole burst) and per-printer interleaving, not wall clock. Deterministic:
 * no sleeps, no real network, no real printers.
 */

const BURST_SIZE = 10;
const JOBS_PER_PRINTER = 5;

describe('C2 load burst (R-VAL-6)', () => {
  it('drains a 10-job single-poll burst across 2 printers: FIFO order, acks drain, zero ambiguous', async () => {
    const printerTransports = new FakeTransportRegistry();
    const printerA = makeCloudPrinterConfig(1, { station: 'kitchen' });
    const printerB = makeCloudPrinterConfig(2, { station: 'counter' });
    const { runtime, transport } = await makeRuntime({ transports: printerTransports });

    // Cloud config (version 1, two tcp_raw printers) applies before any job
    // is released — otherwise intake would reject on unknown printers.
    transport.configResponse = makeCloudConfig(1, [printerA, printerB]);
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    await vi.waitFor(() => {
      expect(runtime.printers.list()).toHaveLength(2);
    });

    // Interleaved A1,B1,A2,B2,… — per-printer submission order is 1→5.
    const envelopeIds = new Set<string>();
    const expectedOrder: Record<'A' | 'B', string[]> = { A: [], B: [] };
    const burst: Record<string, unknown>[] = [];
    for (let seq = 1; seq <= JOBS_PER_PRINTER; seq += 1) {
      for (const key of ['A', 'B'] as const) {
        const printer = key === 'A' ? printerA : printerB;
        const marker = `BURST-${key}-${String(seq)}`;
        expectedOrder[key].push(marker);
        const envelope = signedJobEnvelope(printer.printer_id, {
          job_id: `018f3c2e-0000-7000-8000-${String(300 + burst.length).padStart(12, '0')}`,
          idempotency_key: `burst-${key}-${String(seq)}`,
          payload: makeDoc({ lines: [{ text: marker }] }),
        });
        envelopeIds.add((envelope.job as { job_id: string }).job_id);
        burst.push(envelope);
      }
    }

    // Worst-case arrival: one poll response delivers the entire burst.
    transport.queuedJobs.push(...burst);

    // 1. Completion: all 10 reach `completed`; queue fully drained.
    await vi.waitFor(() => {
      const jobs = runtime.jobs.list();
      expect(jobs).toHaveLength(BURST_SIZE);
      for (const job of jobs) expect(job.status).toBe('completed');
    });
    const snap = await runtime.snapshot();
    expect(snap.pendingJobs).toBe(0);
    expect(snap.ambiguousJobs).toBe(0);

    // 2. Per-printer FIFO: decoded receipt text per printer is strictly in
    //    submission order — the engine never reorders within a printer.
    for (const key of ['A', 'B'] as const) {
      const printer = key === 'A' ? printerA : printerB;
      const t = printerTransports.get(printer.printer_id);
      expect(t, `printer transport for ${key}`).toBeDefined();
      const seen = (t?.writes ?? []).flatMap((w) =>
        decodeEscpos(w).flatMap((e) =>
          e.kind === 'text' && e.text.includes('BURST-') ? [e.text] : [],
        ),
      );
      expect(seen).toEqual(expectedOrder[key]);
    }

    // 3. Ack wire drain: exactly the burst's job ids reached the wire, each
    //    with BOTH the accepted and the completed ack; nothing rejected.
    await vi.waitFor(() => {
      const acks = transport.acks.flatMap((b) => b.acks);
      for (const status of ['accepted', 'completed'] as const) {
        const acked = new Set(acks.filter((a) => a.status === status).map((a) => a.job_id));
        expect(acked).toEqual(envelopeIds);
      }
      expect(acks.some((a) => a.status === 'rejected')).toBe(false);
    });
  });
});
