import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, closeDatabase } from '../src/main/local-store/db';
import { migrate } from '../src/main/local-store/migrations';
import { createSqliteJobStore } from '../src/main/local-store/job-store';
import type { JobRow, JobStore } from '../src/main/local-store/job-store';
import { createPrinterStore } from '../src/main/printers/store';
import { createJobEngine } from '../src/main/jobs/engine';
import type { JobEngine } from '../src/main/jobs/engine';
import type { JobAck } from '../src/main/jobs/types';
import { FakeTransportRegistry } from './helpers/fake-transport';
import { memoryAdapter } from './helpers/memory-adapter';
import { makeDraft } from './helpers/printers';
import { makeDoc } from './helpers/render';
import { makeJob } from './helpers/job-engine-harness';

const T0 = 1_767_225_600_000;

/** Fixed UUID so successive "processes" on the same db file configure the same
 *  printer (PrinterProfileSchema requires a UUID shape; ids must survive a
 *  restart for pre-transmission jobs to resume). */
const PRINTER_ID = '00000000-0000-4000-8000-000000000042';

interface Process {
  readonly engine: JobEngine;
  readonly acks: JobAck[];
  dispose(): void;
}

/** Boot an engine against a real on-disk database — simulates a fresh process start.
 *  `wrapStore` injects store fault wrappers (e.g. fail the Nth updateStatus call). */
async function boot(
  file: string,
  transports: FakeTransportRegistry,
  acks: JobAck[],
  wrapStore?: (base: JobStore) => JobStore,
): Promise<Process> {
  const db = openDatabase({ file });
  migrate(db);
  const base = createSqliteJobStore(db, { now: (): number => T0 });
  const printers = await createPrinterStore({
    filePath: 'printers.json',
    adapter: memoryAdapter(),
    newId: (): string => PRINTER_ID,
  });
  await printers.add(makeDraft());
  const engine: JobEngine = createJobEngine({
    store: wrapStore !== undefined ? wrapStore(base) : base,
    printers,
    transports,
    acks: { submit: (a) => acks.push(a) },
    now: (): number => T0,
    schedule: (): void => {}, // recovery tests never exercise backoff
  });
  return {
    engine,
    acks,
    dispose: (): void => {
      closeDatabase(db);
    },
  };
}

async function drained(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Fully-populated row for direct store.insert() — a job that arrives on disk
 *  from a previous process without having gone through this engine instance. */
function ghostRow(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 'ghost-1',
    idempotencyKey: 'ghost-key',
    tenantId: 'tenant-1',
    restaurantId: 'rest-1',
    printerId: 'ghost-printer',
    docType: 'customer_receipt',
    docVersion: 1,
    payloadJson: JSON.stringify(makeDoc()),
    priority: 5,
    copies: 1,
    status: 'accepted',
    attempts: 0,
    reprintOf: null,
    createdAt: T0,
    expiresAt: null,
    sentAt: null,
    completedAt: null,
    updatedAt: T0,
    lastError: null,
    ...overrides,
  };
}

describe('engine startup recovery', () => {
  it('crash mid-write: restart marks sending rows ambiguous and never re-sends them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recovery-crash-'));
    const file = join(dir, 'jobs.db');
    let p1: Process | null = null;
    let p2: Process | null = null;
    try {
      const hung = new FakeTransportRegistry(() => ({ hang: true })); // write never resolves
      p1 = await boot(file, hung, []);
      p1.engine.submit(makeJob(PRINTER_ID));
      await drained(); // one macrotask: job is durably 'sending', write hung
      expect(p1.engine.getJob('job-1')?.status).toBe('sending');
      p1.dispose(); // crash: db closed under the in-flight write
      p1 = null;

      // Process 2 boots with a NORMAL transport — it would print if re-sent. That is the point.
      const transports2 = new FakeTransportRegistry(() => ({}));
      const acks2: JobAck[] = [];
      p2 = await boot(file, transports2, acks2);
      p2.engine.recover();
      await drained(); // let a (buggy) re-enqueue actually execute before asserting

      expect(p2.engine.getJob('job-1')?.status).toBe('ambiguous');
      expect(transports2.get(PRINTER_ID)?.opens ?? 0).toBe(0); // nothing re-sent
      expect(acks2.at(-1)).toMatchObject({
        status: 'ambiguous',
        printed: false,
        error: { code: 'restarted_in_flight' },
      });
      expect(p2.engine.listAttempts('job-1').some((a) => a.outcome === 'ambiguous_crash')).toBe(
        true,
      );
      p2.dispose();
      p2 = null;
    } finally {
      p1?.dispose();
      p2?.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recover() resolves a row stranded between sent_to_printer and completed (post-write crash window)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recovery-post-write-'));
    const file = join(dir, 'jobs.db');
    let p1: Process | null = null;
    let p2: Process | null = null;
    try {
      // Process 1: a transient db failure exactly on the 'completed' write
      // (4th updateStatus of the happy path: rendered, sending,
      // sent_to_printer, completed). The bytes were already handed off, so the
      // row is durably 'sent_to_printer' — recovery territory, never a re-send.
      let updateStatusCall = 0;
      const failCompletedWrite = (base: JobStore): JobStore => ({
        ...base,
        updateStatus: (...args: Parameters<JobStore['updateStatus']>) => {
          updateStatusCall += 1;
          if (updateStatusCall === 4) throw new Error('simulated db failure at completed write');
          base.updateStatus(...args);
        },
      });
      p1 = await boot(file, new FakeTransportRegistry(() => ({})), [], failCompletedWrite);
      p1.engine.submit(makeJob(PRINTER_ID));
      await drained();
      expect(p1.engine.getJob('job-1')?.status).toBe('sent_to_printer'); // stranded post-write
      p1.dispose(); // simulated process death
      p1 = null;

      // Process 2 boots with a NORMAL store and a working transport — it would
      // print if re-sent. recover() must resolve the row, never re-send it.
      const transports2 = new FakeTransportRegistry(() => ({}));
      const acks2: JobAck[] = [];
      p2 = await boot(file, transports2, acks2);
      p2.engine.recover();
      await drained(); // let a (buggy) re-enqueue actually execute before asserting

      expect(p2.engine.getJob('job-1')?.status).toBe('ambiguous');
      expect(transports2.get(PRINTER_ID)?.opens ?? 0).toBe(0); // nothing re-sent
      const crash = p2.engine.listAttempts('job-1').find((r) => r.outcome === 'ambiguous_crash');
      expect(crash?.errorCode).toBe('restarted_in_flight');
      expect(acks2.at(-1)).toMatchObject({
        status: 'ambiguous',
        printed: false,
        error: { code: 'restarted_in_flight' },
      });
      p2.dispose();
      p2 = null;
    } finally {
      p1?.dispose();
      p2?.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('restart resumes pre-transmission jobs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recovery-resume-'));
    const file = join(dir, 'jobs.db');
    let p1: Process | null = null;
    let p2: Process | null = null;
    try {
      p1 = await boot(file, new FakeTransportRegistry(() => ({})), []);
      p1.engine.submit(makeJob(PRINTER_ID));
      // submit defers execution to a microtask — disposing synchronously leaves
      // the row durably 'accepted' and never executed.
      expect(p1.engine.getJob('job-1')?.status).toBe('accepted');
      p1.dispose();
      p1 = null;

      const transports2 = new FakeTransportRegistry(() => ({}));
      const acks2: JobAck[] = [];
      p2 = await boot(file, transports2, acks2);
      p2.engine.recover();
      await drained();

      expect(p2.engine.getJob('job-1')?.status).toBe('completed');
      const t2 = transports2.get(PRINTER_ID);
      expect(t2?.opens).toBe(1);
      expect(t2?.writes).toHaveLength(1); // printed exactly once
      expect(acks2.map((a) => a.status)).toEqual(['rendered', 'sent_to_printer', 'completed']);
      p2.dispose();
      p2 = null;
    } finally {
      p1?.dispose();
      p2?.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('re-delivery after restart of a completed job: no duplicate execution', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recovery-redelivery-'));
    const file = join(dir, 'jobs.db');
    let p1: Process | null = null;
    let p2: Process | null = null;
    try {
      p1 = await boot(file, new FakeTransportRegistry(() => ({})), []);
      p1.engine.submit(makeJob(PRINTER_ID));
      await drained();
      expect(p1.engine.getJob('job-1')?.status).toBe('completed');
      expect(p1.engine.getJob('job-1')?.sentAt).not.toBeNull();
      p1.dispose();
      p1 = null;

      const transports2 = new FakeTransportRegistry(() => ({}));
      const acks2: JobAck[] = [];
      p2 = await boot(file, transports2, acks2);
      // Same (restaurantId, idempotencyKey) as the completed row → acked from stored state.
      const ack = p2.engine.submit(makeJob(PRINTER_ID, { jobId: 'redelivery-1' }));
      expect(ack.status).toBe('completed');
      expect(acks2).toHaveLength(0); // duplicate ack is returned, not pushed
      expect(transports2.get(PRINTER_ID)?.writes ?? []).toHaveLength(0); // never re-executed
      // recover() on a store with no recoverable rows is harmless.
      expect((): void => p2?.engine.recover()).not.toThrow();
      expect(p2.engine.getJob('redelivery-1')).toBeNull();
      p2.dispose();
      p2 = null;
    } finally {
      p1?.dispose();
      p2?.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovery leaves rows whose printer is unknown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recovery-ghost-'));
    const file = join(dir, 'jobs.db');
    let p2: Process | null = null;
    try {
      // A row persisted by a previous process whose printer is not configured
      // in this one — written with a bare store handle before the engine boots.
      const raw = openDatabase({ file });
      migrate(raw);
      createSqliteJobStore(raw, { now: (): number => T0 }).insert(ghostRow());
      closeDatabase(raw);

      const transports2 = new FakeTransportRegistry(() => ({}));
      const acks2: JobAck[] = [];
      p2 = await boot(file, transports2, acks2);
      p2.engine.recover();
      await drained();

      expect(p2.engine.getJob('ghost-1')?.status).toBe('accepted'); // not executed, not failed
      expect(acks2).toHaveLength(0);
      expect(transports2.get('ghost-printer')).toBeUndefined();
      p2.dispose();
      p2 = null;
    } finally {
      p2?.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
