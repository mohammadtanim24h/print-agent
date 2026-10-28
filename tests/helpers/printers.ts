import type { PrinterDraft, PrinterProfile } from '../../src/main/printers/profile';

export function makeDraft(overrides: Partial<PrinterDraft> = {}): PrinterDraft {
  return {
    name: 'Kitchen',
    role: 'kitchen',
    paperWidthMm: 80,
    printableDots: 576,
    charsPerLine: 48,
    capabilities: {
      cut: true,
      qrCode: false,
      barcode128: false,
      statusPolling: false,
      cashDrawer: false,
    },
    transport: { kind: 'tcp_raw', host: '192.168.1.50', port: 9100 },
    ...overrides,
  };
}

export function makeProfile(overrides: Partial<PrinterProfile> = {}): PrinterProfile {
  return {
    ...makeDraft(),
    printerId: '018f0000-0000-7000-8000-000000000001',
    source: 'local',
    ...overrides,
  };
}
