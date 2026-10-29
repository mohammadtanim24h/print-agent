import type { PrinterProfile } from '../printers/profile';
import { createNetSocketFactory, type SocketFactory } from './socket';
import { createSpoolerRawTransport } from './spooler-raw';
import { createNativeSpoolerBridge, type SpoolerBridge } from './spooler-native';
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
  /** Defaults to the native winspool bridge (lazy dlopen). */
  spoolerBridge?: SpoolerBridge;
  connectTimeoutMs?: number;
  writeTimeoutMs?: number;
}

export function createTransportRegistry(options: TransportRegistryOptions = {}): TransportRegistry {
  return {
    forPrinter(profile) {
      const endpoint = profile.transport;
      // Exhaustive switch over the endpoint union: adding a kind to the
      // profile schema is a compile error here until a transport is wired.
      switch (endpoint.kind) {
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
        case 'spooler_raw':
          return createSpoolerRawTransport({
            printerName: endpoint.windowsPrinterName,
            bridge: options.spoolerBridge ?? createNativeSpoolerBridge(),
          });
      }
    },
  };
}
