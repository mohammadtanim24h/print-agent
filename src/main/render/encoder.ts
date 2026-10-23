import { CharacterSet, PrinterTypes, ThermalPrinter } from 'node-thermal-printer';
import type { Align, Emphasis } from './doc';
import { sanitizeText } from './sanitize';
import type { RasterBitmap } from './raster';
import { packMonoToGsV0 } from './raster';
import type { RenderProfile } from './profile';

/**
 * The ESC/POS boundary of the renderer (architecture.md §3.3). Everything the
 * printer-compatibility.md §2 baseline calls "conservative intersection" is
 * emitted here as explicit bytes (ESC @, ESC t, ESC a, ESC E, GS !, LF);
 * node-thermal-printer (ISC, active 2026-08) is used only where dialect
 * payload construction is genuinely fiddly: QR (GS ( k model 2) and CODE128
 * (GS k). Cuts are explicit GS V bytes — the library's cut() would also emit
 * ESC d 4 feeds and a mid-stream ESC @ re-init. The adapter never opens a
 * connection (`interface` is never `execute()`d; only getBuffer() is read).
 * Swapping/patching a dialect quirk means editing this file only.
 */

/** Styles as explicit command bytes (decoder-testable, deterministic). */
const EMPHASIS_BYTES: Record<Emphasis, readonly number[]> = {
  none: [0x1b, 0x45, 0x00, 0x1d, 0x21, 0x00], // ESC E 0 + GS ! 0
  bold: [0x1b, 0x45, 0x01], // ESC E 1
  double_height: [0x1b, 0x45, 0x00, 0x1d, 0x21, 0x01], // GS ! 1 (double height only)
  double: [0x1b, 0x45, 0x01, 0x1d, 0x21, 0x11], // ESC E 1 + GS ! 0x11 (quad)
};

const ALIGN_BYTES: Record<Align, readonly number[]> = {
  left: [0x1b, 0x61, 0x00], // ESC a 0
  center: [0x1b, 0x61, 0x01], // ESC a 1
  right: [0x1b, 0x61, 0x02], // ESC a 2
};

const CUT_FULL: readonly number[] = [0x1d, 0x56, 0x00]; // GS V 0
const CUT_PARTIAL: readonly number[] = [0x1d, 0x56, 0x01]; // GS V 1

/** Epson character tables selected by ESC t: 0 = CP437, 2 = CP850. */
function codepageTable(codepage: RenderProfile['codepage']): number {
  return codepage === 'cp850' ? 0x02 : 0x00;
}

export interface EscposEncoder {
  setAlign(align: Align): void;
  setEmphasis(emphasis: Emphasis): void;
  /** Appends sanitized text without a newline; layout is the caller's job. */
  text(s: string): void;
  newline(): void;
  feed(lines: number): void;
  separator(width: number): void;
  qr(data: string): void;
  barcode128(data: string): void;
  raster(bitmap: RasterBitmap): void;
  cutFull(): void;
  cutPartial(): void;
  readonly bytes: () => Uint8Array;
  /** Control chars stripped inside text() (defense in depth). */
  readonly strippedCount: number;
}

export class ThermalPrinterEncoder implements EscposEncoder {
  private printer: ThermalPrinter;
  private _stripped = 0;
  private lastAlign: Align | null = null;
  private lastEmphasis: Emphasis | null = null;

  constructor(profile: RenderProfile) {
    this.printer = new ThermalPrinter({
      type: PrinterTypes.EPSON,
      // Resolves to the library's File interface whose constructor only stores
      // the path — execute() (the only I/O entry point) is never called.
      interface: 'buffer',
      // Sets the library's iconv code page used when encoding text().
      characterSet:
        profile.codepage === 'cp850' ? CharacterSet.PC850_MULTILINGUAL : CharacterSet.PC437_USA,
      removeSpecialCharacters: false,
      // The library's print() folds lines at this width; we append() directly,
      // so layout stays the caller's job — keep the default explicit anyway.
      width: profile.charsPerLine,
    });
    // The constructor auto-appends ESC t n (setCharacterSet); start from a
    // clean stream and emit the init prefix ourselves. The prefix is a fixed
    // 6-byte block (shape pinned by tests/render-encoder.test.ts): ESC @
    // (reset), a blank ' ' at offset 2 (printable ASCII — inert on hardware
    // and decoder/fuzz-clean, unlike NUL or an LF feed), then ESC t <table>.
    this.printer.setBuffer(Buffer.alloc(0));
    this.printer.append(
      Buffer.from([0x1b, 0x40, 0x20, 0x1b, 0x74, codepageTable(profile.codepage)]),
    );
  }

  get strippedCount(): number {
    return this._stripped;
  }

  setAlign(align: Align): void {
    if (align === this.lastAlign) return;
    this.lastAlign = align;
    this.printer.append(Buffer.from(ALIGN_BYTES[align]));
  }

  setEmphasis(emphasis: Emphasis): void {
    if (emphasis === this.lastEmphasis) return;
    this.lastEmphasis = emphasis;
    this.printer.append(Buffer.from(EMPHASIS_BYTES[emphasis]));
  }

  text(s: string): void {
    const { text, stripped } = sanitizeText(s);
    this._stripped += stripped;
    // append(), not print(): print() folds lines at the configured width.
    this.printer.append(text);
  }

  newline(): void {
    this.printer.append('\n');
  }

  feed(lines: number): void {
    this.printer.append('\n'.repeat(Math.max(0, lines)));
  }

  separator(width: number): void {
    this.printer.append(`${'-'.repeat(Math.max(1, width))}\n`);
  }

  qr(data: string): void {
    // GS ( k model 2, cell size 3, correction M via the library payload builder.
    this.printer.printQR(data);
  }

  barcode128(data: string): void {
    // GS k function B, type 73 = CODE128, {B charset (verified in epson.js).
    this.printer.printBarcode(data, 73);
  }

  raster(bitmap: RasterBitmap): void {
    this.printer.append(Buffer.from(packMonoToGsV0(bitmap)));
  }

  cutFull(): void {
    this.printer.append(Buffer.from(CUT_FULL));
  }

  cutPartial(): void {
    this.printer.append(Buffer.from(CUT_PARTIAL));
  }

  bytes = (): Uint8Array => new Uint8Array(this.printer.getBuffer());
}
