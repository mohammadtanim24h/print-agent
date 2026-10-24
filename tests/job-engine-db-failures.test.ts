import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeHarness, makeJob } from './helpers/job-engine-harness';
import { FakeTransportRegistry } from './helpers/fake-transport';
import { JobEngineError } from '../src/main/jobs/errors';
import type { JobEngine } from '../src/main/jobs/engine';
import type { JobAck } from '../src/main/jobs/types';
import { isTerminal } from '../src/main/local-store/job-store';
import type { JobStore } from '../src/main/local-store/job-store';
import { openDatabase, closeDatabase } from '../src/main/local-store/db';
import { migrate } from '../src/main/local-store/migrations';
import { createSqliteJobStore } from '../src/main/local-store/job-store';
import { createPrinterStore } from '../src/main/printers/store';
import { createJobEngine } from '../src/main/jobs/engine';
import { memoryAdapter } from './helpers/memory-adapter';
import { makeDraft } from './helpers/printers';

const T0 = 1_767_225_600_000;

/** Fixed UUID so successive "processes" on the same db file configure the same
 *  printer (PrinterProfileSchema requires a UUID shape). */
const PRINTER_ID = '00000000-0000-4000-8000-000000000042';

/** Proxy that throws from a chosen method — simulates disk I/O failure / corruption.
 *  `failTimes` bounds the failure (transient fault); the default is persistent. */
function failingStore(real: JobStore, broken: keyof JobStore, failTimes = Infinity): JobStore {
  let remaining = failTimes;
  return new Proxy(real, {
    get(target, prop: string | symbol) {
      if (prop === broken) {
        const realMethod = Reflect.get(target, prop) as (...args: unknown[]) => unknown;
        return (...args: unknown[]) => {
          if (remaining > 0) {
            remaining -= 1;
            throw new Error(`simulated db failure in ${prop}`);
          }
          return realMethod.apply(target, args);
        };
      }
      return Reflect.get(target, prop);
    },
  });
}

async function drained(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

interface Process {
  readonly engine: JobEngine;
  readonly acks: JobAck[];
  dispose(): void;
}

/** Boot an engine against a real on-disk database — simulates a fresh process start
 *  (pattern from job-engine-recovery.test.ts), with optional store fault injection. */
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
  const engine = createJobEngine({
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

describe('engine store-failure fault injection', () => {
  it('intake insert failure → typed store_unavailable, no ack, engine keeps serving', async () => {
    const h = await makeHarness({ wrapStore: (base) => failingStore(base, 'insert') });
    try {
      let thrown: unknown;
      try {
        h.engine.submit(makeJob(h.printerId));
      } catch (err) {
        thrown = err;
      }
      // Typed error so the caller can distinguish store death from validation rejects.
      expect(thrown).toBeInstanceOf(JobEngineError);
      expect((thrown as JobEngineError).code).toBe('store_unavailable');
      // No ack: the server must re-deliver rather than trust a partial outcome.
      expect(h.acks).toHaveLength(0);
      // The engine did not crash — reads work and intake paths that run before
      // insert still respond (unknown printer rejects without touching insert).
      expect(h.engine.getJob('job-1')).toBeNull();
      const rejected = h.engine.submit(
        makeJob(h.printerId, { jobId: 'job-2', idempotencyKey: 'key-2', printerId: 'no-such-printer' }),
      );
      expect(rejected.status).toBe('rejected');
      expect(rejected.error?.code).toBe('unknown_printer');
    } finally {
      h.dispose();
    }
  });

  it('store failure after hand-off (recordAttempt): conservative sending, engine keeps serving', async () => {
    const transports = new FakeTransportRegistry(() => ({}));
    // The recordAttempt fault strikes once — a transient disk failure right after
    // the bytes were written (persistent would leave every job stranded, which is
    // the requeue-cap test's territory, not the mid-flight-handoff shape).
    const h = await makeHarness({
      transports,
      wrapStore: (base) => failingStore(base, 'recordAttempt', 1),
    });
    try {
      // Execution fails internally, but submit itself must not throw.
      expect(() => h.engine.submit(makeJob(h.printerId, { jobId: 'a', idempotencyKey: 'key-a' }))).not.toThrow();
      await drained();
      // Bytes were written (hand-off LIKELY happened) but the completion record did
      // not — the row conservatively stays durably 'sending' (last successful
      // transition), never silently 'completed'; restart recovery resolves it.
      const row = h.engine.getJob('a');
      expect(row?.status).toBe('sending');
      expect(transports.get(h.printerId)?.writes).toHaveLength(1); // hand-off happened
      expect(h.timers).toHaveLength(0); // 'sending' is never requeued — restart territory
      // The engine is still serving: a second job executes normally to completion.
      h.engine.submit(makeJob(h.printerId, { jobId: 'b', idempotencyKey: 'key-b' }));
      await drained();
      expect(h.engine.getJob('b')?.status).toBe('completed');
      expect(transports.get(h.printerId)?.writes).toHaveLength(2); // b's own write
    } finally {
      h.dispose();
    }
  });

  it('updateStatus broken during execution: requeue cap trips, row stays non-terminal, zero writes', async () => {
    const transports = new FakeTransportRegistry(() => ({}));
    const h = await makeHarness({
      transports,
      wrapStore: (base) => failingStore(base, 'updateStatus'),
    });
    try {
      h.engine.submit(makeJob(h.printerId));
      await drained();
      // The render-phase updateStatus throws → requeue #1 went through the scheduler.
      expect(h.timers.length).toBe(1);
      // Counters 1..3 schedule a backoff requeue each; the 4th gives up.
      h.timers.shift()?.(); // requeue #2
      await drained();
      h.timers.shift()?.(); // requeue #3
      await drained();
      expect(h.timers).toHaveLength(1);
      h.timers.shift()?.(); // requeue #4 → cap reached, nothing scheduled
      await drained();
      expect(h.timers).toHaveLength(0); // engine gave up — no spin
      // Row is readable and non-terminal: left for restart recovery.
      const row = h.engine.getJob('job-1');
      expect(row?.status).toBe('accepted');
      expect(row !== null && !isTerminal(row.status)).toBe(true);
      // Execution never got past the render-phase updateStatus — zero transport
      // activity (the registry never even materialized a transport).
      expect(transports.get(h.printerId)?.opens ?? 0).toBe(0);
      expect(transports.get(h.printerId)?.writes ?? []).toHaveLength(0);
    } finally {
      h.dispose();
    }
  });

  it('restart resolves a stranded sending row to ambiguous after mid-flight store death', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'db-fail-recovery-'));
    const file = join(dir, 'jobs.db');
    let p1: Process | null = null;
    let p2: Process | null = null;
    try {
      // Process 1: the store dies (persistently) at recordAttempt, after the write.
      const transports1 = new FakeTransportRegistry(() => ({}));
      p1 = await boot(file, transports1, [], (base) => failingStore(base, 'recordAttempt'));
      p1.engine.submit(makeJob(PRINTER_ID, { jobId: 'a', idempotencyKey: 'key-a' }));
      await drained();
      expect(p1.engine.getJob('a')?.status).toBe('sending');
      p1.dispose(); // simulated process death
      p1 = null;

      // Process 2 boots with a healthy store and a working transport — it would
      // print if re-sent. That is the point: recover() must resolve, not re-send.
      const transports2 = new FakeTransportRegistry(() => ({}));
      const acks2: JobAck[] = [];
      p2 = await boot(file, transports2, acks2);
      p2.engine.recover();
      await drained();

      expect(p2.engine.getJob('a')?.status).toBe('ambiguous');
      expect(transports2.get(PRINTER_ID)?.opens ?? 0).toBe(0); // nothing re-sent
      const crash = p2.engine.listAttempts('a').find((r) => r.outcome === 'ambiguous_crash');
      expect(crash?.errorCode).toBe('restarted_in_flight');
      p2.dispose();
      p2 = null;
    } finally {
      p1?.dispose();
      p2?.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
