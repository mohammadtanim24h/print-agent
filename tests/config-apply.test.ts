import { describe, expect, it } from 'vitest';
import { mapCloudPrinters } from '../src/main/printers/config-apply';
import { makeConfigUpdate, makePrinterConfig } from './helpers/cloud-config';

describe('mapCloudPrinters', () => {
  it('maps a §4 printer entry to a cloud-sourced local profile', () => {
    const result = mapCloudPrinters(makeConfigUpdate([makePrinterConfig()]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.printers).toHaveLength(1);
    const [p] = result.printers;
    if (p === undefined) return;
    expect(p.printerId).toBe('018f0000-0000-7000-8000-0000000000c1');
    expect(p.name).toBe('Kitchen-1');
    expect(p.source).toBe('cloud');
    expect(p.role).toBe('kitchen');
    expect(p.station).toBe('kitchen');
    // Physical defaults — DEFAULT_80MM_PROFILE values, never fabricated variants.
    expect(p.paperWidthMm).toBe(80);
    expect(p.printableDots).toBe(576);
    expect(p.charsPerLine).toBe(48);
    expect(p.capabilities).toEqual({
      cut: true, qrCode: true, barcode128: true, statusPolling: true,
    });
    expect(p.transport).toEqual({ kind: 'tcp_raw', host: '192.168.1.87', port: 9100 });
    // Cloud-only fields preserved for FR-14 / C1.
    expect(p.copiesDefault).toBe(1);
    expect(p.codepage).toBe('cp437');
    expect(p.cutDefault).toBe('partial');
    expect(p.duplicatePolicy).toBe('ask_operator');
    expect(p.statusPolling).toBe('auto');
  });

  it('maps station to role by exact match, else custom', () => {
    const result = mapCloudPrinters(
      makeConfigUpdate([
        makePrinterConfig({ printer_id: '018f0000-0000-7000-8000-0000000000c2', station: 'bar' }),
        makePrinterConfig({ printer_id: '018f0000-0000-7000-8000-0000000000c3', station: 'cashier' }),
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.printers.map((p) => p.role)).toEqual(['bar', 'custom']);
    expect(result.printers.map((p) => p.station)).toEqual(['bar', 'cashier']);
  });

  it('maps status_polling off to capabilities.statusPolling false', () => {
    const result = mapCloudPrinters(
      makeConfigUpdate([makePrinterConfig({ status_polling: 'off' })]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.printers[0]?.capabilities.statusPolling).toBe(false);
  });

  it('rejects a hostname host (no DNS in v1)', () => {
    const config = makeConfigUpdate([
      makePrinterConfig({ transport: { kind: 'tcp_raw', host: 'printer.example.com', port: 9100, connect_timeout_ms: 3000, write_timeout_ms: 5000 } }),
    ]);
    const result = mapCloudPrinters(config);
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.reason).toContain('IP');
    expect(result.reason).toContain('018f0000-0000-7000-8000-0000000000c1');
  });

  it('rejects loopback and multicast hosts (approved-endpoint policy)', () => {
    for (const host of ['127.0.0.1', '224.0.0.1', '::1', '0.0.0.0']) {
      const result = mapCloudPrinters(
        makeConfigUpdate([
          makePrinterConfig({ transport: { kind: 'tcp_raw', host, port: 9100, connect_timeout_ms: 3000, write_timeout_ms: 5000 } }),
        ]),
      );
      expect(result.ok).toBe(false);
    }
  });

  it('maps spooler_raw entries (windows_printer_name → windowsPrinterName)', () => {
    const result = mapCloudPrinters(
      makeConfigUpdate([
        makePrinterConfig({ transport: { kind: 'spooler_raw', windows_printer_name: 'EPSON TM-T20' } }),
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.printers[0]?.transport).toEqual({
      kind: 'spooler_raw',
      windowsPrinterName: 'EPSON TM-T20',
    });
    expect(result.printers[0]?.source).toBe('cloud');
  });

  it('accepts a mixed tcp_raw + spooler_raw config', () => {
    const result = mapCloudPrinters(
      makeConfigUpdate([
        makePrinterConfig(),
        makePrinterConfig({
          printer_id: '018f0000-0000-7000-8000-0000000000c2',
          transport: { kind: 'spooler_raw', windows_printer_name: 'Star TSP143' },
        }),
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.printers.map((p) => p.transport.kind)).toEqual(['tcp_raw', 'spooler_raw']);
  });

  it('rejects an empty windows_printer_name', () => {
    const result = mapCloudPrinters(
      makeConfigUpdate([
        makePrinterConfig({ transport: { kind: 'spooler_raw', windows_printer_name: '' } }),
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('windows_printer_name');
  });

  it('still rejects usb transports (not applicable in v1)', () => {
    const usb = mapCloudPrinters(
      makeConfigUpdate([makePrinterConfig({ transport: { kind: 'usb', vid: '04b8', pid: '0202' } })]),
    );
    expect(usb.ok).toBe(false);
    if (!usb.ok) expect(usb.reason).toContain('usb');
  });

  it('reject-all: any bad entry rejects the whole config', () => {
    const config = makeConfigUpdate([
      makePrinterConfig(),
      makePrinterConfig({ printer_id: '018f0000-0000-7000-8000-0000000000c4', transport: { kind: 'usb', vid: '04b8', pid: '0202' } }),
    ]);
    const result = mapCloudPrinters(config);
    expect(result.ok).toBe(false);
    // All-or-nothing: not even the valid entry is returned.
    if (!result.ok) expect(result.reason).toContain('018f0000-0000-7000-8000-0000000000c4');
  });

  it('rejects an empty name and duplicate printer_ids', () => {
    const emptyName = mapCloudPrinters(makeConfigUpdate([makePrinterConfig({ name: '' })]));
    expect(emptyName.ok).toBe(false);
    const dup = mapCloudPrinters(
      makeConfigUpdate([makePrinterConfig(), makePrinterConfig()]),
    );
    expect(dup.ok).toBe(false);
    if (!emptyName.ok) expect(emptyName.reason).toContain('empty name');
    if (!dup.ok) expect(dup.reason).toContain('duplicate printer_id');
  });

  it('accepts an empty printers array (config that removes the whole fleet)', () => {
    const result = mapCloudPrinters(makeConfigUpdate([]));
    expect(result).toEqual({ ok: true, printers: [] });
  });

  it('does not mutate its inputs (purity)', () => {
    const pc = makePrinterConfig();
    const config = makeConfigUpdate([pc]);
    const snapshot = JSON.stringify(config);
    mapCloudPrinters(config);
    expect(JSON.stringify(config)).toBe(snapshot);
  });
});
