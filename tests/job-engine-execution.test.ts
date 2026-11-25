import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { makeHarness, makeJob } from './helpers/job-engine-harness';
import { makeDoc } from './helpers/render';
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

describe('engine acks — printer status (C1)', () => {
  it('acks carry the injected cached status at ack-build time', async () => {
    const transports = new FakeTransportRegistry();
    const h = await makeHarness({ transports, printerStatus: () => 'paper_low' });
    try {
      h.engine.submit(makeJob(h.printerId));
      await drained();
      expect(h.acks.length).toBeGreaterThan(0);
      for (const a of h.acks) expect(a.printerStatus).toBe('paper_low');
    } finally {
      h.dispose();
    }
  });

  it('without the injection acks stay unknown (back-compat)', async () => {
    const transports = new FakeTransportRegistry();
    const h = await makeHarness({ transports });
    try {
      h.engine.submit(makeJob(h.printerId));
      await drained();
      for (const a of h.acks) expect(a.printerStatus).toBe('unknown');
    } finally {
      h.dispose();
    }
  });
});

describe('engine execution — Unicode raster gate (R-VAL-1)', () => {
  const BN_DOC = makeDoc({
    header: { restaurant_name: 'প্রিন্ট ক্যাফে', address_lines: ['12 Main St'] },
  });
  const FONT = resolve(__dirname, '../assets/fonts/NotoSansBengali-Regular.ttf');

  async function rasterPrinter(): Promise<{
    h: ReturnType<typeof makeHarness> extends Promise<infer T> ? T : never;
    transports: FakeTransportRegistry;
  }> {
    const transports = new FakeTransportRegistry();
    const h = await makeHarness({ transports, fontPaths: [FONT] });
    await h.printers.update(h.printerId, {
      capabilities: {
        cut: true,
        qrCode: false,
        barcode128: false,
        statusPolling: false,
        unicodeRaster: true,
      },
    });
    return { h, transports };
  }

  it('rasterizes non-ASCII payload lines when the printer capability is on', async () => {
    const { h, transports } = await rasterPrinter();
    try {
      h.engine.submit(makeJob(h.printerId, { payload: BN_DOC }));
      await drained();
      expect(h.acks.map((a) => a.status)).toContain('rendered');
      const events = decodeEscpos(transports.get(h.printerId)?.writes[0] ?? new Uint8Array());
      expect(events.some((e) => e.kind === 'image')).toBe(true); // GS v 0 bitmap
      expect(events.some((e) => e.kind === 'text')).toBe(true); // ASCII stays text
    } finally {
      h.dispose();
    }
  });

  it('fails the job with text_not_encodable when the capability is off', async () => {
    const h = await makeHarness({ transports: new FakeTransportRegistry() });
    try {
      h.engine.submit(makeJob(h.printerId, { payload: BN_DOC }));
      await drained();
      const failed = h.acks.find((a) => a.status === 'failed');
      expect(failed?.error?.code).toBe('text_not_encodable');
    } finally {
      h.dispose();
    }
  });
});
