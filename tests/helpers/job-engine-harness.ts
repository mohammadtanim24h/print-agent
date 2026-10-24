import { openDatabase, closeDatabase } from '../../src/main/local-store/db';
import { migrate } from '../../src/main/local-store/migrations';
import { createSqliteJobStore } from '../../src/main/local-store/job-store';
import type { JobStore } from '../../src/main/local-store/job-store';
import { createPrinterStore } from '../../src/main/printers/store';
import type { TransportRegistry } from '../../src/main/transport/registry';
import { createJobEngine } from '../../src/main/jobs/engine';
import type { JobEngine } from '../../src/main/jobs/engine';
import type { JobAck, PrintJobInput } from '../../src/main/jobs/types';
import { memoryAdapter } from './memory-adapter';
import { makeDraft } from './printers';
import { makeDoc } from './render';

const T0 = 1_767_225_600_000; // 2026-01-01T00:00:00Z

export const HARNESS_T0 = T0;

export interface Harness {
  readonly engine: JobEngine;
  readonly acks: JobAck[];
  readonly printerId: string;
  /** Jobs waiting on the injected schedule timer; tests flush them manually. */
  readonly timers: Array<() => void>;
  dispose(): void;
}

export interface HarnessOptions {
  readonly now?: () => number;
  readonly transports?: TransportRegistry;
  /** 'manual' (default): retry timers are collected in `timers`. 'immediate': fired synchronously. */
  readonly scheduling?: 'manual' | 'immediate';
  readonly limits?: { readonly maxPending?: number; readonly maxAttempts?: number };
  /** Test hook for fault injection (e.g. a store whose insert throws). */
  readonly wrapStore?: (base: JobStore) => JobStore;
}

let printerCounter = 0;

export async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const acks: JobAck[] = [];
  const timers: Array<() => void> = [];
  const db = openDatabase({ file: null });
  migrate(db);
  const now = options.now ?? ((): number => T0);
  const baseStore = createSqliteJobStore(db, { now });
  const store = options.wrapStore !== undefined ? options.wrapStore(baseStore) : baseStore;
  const printers = await createPrinterStore({
    filePath: 'printers.json',
    adapter: memoryAdapter(null),
    // Deterministic but schema-valid UUIDs (PrinterProfileSchema requires z.uuid()).
    newId: () => `00000000-0000-4000-8000-${String((printerCounter += 1)).padStart(12, '0')}`,
  });
  const profile = await printers.add(makeDraft());
  const schedule =
    options.scheduling === 'immediate'
      ? (fn: () => void): void => {
          fn();
        }
      : (fn: () => void): void => {
          timers.push(fn);
        };
  const engine = createJobEngine({
    store,
    printers,
    transports:
      options.transports ??
      ({
        forPrinter: (): never => {
          throw new Error('no transport configured');
        },
      } satisfies TransportRegistry),
    acks: { submit: (a) => acks.push(a) },
    now,
    schedule,
    limits: options.limits ?? {},
  });
  return {
    engine,
    acks,
    printerId: profile.printerId,
    timers,
    dispose: (): void => {
      closeDatabase(db);
    },
  };
}

export function makeJob(printerId: string, overrides: Partial<PrintJobInput> = {}): PrintJobInput {
  return {
    jobId: 'job-1',
    idempotencyKey: 'key-1',
    tenantId: 'tenant-1',
    restaurantId: 'rest-1',
    printerId,
    priority: 5,
    copies: 1,
    docType: 'customer_receipt',
    docVersion: 1,
    expiresAt: null,
    payload: makeDoc(),
    ...overrides,
  };
}
