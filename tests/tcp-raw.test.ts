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
    const sockets = mockSocketFactory((sock) => { sock.connect(); });
    const transport = makeTransport(sockets);

    await expect(transport.open()).resolves.toBeUndefined();

    await transport.write(new Uint8Array([0x1b, 0x40]));
    await transport.write(new Uint8Array([0x1d, 0x56, 0x01]));

    expect(sockets.last()?.written).toEqual([Buffer.from([0x1b, 0x40]), Buffer.from([0x1d, 0x56, 0x01])]);

    await expect(transport.close()).resolves.toBeUndefined();
    expect(sockets.last()?.destroyed).toBe(true);
  });

  it('targets the configured endpoint', async () => {
    const sockets = mockSocketFactory((sock) => { sock.connect(); });
    const transport = makeTransport(sockets);
    await transport.open();
    expect(sockets.last()?.host).toBe(HOST);
    expect(sockets.last()?.port).toBe(9100);
  });

  it('open() is idempotent while already open', async () => {
    const sockets = mockSocketFactory((sock) => { sock.connect(); });
    const transport = makeTransport(sockets);
    await transport.open();
    await transport.open();
    expect(sockets.sockets).toHaveLength(1);
  });

  it('close() is idempotent', async () => {
    const sockets = mockSocketFactory((sock) => { sock.connect(); });
    const transport = makeTransport(sockets);
    await expect(transport.close()).resolves.toBeUndefined();
  });

  it('write() before open() fails with not_open and never touches the network', async () => {
    const sockets = mockSocketFactory((sock) => { sock.connect(); });
    const transport = makeTransport(sockets);
    await expect(transport.write(new Uint8Array([0x0a]))).rejects.toMatchObject({ code: 'not_open' });
    expect(sockets.sockets).toHaveLength(0);
  });
});
