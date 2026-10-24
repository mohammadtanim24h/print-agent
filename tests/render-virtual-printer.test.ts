import net from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { renderDoc } from '../src/main/render/render';
import { decodeEscpos, decodeLines } from './helpers/escpos-decode';
import { makeDoc, makeRenderProfile } from './helpers/render';
import { startVirtualPrinter, type VirtualPrinter } from './helpers/virtual-printer';

const printers: VirtualPrinter[] = [];

async function send(bytes: Uint8Array, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.write(Buffer.from(bytes), () => {
        socket.end();
      });
    });
    socket.on('end', () => {
      resolve();
    });
    socket.on('error', reject);
  });
}

afterAll(async () => {
  await Promise.all(printers.map((p) => p.close()));
});

describe('render output through a virtual ESC/POS printer (TCP)', () => {
  it('delivers a decodable customer receipt end to end', async () => {
    const vp = await startVirtualPrinter();
    printers.push(vp);

    const doc = makeDoc({
      header: { restaurant_name: 'Test Cafe', address_lines: ['12 Main St'] },
      totals: [{ label: 'TOTAL', amount_minor: 2400, emphasis: 'bold' }],
      footer: { text_lines: ['Thank you!'], qr_data: 'https://saas.example/r/ORD-1001' },
    });
    const rendered = renderDoc('customer_receipt', doc, makeRenderProfile());
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;

    await send(rendered.bytes, vp.port);
    const received = await vp.received;

    // Byte-for-byte survival across the socket.
    expect(Buffer.from(received).equals(Buffer.from(rendered.bytes))).toBe(true);

    // Semantic assertions on the decoded stream.
    const events = decodeEscpos(received);
    expect(events[0]).toEqual({ kind: 'init' });
    // Line-content assertions use physical lines (decodeLines): text events
    // split at style boundaries, so parts of one printed line are separate
    // events but a single physical line.
    const lines = decodeLines(received);
    expect(lines.some((l) => l.includes('Test Cafe'))).toBe(true);
    expect(lines.some((l) => l.includes('2 x Coffee'))).toBe(true);
    expect(lines.some((l) => l.includes('TOTAL'))).toBe(true);
    expect(lines.some((l) => l.includes('24.00'))).toBe(true);
    expect(lines.some((l) => l.includes('Thank you!'))).toBe(true);
    expect(
      events
        .filter((e) => e.kind === 'qr')
        .map((e) => (e as { data: string }).data)
        .join(''),
    ).toContain('https://saas.example/r/ORD-1001');
    expect(events.some((e) => e.kind === 'cut')).toBe(true);
    // No control bytes leaked into text positions anywhere on the wire.
    for (const event of events) {
      if (event.kind === 'text') {
        expect(event.text).not.toMatch(/<0x0[0-8]>/);
        expect(event.text).not.toMatch(/<0x1[0-8a-f]>/);
      }
    }
  });

  it('delivers a kitchen ticket end to end', async () => {
    const vp = await startVirtualPrinter();
    printers.push(vp);
    const doc = makeDoc({
      meta: { title: 'KITCHEN', order_ref: 'ORD-77', created_at: '2026-10-22T10:00:00.000Z' },
    });
    const rendered = renderDoc('kitchen_ticket', doc, makeRenderProfile());
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    await send(rendered.bytes, vp.port);
    const received = await vp.received;
    expect(Buffer.from(received).equals(Buffer.from(rendered.bytes))).toBe(true);
    const events = decodeEscpos(received);
    const lines = decodeLines(received);
    expect(lines.some((l) => l.includes('KITCHEN'))).toBe(true);
    expect(lines.some((l) => l.includes('ORD-77'))).toBe(true);
    expect(lines.some((l) => l.includes('2x'))).toBe(true);
    expect(events.some((e) => e.kind === 'cut')).toBe(true);
  });
});
