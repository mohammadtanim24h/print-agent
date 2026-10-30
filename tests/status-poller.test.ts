import { describe, expect, it } from 'vitest';
import { parseDleEotStatus } from '../src/main/printers/status-poller';

/**
 * Bit semantics per the ESC/POS R&P spec (DLE EOT 1 = printer status,
 * DLE EOT 2 = paper sensor). Byte examples use realistic raw values —
 * e.g. many models set bit 6 (0x40) of the DLE EOT 1 response to 1.
 */
describe('parseDleEotStatus', () => {
  it.each([
    ['ok when nothing is flagged', 0x12, 0x00, 'ok'],
    ['ok with reserved bit 6 set', 0x40, 0x00, 'ok'],
    ['printer error bit → offline', 0x20, 0x00, 'offline'],
    ['error bit beats every other condition', 0x24, 0x38, 'offline'],
    ['cover open bit → cover_open', 0x04, 0x00, 'cover_open'],
    ['paper-out bits (0x38) → paper_out', 0x00, 0x08, 'paper_out'],
    ['paper-out + near-end → paper_out wins', 0x00, 0x09, 'paper_out'],
    ['near-end bits (0x07) → paper_low', 0x00, 0x01, 'paper_low'],
    ['paper_out beats cover_open on severity', 0x04, 0x38, 'paper_out'],
    ['all zero → ok', 0x00, 0x00, 'ok'],
  ])('%s', (_name, printerByte, paperByte, expected) => {
    expect(parseDleEotStatus(printerByte, paperByte)).toBe(expected);
  });

  it('fuzz: deterministic 5000-pair corpus never throws and stays in the status enum', () => {
    const allowed = new Set(['ok', 'unknown', 'offline', 'paper_out', 'paper_low', 'cover_open']);
    let seed = 0x12345678;
    const nextByte = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 16) & 0xff;
    };
    for (let i = 0; i < 5_000; i += 1) {
      const status = parseDleEotStatus(nextByte(), nextByte());
      expect(allowed.has(status)).toBe(true);
    }
  });
});
