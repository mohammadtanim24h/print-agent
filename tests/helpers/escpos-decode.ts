/**
 * Minimal ESC/POS decoder for the subset this renderer emits. Used to make
 * semantic assertions on byte streams in tests (research: in-house decoder
 * for the emitted subset — .research/virtual-printer-research.md §4).
 *
 * Non-control bytes outside 0x20–0x7E that are not part of a recognized
 * command surface as `<0xNN>` text events — fuzz/sanitization assertions
 * rely on this.
 */
export type DecodedEvent =
  | { kind: 'init' }
  | { kind: 'align'; value: number }
  | { kind: 'bold'; on: boolean }
  | { kind: 'size'; doubleWidth: boolean; doubleHeight: boolean }
  | { kind: 'text'; text: string }
  | { kind: 'lf' }
  | { kind: 'feed'; n: number }
  | { kind: 'cut'; full: boolean }
  | { kind: 'qr'; data: string }
  | { kind: 'barcode'; data: string }
  | { kind: 'image'; dataBytes: number }
  | { kind: 'codepage'; table: number };

export function decodeEscpos(bytes: Uint8Array): DecodedEvent[] {
  const events: DecodedEvent[] = [];
  let text = '';
  const flush = () => {
    if (text !== '') {
      events.push({ kind: 'text', text });
      text = '';
    }
  };
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i] ?? -1;
    if (b === 0x1b) {
      const cmd = bytes[i + 1];
      flush();
      if (cmd === 0x40) {
        events.push({ kind: 'init' });
        i += 2;
        continue;
      }
      if (cmd === 0x61) {
        events.push({ kind: 'align', value: bytes[i + 2] ?? -1 });
        i += 3;
        continue;
      }
      if (cmd === 0x45) {
        events.push({ kind: 'bold', on: (bytes[i + 2] ?? 0) !== 0 });
        i += 3;
        continue;
      }
      if (cmd === 0x64) {
        events.push({ kind: 'feed', n: bytes[i + 2] ?? 0 });
        i += 3;
        continue;
      }
      if (cmd === 0x74) {
        events.push({ kind: 'codepage', table: bytes[i + 2] ?? -1 });
        i += 3;
        continue;
      }
      i += 2; // unknown ESC x — skip both bytes
      continue;
    }
    if (b === 0x1d) {
      const cmd = bytes[i + 1];
      flush();
      if (cmd === 0x56) {
        // GS V [0|1|65|66] (3 bytes); bare GS V (2 bytes) = auto-feed full cut
        const p = bytes[i + 2];
        if (p === 0 || p === 1 || p === 65 || p === 66) {
          events.push({ kind: 'cut', full: p === 0 || p === 65 });
          i += 3;
        } else {
          events.push({ kind: 'cut', full: true });
          i += 2;
        }
        continue;
      }
      if (cmd === 0x76 && bytes[i + 2] === 0x30) {
        // GS v 0 m xL xH yL yH <data>
        const rowBytes = (bytes[i + 4] ?? 0) + (bytes[i + 5] ?? 0) * 256;
        const height = (bytes[i + 6] ?? 0) + (bytes[i + 7] ?? 0) * 256;
        events.push({ kind: 'image', dataBytes: rowBytes * height });
        i += 8 + rowBytes * height;
        continue;
      }
      if (cmd === 0x28 && bytes[i + 2] === 0x6b) {
        // GS ( k — QR function segments: pL pH cn fn <params/data>.
        // Epson layout: cn at i+5 (0x31 = QR), fn at i+6 (0x50 = store data),
        // data from i+7; pL/pH counts cn..last data byte.
        const segLen = (bytes[i + 3] ?? 0) + (bytes[i + 4] ?? 0) * 256;
        const cn = bytes[i + 5];
        const fn = bytes[i + 6];
        if (cn === 0x31 && fn === 0x50) {
          events.push({
            kind: 'qr',
            data: Buffer.from(bytes.slice(i + 7, i + 4 + segLen)).toString('latin1'),
          });
        }
        i += 4 + segLen;
        continue;
      }
      if (cmd === 0x21) {
        const n = bytes[i + 2] ?? 0;
        events.push({ kind: 'size', doubleWidth: (n & 0x10) !== 0, doubleHeight: (n & 0x01) !== 0 });
        i += 3;
        continue;
      }
      i += 2;
      continue;
    }
    if (b === 0x0a) {
      flush();
      events.push({ kind: 'lf' });
      i += 1;
      continue;
    }
    if (b >= 0x20 && b <= 0x7e) {
      text += String.fromCharCode(b);
      i += 1;
      continue;
    }
    flush();
    events.push({ kind: 'text', text: `<0x${b.toString(16).padStart(2, '0')}>` });
    i += 1;
  }
  flush();
  return events;
}
