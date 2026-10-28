import { hostname, release, type } from 'node:os';
import { statSync } from 'node:fs';
import { createPollingCloudClient } from './cloud-client/poller';
import { createHttpTransport } from './cloud-client/http-transport';
import { createWssChannel, deriveWssUrl } from './cloud-client/ws-channel';
import {
  createSafeStorageSecretStore,
  type IdentitySecrets,
  type SafeStorageLike,
  type SecretKv,
  type SecretStore,
} from './cloud-client/secret-store';
import { CloudError } from './cloud-client/errors';
import { mapCloudPrinters } from './printers/config-apply';
import { ConfigUpdateSchema } from './cloud-client/schemas';
import type { ConfigUpdate } from './cloud-client/schemas';
import type {
  AgentTransport,
  CloudClient,
  ConnectionState,
  HeartbeatSample,
  WssChannelLike,
} from './cloud-client/types';
import { createJobEngine, type JobEngine } from './jobs/engine';
import type { AckSink } from './jobs/types';
import { createPrinterStore, type PrinterStore } from './printers/store';
import type { PrinterDraft } from './printers/profile';
import { createPrinterService, type PrinterService } from './printers/service';
import { createTransportRegistry } from './transport/registry';
import type { TransportRegistry } from './transport/registry';
import { createNodeSettingsAdapter } from './services/settings-fs';
import type { SettingsFileAdapter, SettingsStore } from './services/settings';
import { getRecentLogLines, type Logger } from './services/logger/logger';
import { createConfigStore } from './local-store/config-store';
import { createSqliteJobStore, JOB_STATUSES } from './local-store/job-store';
import type { SqliteDatabase } from './local-store/db';
import { createAckBuffer, type AckBuffer } from './ack-buffer';
import { createJsonFileKv } from './secret-kv';
import { mapPairFailure, toJobRecord, toPrinterInfo } from './view-model';
import type {
  AgentSnapshot,
  ConnectivityCheck,
  DiagnosticsReport,
  JobRecord,
  LogLine,
  PairResult,
  PrinterInfo,
  TestPrintResult,
} from '../renderer/src/services/types';

/**
 * Composition root (architecture §3): instantiates the stores, engine and
 * cloud client with injected dependencies and owns the app lifecycle —
 * pairing, wipe-on-revoke/unpair, snapshot assembly and the cloud-event
 * plumbing. `main.ts` opens + migrates the SQLite database and closes it on
 * quit; the runtime never closes it.
 */

export interface RuntimeDeps {
  readonly db: SqliteDatabase;
  readonly settings: SettingsStore;
  /** dbFile is null for an in-memory database (tests); diagnostics uses it for the size check. */
  readonly paths: {
    readonly printersFile: string;
    readonly dbFile: string | null;
    readonly identityKvFile: string;
  };
  readonly log: Logger;
  readonly agentVersion: string;
  /** Defaults to os.hostname(). */
  readonly deviceName?: string;
  readonly safeStorage: SafeStorageLike;
  readonly cloud: {
    readonly baseUrl: string;
    readonly pollIntervalMs?: number;
    readonly safetyPollIntervalMs?: number;
  };
  /** Test seams; defaults are the real implementations. */
  readonly env?: {
    readonly transportOverride?: AgentTransport;
    readonly kvOverride?: SecretKv;
    /** Test seam: replaces the default real-socket transport registry. */
    readonly transportsOverride?: TransportRegistry;
    /** Test seam: file adapter for the printers store / identity kv (default: node fs). */
    readonly adapterOverride?: SettingsFileAdapter;
    /** Test seam: replaces the default real WSS channel. */
    readonly channelOverride?: WssChannelLike;
    readonly now?: () => number;
    /** Returns a cancel function (poller/ack-buffer seam); the engine's void-returning seam is adapted. */
    readonly schedule?: (fn: () => void, delayMs: number) => () => void;
    readonly random?: () => number;
    /** Injected for tests; defaults to global fetch. */
    readonly fetchOverride?: typeof fetch;
  };
}

export interface AgentRuntime {
  /** Idempotent. Crash recovery runs FIRST, then the poll loop's first cycle. */
  start(): void;
  /** Idempotent: stops the client, then flushes retained acks. */
  stop(): Promise<void>;
  agentInfo(): { name: string; version: string; connectionState: ConnectionState };
  snapshot(): Promise<AgentSnapshot>;
  pair(code: string): Promise<PairResult>;
  unpair(): Promise<void>;
  readonly printers: {
    list(): readonly PrinterInfo[];
    add(draft: unknown): Promise<PrinterInfo>;
    update(printerId: string, patch: unknown): Promise<PrinterInfo>;
    remove(printerId: string): Promise<boolean>;
    testPrint(printerId: string): Promise<TestPrintResult>;
  };
  readonly jobs: {
    list(): readonly JobRecord[];
    retry(jobId: string): Promise<JobRecord>;
    reprint(jobId: string): Promise<JobRecord>;
  };
  readonly diagnostics: {
    report(): Promise<DiagnosticsReport>;
    checks(): Promise<readonly ConnectivityCheck[]>;
    recentLogs(): readonly LogLine[];
  };
}

const CONNECTION_DETAILS: Readonly<Record<ConnectionState, string>> = {
  unpaired: 'Not paired. Enter a pairing code from the SaaS dashboard to begin.',
  connecting: 'Establishing the outbound connection.',
  online:
    'Connected to the cloud. Jobs arrive in real time over a secure socket; polling backs this up.',
  offline:
    'No connection to the cloud. Jobs sent while offline queue on the server and replay on reconnect.',
  revoked:
    'This device was revoked. The local data wipe was triggered — pair again with a new code.',
};

const CLOUD_CHECK_TIMEOUT_MS = 5_000;

export async function createAgentRuntime(deps: RuntimeDeps): Promise<AgentRuntime> {
  const now = deps.env?.now ?? Date.now;
  const schedule =
    deps.env?.schedule ??
    ((fn: () => void, delayMs: number): (() => void) => {
      const t = setTimeout(fn, delayMs);
      return () => {
        clearTimeout(t);
      };
    });
  const random = deps.env?.random ?? Math.random;
  const log = deps.log;
  const deviceName = deps.deviceName ?? hostname();

  const fileAdapter: SettingsFileAdapter = deps.env?.adapterOverride ?? createNodeSettingsAdapter();
  // Sync-persisting kv (secret-kv.ts): save() failures now THROW, so the
  // token-rotation/pairing callers observe them directly (poller poisons
  // refresh; pairing fails closed) instead of an onError swallow.
  const kv: SecretKv = deps.env?.kvOverride ?? createJsonFileKv(deps.paths.identityKvFile);
  const secrets: SecretStore = createSafeStorageSecretStore(kv, deps.safeStorage);
  const transport =
    deps.env?.transportOverride ??
    createHttpTransport({ baseUrl: deps.cloud.baseUrl, agentVersion: deps.agentVersion });
  const jobStore = createSqliteJobStore(deps.db);
  const printers: PrinterStore = await createPrinterStore({
    filePath: deps.paths.printersFile,
    adapter: fileAdapter,
    newId: () => crypto.randomUUID(),
    report: (message) => {
      log.warn(message);
    },
  });
  const registry: TransportRegistry = deps.env?.transportsOverride ?? createTransportRegistry();
  const printerService: PrinterService = createPrinterService({ store: printers, registry });
  const configStore = createConfigStore(deps.db);

  // Ack flow: engine → buffer → client. The buffer is created before the
  // client and reaches it through this forward reference (the first submit
  // only happens after start()/pair(), both post-construction).
  // eslint-disable-next-line prefer-const -- assigned once, after ackBuffer's forward-reference closure exists
  let client: CloudClient;
  const ackBuffer: AckBuffer = createAckBuffer({
    submitAcks: (batch) => client.submitAcks(batch),
    schedule: (fn, delayMs) => schedule(fn, delayMs),
    log: (message) => {
      log.warn(message);
    },
  });
  const ackSink: AckSink = {
    submit: (ack) => {
      ackBuffer.add(ack);
    },
  };

  const engine: JobEngine = createJobEngine({
    store: jobStore,
    printers,
    transports: registry,
    acks: ackSink,
    now,
    // The engine's schedule seam returns void; the env seam returns a cancel fn.
    schedule: (fn, delayMs) => {
      void schedule(fn, delayMs);
    },
  });

  // Outbound-only WSS push channel (contract §1); the poller keeps REST as the
  // safety net. readIdentity/heartbeatSample are hoisted function declarations —
  // the closures only fire at dial/heartbeat time, after construction.
  const channel: WssChannelLike =
    deps.env?.channelOverride ??
    createWssChannel({
      url: deriveWssUrl(deps.cloud.baseUrl),
      agentVersion: deps.agentVersion,
      getAuth: () => {
        const identity = readIdentity();
        return identity === null
          ? null
          : { deviceId: identity.deviceId, deviceToken: identity.deviceToken };
      },
      heartbeatSample: () => heartbeatSample(),
      log: (message) => {
        log.info(message);
      },
      now,
      schedule,
      random,
    });

  client = createPollingCloudClient({
    transport,
    secrets,
    agentVersion: deps.agentVersion,
    log: (message) => {
      log.info(message);
    },
    now,
    schedule,
    random,
    channel,
    ...(deps.cloud.pollIntervalMs !== undefined
      ? { pollIntervalMs: deps.cloud.pollIntervalMs }
      : {}),
    ...(deps.cloud.safetyPollIntervalMs !== undefined
      ? { safetyPollIntervalMs: deps.cloud.safetyPollIntervalMs }
      : {}),
    heartbeatSample: () => heartbeatSample(),
    onRevoked: () => {
      void wipeLocalState();
    },
  });

  let state: ConnectionState = client.state();
  client.on('state', (next) => {
    // Acks retained while offline drain the moment we are back online —
    // never wait out the buffer's delay timer after a reconnect.
    if (next === 'online' && state !== 'online') ackBuffer.flushNow();
    state = next;
  });

  // Validated + scope/-signature-checked by the poller — no re-validation here.
  client.on('job', (envelope) => {
    const job = envelope.job;
    engine.submit({
      jobId: job.job_id,
      idempotencyKey: job.idempotency_key,
      tenantId: job.tenant_id,
      restaurantId: job.restaurant_id,
      printerId: job.printer_id,
      priority: job.priority,
      copies: job.copies,
      docType: job.doc_type,
      docVersion: job.doc_version,
      expiresAt: Date.parse(job.expires_at),
      payload: job.payload,
    });
  });

  client.on('config', (config) => {
    applyConfig(config);
  });

  // ---- cloud config application (FR-16) ------------------------------------

  // Config applies are serialized: a poll batch can deliver config updates
  // back-to-back and start() fires a persisted apply + fetch concurrently.
  // wipeGeneration invalidates an in-flight apply's marker write so a config
  // landing mid-wipe cannot re-arm the guard after the reset (§3.5).
  let applyChain: Promise<void> = Promise.resolve();
  let wipeGeneration = 0;

  /** Reject-all semantics: nothing is applied unless every entry maps. */
  function applyConfig(config: ConfigUpdate): void {
    const generation = wipeGeneration;
    applyChain = applyChain
      .then(() => runApply(config, generation))
      .catch((err: unknown) => {
        log.error(`runtime: config v${String(config.config_version)} apply failed: ${describeErr(err)}`);
      });
  }

  async function runApply(config: ConfigUpdate, generation: number): Promise<void> {
    // A wiped/unpaired device must never apply config — a fetch that resolves
    // mid-wipe (or after) would otherwise re-arm state on an unpaired agent.
    // The generation check alone cannot close this: a config chained onto the
    // tail the wipe awaits carries the CURRENT generation, so it would pass.
    if (readIdentity() === null) return;
    const marker = deps.settings.get().appliedConfigVersion;
    if (config.config_version <= marker) return; // regression — ignore (§6)
    configStore.save(config); // record of latest known config, even if apply fails
    const mapped = mapCloudPrinters(config);
    if (!mapped.ok) {
      log.warn(`runtime: rejected config v${String(config.config_version)}: ${mapped.reason}`);
      return;
    }
    await printers.replaceCloud(mapped.printers);
    // A wipe that started mid-apply (config + revoke in one poll batch) must
    // not see the marker re-armed after its reset. If this set fails, the
    // store is unchanged (replaceCloud is atomic) and the marker stays old, so
    // start() re-applies this config.
    if (generation === wipeGeneration) {
      await deps.settings.set({ appliedConfigVersion: config.config_version });
    }
  }

  /** One-shot GET /config (initial fleet for a fresh pair, catch-up at
   *  launch). Failure is benign — poll/push deliver the config later. */
  function fetchConfigOnce(): void {
    client.refreshConfig().catch((err: unknown) => {
      log.warn(
        `runtime: initial config fetch failed (will arrive via poll/push): ${describeErr(err)}`,
      );
    });
  }

  // ---- lifecycle -----------------------------------------------------------

  let started = false;
  function start(): void {
    if (started) return;
    started = true;
    engine.recover(); // crash recovery BEFORE the first poll (architecture §5)
    // Pre-flight the identity read: the poller's start() calls secrets.load()
    // too, and CloudError('secure_storage_unavailable') (e.g. a DPAPI decrypt
    // failure after a Windows credential reset) would escape as an unhandled
    // rejection at every launch. readIdentity() owns the policy — present as
    // unpaired, never wipe — so the client only starts when the identity is
    // readable; any residual failure still degrades to unpaired, never crashes.
    try {
      if (readIdentity() !== null) {
        // Re-apply a config that was persisted but never successfully applied
        // (crash or transient failure window). The marker guard makes this a
        // no-op when the persisted config is already applied. The safeParse
        // guard is the honest runtime check: cloud_config is on-disk state,
        // and StoredCloudConfig (config-store) validates less than ConfigUpdate.
        const persisted = configStore.get();
        const validated = persisted !== null ? ConfigUpdateSchema.safeParse(persisted) : null;
        if (validated?.success) {
          applyConfig(validated.data);
        } else if (persisted !== null) {
          log.warn(
            'runtime: stored cloud config is unreadable — skipping; the next server push replaces it',
          );
        }
        client.start();
        fetchConfigOnce();
      }
    } catch (err) {
      log.error('runtime: cloud client start failed — presenting as unpaired', err);
    }
  }

  async function stop(): Promise<void> {
    if (!started) return;
    started = false;
    client.stop();
    await ackBuffer.stop(); // best-effort final flush; never blocks on a dead network
  }

  /** Shared by unpair and revocation (§3.5). Never throws to the caller. */
  async function wipeLocalState(): Promise<void> {
    // Invalidate any in-flight apply's marker write, then drain the chain so
    // the destructive file writes (writeAtomic) never race a concurrent writer.
    wipeGeneration += 1;
    await applyChain.catch(() => undefined); // never block the wipe on an apply's errors
    try {
      client.stop();
      secrets.clear();
      jobStore.clearJobs();
      await printers.clear();
      configStore.clear();
      await deps.settings.set({ pairedAt: null, appliedConfigVersion: -1 });
    } catch (err) {
      log.error(`runtime: local state wipe failed: ${describeErr(err)}`);
    }
  }

  // ---- pairing -------------------------------------------------------------

  function readIdentity(): IdentitySecrets | null {
    try {
      return secrets.load();
    } catch (err) {
      // secure_storage_unavailable means we cannot PROVE pairing state — do not
      // wipe (that would be irreversible on a mere decrypt hiccup); the
      // operator decides. Present as unpaired meanwhile.
      log.warn(`runtime: stored identity unreadable, presenting as unpaired: ${describeErr(err)}`);
      return null;
    }
  }

  function toAgentIdentity(
    id: { deviceId: string; restaurantId: string },
    pairedAt: string | null,
  ) {
    return {
      deviceId: id.deviceId,
      agentName: deviceName,
      restaurantId: id.restaurantId,
      // Display name arrives via the config stream later; the id is the honest placeholder.
      restaurantName: id.restaurantId,
      pairedAt,
    };
  }

  async function pair(code: string): Promise<PairResult> {
    if (readIdentity() !== null) {
      return { ok: false, reason: 'already_paired', message: 'This agent is already paired.' };
    }
    try {
      const identity = await client.pair({ pairingCode: code, deviceName });
      const pairedAt = new Date(now()).toISOString();
      await deps.settings.set({ pairedAt });
      fetchConfigOnce(); // fire-and-forget; the fleet also arrives via poll/push
      return { ok: true, identity: toAgentIdentity(identity, pairedAt) };
    } catch (err) {
      if (err instanceof CloudError) return mapPairFailure(err);
      throw err;
    }
  }

  async function unpair(): Promise<void> {
    await wipeLocalState();
    state = 'unpaired'; // the stopped client keeps its last state; the runtime reports the truth
  }

  // ---- snapshot ------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/require-await -- the interface promises a Promise; the body is intentionally sync
  async function snapshot(): Promise<AgentSnapshot> {
    const identity = readIdentity();
    const terminal = jobStore.listByStatus('completed', 'failed', 'ambiguous', 'rejected');
    const lastActivityAt =
      terminal.length === 0
        ? null
        : new Date(Math.max(...terminal.map((r) => r.updatedAt))).toISOString();
    return {
      version: deps.agentVersion,
      connection: state,
      connectionDetail: CONNECTION_DETAILS[state],
      identity:
        identity === null
          ? null
          : // pairedAt may legitimately be null (settings reset while the
            // identity survived) — report what is known, never fabricate.
            toAgentIdentity(identity, deps.settings.get().pairedAt),
      pendingJobs: engine.pendingCount(),
      ambiguousJobs: jobStore.countByStatus('ambiguous'),
      lastActivityAt,
    };
  }

  function agentInfo() {
    return { name: 'print-agent', version: deps.agentVersion, connectionState: state };
  }

  /** §3.2 in-cycle heartbeat facts; health stays 'unknown' until status
   *  polling lands (R-VAL-3). */
  function heartbeatSample(): HeartbeatSample {
    return {
      uptime_s: Math.floor(process.uptime()),
      queue_depth: engine.pendingCount(),
      connection: 'poll',
      printers: printers.list().map((p) => ({
        printer_id: p.printerId,
        health: 'unknown' as const,
      })),
    };
  }

  // ---- printers ------------------------------------------------------------

  const printersApi = {
    list(): readonly PrinterInfo[] {
      return printers.list().map(toPrinterInfo);
    },
    add(draft: unknown): Promise<PrinterInfo> {
      // The store re-validates with PrinterDraftSchema — unknown never reaches disk raw.
      return printers.add(draft as PrinterDraft).then(toPrinterInfo);
    },
    update(printerId: string, patch: unknown): Promise<PrinterInfo> {
      return printers.update(printerId, patch as Partial<PrinterDraft>).then(toPrinterInfo);
    },
    remove(printerId: string): Promise<boolean> {
      return printers.remove(printerId);
    },
    async testPrint(printerId: string): Promise<TestPrintResult> {
      const result = await printerService.testPrint(printerId);
      const at = new Date(now()).toISOString();
      return result.ok
        ? {
            ok: true,
            detail: `Test page handed to the printer/driver (${String(result.bytesWritten)} bytes).`,
            at,
          }
        : { ok: false, detail: `${result.code}: ${result.detail}`, at };
    },
  };

  // ---- jobs ----------------------------------------------------------------

  const jobRecords = (): JobRecord[] =>
    jobStore
      .listByStatus(...JOB_STATUSES)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 200)
      .map((row) => toJobRecord(row, (id) => printers.get(id)?.name ?? null));

  const jobsApi = {
    list(): readonly JobRecord[] {
      return jobRecords();
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- the interface promises a Promise; engine calls are sync
    async retry(jobId: string): Promise<JobRecord> {
      engine.retryJob(jobId); // JobEngineError propagates with a clean message
      const record = jobRecords().find((j) => j.jobId === jobId);
      if (record === undefined) throw new Error(`job record disappeared after retry: ${jobId}`);
      return record;
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- the interface promises a Promise; engine calls are sync
    async reprint(jobId: string): Promise<JobRecord> {
      const newId = engine.reprintJob(jobId);
      const record = jobRecords().find((j) => j.jobId === newId);
      if (record === undefined) throw new Error(`job record disappeared after reprint: ${newId}`);
      return record;
    },
  };

  // ---- diagnostics ---------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/require-await -- the interface promises a Promise; all probes here are sync
  async function report(): Promise<DiagnosticsReport> {
    let sizeBytes = 0;
    if (deps.paths.dbFile !== null) {
      try {
        sizeBytes = statSync(deps.paths.dbFile).size;
      } catch {
        sizeBytes = 0;
      }
    }
    return {
      version: deps.agentVersion,
      electronVersion:
        'electron' in process.versions ? process.versions.electron || 'unknown' : 'unknown',
      platform: `${type()} ${release()} ${process.arch}`,
      uptimeS: Math.floor(process.uptime()),
      db: {
        ok: true,
        sizeBytes,
        queueDepth: engine.pendingCount(),
        journalMode: String(deps.db.pragma('journal_mode', { simple: true })),
      },
    };
  }

  async function cloudApiCheck(): Promise<ConnectivityCheck> {
    const doFetch = deps.env?.fetchOverride ?? fetch;
    try {
      await doFetch(deps.cloud.baseUrl, { signal: AbortSignal.timeout(CLOUD_CHECK_TIMEOUT_MS) });
      return { id: 'cloud-api', label: 'Cloud API', status: 'pass', detail: 'TLS/HTTP reachable' };
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'AbortError' || name === 'TimeoutError') {
        return {
          id: 'cloud-api',
          label: 'Cloud API',
          status: 'warn',
          detail: `No response within ${String(CLOUD_CHECK_TIMEOUT_MS / 1000)} s`,
        };
      }
      return {
        id: 'cloud-api',
        label: 'Cloud API',
        status: 'fail',
        detail: 'Could not reach the server',
      };
    }
  }

  async function printersCheck(): Promise<ConnectivityCheck> {
    const list = printers.list();
    if (list.length === 0) {
      return {
        id: 'printers',
        label: 'Printers',
        status: 'pass',
        detail: 'No printers configured',
      };
    }
    const failedCodes: string[] = [];
    for (const printer of list) {
      try {
        const result = await printerService.testConnection(printer.printerId);
        if (!result.ok) failedCodes.push(result.code);
      } catch {
        failedCodes.push('internal_error'); // testConnection only throws on a programming error
      }
    }
    return failedCodes.length === 0
      ? {
          id: 'printers',
          label: 'Printers',
          status: 'pass',
          detail: `All ${String(list.length)} printer(s) reachable`,
        }
      : {
          id: 'printers',
          label: 'Printers',
          status: 'warn',
          detail: `${String(failedCodes.length)} of ${String(list.length)} printer(s) unreachable (${failedCodes.join(', ')})`,
        };
  }

  function dbCheck(): ConnectivityCheck {
    try {
      const result = deps.db.pragma('quick_check', { simple: true });
      return result === 'ok'
        ? { id: 'db', label: 'Local database', status: 'pass', detail: 'Integrity check passed' }
        : {
            id: 'db',
            label: 'Local database',
            status: 'fail',
            detail: `quick_check reported ${String(result)}`,
          };
    } catch (err) {
      return {
        id: 'db',
        label: 'Local database',
        status: 'fail',
        detail: `Integrity check could not run (${describeErr(err)})`,
      };
    }
  }

  const diagnosticsApi = {
    report,
    async checks(): Promise<readonly ConnectivityCheck[]> {
      // Best-effort by contract: a thrown check degrades to 'fail', never propagates.
      const checks: ConnectivityCheck[] = [];
      for (const check of [cloudApiCheck(), printersCheck(), Promise.resolve(dbCheck())]) {
        try {
          checks.push(await check);
        } catch (err) {
          checks.push({
            id: 'unknown',
            label: 'Check',
            status: 'fail',
            detail: `Check crashed: ${describeErr(err)}`,
          });
        }
      }
      return checks;
    },
    recentLogs(): readonly LogLine[] {
      return getRecentLogLines();
    },
  };

  return {
    start,
    stop,
    agentInfo,
    snapshot,
    pair,
    unpair,
    printers: printersApi,
    jobs: jobsApi,
    diagnostics: diagnosticsApi,
  };
}

function describeErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
