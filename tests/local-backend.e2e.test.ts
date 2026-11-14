import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, openDatabase, type SqliteDatabase } from '../src/main/local-store/db';
import { migrate } from '../src/main/local-store/migrations';
import { createSettingsStore, type SettingsStore } from '../src/main/services/settings';
import { createNodeSettingsAdapter } from '../src/main/services/settings-fs';
import { createAgentRuntime, type AgentRuntime } from '../src/main/agent-runtime';
import type { SafeStorageLike } from '../src/main/cloud-client/secret-store';
import { ConfigUpdateSchema } from '../src/main/cloud-client/schemas';
import { generateDeviceKeyPair } from '../src/main/cloud-client/envelope-sig';
import { isApprovedEndpointHost } from '../src/main/printers/profile';
import { startVirtualPrinter, type VirtualPrinter } from './helpers/virtual-printer';

/**
 * LIVE end-to-end smoke against a real Laravel backend (servepro-api) — the
 * B2 "functional staging pass" rehearsal, but runnable against a dev machine's
 * `php artisan serve`. Skipped entirely in CI; opt in with:
 *
 *   E2E_BACKEND_URL=http://localhost:8000 \
 *   E2E_PAIRING_CODE=XXXXXXXX \
 *   pnpm exec vitest run tests/local-backend.e2e.test.ts
 *
 * Consumes the pairing code (single-use) and counts toward the pair rate
 * limit (3 attempts / 15 min per IP). Uses the REAL http transport, kv file,
 * printer store, job store and tcp_raw transport; only safeStorage is a
 * passthrough stub (DPAPI is Electron-only), which keeps the identity kv
 * readable so the raw contract checks below can reuse the device token.
 */

const BACKEND_URL = process.env['E2E_BACKEND_URL'];
const PAIRING_CODE = process.env['E2E_PAIRING_CODE'];
const AGENT_API = `${(BACKEND_URL ?? '').replace(/\/+$/, '')}/api/agent/v1`;

const d = BACKEND_URL !== undefined && PAIRING_CODE !== undefined ? describe : describe.skip;

function passthroughSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(plain, 'utf8'),
    decryptString: (buf) => buf.toString('utf8'),
  };
}

function log(message: string): void {
  // eslint-disable-next-line no-console -- this file exists to produce evidence
  console.log(`[e2e] ${message}`);
}

/** Read the identity record back out of the kv file (passthrough safeStorage). */
async function readIdentity(kvFile: string): Promise<{ deviceToken: string; deviceId: string }> {
  const raw = JSON.parse(await readFile(kvFile, 'utf8')) as Record<string, string>;
  const blob = raw['cloud.identity'];
  if (blob === undefined) throw new Error('no cloud.identity in kv file');
  return JSON.parse(Buffer.from(blob, 'base64').toString('utf8')) as {
    deviceToken: string;
    deviceId: string;
  };
}

function lanIpv4(): string {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal && isApprovedEndpointHost(iface.address)) {
        return iface.address;
      }
    }
  }
  throw new Error('no approved LAN IPv4 interface found');
}

function agentHeaders(token: string, deviceId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'X-Device-Id': deviceId,
    'X-Agent-Version': '0.1.1-e2e',
    'X-Protocol-Version': '1',
  };
}

let dir: string;
let runtime: AgentRuntime;
let db: SqliteDatabase;
let settings: SettingsStore;
let printer: VirtualPrinter;
let cloudPrinterId: string | undefined;
let cloudCapture: VirtualPrinter | undefined;

d('live backend E2E', () => {
  it('sets up the runtime and capture printer', async () => {
    dir = await mkdtemp(join(tmpdir(), 'print-agent-e2e-'));
    const host = lanIpv4();
    printer = await startVirtualPrinter(host);
    log(`capture printer on ${host}:${printer.port}`);

    db = openDatabase({ file: join(dir, 'agent.db') });
    migrate(db);
    settings = await createSettingsStore({
      filePath: join(dir, 'settings.json'),
      adapter: createNodeSettingsAdapter(),
      report: () => {},
    });

    const result = await createAgentRuntime({
      db,
      settings,
      paths: {
        dbFile: join(dir, 'agent.db'),
        identityKvFile: join(dir, 'identity-kv.json'),
        printersFile: join(dir, 'printers.json'),
      },
      log: { debug: log, info: log, warn: log, error: log },
      agentVersion: '0.1.1-e2e',
      deviceName: 'E2E-DEV',
      safeStorage: passthroughSafeStorage(),
      cloud: {
        baseUrl: `${BACKEND_URL as string}/api/agent/v1`,
        allowInsecureHttp: true,
        // The mock backend has no WS endpoint — WSS is default-on since
        // 2026-11-14, so opt out to keep this a REST-flow E2E.
        wss: { enabled: false },
      },
    });
    runtime = result;
  }, 30_000);

  it('pairs with the dashboard code', async () => {
    const result = await runtime.pair(PAIRING_CODE as string);
    // Log before asserting so a failure still shows the server's identity payload.
    log(`pair result: ${JSON.stringify(result.ok ? result.identity : result)}`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.deviceId).toMatch(/[0-9a-f-]{36}/i);
    }
  }, 30_000);

  it('rejects a reused pairing code server-side', async () => {
    const keyPair = generateDeviceKeyPair();
    const res = await fetch(`${AGENT_API}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairing_code: PAIRING_CODE,
        device_pubkey: keyPair.publicKeyRaw,
        device_name: 'E2E-REPLAY',
        agent_version: '0.1.1-e2e',
      }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const text = await res.text();
    let code: string | undefined;
    try {
      code = (JSON.parse(text) as { error?: { code?: string } }).error?.code;
    } catch {
      // HTML body = the pair rate limiter's 429 page (backend finding: not the
      // contract's JSON envelope). Single-use was already proven on a run that
      // stayed under the limiter — tolerate this on rapid reruns.
      log(`reused code → ${res.status} non-JSON body (rate limiter page)`);
      return;
    }
    log(`reused code → ${res.status} ${JSON.stringify(code)}`);
    expect(code).toBeDefined();
  }, 30_000);

  it('reaches connectionState online (poll + heartbeat cycle)', async () => {
    runtime.start();
    const deadline = Date.now() + 20_000;
    while (runtime.agentInfo().connectionState !== 'online') {
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    log(`connectionState: ${runtime.agentInfo().connectionState}`);
    expect(runtime.agentInfo().connectionState).toBe('online');
  }, 30_000);

  it('GET /config validates against the agent strict schema', async () => {
    const identity = await readIdentity(join(dir, 'identity-kv.json'));
    const res = await fetch(`${AGENT_API}/config`, {
      headers: agentHeaders(identity.deviceToken, identity.deviceId),
    });
    log(`GET /config → ${res.status}`);
    expect(res.status).toBe(200);
    const parsed = ConfigUpdateSchema.safeParse(await res.json());
    if (!parsed.success) {
      log(`config schema mismatch: ${JSON.stringify(parsed.error.issues)}`);
    }
    expect(parsed.success).toBe(true);
  }, 30_000);

  it('adds a local tcp_raw printer and completes a test print', async () => {
    const host = lanIpv4();
    const info = await runtime.printers.add({
      name: 'E2E-Emulator',
      role: 'receipt',
      paperWidthMm: 80,
      printableDots: 576,
      charsPerLine: 42,
      capabilities: { cut: true, qrCode: true, barcode128: true, statusPolling: false },
      transport: { kind: 'tcp_raw', host, port: printer.port },
    });
    log(`local printer ${info.config.printerId}`);
    const result = await runtime.printers.testPrint(info.config.printerId);
    log(`testPrint: ${result.detail}`);
    expect(result.ok).toBe(true);
    const bytes = await Promise.race([
      printer.received,
      new Promise<Uint8Array>((resolve) => setTimeout(() => resolve(new Uint8Array(0)), 5_000)),
    ]);
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes[0]).toBe(0x1b);
    expect(bytes[1]).toBe(0x40); // ESC @ — ESC/POS init
    log(`captured ${bytes.length} bytes of ESC/POS`);
  }, 30_000);

  // ---- job delivery (needs dashboard credentials) --------------------------
  // E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD enable the full POS → agent → ack leg:
  // create a cloud tcp_raw printer pointed at a capture server, wait for the
  // config stream to apply it, enqueue a print job for an existing order, and
  // wait for the backend to reach `completed` (which only an agent ack drives).

  const ADMIN_EMAIL = process.env['E2E_ADMIN_EMAIL'];
  const ADMIN_PASSWORD = process.env['E2E_ADMIN_PASSWORD'];
  const da = ADMIN_EMAIL !== undefined && ADMIN_PASSWORD !== undefined ? it : it.skip;
  const adminApi = () => `${(BACKEND_URL as string).replace(/\/+$/, '')}/api`;

  async function adminLogin(): Promise<string> {
    const res = await fetch(`${adminApi()}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        device_name: 'e2e-admin',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { token: string } };
    return body.data.token;
  }

  async function until<T>(
    what: string,
    timeoutMs: number,
    probe: () => Promise<T | undefined>,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await probe();
      if (value !== undefined) return value;
      if (Date.now() > deadline) {
        // Evidence dump: the agent's own view when a wait fails.
        log(`agent jobs at timeout: ${JSON.stringify(runtime.jobs.list())}`);
        log(
          `agent recent logs: ${JSON.stringify(
            runtime.diagnostics
              .recentLogs()
              .slice(-15)
              .map((l) => `${l.level} ${l.message}`),
          )}`,
        );
        throw new Error(`timed out waiting for ${what}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  da(
    'job delivery: registers a cloud printer and waits for config apply',
    async () => {
      const token = await adminLogin();
      cloudCapture = await startVirtualPrinter(lanIpv4());
      const res = await fetch(`${adminApi()}/printers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'E2E-Cloud-Capture',
          station: 'kitchen',
          transport_kind: 'tcp_raw',
          transport: {
            kind: 'tcp_raw',
            host: lanIpv4(),
            port: cloudCapture.port,
            connect_timeout_ms: 3000,
            write_timeout_ms: 5000,
          },
          copies_default: 1,
          codepage: 'cp437',
          cut_default: 'partial',
          duplicate_policy: 'never',
        }),
      });
      const body = (await res.json()) as { data?: { id?: string } };
      log(`printer create → ${res.status} ${JSON.stringify(body)}`);
      expect(res.status).toBe(201);
      cloudPrinterId = body.data?.id;
      expect(cloudPrinterId).toBeDefined();

      // Evidence: dump exactly what the agent's next GET /config will see. If any
      // row violates the agent's approved-destination policy (hostname, loopback),
      // the WHOLE config_update is rejected atomically — including our new printer.
      const identity = await readIdentity(join(dir, 'identity-kv.json'));
      const cfgRes = await fetch(`${AGENT_API}/config`, {
        headers: agentHeaders(identity.deviceToken, identity.deviceId),
      });
      const cfg = (await cfgRes.json()) as {
        config_version?: number;
        printers?: Array<{
          printer_id: string;
          name: string;
          transport: { kind: string; host?: string };
        }>;
      };
      log(
        `config v${String(cfg.config_version)} printers: ${JSON.stringify(
          cfg.printers?.map((p) => ({
            id: p.printer_id,
            name: p.name,
            kind: p.transport.kind,
            host: p.transport.host,
          })),
        )}`,
      );

      // Config stream: the agent's 60 s periodic refresh must pick up the new
      // printer (config_version bump); allow two refresh intervals + margin.
      await until('cloud printer in agent printer store', 150_000, async () => {
        const list = runtime.printers.list();
        const found = list.find((p) => p.config.printerId === cloudPrinterId);
        if (found === undefined) {
          log(`waiting; agent printers: ${JSON.stringify(list.map((p) => p.config.printerId))}`);
          return undefined;
        }
        log(`cloud printer applied, source=${found.config.source}`);
        return found;
      });
    },
    60_000,
  );

  da(
    'job delivery: enqueues a POS print job and observes completed + captured bytes',
    async () => {
      const token = await adminLogin();
      const ordersRes = await fetch(`${adminApi()}/orders?status=completed`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (ordersRes.status !== 200) {
        log(`orders list → ${ordersRes.status}: ${await ordersRes.text()}`);
      }
      expect(ordersRes.status).toBe(200);
      const ordersBody = (await ordersRes.json()) as { data: unknown };
      const ordersRaw = Array.isArray(ordersBody.data)
        ? ordersBody.data
        : (ordersBody.data as { data?: Array<{ id: string | number }> }).data;
      const orderId = (ordersRaw as Array<{ id: string | number }> | undefined)?.[0]?.id;
      if (orderId === undefined) {
        throw new Error('no existing order to attach a print job to — seed one order and rerun');
      }
      log(`using order ${String(orderId)}`);

      const jobRes = await fetch(`${adminApi()}/print-jobs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order_id: orderId,
          printer_id: cloudPrinterId,
          doc_type: 'customer_receipt',
          idempotency_key: `e2e-${Date.now()}`,
        }),
      });
      const jobBody = (await jobRes.json()) as { data?: { id?: string; status?: string } };
      log(`job create → ${jobRes.status} ${JSON.stringify(jobBody)}`);
      expect(jobRes.status).toBe(201);
      const jobId = jobBody.data?.id;
      expect(jobId).toBeDefined();

      // completed is only reachable via the agent's ack chain (§7 note 2).
      const finalStatus = await until('backend job completed', 45_000, async () => {
        const res = await fetch(`${adminApi()}/print-jobs/show/${String(jobId)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.status !== 200) return undefined;
        const body = (await res.json()) as { data?: { status?: string } };
        const status = body.data?.status;
        if (status === 'completed' || status === 'failed' || status === 'outcome_unknown') {
          return status;
        }
        return undefined;
      });
      log(`backend job status: ${String(finalStatus)}`);
      expect(finalStatus).toBe('completed');

      const local = runtime.jobs.list().find((j) => j.jobId === jobId);
      log(`agent job record: ${JSON.stringify(local)}`);
      expect(local?.status).toBe('completed');

      const bytes = await Promise.race([
        (cloudCapture as VirtualPrinter).received,
        new Promise<Uint8Array>((resolve) => setTimeout(() => resolve(new Uint8Array(0)), 5_000)),
      ]);
      expect(bytes.length).toBeGreaterThan(0);
      log(`captured ${bytes.length} bytes for job ${String(jobId)}`);
    },
    90_000,
  );

  it('cleans up', async () => {
    // Remove this run's cloud printer so reruns don't accumulate orphans
    // pointing at dead capture ports (each orphan also churns config_version).
    if (cloudPrinterId !== undefined) {
      try {
        const token = await adminLogin();
        await fetch(`${adminApi()}/printers/destroy/${cloudPrinterId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
        log(`destroyed cloud printer ${cloudPrinterId}`);
      } catch (err) {
        log(`printer cleanup failed: ${String(err)}`);
      }
    }
    await runtime.stop();
    await printer.close();
    if (cloudCapture !== undefined) await cloudCapture.close();
    closeDatabase(db);
    await rm(dir, { recursive: true, force: true });
  }, 30_000);
});
