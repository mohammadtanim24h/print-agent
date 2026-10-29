import { describe, expect, it, vi } from 'vitest';
import { createSpoolerRawTransport } from '../src/main/transport/spooler-raw';
import type { SpoolerBridge } from '../src/main/transport/spooler-native';

type WriteRecord = { name: string; bytes: Uint8Array };

function makeBridge(overrides: Partial<SpoolerBridge> = {}): SpoolerBridge & { writes: WriteRecord[] } {
  const writes: WriteRecord[] = [];
  return {
    writes,
    printerExists: vi.fn((name: string) => Promise.resolve(name === 'EPSON TM-T20')),
    writeRaw: vi.fn((name: string, bytes: Uint8Array) => {
      writes.push({ name, bytes });
      return Promise.resolve();
    }),
    enumerate: vi.fn(() => Promise.resolve(['EPSON TM-T20'])),
    ...overrides,
  };
}

function makeTransport(bridge: SpoolerBridge) {
  return createSpoolerRawTransport({ printerName: 'EPSON TM-T20', bridge });
}

describe('spooler-raw transport — happy path', () => {
  it('probes existence on open, spools one job per write, closes idempotently', async () => {
    const bridge = makeBridge();
    const transport = makeTransport(bridge);
    await expect(transport.open()).resolves.toBeUndefined();
    await transport.write(new Uint8Array([0x1b, 0x40]));
    await transport.write(new Uint8Array([0x1d, 0x56, 0x01]));
    expect(bridge.writes.map((w) => Array.from(w.bytes))).toEqual([
      [0x1b, 0x40],
      [0x1d, 0x56, 0x01],
    ]);
    await expect(transport.close()).resolves.toBeUndefined();
  });

  it('open() is idempotent (one probe)', async () => {
    const printerExists = vi.fn((name: string) => Promise.resolve(name === 'EPSON TM-T20'));
    const bridge = makeBridge({ printerExists });
    const transport = makeTransport(bridge);
    await transport.open();
    await transport.open();
    expect(printerExists).toHaveBeenCalledTimes(1);
  });

  it('healthCheck probes without requiring open()', async () => {
    const printerExists = vi.fn((name: string) => Promise.resolve(name === 'EPSON TM-T20'));
    const writeRaw = vi.fn(() => Promise.resolve());
    const bridge = makeBridge({ printerExists, writeRaw });
    await expect(makeTransport(bridge).healthCheck()).resolves.toBeUndefined();
    expect(printerExists).toHaveBeenCalledWith('EPSON TM-T20');
    expect(writeRaw).not.toHaveBeenCalled();
  });
});

describe('spooler-raw transport — failures', () => {
  it('rejects open() with printer_not_found when the printer is not installed', async () => {
    const bridge = makeBridge({ printerExists: vi.fn(() => Promise.resolve(false)) });
    const transport = makeTransport(bridge);
    await expect(transport.open()).rejects.toMatchObject({ code: 'printer_not_found' });
  });

  it('write() before open() fails with not_open and never touches the spooler', async () => {
    const writeRaw = vi.fn(() => Promise.resolve());
    const bridge = makeBridge({ writeRaw });
    const transport = makeTransport(bridge);
    await expect(transport.write(new Uint8Array([0x0a]))).rejects.toMatchObject({
      code: 'not_open',
    });
    expect(writeRaw).not.toHaveBeenCalled();
  });

  it('propagates a spooler write failure as write_failed', async () => {
    const writeRaw = vi.fn(() =>
      Promise.reject(new Error('WritePrinter failed (Windows error 1168)')),
    );
    const bridge = makeBridge({ writeRaw });
    const transport = makeTransport(bridge);
    await transport.open();
    await expect(transport.write(new Uint8Array([0x0a]))).rejects.toMatchObject({
      code: 'write_failed',
    });
  });

  it('propagates a probe failure (access denied) from open() unchanged', async () => {
    const denied = Object.assign(new Error('denied'), { code: 'write_failed' });
    const bridge = makeBridge({ printerExists: vi.fn(() => Promise.reject(denied)) });
    const transport = makeTransport(bridge);
    await expect(transport.open()).rejects.toBe(denied);
  });

  it('serializes concurrent writes — jobs spool in call order', async () => {
    const order: number[] = [];
    const writeRaw = vi.fn(async (_name: string, bytes: Uint8Array) => {
      await new Promise((r) => setTimeout(r, 5));
      order.push(bytes[0] ?? 0);
    });
    const bridge = makeBridge({ writeRaw });
    const transport = makeTransport(bridge);
    await transport.open();
    await Promise.all([
      transport.write(new Uint8Array([0x01])),
      transport.write(new Uint8Array([0x02])),
      transport.write(new Uint8Array([0x03])),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('write() after close() fails with not_open', async () => {
    const writeRaw = vi.fn(() => Promise.resolve());
    const bridge = makeBridge({ writeRaw });
    const transport = makeTransport(bridge);
    await transport.open();
    await transport.close();
    await expect(transport.write(new Uint8Array([0x0a]))).rejects.toMatchObject({
      code: 'not_open',
    });
    expect(writeRaw).not.toHaveBeenCalled();
  });

  it('close() then open() re-probes the printer', async () => {
    const printerExists = vi.fn((name: string) => Promise.resolve(name === 'EPSON TM-T20'));
    const bridge = makeBridge({ printerExists });
    const transport = makeTransport(bridge);
    await transport.open();
    await transport.close();
    await transport.open();
    expect(printerExists).toHaveBeenCalledTimes(2);
  });
});
