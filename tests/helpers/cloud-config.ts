import type { ConfigUpdate, PrinterConfig } from '../../src/main/cloud-client/schemas';

/** A contract §4 printer entry that maps cleanly to a local profile. */
export function makePrinterConfig(overrides: Partial<PrinterConfig> = {}): PrinterConfig {
  return {
    printer_id: '018f0000-0000-7000-8000-0000000000c1',
    name: 'Kitchen-1',
    transport: { kind: 'tcp_raw', host: '192.168.1.87', port: 9100, connect_timeout_ms: 3000, write_timeout_ms: 5000 },
    station: 'kitchen',
    copies_default: 1,
    codepage: 'cp437',
    cut_default: 'partial',
    duplicate_policy: 'ask_operator',
    status_polling: 'auto',
    ...overrides,
  };
}

export function makeConfigUpdate(
  printers: PrinterConfig[],
  configVersion = 1,
): ConfigUpdate {
  return { type: 'config_update', config_version: configVersion, printers };
}
