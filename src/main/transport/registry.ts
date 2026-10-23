import type { PrinterProfile } from '../printers/profile';
import { createNetSocketFactory, type SocketFactory } from './socket';
import { createTcpRawTransport, type TcpRawTransportOptions } from './tcp-raw';
import type { PrinterTransport } from './types';

export interface TransportRegistry {
  /**
   * Builds a transport from an APPROVED stored profile. Endpoints enter the
   * system only through PrinterStore validation (spec §3) — there is no API
   * that accepts a bare host/port.
   */
  forPrinter(profile: PrinterProfile): PrinterTransport;
}

export interface TransportRegistryOptions {
  /** Defaults to the production node:net factory. */
  socketFactory?: SocketFactory;
  connectTimeoutMs?: number;
  writeTimeoutMs?: number;
}

export function createTransportRegistry(options: TransportRegistryOptions = {}): TransportRegistry {
  return {
    forPrinter(profile) {
      const endpoint = profile.transport;
      // Exhaustive switch over the endpoint kind: once PrinterProfile's
      // `transport` widens to a union (spooler_raw, usb, ...), a new kind
      // becomes a compile error here until a transport is wired for it.
      // Today it is a single-variant type, so the check is a no-op for ESLint.
      switch (endpoint.kind) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        case 'tcp_raw': {
          const tcpOptions: TcpRawTransportOptions = {
            host: endpoint.host,
            port: endpoint.port,
            socketFactory: options.socketFactory ?? createNetSocketFactory(),
          };
          if (options.connectTimeoutMs !== undefined) {
            tcpOptions.connectTimeoutMs = options.connectTimeoutMs;
          }
          if (options.writeTimeoutMs !== undefined) {
            tcpOptions.writeTimeoutMs = options.writeTimeoutMs;
          }
          return createTcpRawTransport(tcpOptions);
        }
      }
    },
  };
}
