import { describe, expect, it, vi } from 'vitest';
import { createTcpRawTransport } from '../src/main/transport/tcp-raw';
import { mockSocketFactory, type MockSockets } from './helpers/mock-socket';

const HOST = '192.168.1.50';

function makeTransport(sockets: MockSockets) {
  return createTcpRawTransport({
    host: HOST,
    port: 9100,
    socketFactory: sockets.factory,
  });
}

describe('tcp-raw transport — happy path', () => {
  it('connects, writes bytes in order, and closes', async () => {
    const sockets = mockSocketFactory((sock) => {
      sock.connect();
    });
    const transport = makeTransport(sockets);

    await expect(transport.open()).resolves.toBeUndefined();

    await transport.write(new Uint8Array([0x1b, 0x40]));
    await transport.write(new Uint8Array([0x1d, 0x56, 0x01]));

    expect(sockets.last()?.written).toEqual([
      Buffer.from([0x1b, 0x40]),
      Buffer.from([0x1d, 0x56, 0x01]),
    ]);

    await expect(transport.close()).resolves.toBeUndefined();
    expect(sockets.last()?.destroyed).toBe(true);
  });

  it('targets the configured endpoint', async () => {
    const sockets = mockSocketFactory((sock) => {
      sock.connect();
    });
    const transport = makeTransport(sockets);
    await transport.open();
    expect(sockets.last()?.host).toBe(HOST);
    expect(sockets.last()?.port).toBe(9100);
  });

  it('open() is idempotent while already open', async () => {
    const sockets = mockSocketFactory((sock) => {
      sock.connect();
    });
    const transport = makeTransport(sockets);
    await transport.open();
    await transport.open();
    expect(sockets.sockets).toHaveLength(1);
  });

  it('close() is idempotent', async () => {
    const sockets = mockSocketFactory((sock) => {
      sock.connect();
    });
    const transport = makeTransport(sockets);
    await expect(transport.close()).resolves.toBeUndefined();
  });

  it('write() before open() fails with not_open and never touches the network', async () => {
    const sockets = mockSocketFactory((sock) => {
      sock.connect();
    });
    const transport = makeTransport(sockets);
    await expect(transport.write(new Uint8Array([0x0a]))).rejects.toMatchObject({
      code: 'not_open',
    });
    expect(sockets.sockets).toHaveLength(0);
  });
});

describe('tcp-raw transport — lifecycle', () => {
  it('open() during in-flight connect coalesces into one connection', async () => {
    let connectNow: (() => void) | undefined;
    const sockets = mockSocketFactory((sock) => {
      connectNow = () => {
        sock.connect();
      };
    });
    const transport = makeTransport(sockets);
    const first = transport.open();
    const second = transport.open();
    // The mock factory runs its script on a microtask; yield once so
    // connectNow is assigned before the connect is triggered.
    await Promise.resolve();
    connectNow?.();
    await Promise.all([first, second]);
    expect(sockets.sockets).toHaveLength(1);
  });

  it('close() during in-flight connect aborts the connection attempt', async () => {
    const sockets = mockSocketFactory(() => {
      /* never connects */
    });
    const transport = makeTransport(sockets);
    const pendingOpen = transport.open();
    const expectation = expect(pendingOpen).rejects.toMatchObject({ code: 'disconnected' });
    await transport.close();
    await expectation;
  });

  it('close() resolves only after the socket close event', async () => {
    let emitClose: (() => void) | undefined;
    const sockets = mockSocketFactory((sock) => {
      sock.connect();
      sock.destroy = () => {
        emitClose = () => {
          sock.emit('close', false);
        };
      };
    });
    const transport = makeTransport(sockets);
    await transport.open();
    let resolved = false;
    const closing = transport.close().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
    emitClose?.();
    await closing;
    expect(resolved).toBe(true);
  });

  it('open() after close() creates a fresh connection', async () => {
    const sockets = mockSocketFactory((sock) => {
      sock.connect();
    });
    const transport = makeTransport(sockets);
    await transport.open();
    await transport.close();
    await transport.open();
    expect(sockets.sockets).toHaveLength(2);
  });

  it('serializes concurrent writes — bytes land in call order', async () => {
    const sockets = mockSocketFactory((sock) => {
      sock.connect();
    });
    const transport = makeTransport(sockets);
    await transport.open();
    await Promise.all([
      transport.write(new Uint8Array([0x01])),
      transport.write(new Uint8Array([0x02])),
      transport.write(new Uint8Array([0x03])),
    ]);
    expect(sockets.last()?.written.map((b) => b[0])).toEqual([1, 2, 3]);
  });

  it('classifies ETIMEDOUT during connect as connect_timeout', async () => {
    const sockets = mockSocketFactory((sock) => {
      sock.failWithCode('ETIMEDOUT');
    });
    const transport = makeTransport(sockets);
    await expect(transport.open()).rejects.toMatchObject({ code: 'connect_timeout' });
  });
});

describe('tcp-raw transport — failures', () => {
  it('classifies ECONNREFUSED as connect_refused', async () => {
    const sockets = mockSocketFactory((sock) => {
      sock.refuse();
    });
    const transport = makeTransport(sockets);
    await expect(transport.open()).rejects.toMatchObject({ code: 'connect_refused' });
    expect(sockets.last()?.destroyed).toBe(true);
  });

  it('classifies EHOSTUNREACH as host_unreachable', async () => {
    const sockets = mockSocketFactory((sock) => {
      sock.unreachable();
    });
    const transport = makeTransport(sockets);
    await expect(transport.open()).rejects.toMatchObject({ code: 'host_unreachable' });
  });

  it('times out when the printer never accepts the connection', async () => {
    vi.useFakeTimers();
    try {
      const sockets = mockSocketFactory(() => {
        /* never connects */
      });
      const transport = makeTransport(sockets);
      const pending = transport.open();
      const expectation = expect(pending).rejects.toMatchObject({ code: 'connect_timeout' });
      await vi.advanceTimersByTimeAsync(3_000);
      await expectation;
      expect(sockets.last()?.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects non-IP hosts without touching the network (dns_unsupported)', async () => {
    const sockets = mockSocketFactory((sock) => {
      sock.connect();
    });
    const transport = createTcpRawTransport({
      host: 'printer.local',
      port: 9100,
      socketFactory: sockets.factory,
    });
    await expect(transport.open()).rejects.toMatchObject({ code: 'dns_unsupported' });
    expect(sockets.sockets).toHaveLength(0);
  });

  it('classifies a write callback error as write_failed', async () => {
    const sockets = mockSocketFactory((sock) => {
      sock.connect();
      sock.write = (_data, cb) => {
        cb(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      };
    });
    const transport = makeTransport(sockets);
    await transport.open();
    await expect(transport.write(new Uint8Array([0x0a]))).rejects.toMatchObject({
      code: 'write_failed',
    });
  });

  it('classifies a lost connection mid-write as disconnected', async () => {
    const sockets = mockSocketFactory((sock) => {
      sock.connect();
      sock.write = () => {
        sock.destroy(); // drop the link without invoking the write callback
      };
    });
    const transport = makeTransport(sockets);
    await transport.open();
    await expect(transport.write(new Uint8Array([0x0a]))).rejects.toMatchObject({
      code: 'disconnected',
    });
  });

  it('rejects an in-flight write with disconnected when close() is called', async () => {
    const sockets = mockSocketFactory((sock) => {
      sock.connect();
      sock.write = () => {
        /* never calls cb */
      };
    });
    const transport = makeTransport(sockets);
    await transport.open();
    const pending = transport.write(new Uint8Array([0x0a]));
    await transport.close();
    await expect(pending).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('times out when the socket never accepts written bytes (write_timeout)', async () => {
    vi.useFakeTimers();
    try {
      const sockets = mockSocketFactory((sock) => {
        sock.connect();
        sock.write = () => {
          /* never calls cb — buffer full / link dead */
        };
      });
      const transport = makeTransport(sockets);
      await transport.open();
      const pending = transport.write(new Uint8Array([0x0a]));
      const expectation = expect(pending).rejects.toMatchObject({ code: 'write_timeout' });
      await vi.advanceTimersByTimeAsync(5_000);
      await expectation;
      expect(sockets.last()?.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('write() after a lost connection fails with not_open', async () => {
    const sockets = mockSocketFactory((sock) => {
      sock.connect();
      queueMicrotask(() => {
        queueMicrotask(() => {
          sock.failWithCode('ECONNRESET');
        });
      });
    });
    const transport = makeTransport(sockets);
    await transport.open();
    await vi.waitFor(() =>
      expect(transport.write(new Uint8Array([0x0a]))).rejects.toMatchObject({ code: 'not_open' }),
    );
  });

  it('a write queued behind a failed one rejects disconnected (not not_open)', async () => {
    const sockets = mockSocketFactory((sock) => {
      sock.connect();
      sock.write = () => {
        /* first write never completes */
      };
    });
    const transport = makeTransport(sockets);
    await transport.open();
    const first = transport.write(new Uint8Array([0x01])); // in flight, never acknowledged
    const second = transport.write(new Uint8Array([0x02])); // queued behind it
    // The link dies before the queued write's serialized attempt runs.
    sockets.last()?.destroy();
    await expect(first).rejects.toMatchObject({ code: 'disconnected' });
    await expect(second).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('a write queued across a close/reopen rejects disconnected instead of using the new link', async () => {
    const sockets = mockSocketFactory((sock) => {
      sock.connect();
      sock.write = () => {
        /* never calls cb */
      };
    });
    const transport = makeTransport(sockets);
    await transport.open();
    const first = transport.write(new Uint8Array([0x01])); // in flight
    const queued = transport.write(new Uint8Array([0x02])); // captured the first socket
    await transport.close();
    await transport.open(); // fresh connection epoch
    await expect(first).rejects.toMatchObject({ code: 'disconnected' });
    await expect(queued).rejects.toMatchObject({ code: 'disconnected' });
    // The new connection received nothing from the stale queued write.
    expect(sockets.sockets).toHaveLength(2);
    expect(sockets.last()?.written).toEqual([]);
  });

  it('classifies ENETUNREACH as host_unreachable', async () => {
    const sockets = mockSocketFactory((sock) => {
      sock.failWithCode('ENETUNREACH');
    });
    const transport = makeTransport(sockets);
    await expect(transport.open()).rejects.toMatchObject({ code: 'host_unreachable' });
  });
});

describe('tcp-raw transport — healthCheck', () => {
  it('opens and closes a probe connection', async () => {
    const sockets = mockSocketFactory((sock) => {
      sock.connect();
    });
    const transport = makeTransport(sockets);
    await expect(transport.healthCheck()).resolves.toBeUndefined();
    expect(sockets.last()?.destroyed).toBe(true);
  });

  it('propagates classified failures', async () => {
    const sockets = mockSocketFactory((sock) => {
      sock.refuse();
    });
    const transport = makeTransport(sockets);
    await expect(transport.healthCheck()).rejects.toMatchObject({ code: 'connect_refused' });
  });
});

/** Status-probe script: answers each poll write with the next queued byte via
 *  the socket's data event (MockSocket is an EventEmitter). The write override
 *  is installed before connect(): the transport writes synchronously inside
 *  the 'connect' emit, so the override must already be in place to answer. */
function scriptedStatusSocket(
  responses: Array<Buffer | 'never'>,
): MockSockets {
  return mockSocketFactory((sock) => {
    const queue = [...responses];
    const write = sock.write.bind(sock);
    sock.write = (data, cb) => {
      write(data, cb);
      const next = queue.shift();
      if (next === 'never') return; // stay silent
      if (next !== undefined) queueMicrotask(() => sock.emit('data', next));
    };
    sock.connect();
  });
}

describe('tcp-raw transport — status probe (DLE EOT, C1)', () => {
  const HOST = '192.168.1.50';

  function makeStatusTransport(
    sockets: MockSockets,
    statusTimeoutMs = 500,
  ) {
    const transport = createTcpRawTransport({
      host: HOST,
      port: 9100,
      socketFactory: sockets.factory,
      statusTimeoutMs,
    });
    const status = transport.status?.bind(transport);
    if (status === undefined) throw new Error('tcp-raw must implement status()');
    // Narrow the optional interface member: these tests exercise status().
    return { ...transport, status };
  }

  it('sends DLE EOT 1 + 2 on an ephemeral socket and returns the two response bytes', async () => {
    const sockets = scriptedStatusSocket([Buffer.from([0x12]), Buffer.from([0x00])]);
    const transport = makeStatusTransport(sockets);

    await expect(transport.status()).resolves.toEqual([0x12, 0x00]);

    expect(sockets.last()?.written).toEqual([
      Buffer.from([0x10, 0x04, 0x01]),
      Buffer.from([0x10, 0x04, 0x02]),
    ]);
    expect(sockets.last()?.destroyed).toBe(true);
  });

  it('never touches the job socket — probes open their own connection', async () => {
    const sockets = scriptedStatusSocket([Buffer.from([0x12]), Buffer.from([0x00])]);
    const transport = makeStatusTransport(sockets);
    await transport.open(); // job connection is open
    const jobSockets = sockets.sockets.length;

    await transport.status();

    expect(sockets.sockets.length).toBe(jobSockets + 1); // probe = separate socket
    await transport.close();
    expect(sockets.sockets.at(-1)?.destroyed).toBe(true); // probe already destroyed
  });

  it('connect refusal rejects with the connect code (poller maps it to offline)', async () => {
    const sockets = mockSocketFactory((sock) => {
      sock.refuse();
    });
    const transport = makeStatusTransport(sockets);
    await expect(transport.status()).rejects.toMatchObject({ code: 'connect_refused' });
  });

  it('no answer within the timeout rejects with status_failed', async () => {
    const sockets = scriptedStatusSocket(['never', 'never']);
    const transport = makeStatusTransport(sockets, 20);
    await expect(transport.status()).rejects.toMatchObject({ code: 'status_failed' });
  });

  it('trickled bytes (one per chunk) accumulate into the two-byte answer', async () => {
    const sockets = mockSocketFactory((sock) => {
      const write = sock.write.bind(sock);
      let nth = 0;
      sock.write = (data, cb) => {
        write(data, cb);
        nth += 1;
        const byte = nth === 1 ? 0x12 : 0x00;
        queueMicrotask(() => sock.emit('data', Buffer.from([byte])));
      };
      sock.connect(); // after the override — see scriptedStatusSocket
    });
    const transport = makeStatusTransport(sockets);
    await expect(transport.status()).resolves.toEqual([0x12, 0x00]);
  });

  it('socket error mid-probe rejects with disconnected (not a connect code)', async () => {
    const sockets = mockSocketFactory((sock) => {
      const write = sock.write.bind(sock);
      sock.write = (data, cb) => {
        write(data, cb);
        queueMicrotask(() => {
          sock.failWithCode('ECONNRESET');
        });
      };
      sock.connect(); // after the override — see scriptedStatusSocket
    });
    const transport = makeStatusTransport(sockets);
    await expect(transport.status()).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('coalesces both answer bytes arriving in a single chunk', async () => {
    // Respond to the first poll write with the whole two-byte answer; stay
    // silent for the second (the probe resolves before it is ever written).
    const sockets = scriptedStatusSocket([Buffer.from([0x12, 0x00]), 'never']);
    const transport = makeStatusTransport(sockets);
    await expect(transport.status()).resolves.toEqual([0x12, 0x00]);
  });
});
