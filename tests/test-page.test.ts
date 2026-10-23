import { describe, expect, it } from 'vitest';
import { buildTestPage } from '../src/main/printers/test-page';
import { makeProfile } from './helpers/printers';

const NOW = new Date('2026-10-23T12:00:00.000Z');

function textOf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('ascii');
}

describe('test page', () => {
  it('starts with ESC @ init followed by center alignment', () => {
    const bytes = buildTestPage(makeProfile(), NOW);
    expect([...bytes.slice(0, 5)]).toEqual([0x1b, 0x40, 0x1b, 0x61, 0x01]);
  });

  it('contains the printer name, profile facts, and honest wording', () => {
    const text = textOf(buildTestPage(makeProfile(), NOW));
    expect(text).toContain('Kitchen');
    expect(text).toContain('role: kitchen');
    expect(text).toContain('80mm, 576 dots, 48 cols');
    expect(text).toContain('2026-10-23T12:00:00');
    expect(text).toContain('sent to printer');
    expect(text).not.toContain('printed');
  });

  it('sanitizes control characters from configured text (threat T2)', () => {
    const text = textOf(buildTestPage(makeProfile({ name: 'Kitch\u001ben' }), NOW));
    expect(text).toContain('Kitch?en');
  });

  it('ends with a partial cut only when the capability is on', () => {
    const withCut = [...buildTestPage(makeProfile(), NOW)];
    const capabilitiesOff = {
      cut: false,
      qrCode: false,
      barcode128: false,
      statusPolling: false,
      cashDrawer: false,
    };
    const withoutCut = [...buildTestPage(makeProfile({ capabilities: capabilitiesOff }), NOW)];
    expect(withCut.slice(-3)).toEqual([0x1d, 0x56, 0x01]);
    expect(withoutCut.includes(0x1d)).toBe(false);
  });
});
