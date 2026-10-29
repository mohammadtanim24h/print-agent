import { TransportError } from './errors';
import type { SpoolerBridge } from './spooler-native';
import type { PrinterTransport } from './types';

export interface SpoolerRawTransportOptions {
  /** Windows printer name (approved destination from the printer store). */
  printerName: string;
  /** Injected winspool access — unit tests run against fakes (ADR-10). */
  bridge: SpoolerBridge;
}

/**
 * Win32 spooler RAW transport (ADR-4, architecture §3.4): one RAW-datatype
 * spooler job per `write()`, spooled through the injected bridge. Fire-and-
 * forget like tcp-raw, but "resolved" means **Windows accepted the job** —
 * the vendor driver may still buffer or fail downstream (R-VAL-4 duplicate
 * risk; feeds the ambiguity/duplicate-policy flow). Writes are serialized in
 * call order; `close()` is a stateless flag reset (no persistent handle).
 */
export function createSpoolerRawTransport(options: SpoolerRawTransportOptions): PrinterTransport {
  const { printerName, bridge } = options;
  const target = `spooler:${printerName}`;

  let open = false;
  let writeTail: Promise<void> = Promise.resolve();

  const probe = async (): Promise<void> => {
    // false = the name is genuinely not installed (errors 2/1801 in the
    // shim); every other native failure arrives as a TransportError already.
    if (!(await bridge.printerExists(printerName))) {
      throw new TransportError(
        'printer_not_found',
        `${target}: printer is not installed on this machine`,
      );
    }
  };

  const openTransport = async (): Promise<void> => {
    if (open) return; // idempotent
    await probe();
    open = true;
  };

  const write = (bytes: Uint8Array): Promise<void> => {
    const attempt = async (): Promise<void> => {
      // Late binding vs tcp-raw: the live `open` flag is read at attempt time,
      // so a write queued before close() still fails not_open (stateless close
      // ⇒ nothing spools if close() lands before the attempt runs) — tcp-raw
      // captures its socket at call time instead.
      if (!open) {
        throw new TransportError('not_open', `${target}: transport is not open`);
      }
      try {
        await bridge.writeRaw(printerName, bytes);
      } catch (err) {
        // TransportErrors pass through (the production bridge pre-classifies);
        // anything else is classified here so the transport's error contract
        // holds for every bridge implementation (tcp-raw's classifier pattern).
        if (err instanceof TransportError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new TransportError('write_failed', `${target}: ${message}`, { cause: err });
      }
    };
    // Serialize: each job starts only after the previous one settles (same
    // tail-promise discipline as tcp-raw) — one in-flight spooler job.
    const result = writeTail.then(attempt);
    writeTail = result.then(
      () => {},
      () => {},
    );
    return result;
  };

  const close = (): Promise<void> => {
    open = false; // stateless flag reset — no persistent handle to release
    return Promise.resolve();
  };

  const healthCheck = (): Promise<void> => probe();

  return { open: openTransport, write, close, healthCheck };
}
