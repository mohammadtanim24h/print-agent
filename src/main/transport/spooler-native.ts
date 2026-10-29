import { createRequire } from 'node:module';
import type { NativeSpooler } from 'print-agent-spooler-raw';
import { TransportError } from './errors';

/**
 * Production SpoolerBridge over the `print-agent-spooler-raw` N-API addon
 * (ADR-4). Thin node glue (like socket.ts's factory): translates native
 * failures into TransportError codes — classification per
 * docs/transport-adapters.md. The addon is dlopen'd lazily on its first call,
 * so tcp_raw-only installs never load it. Unit tests inject a loader stub;
 * the real binary is exercised by tests/spooler-raw-capture.test.ts (opt-in).
 */
export interface SpoolerBridge {
  /** false = genuinely no such printer (name not found). Throws
   *  TransportError('write_failed') for any other native failure. */
  printerExists(name: string): Promise<boolean>;
  writeRaw(name: string, bytes: Uint8Array): Promise<void>;
  enumerate(): Promise<readonly string[]>;
}

/** CJS require keeps the dlopen lazy (the type-only default export cannot be
 *  imported as a value). */
const defaultLoad = (): NativeSpooler =>
  createRequire(import.meta.url)('print-agent-spooler-raw') as NativeSpooler;

export function createNativeSpoolerBridge(load: () => NativeSpooler = defaultLoad): SpoolerBridge {
  const wrap = (name: string, error: unknown): TransportError => {
    if (error instanceof TransportError) return error;
    const message = error instanceof Error ? error.message : String(error);
    // `cause` keeps the original failure for logs, matching tcp-raw.ts classifiers.
    return new TransportError('write_failed', `spooler:${name}: ${message}`, { cause: error });
  };
  // `await` inside the try means one wrapper covers both failure modes: a
  // synchronous native throw (OpenPrinterW/spooler errors) and an async
  // rejection from the writeRaw AsyncWorker. The bridge contract is async,
  // so callers await and never try/catch a sync call.
  const call = async <T>(name: string, op: (native: NativeSpooler) => T): Promise<Awaited<T>> => {
    try {
      return await op(load());
    } catch (error) {
      throw wrap(name, error);
    }
  };
  return {
    printerExists: (name) => call(name, (native) => native.printerExists(name)),
    writeRaw: (name, bytes) => call(name, (native) => native.writeRaw(name, bytes)),
    enumerate: () => call('printers', (native) => native.enumeratePrinters()),
  };
}
