import type { AgentService } from './agent-service';
import type {
  AgentSnapshot,
  AgentIdentity,
  ConnectivityCheck,
  DiagnosticsReport,
  JobRecord,
  LogLine,
  PairResult,
  PrinterDraft,
  PrinterInfo,
  TestPrintResult,
  UiSettings,
} from './types';

export interface MockAgentServiceOptions {
  /** Simulated round-trip latency per call (ms). 0 keeps tests deterministic-fast. */
  readonly latencyMs?: number;
  readonly connection?: AgentSnapshot['connection'];
  readonly now?: () => Date;
}

const AGENT_VERSION = '0.1.0';

function rfc3339(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * In-memory stand-in for the main-process services (job engine, cloud client,
 * local store, diagnostics). All data is demo data; the UI shows a demo badge
 * while `demo` is true so nothing is mistaken for a live connection or live
 * printer status.
 */
export class MockAgentService implements AgentService {
  public readonly demo = true;

  private readonly latencyMs: number;
  private readonly now: () => Date;
  private connection: AgentSnapshot['connection'];
  private identity: AgentIdentity | null = null;
  private readonly printers: PrinterInfo[] = [];
  private readonly jobs: JobRecord[] = [];
  private settings: UiSettings = {
    launchAtLogin: false,
    startMinimized: true,
    logLevel: 'info',
  };
  private nextPrinterId = 1;
  private nextJobId = 1;
  private reprintCounter = 0;

  constructor(options: MockAgentServiceOptions = {}) {
    this.latencyMs = options.latencyMs ?? 25;
    this.connection = options.connection ?? 'online';
    this.now = options.now ?? (() => new Date());
    this.identity = {
      deviceId: 'dev-0001-a3f2',
      agentName: 'Cashier PC',
      restaurantId: 'rst-018f3c2e',
      restaurantName: 'Trattoria Bella (demo)',
      pairedAt: rfc3339(this.now().getTime() - 86400_000),
    };
    this.seedPrinters();
    this.seedJobs();
  }

  private async tick(): Promise<void> {
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }
  }

  private seedPrinters(): void {
    this.printers.push(
      this.makePrinter({
        name: 'Kitchen-1',
        station: 'kitchen',
        transport: { kind: 'tcp_raw', host: '192.168.1.87', port: 9100 },
        health: 'ok',
      }),
      this.makePrinter({
        name: 'Cashier-1',
        station: 'cashier',
        transport: { kind: 'spooler_raw', windowsPrinterName: 'EPSON TM-T88VI' },
        health: 'paper_low',
      }),
      this.makePrinter({
        name: 'Bar-1',
        station: 'bar',
        transport: { kind: 'tcp_raw', host: '192.168.1.104', port: 9100 },
        health: 'offline',
      }),
    );
  }

  private makePrinter(input: {
    name: string;
    station: string;
    transport: PrinterDraft['transport'];
    health: PrinterInfo['health'];
  }): PrinterInfo {
    const id = `prt-${String(this.nextPrinterId++).padStart(3, '0')}`;
    return {
      config: {
        printerId: id,
        name: input.name,
        station: input.station,
        transport: input.transport,
        copiesDefault: 1,
        codepage: 'cp437',
        cutDefault: 'partial',
        duplicatePolicy: 'ask_operator',
      },
      health: input.health,
      lastPrintAt: input.health === 'offline' ? null : rfc3339(this.now().getTime() - 90_000),
    };
  }

  private seedJobs(): void {
    const t = this.now().getTime();
    const minute = 60_000;
    this.jobs.push(
      {
        jobId: 'job-1007',
        idempotencyKey: 'ord_4218-kitchen',
        docType: 'kitchen_ticket',
        destinationPrinterName: 'Kitchen-1',
        status: 'completed',
        createdAt: rfc3339(t - 6 * minute),
        updatedAt: rfc3339(t - 6 * minute + 1_400),
        attempts: 1,
        lastError: null,
      },
      {
        jobId: 'job-1006',
        idempotencyKey: 'ord_4217-receipt',
        docType: 'customer_receipt',
        destinationPrinterName: 'Cashier-1',
        status: 'completed',
        createdAt: rfc3339(t - 14 * minute),
        updatedAt: rfc3339(t - 14 * minute + 2_100),
        attempts: 1,
        lastError: null,
      },
      {
        jobId: 'job-1005',
        idempotencyKey: 'ord_4216-bar',
        docType: 'bar_ticket',
        destinationPrinterName: 'Bar-1',
        status: 'failed',
        createdAt: rfc3339(t - 21 * minute),
        updatedAt: rfc3339(t - 21 * minute + 9_500),
        attempts: 3,
        lastError: 'transport_timeout: no route to 192.168.1.104:9100',
      },
      {
        jobId: 'job-1004',
        idempotencyKey: 'ord_4215-kitchen',
        docType: 'kitchen_ticket',
        destinationPrinterName: 'Kitchen-1',
        status: 'ambiguous',
        createdAt: rfc3339(t - 38 * minute),
        updatedAt: rfc3339(t - 38 * minute + 800),
        attempts: 1,
        lastError: 'agent restarted while job was in flight; outcome unknown',
      },
      {
        jobId: 'job-1003',
        idempotencyKey: 'ord_4214-receipt',
        docType: 'customer_receipt',
        destinationPrinterName: 'Cashier-1',
        status: 'sent_to_printer',
        createdAt: rfc3339(t - 52 * minute),
        updatedAt: rfc3339(t - 52 * minute + 1_900),
        attempts: 1,
        lastError: null,
      },
    );
    this.nextJobId = 1008;
  }

  private jobId(): string {
    return `job-${String(this.nextJobId++)}`;
  }

  getSnapshot(): Promise<AgentSnapshot> {
    return this.tick().then(() => {
      const terminal = new Set<JobRecord['status']>([
        'completed',
        'failed',
        'ambiguous',
        'rejected',
      ]);
      const nonTerminal = new Set<JobRecord['status']>([
        'accepted',
        'rendered',
        'sending',
        'sent_to_printer',
      ]);
      const lastActivity = this.jobs
        .filter((j) => terminal.has(j.status))
        .map((j) => j.updatedAt)
        .sort()
        .at(-1);
      return {
        version: AGENT_VERSION,
        connection: this.identity === null ? 'disabled' : this.connection,
        connectionDetail:
          this.identity === null
            ? 'Not paired. Enter a pairing code from the SaaS dashboard to begin.'
            : 'Demo data — the cloud link is not implemented in this phase.',
        identity: this.identity,
        pendingJobs: this.jobs.filter((j) => nonTerminal.has(j.status)).length,
        ambiguousJobs: this.jobs.filter((j) => j.status === 'ambiguous').length,
        lastActivityAt: lastActivity ?? null,
      };
    });
  }

  async pairWithCode(code: string): Promise<PairResult> {
    await this.tick();
    if (this.identity !== null) {
      return { ok: false, reason: 'already_paired', message: 'This agent is already paired.' };
    }
    const normalized = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(normalized)) {
      return {
        ok: false,
        reason: 'invalid_code',
        message: 'Pairing codes are 8 letters or digits.',
      };
    }
    this.identity = {
      deviceId: 'dev-0001-a3f2',
      agentName: 'Cashier PC',
      restaurantId: 'rst-018f3c2e',
      restaurantName: 'Trattoria Bella (demo)',
      pairedAt: rfc3339(this.now().getTime()),
    };
    this.connection = 'online';
    return { ok: true, identity: this.identity };
  }

  async unpair(): Promise<void> {
    await this.tick();
    this.identity = null;
    this.connection = 'disabled';
    this.jobs.length = 0;
    this.printers.length = 0;
  }

  getPrinters(): Promise<readonly PrinterInfo[]> {
    return this.tick().then(() => [...this.printers]);
  }

  async addPrinter(draft: PrinterDraft): Promise<PrinterInfo> {
    await this.tick();
    const printer = this.makePrinter({ ...draft, health: 'unknown' });
    this.printers.push(printer);
    return printer;
  }

  async updatePrinter(printerId: string, draft: PrinterDraft): Promise<PrinterInfo> {
    await this.tick();
    const index = this.printers.findIndex((p) => p.config.printerId === printerId);
    if (index === -1) {
      throw new Error(`unknown printer: ${printerId}`);
    }
    const existing = this.printers[index];
    if (existing === undefined) {
      throw new Error(`unknown printer: ${printerId}`);
    }
    const updated: PrinterInfo = { ...existing, config: { ...existing.config, ...draft } };
    this.printers[index] = updated;
    return updated;
  }

  async removePrinter(printerId: string): Promise<void> {
    await this.tick();
    const index = this.printers.findIndex((p) => p.config.printerId === printerId);
    if (index === -1) {
      throw new Error(`unknown printer: ${printerId}`);
    }
    this.printers.splice(index, 1);
  }

  async testPrint(printerId: string): Promise<TestPrintResult> {
    await this.tick();
    const printer = this.printers.find((p) => p.config.printerId === printerId);
    if (printer === undefined) {
      throw new Error(`unknown printer: ${printerId}`);
    }
    const at = rfc3339(this.now().getTime());
    if (printer.health === 'offline') {
      return { ok: false, detail: 'Printer is offline — check power and network cable.', at };
    }
    return {
      ok: true,
      detail: 'Test page handed to the printer. This confirms hand-off, not physical printing.',
      at,
    };
  }

  getJobs(): Promise<readonly JobRecord[]> {
    return this.tick().then(() => [...this.jobs]);
  }

  private findJob(jobId: string): JobRecord {
    const job = this.jobs.find((j) => j.jobId === jobId);
    if (job === undefined) {
      throw new Error(`unknown job: ${jobId}`);
    }
    return job;
  }

  async retryJob(jobId: string): Promise<JobRecord> {
    await this.tick();
    const job = this.findJob(jobId);
    if (job.status !== 'failed') {
      throw new Error(`retry is only available for failed jobs (job ${jobId} is ${job.status})`);
    }
    const updated: JobRecord = {
      ...job,
      status: 'completed',
      attempts: job.attempts + 1,
      updatedAt: rfc3339(this.now().getTime()),
      lastError: null,
    };
    this.replaceJob(updated);
    return updated;
  }

  async reprintJob(jobId: string): Promise<JobRecord> {
    await this.tick();
    const job = this.findJob(jobId);
    if (job.status !== 'completed' && job.status !== 'ambiguous') {
      throw new Error(
        `reprint is only available for completed or ambiguous jobs (job ${jobId} is ${job.status})`,
      );
    }
    this.reprintCounter += 1;
    const reprint: JobRecord = {
      ...job,
      jobId: this.jobId(),
      idempotencyKey: `${job.idempotencyKey}#reprint-${String(this.reprintCounter)}`,
      status: 'completed',
      createdAt: rfc3339(this.now().getTime()),
      updatedAt: rfc3339(this.now().getTime()),
      attempts: 1,
      lastError: null,
    };
    this.jobs.unshift(reprint);
    return reprint;
  }

  private replaceJob(updated: JobRecord): void {
    const index = this.jobs.findIndex((j) => j.jobId === updated.jobId);
    if (index !== -1) {
      this.jobs[index] = updated;
    }
  }

  getSettings(): Promise<UiSettings> {
    return this.tick().then(() => ({ ...this.settings }));
  }

  async updateSettings(patch: Partial<UiSettings>): Promise<UiSettings> {
    await this.tick();
    this.settings = { ...this.settings, ...patch };
    return { ...this.settings };
  }

  getDiagnostics(): Promise<DiagnosticsReport> {
    return this.tick().then(() => ({
      version: AGENT_VERSION,
      electronVersion: '45.0.0',
      platform: 'Windows 10 Pro (build 19045), x64',
      uptimeS: Math.floor(this.now().getTime() / 1000) % 86_400,
      db: {
        ok: true,
        sizeBytes: 148_897,
        queueDepth: this.jobs.filter((j) => !['completed', 'failed', 'rejected'].includes(j.status))
          .length,
        journalMode: 'wal',
      },
    }));
  }

  async runConnectivityChecks(): Promise<readonly ConnectivityCheck[]> {
    await this.tick();
    const unreachable = this.printers.filter((p) => p.health === 'offline').length;
    return [
      {
        id: 'cloud-api',
        label: 'Cloud endpoint (api.example-saas.test)',
        status: 'pass',
        detail: 'TLS handshake OK in 84 ms (demo result).',
      },
      {
        id: 'auth',
        label: 'Device token',
        status: 'pass',
        detail: 'Token present and not expired (demo result).',
      },
      {
        id: 'printers',
        label: 'Printer network reachability',
        status: unreachable > 0 ? 'warn' : 'pass',
        detail:
          unreachable > 0
            ? `${String(unreachable)} of ${String(this.printers.length)} printers did not answer (demo result).`
            : `All ${String(this.printers.length)} printers answered (demo result).`,
      },
      {
        id: 'db',
        label: 'Local database',
        status: 'pass',
        detail: 'Integrity check passed; WAL mode active (demo result).',
      },
    ];
  }

  getRecentLogs(): Promise<readonly LogLine[]> {
    return this.tick().then(() => {
      const t = this.now().getTime();
      return [
        {
          ts: rfc3339(t - 12_000),
          level: 'info',
          module: 'cloud-client',
          message: 'auth header prepared: Bearer *** (redacted)',
        },
        {
          ts: rfc3339(t - 9_000),
          level: 'warn',
          module: 'transport-tcp',
          message: 'connect timeout after 3000 ms to 192.168.1.104:9100',
        },
        {
          ts: rfc3339(t - 7_500),
          level: 'info',
          module: 'job-engine',
          message: 'job job-1003 handed to printer Cashier-1 (hand-off, not print-confirmed)',
        },
        {
          ts: rfc3339(t - 5_000),
          level: 'error',
          module: 'job-engine',
          message: 'job job-1005 failed: transport_timeout (attempts: 3)',
        },
        {
          ts: rfc3339(t - 2_000),
          level: 'info',
          module: 'main',
          message: 'heartbeat sent (queue_depth=1, printers=3)',
        },
      ] satisfies LogLine[];
    });
  }
}
