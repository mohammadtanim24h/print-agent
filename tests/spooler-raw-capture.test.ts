import { readFile, rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createNativeSpoolerBridge } from '../src/main/transport/spooler-native';

/**
 * ADR-10 file-port capture: the REAL native shim writes through the Windows
 * spooler to a redirected file port; the captured file must equal the written
 * bytes exactly. Skips silently wherever the capture printer is not installed
 * (CI, contributor machines) — set it up once per validation machine with
 * scripts/setup-capture-printer.ps1. Hardware pass/fail stays R-VAL-4 (B1).
 */
const CAPTURE_PRINTER = process.env['PRINT_AGENT_CAPTURE_PRINTER'] ?? 'PrintAgentCapture';
const CAPTURE_FILE =
  process.env['PRINT_AGENT_CAPTURE_FILE'] ?? 'C:\\print-agent-capture\\capture.prn';

const bridge = createNativeSpoolerBridge();

describe('spooler-raw file-port capture (opt-in, ADR-10)', () => {
  let installed = false;
  beforeAll(async () => {
    installed = await bridge.printerExists(CAPTURE_PRINTER);
  });

  afterAll(() => {
    rm(CAPTURE_FILE, { force: true }).catch(() => {});
  });

  it('delivers byte-exact RAW output through the Windows spooler', async (ctx) => {
    if (!installed) ctx.skip(); // capture printer not installed on this machine
    await rm(CAPTURE_FILE, { force: true }).catch(() => {});

    // Deterministic pattern exercising init, text, and cut-style commands.
    const payload = Buffer.concat([
      Buffer.from([0x1b, 0x40]), // ESC @ init
      Buffer.from('print-agent capture\n', 'ascii'),
      Buffer.from([0x1d, 0x56, 0x01]), // GS V full cut
    ]);
    await bridge.writeRaw(CAPTURE_PRINTER, new Uint8Array(payload));

    // The spooler flushes asynchronously; poll for the file with the payload.
    const captured = await vi.waitFor(
      async () => {
        const data = await readFile(CAPTURE_FILE);
        // File ports may append across jobs — compare the tail.
        const tail = data.subarray(data.length - payload.length);
        expect(tail.equals(payload)).toBe(true);
        return data;
      },
      { timeout: 10_000, interval: 250 },
    );
    expect(captured.length).toBeGreaterThanOrEqual(payload.length);
  });

  it('reports a missing capture printer as printer_not_found through the transport', async (ctx) => {
    if (installed) ctx.skip(); // only meaningful without the capture printer
    const { createSpoolerRawTransport } = await import('../src/main/transport/spooler-raw');
    const transport = createSpoolerRawTransport({ printerName: CAPTURE_PRINTER, bridge });
    await expect(transport.healthCheck()).rejects.toMatchObject({ code: 'printer_not_found' });
  });
});
