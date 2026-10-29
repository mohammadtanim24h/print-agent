import { describe, expect, it, vi } from 'vitest';
import { createTransportRegistry } from '../src/main/transport/registry';
import { mockSocketFactory } from './helpers/mock-socket';
import { makeProfile } from './helpers/printers';

describe('transport registry', () => {
  it('builds a tcp transport from the approved profile endpoint', async () => {
    const sockets = mockSocketFactory((sock) => {
      sock.connect();
    });
    const registry = createTransportRegistry({ socketFactory: sockets.factory });
    const transport = registry.forPrinter(
      makeProfile({ transport: { kind: 'tcp_raw', host: '10.1.2.3', port: 9100 } }),
    );
    await transport.open();
    expect(sockets.last()?.host).toBe('10.1.2.3');
    expect(sockets.last()?.port).toBe(9100);
  });

  it('honors configured timeouts on created transports', async () => {
    vi.useFakeTimers();
    try {
      const sockets = mockSocketFactory(() => {
        /* never connects */
      });
      const registry = createTransportRegistry({
        socketFactory: sockets.factory,
        connectTimeoutMs: 1_234,
      });
      const transport = registry.forPrinter(makeProfile());
      const pending = transport.open();
      const expectation = expect(pending).rejects.toMatchObject({ code: 'connect_timeout' });
      await vi.advanceTimersByTimeAsync(1_234);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('transport registry — spooler_raw', () => {
  it('builds a spooler transport from the approved profile endpoint', async () => {
    const bridge = {
      printerExists: () => Promise.resolve(true),
      writeRaw: () => Promise.resolve(),
      enumerate: () => Promise.resolve(['EPSON TM-T20']),
    };
    const registry = createTransportRegistry({ spoolerBridge: bridge });
    const transport = registry.forPrinter(
      makeProfile({ transport: { kind: 'spooler_raw', windowsPrinterName: 'EPSON TM-T20' } }),
    );
    await expect(transport.healthCheck()).resolves.toBeUndefined();
  });

  it('routes writes to the profiled printer name', async () => {
    const writes: Array<{ name: string; bytes: Uint8Array }> = [];
    const bridge = {
      printerExists: () => Promise.resolve(true),
      writeRaw: (name: string, bytes: Uint8Array) => {
        writes.push({ name, bytes });
        return Promise.resolve();
      },
      enumerate: () => Promise.resolve(['EPSON TM-T20']),
    };
    const registry = createTransportRegistry({ spoolerBridge: bridge });
    const transport = registry.forPrinter(
      makeProfile({ transport: { kind: 'spooler_raw', windowsPrinterName: 'EPSON TM-T20' } }),
    );
    await transport.open();
    await transport.write(new Uint8Array([0x1b, 0x40]));
    expect(writes).toEqual([{ name: 'EPSON TM-T20', bytes: new Uint8Array([0x1b, 0x40]) }]);
  });
});
