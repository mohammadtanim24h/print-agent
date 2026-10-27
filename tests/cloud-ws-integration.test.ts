import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createWssChannel } from '../src/main/cloud-client/ws-channel';

/** End-to-end over a real socket: §1 upgrade headers, frame delivery, 4401
 *  auth-failure routing. Loopback listener — tests only (ADR-2 governs the
 *  shipped app, which never listens). */

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

function startServer(
  handlers: {
    onConnection?: (ws: WebSocket, headers: IncomingHttpHeaders) => void;
  } = {},
): Promise<{ url: string }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    wss.on('connection', (ws, req) => {
      handlers.onConnection?.(ws, req.headers);
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
      resolve({ url: `ws://127.0.0.1:${String(addr.port)}/agent/v1/ws` });
    });
  });
}

describe('ws-channel over a real socket', () => {
  it('sends §1 headers on upgrade, delivers frames, and routes 4401 closes', async () => {
    const seenHeaders: IncomingHttpHeaders[] = [];
    const { url } = await startServer({
      onConnection: (ws, headers) => {
        seenHeaders.push(headers);
        ws.send('{"type":"ping"}');
        // Close with the contract's auth-failure code after the frame lands.
        setTimeout(() => {
          ws.close(4401, 'auth');
        }, 20);
      },
    });
    const channel = createWssChannel({
      url,
      agentVersion: '0.1.0-test',
      getAuth: () => ({ deviceId: '018f3c2e-0000-7000-8000-000000000003', deviceToken: 'tok' }),
      allowInsecureWs: true, // loopback test server has no TLS
      heartbeatIntervalMs: 3_600_000, // keep heartbeat out of this test
      pingIntervalMs: 3_600_000,
    });
    const messages: unknown[] = [];
    const authFailures = vi.fn();
    channel.on('message', (raw) => {
      messages.push(raw);
    });
    channel.on('auth-failed', authFailures);
    channel.start();
    await vi.waitFor(
      () => {
        expect(messages).toEqual([{ type: 'ping' }]);
      },
      { timeout: 2_000 },
    );
    expect(seenHeaders[0]?.['authorization']).toBe('Bearer tok');
    expect(seenHeaders[0]?.['x-agent-version']).toBe('0.1.0-test');
    expect(seenHeaders[0]?.['x-protocol-version']).toBe('1');
    await vi.waitFor(
      () => {
        expect(authFailures).toHaveBeenCalledOnce();
      },
      { timeout: 2_000 },
    );
    channel.stop();
  });

  it('drops an oversized frame at the transport cap without delivering it', async () => {
    const serverCloses: number[] = [];
    let conn: WebSocket | null = null;
    const { url } = await startServer({
      onConnection: (ws) => {
        conn = ws;
        ws.on('close', (code) => {
          serverCloses.push(code);
        });
      },
    });
    const channel = createWssChannel({
      url,
      agentVersion: '0.1.0-test',
      getAuth: () => ({ deviceId: '018f3c2e-0000-7000-8000-000000000003', deviceToken: 'tok' }),
      allowInsecureWs: true,
      heartbeatIntervalMs: 3_600_000,
      pingIntervalMs: 3_600_000,
    });
    const messages: unknown[] = [];
    channel.on('message', (raw) => {
      messages.push(raw);
    });
    channel.start();
    await vi.waitFor(
      () => {
        expect(channel.isConnected()).toBe(true);
      },
      { timeout: 2_000 },
    );
    const serverSend = (data: string | Buffer): void => {
      if (conn === null) throw new Error('server socket not connected');
      conn.send(data);
    };
    // A small frame first proves delivery works on this exact socket.
    serverSend('{"type":"before"}');
    await vi.waitFor(
      () => {
        expect(messages).toEqual([{ type: 'before' }]);
      },
      { timeout: 2_000 },
    );
    // One byte past the 1 MiB maxPayload the channel hands to the real ws client.
    serverSend(Buffer.alloc(1024 * 1024 + 1, 0x61));
    await vi.waitFor(
      () => {
        expect(channel.isConnected()).toBe(false);
      },
      { timeout: 2_000 },
    );
    expect(messages).toEqual([{ type: 'before' }]);
    channel.stop();
    // ws enforces maxPayload by closing the connection (1009), not silently
    // skipping the frame — the server observes the client's 1009 close frame.
    expect(serverCloses).toContain(1009);
  });
});
