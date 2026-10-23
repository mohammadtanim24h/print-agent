import type { Align, DocV1, Emphasis } from './doc';
import type { EscposEncoder } from './encoder';
import { RenderError } from './errors';
import { splitTwoColumns, wrapText } from './layout';
import type { RenderProfile } from './profile';
import type { TextRasterizer } from './raster';
import { isAsciiPrintable, sanitizeText } from './sanitize';

/**
 * Diagnostic summary of a render — what the job engine logs and what the
 * support view shows. Wording never claims a physical print.
 */
/** Closed set of diagnostic warning tokens (stable machine codes — CLAUDE.md). */
export type RenderWarning =
  | 'cut_skipped_unsupported'
  | 'qr_skipped_unsupported'
  | 'qr_skipped_invalid'
  | 'barcode_skipped_unsupported'
  | 'barcode_skipped_invalid'
  | 'logo_skipped_no_asset_store'
  | 'qr_skipped_kitchen'
  | 'barcode_skipped_kitchen';

export interface RenderSummary {
  docType: string;
  charsPerLine: number;
  paperWidthMm: 58 | 80;
  codepage: 'cp437' | 'cp850';
  textLines: number;
  rasterizedLines: number;
  controlCharsStripped: number;
  /** Echoed for the job engine — the renderer emits exactly one copy. */
  copies: number;
  cut: 'full' | 'partial' | 'none';
  features: { qr: boolean; barcode: boolean };
  warnings: RenderWarning[];
  byteLength: number;
}

export interface RenderContext {
  enc: EscposEncoder;
  profile: RenderProfile;
  raster: TextRasterizer | null;
  summary: RenderSummary;
}

export function createContext(
  docType: string,
  doc: DocV1,
  profile: RenderProfile,
  enc: EscposEncoder,
  raster: TextRasterizer | null,
): RenderContext {
  return {
    enc,
    profile,
    raster,
    summary: {
      docType,
      charsPerLine: profile.charsPerLine,
      paperWidthMm: profile.paperWidthMm,
      codepage: profile.codepage,
      textLines: 0,
      rasterizedLines: 0,
      controlCharsStripped: 0,
      copies: doc.station_hints.copies ?? 1,
      cut: 'none',
      features: { qr: false, barcode: false },
      warnings: [],
      byteLength: 0,
    },
  };
}

/**
 * The single text sink of both templates. ASCII goes out as text; anything
 * else is rasterized when the fallback is configured, or fails rendering —
 * it is never sent as raw UTF-8 (mojibake; R-VAL-1).
 */
export function writeText(ctx: RenderContext, s: string, align: Align, emphasis: Emphasis): void {
  if (s === '') return;
  ctx.enc.setAlign(align);
  ctx.enc.setEmphasis(emphasis);
  if (isAsciiPrintable(s)) {
    ctx.enc.text(s);
    ctx.summary.textLines += 1;
    return;
  }
  if (ctx.raster) {
    ctx.enc.raster(ctx.raster.rasterize(s, ctx.profile.printableDots));
    ctx.enc.newline();
    ctx.summary.rasterizedLines += 1;
    return;
  }
  throw new RenderError(
    'text_not_encodable',
    `text is not printable in codepage ${ctx.profile.codepage} and the raster fallback is disabled`,
    s.slice(0, 32),
  );
}

export function writeWrapped(
  ctx: RenderContext,
  s: string,
  emphasis: Emphasis,
  align: Align = 'left',
): void {
  for (const line of wrapText(s, ctx.profile.charsPerLine)) {
    writeText(ctx, line, align, emphasis);
  }
}

export function writeTwoColumns(
  ctx: RenderContext,
  left: string,
  right: string,
  emphasis: Emphasis,
): void {
  for (const line of splitTwoColumns(left, right, ctx.profile.charsPerLine)) {
    writeText(ctx, line, 'left', emphasis);
  }
}

export function separator(ctx: RenderContext): void {
  ctx.enc.setAlign('left');
  ctx.enc.setEmphasis('none');
  ctx.enc.separator(ctx.profile.charsPerLine);
  ctx.summary.textLines += 1;
}

/**
 * Safe-cut policy (printer-compatibility.md §2): feed first so the paper
 * clears the cutter, then cut only if the printer has a cutter and the doc
 * allows it. Partial is the default; full/none are explicit.
 */
export function applyCut(ctx: RenderContext, requested?: 'full' | 'partial' | 'none'): void {
  const want = requested ?? 'partial';
  ctx.enc.feed(3);
  if (!ctx.profile.capabilities.cut) {
    ctx.summary.cut = 'none';
    if (want !== 'none') ctx.summary.warnings.push('cut_skipped_unsupported');
    return;
  }
  ctx.summary.cut = want;
  if (want === 'full') ctx.enc.cutFull();
  else if (want === 'partial') ctx.enc.cutPartial();
}

export function writeQr(ctx: RenderContext, data: string | undefined): void {
  if (data === undefined || data === '') return;
  if (!ctx.profile.capabilities.qrCode) {
    ctx.summary.warnings.push('qr_skipped_unsupported');
    return;
  }
  const clean = sanitizeText(data).text;
  if (clean === '') {
    ctx.summary.warnings.push('qr_skipped_invalid');
    return;
  }
  ctx.enc.setAlign('center');
  ctx.enc.qr(clean);
  ctx.summary.features.qr = true;
}

export function writeBarcode(ctx: RenderContext, data: string | undefined): void {
  if (data === undefined || data === '') return;
  if (!ctx.profile.capabilities.barcode128) {
    ctx.summary.warnings.push('barcode_skipped_unsupported');
    return;
  }
  const clean = sanitizeText(data).text;
  // CODE128 payload must survive as printable ASCII.
  if (clean === '' || !isAsciiPrintable(clean)) {
    ctx.summary.warnings.push('barcode_skipped_invalid');
    return;
  }
  ctx.enc.setAlign('center');
  ctx.enc.barcode128(clean);
  ctx.summary.features.barcode = true;
}
