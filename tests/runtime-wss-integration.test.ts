import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';
import {
  PAIRING_CODE,
  makeCloudConfig,
  makeCloudPrinterConfig,
  makeRuntime,
  makeUuid,
  signedJobEnvelope,
} from './helpers/runtime-harness';

/**
 * Full-stack §1 check with the runtime flag ON (A3 revival): pairing dials a
 * loopback WSS server, a pushed signed envelope flows through the SAME funnel
 * as poll batches (scope check → sig verify → intake), acks drain over REST,
 * and the channel's own §3.2 heartbeat (connection:"wss") is seen server-side.
 * Protocol-level legs (4401 routing, refresh redial, frame caps) are covered
 * in cloud-ws-channel.test.ts / cloud-poller.test.ts / cloud-ws-integration.test.ts.
 * Loopback listener — tests only (ADR-2 governs the shipped app, which never listens).
 */

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

function startServer(): Promise<{
  httpBaseUrl: string;
  connections: WebSocket[];
  headers: IncomingHttpHeaders[];
  frames: unknown[];
}> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const connections: WebSocket[] = [];
    const headers: IncomingHttpHeaders[] = [];
    const frames: unknown[] = [];
    wss.on('connection', (ws, req) => {
      connections.push(ws);
      headers.push(req.headers);
      ws.on('message', (data) => {
        // RawData is Buffer | ArrayBuffer | Buffer[]; normalize to Buffer first.
        const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(new Uint8Array(data));
        frames.push(JSON.parse(buf.toString('utf8')));
      });
    });
    wss.on('listening', () => {
      const addr = wss.address() as AddressInfo;
      servers.push({
        close: () =>
          new Promise<void>((resolveClose) => {
            wss.close(() => {
              resolveClose();
            });
          }),
      });
      resolve({
        httpBaseUrl: `http://127.0.0.1:${String(addr.port)}`,
        connections,
        headers,
        frames,
      });
    });
  });
}

describe('AgentRuntime §1 push channel over a real socket (A3 revival)', () => {
  it('pairs, dials, renders a pushed job, drains acks over REST, and heartbeats over wss', async () => {
    const server = await startServer();
    const { runtime, transport } = await makeRuntime({
      cloud: {
        baseUrl: server.httpBaseUrl,
        allowInsecureHttp: true,
        pollIntervalMs: 20,
        wss: { enabled: true },
      },
    });
    transport.configResponse = makeCloudConfig(1, [makeCloudPrinterConfig(1)]);
    runtime.start();
    await runtime.pair(PAIRING_CODE);

    await vi.waitFor(() => {
      expect(server.headers.length).toBe(1);
    });
    expect(server.headers[0]?.['authorization']).toBe('Bearer device-token-test');
    expect(server.headers[0]?.['x-device-id']).toBe(makeUuid(3));
    expect(server.headers[0]?.['x-protocol-version']).toBe('1');

    // The pair-time REST config fetch applied the fleet → intake accepts its jobs.
    await vi.waitFor(() => {
      expect(runtime.printers.list()).toHaveLength(1);
    });
    const printerId = runtime.printers.list()[0]?.config.printerId ?? '';

    server.connections[0]?.send(JSON.stringify(signedJobEnvelope(printerId)));
    await vi.waitFor(() => {
      const statuses = transport.acks.flatMap((b) => b.acks.map((a) => a.status));
      expect(statuses).toContain('accepted');
      // Stub transport hand-off succeeds: 'completed' = hand-off, never 'printed' (§3.1).
      expect(statuses).toContain('completed');
      expect(statuses).not.toContain('rejected');
    });

    // The channel's §3.2 heartbeat (connection forced to 'wss') reaches the server.
    await vi.waitFor(() => {
      const beat = server.frames.find((f) => (f as { type?: string }).type === 'heartbeat');
      expect(beat).toMatchObject({ type: 'heartbeat', connection: 'wss' });
    });
    await runtime.stop();
  });
});
