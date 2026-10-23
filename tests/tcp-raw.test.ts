import { describe, expect, it } from 'vitest';
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
