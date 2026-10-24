import type { PrinterTransport } from '../../src/main/transport/types';
import type { TransportRegistry } from '../../src/main/transport/registry';
import type { PrinterProfile } from '../../src/main/printers/profile';

export interface FakeTransportScript {
  /** open() rejects with this error (simulates printer disconnected). */
  readonly openError?: Error;
  /** write() rejects on the Nth write (1-based) — simulates mid-stream disconnect. */
  readonly failWriteNumber?: number;
  readonly writeError?: Error;
  /** write() never resolves — simulates a hung in-flight write (crash simulation). */
  readonly hang?: boolean;
}

export class FakeTransport implements PrinterTransport {
  readonly writes: Uint8Array[] = [];
  opens = 0;
  closes = 0;
  activeWrites = 0;
  maxConcurrentWrites = 0;

  constructor(private readonly script: FakeTransportScript) {}

  open(): Promise<void> {
    this.opens += 1;
    if (this.script.openError !== undefined) return Promise.reject(this.script.openError);
    return Promise.resolve();
  }

  async write(bytes: Uint8Array): Promise<void> {
    this.activeWrites += 1;
    this.maxConcurrentWrites = Math.max(this.maxConcurrentWrites, this.activeWrites);
    try {
      if (this.script.hang === true) {
        await new Promise<void>(() => {}); // never resolves
      }
      if (
        this.script.failWriteNumber !== undefined &&
        this.writes.length + 1 >= this.script.failWriteNumber
      ) {
        throw this.script.writeError ?? new Error('write failed');
      }
      this.writes.push(bytes);
    } finally {
      this.activeWrites -= 1;
    }
  }

  close(): Promise<void> {
    this.closes += 1;
    return Promise.resolve();
  }

  async healthCheck(): Promise<void> {}
}

/** One FakeTransport per printerId, reused across jobs — mirrors a persistent
 *  connection per execution cycle (the real TCP transport opens/closes per job;
 *  instance reuse here is a test convenience). */
export class FakeTransportRegistry implements TransportRegistry {
  private readonly transports = new Map<string, FakeTransport>();

  constructor(
    private readonly scriptFor: (printerId: string) => FakeTransportScript = () => ({}),
  ) {}

  forPrinter(profile: PrinterProfile): FakeTransport {
    const existing = this.transports.get(profile.printerId);
    if (existing !== undefined) return existing;
    const t = new FakeTransport(this.scriptFor(profile.printerId));
    this.transports.set(profile.printerId, t);
    return t;
  }

  get(printerId: string): FakeTransport | undefined {
    return this.transports.get(printerId);
  }
}
