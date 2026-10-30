import { describe, expect, it } from 'vitest';
import {
  isApprovedEndpointHost,
  PrinterDraftSchema,
  PrinterProfileSchema,
} from '../src/main/printers/profile';
import { makeDraft, makeProfile } from './helpers/printers';

describe('approved endpoint host policy', () => {
  it.each([
    ['192.168.1.50', true],
    ['10.0.0.7', true],
    ['172.16.0.9', true],
    ['fd12:3456::1', true],
    ['127.0.0.1', false],
    ['0.0.0.0', false],
    ['224.0.0.1', false],
    ['240.0.0.1', false],
    ['255.255.255.255', false],
    ['::', false],
    ['::1', false],
    ['ff02::1', false],
    ['printer.local', false],
    ['example.com', false],
    ['', false],
    ['::1%eth0', false],
    ['::%1', false],
    ['0:0:0:0:0:0:0:1', false],
    ['::ffff:127.0.0.1', false],
    ['::ffff:7f00:1', false],
    ['::127.0.0.1', false],
    ['fe80::1', true],
    ['2001:db8::1', true],
  ])('%s → %s', (host, approved) => {
    expect(isApprovedEndpointHost(host)).toBe(approved);
  });
});

describe('printer profile schema', () => {
  it('accepts a valid 80mm profile', () => {
    expect(() => PrinterProfileSchema.parse(makeProfile())).not.toThrow();
  });

  it('accepts a 58mm profile with narrower per-printer values', () => {
    const profile = PrinterProfileSchema.parse(
      makeProfile({ paperWidthMm: 58, printableDots: 384, charsPerLine: 32 }),
    );
    expect(profile.paperWidthMm).toBe(58);
    expect(profile.printableDots).toBe(384);
  });

  it('rejects unknown fields (strict)', () => {
    expect(PrinterProfileSchema.safeParse({ ...makeProfile(), extra: 1 }).success).toBe(false);
  });

  it('derives a draft schema without printerId', () => {
    expect(() => PrinterDraftSchema.parse(makeDraft())).not.toThrow();
    expect(PrinterDraftSchema.safeParse(makeProfile()).success).toBe(false); // extra printerId field
  });

  it.each([
    ['unknown role', { role: 'pantry' }],
    ['invalid paper width', { paperWidthMm: 100 }],
    ['dots too low', { printableDots: 100 }],
    ['dots too high', { printableDots: 1024 }],
    ['chars too low', { charsPerLine: 8 }],
    ['chars too high', { charsPerLine: 128 }],
    ['empty name', { name: '' }],
    ['name too long', { name: 'x'.repeat(65) }],
    ['port zero', { transport: { kind: 'tcp_raw', host: '192.168.1.50', port: 0 } }],
    ['port too high', { transport: { kind: 'tcp_raw', host: '192.168.1.50', port: 65536 } }],
    ['hostname endpoint', { transport: { kind: 'tcp_raw', host: 'printer.local', port: 9100 } }],
    ['loopback endpoint', { transport: { kind: 'tcp_raw', host: '127.0.0.1', port: 9100 } }],
    ['unspecified endpoint', { transport: { kind: 'tcp_raw', host: '0.0.0.0', port: 9100 } }],
    [
      'unknown transport kind',
      { transport: { kind: 'bluetooth', host: '192.168.1.50', port: 9100 } },
    ],
  ])('rejects %s', (_label, overrides) => {
    expect(PrinterDraftSchema.safeParse(makeDraft(overrides as never)).success).toBe(false);
  });

  it('rejects unknown fields nested inside capabilities (strict)', () => {
    const draft = makeDraft();
    const result = PrinterProfileSchema.safeParse({
      ...draft,
      capabilities: { ...draft.capabilities, extra: true },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields nested inside transport (strict)', () => {
    const draft = makeDraft();
    const result = PrinterProfileSchema.safeParse({
      ...draft,
      transport: { ...draft.transport, gateway: '192.168.1.1' },
    });
    expect(result.success).toBe(false);
  });

  it('defaults an omitted port to 9100', () => {
    const draft = makeDraft();
    const parsed = PrinterDraftSchema.parse({
      ...draft,
      transport: { kind: 'tcp_raw', host: '192.168.1.50' },
    });
    expect(parsed.transport).toEqual({ kind: 'tcp_raw', host: '192.168.1.50', port: 9100 });
  });

  it('accepts a spooler_raw endpoint', () => {
    const spoolerTransport = { kind: 'spooler_raw', windowsPrinterName: 'EPSON TM-T20' } as const;
    const parsed = PrinterProfileSchema.parse(makeProfile({ transport: spoolerTransport }));
    expect(parsed.transport).toEqual({ kind: 'spooler_raw', windowsPrinterName: 'EPSON TM-T20' });
  });

  it('rejects a spooler endpoint with an empty or over-long printer name (strict bounds)', () => {
    expect(
      PrinterProfileSchema.safeParse(
        makeProfile({ transport: { kind: 'spooler_raw', windowsPrinterName: '' } }),
      ).success,
    ).toBe(false);
    expect(
      PrinterProfileSchema.safeParse(
        makeProfile({ transport: { kind: 'spooler_raw', windowsPrinterName: 'x'.repeat(129) } }),
      ).success,
    ).toBe(false);
  });

  it('rejects spooler endpoints with unknown fields (strict)', () => {
    expect(
      PrinterProfileSchema.safeParse(
        makeProfile({
          transport: { kind: 'spooler_raw', windowsPrinterName: 'P', host: '1.2.3.4' } as never,
        }),
      ).success,
    ).toBe(false);
  });
});

describe('profile schema: source tag + cloud-sourced fields', () => {
  // A pre-A1 on-disk file has no `source` field — it must parse as 'local',
  // not hit the strict rejection ("printers file invalid, starting empty").
  it('defaults a missing source to local (legacy file upgrade path)', () => {
    const legacy = {
      printerId: '018f0000-0000-7000-8000-000000000001',
      name: 'Kitchen',
      role: 'kitchen',
      paperWidthMm: 80,
      printableDots: 576,
      charsPerLine: 48,
      capabilities: { cut: true, qrCode: false, barcode128: false, statusPolling: false },
      transport: { kind: 'tcp_raw', host: '192.168.1.50', port: 9100 },
    };
    const parsed = PrinterProfileSchema.parse(legacy);
    expect(parsed.source).toBe('local');
    expect(parsed.station).toBeUndefined();
    expect(parsed.duplicatePolicy).toBeUndefined();
  });

  it('accepts a cloud-sourced profile with the cloud-only fields', () => {
    const parsed = PrinterProfileSchema.parse({
      ...makeProfile({ source: 'cloud' }),
      station: 'kitchen',
      copiesDefault: 2,
      codepage: 'cp850',
      cutDefault: 'partial',
      duplicatePolicy: 'auto_reprint',
      statusPolling: 'auto',
    });
    expect(parsed.source).toBe('cloud');
    expect(parsed.copiesDefault).toBe(2);
    expect(parsed.station).toBe('kitchen');
  });

  it('rejects an unknown source value', () => {
    expect(() =>
      PrinterProfileSchema.parse({ ...makeProfile(), source: 'admin' }),
    ).toThrow();
  });

  it('rejects out-of-range cloud fields (copiesDefault, cutDefault)', () => {
    expect(() =>
      PrinterProfileSchema.parse({ ...makeProfile(), copiesDefault: 5 }),
    ).toThrow();
    expect(() =>
      PrinterProfileSchema.parse({ ...makeProfile(), cutDefault: 'tear' }),
    ).toThrow();
  });

  it('drafts cannot set printerId or source', () => {
    expect(() =>
      PrinterDraftSchema.parse({ ...makeDraft(), source: 'cloud' }),
    ).toThrow();
  });
});
