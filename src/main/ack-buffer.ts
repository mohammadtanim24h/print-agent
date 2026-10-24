import { ENVELOPE_VERSION } from './cloud-client/schemas';
import type { AckBatch } from './cloud-client/types';
import type { JobAck } from './jobs/types';

/** Collects engine acks and delivers them to the cloud client in batches
 *  (§7.1). Failures retain acks (retry on next trigger); the queue is capped
 *  with oldest-first drop, mirroring the engine's bounded-queue philosophy. */
export interface AckBuffer {
  add(ack: JobAck): void;
  pendingCount(): number;
  /** Final flush; resolves after the attempt (even if it failed — callers
   *  must not block shutdown on a dead network). */
  stop(): Promise<void>;
}

export interface AckBufferOptions {
  submitAcks(batch: AckBatch): Promise<void>;
  schedule(fn: () => void, delayMs: number): () => void;
  maxBatch?: number;   // default 20 (AckBatchSchema caps at 100)
  maxDelayMs?: number; // default 5_000
  maxQueued?: number;  // default 500
  envelopeVersion?: typeof ENVELOPE_VERSION; // default ENVELOPE_VERSION
  log?: (message: string) => void;
}

export function createAckBuffer(options: AckBufferOptions): AckBuffer {
  const maxBatch = options.maxBatch ?? 20;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const maxQueued = options.maxQueued ?? 500;
  const envelopeVersion = options.envelopeVersion ?? ENVELOPE_VERSION;
  const log = options.log ?? ((): void => {});
  let queue: JobAck[] = [];
  let timer: (() => void) | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  const toBatch = (acks: readonly JobAck[]): AckBatch => ({
    envelope_version: envelopeVersion,
    type: 'ack',
    acks: acks.map((a) => ({
      job_id: a.jobId,
      status: a.status,
      printer_status: a.printerStatus,
      printed: a.printed,
      attempt: a.attempt,
      at: a.at,
      ...(a.error === undefined ? {} : { error: a.error }),
    })),
  });

  function flush(): void {
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    inFlight = inFlight
      .then(() => options.submitAcks(toBatch(batch)))
      .catch(() => {
        // Retain for the next trigger; bounded.
        log(`ack buffer: flush failed, ${String(batch.length)} ack(s) retained`);
        queue = [...batch, ...queue].slice(-maxQueued);
      });
  }

  function armTimer(): void {
    if (timer !== null) return;
    timer = options.schedule(() => {
      timer = null;
      flush();
    }, maxDelayMs);
  }

  return {
    add(ack) {
      queue.push(ack);
      if (queue.length > maxQueued) {
        queue.shift();
        log('ack buffer: overflow, oldest ack dropped');
      }
      if (queue.length >= maxBatch) flush();
      else armTimer();
    },
    pendingCount: () => queue.length,
    async stop() {
      timer?.();
      timer = null;
      flush();
      await inFlight;
    },
  };
}
