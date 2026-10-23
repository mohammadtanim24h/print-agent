import { createConnection } from 'node:net';

/**
 * Minimal async surface of a print socket; `node:net` semantics for events.
 * Injected so unit tests run mock sockets with zero network I/O. The
 * production adapter below is node glue and untested (like settings-fs.ts).
 */
export interface TransportSocket {
  write(data: Uint8Array, cb: (err: Error | null) => void): void;
  destroy(): void;
  on(event: 'connect', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'close', listener: (hadError: boolean) => void): unknown;
}

export type SocketFactory = (endpoint: {
  readonly host: string;
  readonly port: number;
}) => TransportSocket;

/** Production adapter: outbound node:net connection. The factory initiates
 *  the connection; nothing listens (AC-4). */
export function createNetSocketFactory(): SocketFactory {
  return ({ host, port }) => {
    // node:net's write callback accepts `err?: Error | null | undefined`;
    // normalize to the transport contract's `Error | null`.
    const socket = createConnection({ host, port });
    return {
      write: (data, cb) => {
        socket.write(data, (err) => {
          cb(err ?? null);
        });
      },
      destroy: () => {
        socket.destroy();
      },
      on: (event, listener) => socket.on(event, listener),
    };
  };
}
