import type { PrinterDraft, PrinterProfile } from './profile';
import type { PrinterStore } from './store';
import { buildTestPage } from './test-page';
import type { TransportRegistry } from '../transport/registry';
import { TransportError, type TransportErrorCode } from '../transport/errors';

export type ConnectionTestResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: TransportErrorCode; readonly detail: string };

export type TestPrintResult =
  | { readonly ok: true; readonly bytesWritten: number }
  | { readonly ok: false; readonly code: TransportErrorCode; readonly detail: string };

interface TransportFailure {
  readonly ok: false;
  readonly code: TransportErrorCode;
  readonly detail: string;
}

/**
 * Operations other modules (and later the IPC layer) call. Endpoints come
 * only from the validated store via the registry (spec §3) — a caller can
 * never hand the service a raw host/port.
 */
export interface PrinterService {
  savePrinter(draft: PrinterDraft): Promise<PrinterProfile>;
  testConnection(printerId: string): Promise<ConnectionTestResult>;
  testPrint(printerId: string): Promise<TestPrintResult>;
}

export function createPrinterService(options: {
  store: PrinterStore;
  registry: TransportRegistry;
  /** Injected clock for deterministic test-page timestamps. */
  now?: () => Date;
}): PrinterService {
  const { store, registry } = options;
  const now = options.now ?? (() => new Date());

  const loadProfile = (printerId: string): PrinterProfile => {
    const profile = store.get(printerId);
    if (profile === null) throw new Error(`printer not found: ${printerId}`);
    return profile;
  };

  const toFailure = (error: unknown): TransportFailure | null => {
    if (error instanceof TransportError) {
      return { ok: false, code: error.code, detail: error.message };
    }
    return null;
  };

  return {
    async savePrinter(draft) {
      // Validation (schema + approved-destination policy) happens inside the store.
      return store.add(draft);
    },
    async testConnection(printerId) {
      const transport = registry.forPrinter(loadProfile(printerId));
      try {
        await transport.healthCheck();
        return { ok: true };
      } catch (error) {
        const failure = toFailure(error);
        if (failure === null) throw error;
        return failure;
      }
    },
    async testPrint(printerId) {
      const profile = loadProfile(printerId);
      const transport = registry.forPrinter(profile);
      const bytes = buildTestPage(profile, now());
      try {
        await transport.open();
        await transport.write(bytes);
        return { ok: true, bytesWritten: bytes.byteLength };
      } catch (error) {
        const failure = toFailure(error);
        if (failure === null) throw error;
        return failure;
      } finally {
        await transport.close();
      }
    },
  };
}
