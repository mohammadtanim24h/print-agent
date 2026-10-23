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
