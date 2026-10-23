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
    expect(parsed.transport.port).toBe(9100);
  });
});
