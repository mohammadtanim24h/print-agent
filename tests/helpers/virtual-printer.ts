import net from 'node:net';

/**
 * Test-only virtual ESC/POS printer: an ephemeral loopback TCP listener that
 * silently collects a print stream (port 9100 semantics: plain socket, no
 * protocol). Binds 127.0.0.1:0 — never shipped, never port 9100.
 */
export interface VirtualPrinter {
  port: number;
  /** Resolves with everything received once the client half-closes. */
  received: Promise<Uint8Array>;
  close(): Promise<void>;
}

export function startVirtualPrinter(): Promise<VirtualPrinter> {
  const chunks: Buffer[] = [];
  let resolve!: (bytes: Uint8Array) => void;
  const received = new Promise<Uint8Array>((res) => {
    resolve = res;
  });
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      chunks.push(chunk);
    });
    const finish = () => {
      resolve(Uint8Array.from(Buffer.concat(chunks)));
    };
    socket.on('end', finish);
    socket.on('close', finish);
  });
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolveServer({
        port,
        received,
        close: () =>
          new Promise((res) => {
            server.close(() => {
              res();
            });
          }),
      });
    });
  });
}
