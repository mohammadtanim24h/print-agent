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
  const code: TransportErrorCode =
    err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH' ? 'host_unreachable' : 'connect_refused';
  return new TransportError(code, `${target}: ${err.message}`, { cause: err });
}

function classifyWriteError(err: Error): TransportError {
  return new TransportError('write_failed', err.message, { cause: err });
}

/**
 * Outbound TCP raw transport (architecture §3.4): Node `net` to <ip>:9100.
 * Fire-and-forget — a resolved `write()` means kernel acceptance, never a
 * physical print. Hosts must be IP literals; DNS is rejected (spec §3).
 */
export function createTcpRawTransport(options: TcpRawTransportOptions): PrinterTransport {
  const { host, port, socketFactory } = options;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const writeTimeoutMs = options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
  const target = `${host}:${String(port)}`;

  let socket: TransportSocket | null = null;
  /** Rejects the operation currently in flight (invoked by the close/error watchers). */
  let failInFlight: ((error: TransportError) => void) | null = null;

  const socketDied = (error: TransportError): void => {
    socket = null;
    const fail = failInFlight;
    failInFlight = null;
    fail?.(error);
  };

  const open = async (): Promise<void> => {
    if (socket !== null) return; // idempotent
    if (isIP(host) === 0) {
      throw new TransportError('dns_unsupported', `${target}: host must be an IPv4/IPv6 literal`);
    }
    const sock = socketFactory({ host, port });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(
        () => { settle(
            new TransportError(
              'connect_timeout',
              `${target}: connect timed out after ${String(connectTimeoutMs)}ms`,
            ),
          ); },
        connectTimeoutMs,
      );
      const settle = (error?: TransportError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error === undefined) {
          // Adopt persistent watchers for the write phase.
          sock.on('error', (err) => { socketDied(classifyWriteError(err)); });
          sock.on('close', () => { socketDied(new TransportError('disconnected', `${target}: connection lost`)); });
          socket = sock;
          resolve();
        } else {
          reject(error);
          sock.destroy(); // emits 'close'; settle is already a no-op
        }
      };
      sock.on('connect', () => { settle(); });
      sock.on('error', (err) => { settle(classifyConnectError(err, target)); });
      sock.on('close', () => { settle(new TransportError('disconnected', `${target}: closed before connect completed`)); });
    });
  };

  const write = async (bytes: Uint8Array): Promise<void> => {
    const sock = socket;
    if (sock === null) throw new TransportError('not_open', `${target}: transport is not open`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        failInFlight = null;
        sock.destroy(); // 'close' watcher clears socket state
        reject(new TransportError('write_timeout', `${target}: write timed out after ${String(writeTimeoutMs)}ms`));
      }, writeTimeoutMs);
      failInFlight = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      sock.write(bytes, (err) => {
        if (failInFlight === null) return; // already timed out or connection died
        failInFlight = null;
        clearTimeout(timer);
        if (err !== null) reject(classifyWriteError(err));
        else resolve();
      });
    });
  };

  const close = (): Promise<void> => {
    const sock = socket;
    if (sock !== null) {
      // 'close' watcher → socketDied → any in-flight op rejects with 'disconnected'.
      sock.destroy();
    }
    return Promise.resolve(); // idempotent when already closed
  };

  const healthCheck = async (): Promise<void> => {
    await open();
    await close();
  };

  return { open, write, close, healthCheck };
}
