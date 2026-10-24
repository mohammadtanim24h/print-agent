import { describe, expect, it } from 'vitest';
import { ThermalPrinterEncoder } from '../src/main/render/encoder';
import { decodeEscpos } from './helpers/escpos-decode';
import { makeRenderProfile } from './helpers/render';

describe('ThermalPrinterEncoder', () => {
  it('starts the stream with ESC @ init and the configured codepage (ESC t 0 for cp437)', () => {
    const enc = new ThermalPrinterEncoder(makeRenderProfile());
    const b = enc.bytes();
    expect(b[0]).toBe(0x1b);
    expect(b[1]).toBe(0x40);
    // ESC t n immediately after init
    expect(b[2]).toBe(0x1b);
    expect(b[3]).toBe(0x74);
    expect(b[4]).toBe(0x00);
  });

  it('emits ESC t 2 for cp850', () => {
    const enc = new ThermalPrinterEncoder(makeRenderProfile({ codepage: 'cp850' }));
    expect(enc.bytes()[4]).toBe(0x02);
  });

  it('setAlign emits ESC a n once per change', () => {
    const enc = new ThermalPrinterEncoder(makeRenderProfile());
    enc.setAlign('center');
    enc.setAlign('center'); // no duplicate
    enc.setAlign('left');
    const b = [...enc.bytes()];
    expect(b.filter((x) => x === 0x61)).toHaveLength(2); // two ESC a sequences total
  });

  it('setEmphasis emits explicit ESC E / GS ! sequences', () => {
    const enc = new ThermalPrinterEncoder(makeRenderProfile());
    enc.setEmphasis('bold');
    let b = enc.bytes();
    expect(decodeEscpos(b)).toContainEqual({ kind: 'bold', on: true });
    enc.setEmphasis('double');
    b = enc.bytes();
    expect(decodeEscpos(b)).toContainEqual({ kind: 'size', doubleWidth: true, doubleHeight: true });
    enc.setEmphasis('none');
    b = enc.bytes();
    const events = decodeEscpos(b);
    expect(events).toContainEqual({ kind: 'bold', on: false });
  });

  it('text() strips control chars as defense in depth and counts them', () => {
    const enc = new ThermalPrinterEncoder(makeRenderProfile());
    enc.text('A\x1bB');
    expect(enc.strippedCount).toBe(1);
    const events = decodeEscpos(enc.bytes());
    expect(events).toContainEqual({ kind: 'text', text: 'AB' });
  });

  it('newline and feed emit LF bytes', () => {
    const enc = new ThermalPrinterEncoder(makeRenderProfile());
    enc.newline();
    enc.feed(3);
    expect(decodeEscpos(enc.bytes()).filter((e) => e.kind === 'lf')).toHaveLength(4);
  });

  it('separator emits a dash rule plus newline', () => {
    const enc = new ThermalPrinterEncoder(makeRenderProfile({ charsPerLine: 10 }));
    enc.separator(10);
    expect(decodeEscpos(enc.bytes())).toContainEqual({ kind: 'text', text: '----------' });
  });

  it('qr() emits GS ( k with the data', () => {
    const enc = new ThermalPrinterEncoder(makeRenderProfile());
    enc.qr('XY');
    enc.qr('https://saas.example/r/ORD-1');
    const b = enc.bytes();
    expect(b).toContain(0x1d);
    expect(Buffer.from(b).toString('latin1')).toContain('https://saas.example/r/ORD-1');
    // Decoded data must be exact (guards against slice-bound drift).
    const qrData = decodeEscpos(b)
      .filter((e) => e.kind === 'qr')
      .map((e) => (e as { data: string }).data);
    expect(qrData).toContain('XY');
    expect(qrData.join('')).toContain('https://saas.example/r/ORD-1');
  });

  it('barcode128() emits GS k with the data', () => {
    const enc = new ThermalPrinterEncoder(makeRenderProfile());
    enc.barcode128('ABC-123');
    const b = enc.bytes();
    expect(b).toContain(0x1d);
    expect(b).toContain(0x6b);
    expect(Buffer.from(b).toString('latin1')).toContain('ABC-123');
  });

  it('cutFull and cutPartial emit GS V', () => {
    const enc = new ThermalPrinterEncoder(makeRenderProfile());
    enc.cutFull();
    expect(decodeEscpos(enc.bytes())).toContainEqual({ kind: 'cut', full: true });
    const enc2 = new ThermalPrinterEncoder(makeRenderProfile());
    enc2.cutPartial();
    expect(decodeEscpos(enc2.bytes())).toContainEqual({ kind: 'cut', full: false });
  });

  it('raster() emits a GS v 0 bit image with a correct header', () => {
    const enc = new ThermalPrinterEncoder(makeRenderProfile());
    const rowBytes = 72; // 576 dots
    enc.raster({ width: 576, height: 4, data: new Uint8Array(rowBytes * 4) });
    const b = enc.bytes();
    const idx = Buffer.from(b).indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00]));
    expect(idx).toBeGreaterThan(0);
    expect(b[idx + 4]).toBe(72); // xL
    expect(b[idx + 5]).toBe(0); // xH
    expect(b[idx + 6]).toBe(4); // yL
  });

  it('emphasis transitions do not leak size state (double_height → bold)', () => {
    const enc = new ThermalPrinterEncoder(makeRenderProfile());
    enc.setEmphasis('double_height');
    enc.setEmphasis('bold');
    const events = decodeEscpos(enc.bytes());
    // The bold entry must appear with size already normalized to normal.
    const sizeIdx = events.findIndex((e) => e.kind === 'size');
    expect(sizeIdx).toBeGreaterThan(-1);
    const lastSize = events.filter((e) => e.kind === 'size').at(-1);
    expect(lastSize).toEqual({ kind: 'size', doubleWidth: false, doubleHeight: false });
    expect(events.filter((e) => e.kind === 'bold').at(-1)).toEqual({ kind: 'bold', on: true });
  });

  it('interleaved align and emphasis changes each emit exactly once per change', () => {
    const enc = new ThermalPrinterEncoder(makeRenderProfile());
    enc.setAlign('center');
    enc.setEmphasis('bold');
    enc.setAlign('left');
    enc.setEmphasis('none');
    enc.setAlign('left'); // repeat — no emission
    enc.setEmphasis('none'); // repeat — no emission
    const b = [...enc.bytes()];
    // ESC a appears once per CHANGE (center, left) → 2.
    expect(b.filter((x) => x === 0x61)).toHaveLength(2);
    const events = decodeEscpos(enc.bytes());
    expect(events.filter((e) => e.kind === 'bold')).toHaveLength(2); // on then off
    expect(events.filter((e) => e.kind === 'init')).toHaveLength(1); // exactly one init
  });

  it('bytes() returns a copy; encoders are independent', () => {
    const a = new ThermalPrinterEncoder(makeRenderProfile());
    const c = new ThermalPrinterEncoder(makeRenderProfile());
    a.text('X');
    expect(c.bytes().byteLength).toBe(a.bytes().byteLength - 1);
    const before = a.bytes();
    before.fill(0);
    expect(a.bytes().at(-1)).toBe('X'.charCodeAt(0));
  });
});
