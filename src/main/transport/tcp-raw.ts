import { isIP } from 'node:net';
import { TransportError, type TransportErrorCode } from './errors';
import type { SocketFactory, TransportSocket } from './socket';
import type { PrinterTransport } from './types';

export const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
export const DEFAULT_WRITE_TIMEOUT_MS = 5_000;

export interface TcpRawTransportOptions {
  host: string;
  port: number;
  socketFactory: SocketFactory;
  connectTimeoutMs?: number;
  writeTimeoutMs?: number;
}

function classifyConnectError(err: NodeJS.ErrnoException, target: string): TransportError {
  let code: TransportErrorCode = 'connect_refused';
  if (err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH') {
    code = 'host_unreachable';
  } else if (err.code === 'ETIMEDOUT') {
    code = 'connect_timeout';
  }
  return new TransportError(code, `${target}: ${err.message}`, { cause: err });
}

function classifyWriteError(err: Error): TransportError {
  return new TransportError('write_failed', err.message, { cause: err });
}

/**
 * Outbound TCP raw transport (architecture §3.4): Node `net` to <ip>:9100.
 * Fire-and-forget — a resolved `write()` means kernel acceptance, never a
 * physical print. Hosts must be IP literals; DNS is rejected (spec §3).
 * Writes are serialized; `open()` coalesces concurrent calls; `close()`
 * resolves only after the socket close event (real net sockets close async).
 */
export function createTcpRawTransport(options: TcpRawTransportOptions): PrinterTransport {
  const { host, port, socketFactory } = options;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const writeTimeoutMs = options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
  const target = `${host}:${String(port)}`;

  let socket: TransportSocket | null = null; // connected
  let connecting: TransportSocket | null = null; // connect in flight
  let pendingOpen: Promise<void> | null = null; // coalesces concurrent open() calls
  let failInFlight: ((error: TransportError) => void) | null = null;
  let writeTail: Promise<void> = Promise.resolve(); // serializes writes

  const socketDied = (error: TransportError): void => {
    socket = null;
    const fail = failInFlight;
    failInFlight = null;
    fail?.(error);
  };

  const open = (): Promise<void> => {
    if (pendingOpen !== null) return pendingOpen;
    if (socket !== null) return Promise.resolve(); // idempotent
    if (isIP(host) === 0) {
      return Promise.reject(
        new TransportError('dns_unsupported', `${target}: host must be an IPv4/IPv6 literal`),
      );
    }
    const sock = socketFactory({ host, port });
    connecting = sock;
    const attempt = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        finish(
          new TransportError(
            'connect_timeout',
            `${target}: connect timed out after ${String(connectTimeoutMs)}ms`,
          ),
        );
      }, connectTimeoutMs);
      const finish = (error?: TransportError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pendingOpen = null;
        connecting = null;
        if (error === undefined) {
          // Adopt persistent watchers for the write phase.
          sock.on('error', (err) => {
            socketDied(classifyWriteError(err));
          });
          sock.on('close', () => {
            socketDied(new TransportError('disconnected', `${target}: connection lost`));
          });
          socket = sock;
          resolve();
        } else {
          reject(error);
          sock.destroy(); // emits 'close'; finish is already a no-op
        }
      };
      sock.on('connect', () => {
        finish();
      });
      sock.on('error', (err) => {
        finish(classifyConnectError(err, target));
      });
      sock.on('close', () => {
        finish(new TransportError('disconnected', `${target}: closed before connect completed`));
      });
    });
    pendingOpen = attempt;
    return attempt;
  };

  const write = (bytes: Uint8Array): Promise<void> => {
    // Capture the socket at call time: if the link dies (or close() runs)
    // before the serialized attempt starts, the queued write must fail as
    // 'disconnected' — not masquerade as not_open.
    const sock = socket;
    const attempt = (): Promise<void> => {
      if (sock === null) {
        return Promise.reject(new TransportError('not_open', `${target}: transport is not open`));
      }
      if (socket !== sock) {
        return Promise.reject(
          new TransportError('disconnected', `${target}: connection closed before write started`),
        );
      }
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          failInFlight = null;
          sock.destroy(); // 'close' watcher clears socket state
          reject(
            new TransportError(
              'write_timeout',
              `${target}: write timed out after ${String(writeTimeoutMs)}ms`,
            ),
          );
        }, writeTimeoutMs);
        failInFlight = (error) => {
          clearTimeout(timer);
          reject(error);
        };
        sock.write(bytes, (err) => {
          if (failInFlight === null) return; // already timed out or connection died
          failInFlight = null;
          clearTimeout(timer);
          if (err !== null) {
            reject(classifyWriteError(err));
          } else {
            resolve();
          }
        });
      });
    };
    // Serialize: each write starts only after the previous one settles.
    const result = writeTail.then(attempt);
    writeTail = result.then(
      () => {},
      () => {},
    );
    return result;
  };

  const close = (): Promise<void> => {
    const sock = connecting ?? socket;
    if (sock === null) return Promise.resolve(); // idempotent
    // Resolves on the socket's close event — callers never observe a
    // stale-open window. During connect, the connect-phase 'close' watcher
    // rejects the pending open() with 'disconnected'.
    return new Promise<void>((resolve) => {
      sock.on('close', () => {
        resolve();
      });
      sock.destroy();
    });
  };

  const healthCheck = async (): Promise<void> => {
    await open();
    await close();
  };

  return { open, write, close, healthCheck };
}
