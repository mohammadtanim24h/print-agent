import { describe, expect, it, vi } from 'vitest';
import { createNativeSpoolerBridge } from '../src/main/transport/spooler-native';
import type { NativeSpooler } from 'print-agent-spooler-raw';

function stubNative(overrides: Partial<NativeSpooler> = {}): NativeSpooler {
  return {
    printerExists: vi.fn(() => true),
    writeRaw: vi.fn(() => Promise.resolve()),
    enumeratePrinters: vi.fn(() => ['EPSON TM-T20']),
    ...overrides,
  };
}

describe('native spooler bridge adapter', () => {
  it('passes enumerate through', async () => {
    const bridge = createNativeSpoolerBridge(() => stubNative());
    await expect(bridge.enumerate()).resolves.toEqual(['EPSON TM-T20']);
  });

  it('passes a successful writeRaw through', async () => {
    const writeRaw = vi.fn(() => Promise.resolve());
    const bridge = createNativeSpoolerBridge(() => stubNative({ writeRaw }));
    const bytes = new Uint8Array([0x1b, 0x40]);
    await expect(bridge.writeRaw('EPSON TM-T20', bytes)).resolves.toBeUndefined();
    expect(writeRaw).toHaveBeenCalledWith('EPSON TM-T20', bytes);
  });

  it('maps a native write rejection to write_failed with the Windows message', async () => {
    const native = stubNative({
      writeRaw: vi.fn(() =>
        Promise.reject(new Error('StartDocPrinterW failed (Windows error 1802)')),
      ),
    });
    const bridge = createNativeSpoolerBridge(() => native);
    await expect(bridge.writeRaw('EPSON TM-T20', new Uint8Array([0x0a]))).rejects.toMatchObject({
      code: 'write_failed',
      message: expect.stringContaining('Windows error 1802'),
    });
  });

  it('maps a synchronous native failure (printerExists throw) to write_failed', async () => {
    const native = stubNative({
      printerExists: vi.fn(() => {
        throw new Error('OpenPrinterW failed (Windows error 5)');
      }),
    });
    const bridge = createNativeSpoolerBridge(() => native);
    await expect(bridge.printerExists('EPSON TM-T20')).rejects.toMatchObject({
      code: 'write_failed',
      message: expect.stringContaining('Windows error 5'),
    });
  });

  it('lets a clean not-found result pass through as false (no error)', async () => {
    const bridge = createNativeSpoolerBridge(() => stubNative({ printerExists: () => false }));
    await expect(bridge.printerExists('Ghost')).resolves.toBe(false);
  });

  it('wraps a loader failure as write_failed (addon missing/broken)', async () => {
    const bridge = createNativeSpoolerBridge(() => {
      throw new Error('not built');
    });
    await expect(bridge.writeRaw('P', new Uint8Array([0x0a]))).rejects.toMatchObject({
      code: 'write_failed',
    });
    await expect(bridge.printerExists('P')).rejects.toMatchObject({ code: 'write_failed' });
  });
});
