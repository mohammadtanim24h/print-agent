import { isIP } from 'node:net';
import { DEFAULT_80MM_PROFILE } from '../render/profile';
import type { ConfigUpdate, PrinterConfig } from '../cloud-client/schemas';
import { isApprovedEndpointHost, type PrinterProfile } from './profile';

/**
 * FR-16 mapping: contract §4 `PrinterConfig` → local `PrinterProfile`.
 * Pure: no I/O, no timers, inputs never mutated. All-or-nothing — any
 * unmappable entry rejects the whole config (api-contract §4 "applies
 * atomically", §6 "invalid transport address rejected").
 *
 * v1 applies tcp_raw (IP-literal hosts only — no DNS surface) and
 * spooler_raw (ADR-4 shim). usb remains v1.1 and rejects the whole config.
 */

export type ConfigApplyResult =
  | { readonly ok: true; readonly printers: PrinterProfile[] }
  | { readonly ok: false; readonly reason: string };

function roleFromStation(station: string): 'kitchen' | 'receipt' | 'bar' | 'custom' {
  return station === 'kitchen' || station === 'receipt' || station === 'bar'
    ? station
    : 'custom';
}

function toProfile(pc: PrinterConfig): PrinterProfile | { readonly error: string } {
  if (pc.name === '') return { error: `printer ${pc.printer_id}: empty name` };
  if (pc.transport.kind === 'usb') {
    return {
      error: `printer ${pc.printer_id}: transport usb not applicable in v1 (tcp_raw/spooler_raw only)`,
    };
  }
  let transport: PrinterProfile['transport'];
  if (pc.transport.kind === 'tcp_raw') {
    if (isIP(pc.transport.host) === 0) {
      return { error: `printer ${pc.printer_id}: host must be an IP literal (no DNS in v1)` };
    }
    if (!isApprovedEndpointHost(pc.transport.host)) {
      return {
        error: `printer ${pc.printer_id}: host is loopback, multicast or otherwise not approved`,
      };
    }
    transport = { kind: 'tcp_raw', host: pc.transport.host, port: pc.transport.port };
  } else {
    if (pc.transport.windows_printer_name === '') {
      return { error: `printer ${pc.printer_id}: empty windows_printer_name` };
    }
    transport = { kind: 'spooler_raw', windowsPrinterName: pc.transport.windows_printer_name };
  }
  return {
    printerId: pc.printer_id,
    name: pc.name,
    role: roleFromStation(pc.station),
    // Physical values: the renderer's existing 80mm fallback (render/profile.ts).
    // The cloud does not send physical fields — FR-16 contract extension is out of scope.
    paperWidthMm: DEFAULT_80MM_PROFILE.paperWidthMm,
    printableDots: DEFAULT_80MM_PROFILE.printableDots,
    charsPerLine: DEFAULT_80MM_PROFILE.charsPerLine,
    capabilities: {
      cut: true,
      qrCode: true,
      barcode128: true,
      statusPolling: pc.status_polling === 'auto',
      cashDrawer: false,
    },
    transport,
    station: pc.station,
    copiesDefault: pc.copies_default,
    codepage: pc.codepage,
    cutDefault: pc.cut_default,
    duplicatePolicy: pc.duplicate_policy,
    statusPolling: pc.status_polling,
    source: 'cloud',
  };
}

export function mapCloudPrinters(config: ConfigUpdate): ConfigApplyResult {
  const printers: PrinterProfile[] = [];
  const seen = new Set<string>();
  for (const pc of config.printers) {
    const mapped = toProfile(pc);
    if ('error' in mapped) return { ok: false, reason: mapped.error };
    if (seen.has(mapped.printerId)) {
      return { ok: false, reason: `duplicate printer_id in config: ${mapped.printerId}` };
    }
    seen.add(mapped.printerId);
    printers.push(mapped);
  }
  return { ok: true, printers };
}
