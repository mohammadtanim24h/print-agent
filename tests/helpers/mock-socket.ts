import { EventEmitter } from 'node:events';
import type { SocketFactory, TransportSocket } from '../../src/main/transport/socket';

/**
 * Mock print socket: no network. A script decides how the connection behaves.
 * Scripts run on a microtask after creation so the transport's event handlers
 * are attached before the connection outcome is simulated.
 */
export class MockSocket extends EventEmitter implements TransportSocket {
  readonly written: Buffer[] = [];
  destroyed = false;

  constructor(
    readonly host: string,
    readonly port: number,
  ) {
    super();
  }

  write(data: Uint8Array, cb: (err: Error | null) => void): void {
    this.written.push(Buffer.from(data));
    cb(null);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close', false);
  }

  connect(): void {
    this.emit('connect');
  }

  failWithCode(code: string): void {
    const err: NodeJS.ErrnoException = Object.assign(
      new Error(`${code} on ${this.host}:${String(this.port)}`),
      { code },
    );
    this.emit('error', err);
    this.emit('close', true);
  }

  refuse(): void {
    this.failWithCode('ECONNREFUSED');
  }

  unreachable(): void {
    this.failWithCode('EHOSTUNREACH');
  }
}

export interface MockSockets {
  factory: SocketFactory;
  /** Every socket the factory created, in creation order. */
  sockets: MockSocket[];
  last(): MockSocket | undefined;
}

export function mockSocketFactory(script: (socket: MockSocket) => void): MockSockets {
  const sockets: MockSocket[] = [];
  return {
    factory: ({ host, port }) => {
      const sock = new MockSocket(host, port);
      sockets.push(sock);
      queueMicrotask(() => {
        script(sock);
      });
      return sock;
    },
    sockets,
    last: () => sockets.at(-1),
  };
}
