import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { ServiceProvider } from '../../src/renderer/src/services/service-context';
import type { AgentService } from '../../src/renderer/src/services/agent-service';
import type {
  AgentIdentity,
  AgentSnapshot,
  ConnectivityCheck,
  DiagnosticsReport,
  JobRecord,
  LogLine,
  PairResult,
  PrinterDraft,
  PrinterInfo,
  UiSettings,
} from '../../src/renderer/src/services/types';

const AGENT_VERSION = '0.1.0';

function rfc3339(ms: number): string {
  return new Date(ms).toISOString();
}

function profile(input: {
  printerId: string;
  name: string;
  role: PrinterInfo['config']['role'];
  host: string;
  port: number;
  paperWidthMm: 58 | 80;
  health: PrinterInfo['health'];
}): PrinterInfo {
  return {
    config: {
      printerId: input.printerId,
      name: input.name,
      role: input.role,
      paperWidthMm: input.paperWidthMm,
      printableDots: 576,
      charsPerLine: 48,
      capabilities: {
        cut: true,
        qrCode: true,
        barcode128: false,
        statusPolling: false,
        cashDrawer: false,
      },
      transport: { kind: 'tcp_raw', host: input.host, port: input.port },
    },
    health: input.health,
    lastPrintAt: input.health === 'offline' ? null : rfc3339(Date.now() - 90_000),
  };
}

/**
 * In-memory fake implementing `AgentService` directly. Same
 * fixture values the UI tests have always asserted: three printers
 * (Kitchen-1 ok, Cashier-1 paper_low, Bar-1 offline), a five-job history
 * spanning completed/failed/ambiguous/sent_to_printer, paired identity
 * "Trattoria Bella (demo)".
 */
/* eslint-disable @typescript-eslint/require-await -- AgentService methods are async by contract; the fake resolves synchronously for deterministic tests. */
class FakeAgentService implements AgentService {
  readonly demo = false;

  private connection: AgentSnapshot['connection'] = 'online';
  private identity: AgentIdentity | null = {
    deviceId: 'dev-0001-a3f2',
    agentName: 'Cashier PC',
    restaurantId: 'rst-018f3c2e',
    restaurantName: 'Trattoria Bella (demo)',
    pairedAt: rfc3339(Date.now() - 86_400_000),
  };
  private readonly printers: PrinterInfo[] = [
    profile({
      printerId: '5f0a3b1e-9c2d-4a7e-8b1f-2c3d4e5f6a01',
      name: 'Kitchen-1',
      role: 'kitchen',
      host: '192.168.1.87',
      port: 9100,
      paperWidthMm: 80,
      health: 'ok',
    }),
    profile({
      printerId: '5f0a3b1e-9c2d-4a7e-8b1f-2c3d4e5f6a02',
      name: 'Cashier-1',
      role: 'receipt',
      host: '192.168.1.90',
      port: 9100,
      paperWidthMm: 80,
      health: 'paper_low',
    }),
    profile({
      printerId: '5f0a3b1e-9c2d-4a7e-8b1f-2c3d4e5f6a03',
      name: 'Bar-1',
      role: 'bar',
      host: '192.168.1.104',
      port: 9100,
      paperWidthMm: 58,
      health: 'offline',
    }),
  ];
  private readonly jobs: JobRecord[] = this.seedJobs();
  private settings: UiSettings = {
    launchAtLogin: false,
    startMinimized: true,
    logLevel: 'info',
  };
  private reprintCounter = 0;

  private seedJobs(): JobRecord[] {
    const t = Date.now();
    const minute = 60_000;
    return [
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
    ];
  }

  getSnapshot(): Promise<AgentSnapshot> {
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
    const details: Readonly<Record<AgentSnapshot['connection'], string>> = {
      unpaired: 'Not paired. Enter a pairing code from the SaaS dashboard to begin.',
      connecting: 'Establishing the outbound connection.',
      online: 'Connected to the cloud. Jobs are delivered by outbound polling.',
      offline:
        'No connection to the cloud. Jobs sent while offline queue on the server and replay on reconnect.',
      revoked: 'This device was revoked. Local data was wiped — pair again with a new code.',
    };
    return Promise.resolve({
      version: AGENT_VERSION,
      connection: this.identity === null ? 'unpaired' : this.connection,
      connectionDetail: details[this.identity === null ? 'unpaired' : this.connection],
      identity: this.identity,
      pendingJobs: this.jobs.filter((j) => nonTerminal.has(j.status)).length,
      ambiguousJobs: this.jobs.filter((j) => j.status === 'ambiguous').length,
      lastActivityAt: lastActivity ?? null,
    });
  }

  async pairWithCode(code: string): Promise<PairResult> {
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
      pairedAt: rfc3339(Date.now()),
    };
    this.connection = 'online';
    return { ok: true, identity: this.identity };
  }

  async unpair(): Promise<void> {
    this.identity = null;
    this.connection = 'unpaired';
    this.jobs.length = 0;
    this.printers.length = 0;
  }

  getPrinters(): Promise<readonly PrinterInfo[]> {
    return Promise.resolve([...this.printers]);
  }

  async addPrinter(draft: PrinterDraft): Promise<PrinterInfo> {
    const printer: PrinterInfo = {
      config: { ...draft, printerId: crypto.randomUUID() },
      health: 'unknown',
      lastPrintAt: null,
    };
    this.printers.push(printer);
    return printer;
  }

  async updatePrinter(printerId: string, draft: PrinterDraft): Promise<PrinterInfo> {
    const index = this.printers.findIndex((p) => p.config.printerId === printerId);
    const existing = this.printers[index];
    if (index === -1 || existing === undefined) {
      throw new Error(`unknown printer: ${printerId}`);
    }
    const updated: PrinterInfo = { ...existing, config: { ...draft, printerId } };
    this.printers[index] = updated;
    return updated;
  }

  async removePrinter(printerId: string): Promise<void> {
    const index = this.printers.findIndex((p) => p.config.printerId === printerId);
    if (index === -1) {
      throw new Error(`unknown printer: ${printerId}`);
    }
    this.printers.splice(index, 1);
  }

  async testPrint(printerId: string): Promise<{ ok: boolean; detail: string; at: string }> {
    const printer = this.printers.find((p) => p.config.printerId === printerId);
    if (printer === undefined) {
      throw new Error(`unknown printer: ${printerId}`);
    }
    const at = rfc3339(Date.now());
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
    return Promise.resolve([...this.jobs]);
  }

  private findJob(jobId: string): JobRecord {
    const job = this.jobs.find((j) => j.jobId === jobId);
    if (job === undefined) {
      throw new Error(`unknown job: ${jobId}`);
    }
    return job;
  }

  async retryJob(jobId: string): Promise<JobRecord> {
    const job = this.findJob(jobId);
    if (job.status !== 'failed') {
      throw new Error(`retry is only available for failed jobs (job ${jobId} is ${job.status})`);
    }
    const updated: JobRecord = {
      ...job,
      status: 'completed',
      attempts: job.attempts + 1,
      updatedAt: rfc3339(Date.now()),
      lastError: null,
    };
    this.replaceJob(updated);
    return updated;
  }

  async reprintJob(jobId: string): Promise<JobRecord> {
    const job = this.findJob(jobId);
    if (job.status !== 'completed' && job.status !== 'ambiguous') {
      throw new Error(
        `reprint is only available for completed or ambiguous jobs (job ${jobId} is ${job.status})`,
      );
    }
    this.reprintCounter += 1;
    const reprint: JobRecord = {
      ...job,
      jobId: `job-${String(1008 + this.reprintCounter)}`,
      idempotencyKey: `${job.idempotencyKey}#reprint-${String(this.reprintCounter)}`,
      status: 'completed',
      createdAt: rfc3339(Date.now()),
      updatedAt: rfc3339(Date.now()),
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
    return Promise.resolve({ ...this.settings });
  }

  /** Mirrors the real behavior: all three toggles persist. In production
   * `launchAtLogin` is routed to its dedicated channel (it also drives the OS
   * autolaunch registration) while `startMinimized`/`logLevel` go through
   * `settings:update` — the fake collapses both into this one in-memory write. */
  async updateSettings(patch: Partial<UiSettings>): Promise<UiSettings> {
    this.settings = { ...this.settings, ...patch };
    return { ...this.settings };
  }

  getDiagnostics(): Promise<DiagnosticsReport> {
    return Promise.resolve({
      version: AGENT_VERSION,
      electronVersion: '45.0.0',
      platform: 'Windows 10 Pro (build 19045), x64',
      uptimeS: Math.floor(Date.now() / 1000) % 86_400,
      db: {
        ok: true,
        sizeBytes: 148_897,
        queueDepth: this.jobs.filter((j) => !['completed', 'failed', 'rejected'].includes(j.status))
          .length,
        journalMode: 'wal',
      },
    });
  }

  async runConnectivityChecks(): Promise<readonly ConnectivityCheck[]> {
    const unreachable = this.printers.filter((p) => p.health === 'offline').length;
    return [
      {
        id: 'cloud-api',
        label: 'Cloud endpoint (api.example-saas.test)',
        status: 'pass',
        detail: 'TLS handshake OK in 84 ms.',
      },
      {
        id: 'auth',
        label: 'Device token',
        status: 'pass',
        detail: 'Token present and not expired.',
      },
      {
        id: 'printers',
        label: 'Printer network reachability',
        status: unreachable > 0 ? 'warn' : 'pass',
        detail:
          unreachable > 0
            ? `${String(unreachable)} of ${String(this.printers.length)} printers did not answer.`
            : `All ${String(this.printers.length)} printers answered.`,
      },
      {
        id: 'db',
        label: 'Local database',
        status: 'pass',
        detail: 'Integrity check passed; WAL mode active.',
      },
    ];
  }

  getRecentLogs(): Promise<readonly LogLine[]> {
    const t = Date.now();
    return Promise.resolve([
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
    ] satisfies LogLine[]);
  }
}

/** Deterministic in-memory service with selected methods overridden. */
export function makeService(overrides: Partial<AgentService> = {}): AgentService {
  const base = new FakeAgentService();
  return Object.assign(base, overrides);
}

export function renderWithService(
  ui: ReactElement,
  service: AgentService,
): ReturnType<typeof render> {
  return render(<ServiceProvider service={service}>{ui}</ServiceProvider>);
}
