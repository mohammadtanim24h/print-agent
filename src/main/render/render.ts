import { createContext, type RenderSummary } from './context';
import { DOC_TYPES, DocV1Schema, PAYLOAD_MAX_BYTES } from './doc';
import { ThermalPrinterEncoder } from './encoder';
import { RenderError } from './errors';
import { DEFAULT_80MM_PROFILE, type RenderProfile } from './profile';
import { createCanvasRasterizer, type TextRasterizer } from './raster';
import { renderKitchen } from './render-kitchen';
import { renderReceipt } from './render-receipt';

/**
 * The renderer entry point (architecture.md §3.3): validated doc JSON →
 * ESC/POS stream + diagnostic summary. Pure: no timers, no network, no
 * ambient state; never throws (returns an error result — fuzz-asserted).
 * Raw printer bytes from any client are structurally impossible here: the
 * input is the structured doc model, and every string passes the sanitizer
 * inside the encoder (threat T2, ADR-3/ADR-11).
 */
export type RenderResult =
  | { ok: true; bytes: Uint8Array; summary: RenderSummary }
  | { ok: false; error: RenderError };

export const MAX_OUTPUT_BYTES = 256 * 1024;

export function renderDoc(
  docType: string,
  payload: unknown,
  profile: RenderProfile = DEFAULT_80MM_PROFILE,
  deps: { rasterizer?: TextRasterizer | null } = {},
): RenderResult {
  try {
    if (!(DOC_TYPES as readonly string[]).includes(docType)) {
      throw new RenderError('unsupported_doc_type', `doc_type "${docType}" is not supported`);
    }
    // JSON.stringify returns undefined only for a top-level `undefined`;
    // TS types can't express that, so guard the input directly (same
    // observable behavior: payload_too_large before any parsing).
    if (payload === undefined) {
      throw new RenderError('payload_too_large', `payload exceeds ${String(PAYLOAD_MAX_BYTES)} bytes`);
    }
    let json: string;
    try {
      json = JSON.stringify(payload);
    } catch {
      throw new RenderError('invalid_doc', 'payload is not JSON-serializable');
    }
    if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > PAYLOAD_MAX_BYTES) {
      throw new RenderError('payload_too_large', `payload exceeds ${String(PAYLOAD_MAX_BYTES)} bytes`);
    }
    const parsed = DocV1Schema.safeParse(payload);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.map(String).join('.')}: ${i.message}`)
        .join('; ')
        .slice(0, 512);
      throw new RenderError('invalid_doc', 'payload failed doc model v1 validation', detail);
    }
    const doc = parsed.data;
    const raster = profile.rasterFallback.enabled
      ? deps.rasterizer !== undefined
        ? deps.rasterizer
        : createCanvasRasterizer(profile.rasterFallback.fontPaths)
      : null;
    const enc = new ThermalPrinterEncoder(profile);
    const ctx = createContext(docType, doc, profile, enc, raster);
    if (docType === 'customer_receipt') renderReceipt(doc, ctx);
    else renderKitchen(doc, ctx); // kitchen/bar/station share the ticket layout
    const bytes = enc.bytes();
    if (bytes.byteLength > MAX_OUTPUT_BYTES) {
      throw new RenderError(
        'render_failed',
        `rendered stream of ${String(bytes.byteLength)} bytes exceeds the safety cap`,
      );
    }
    ctx.summary.byteLength = bytes.byteLength;
    ctx.summary.controlCharsStripped = enc.strippedCount;
    return { ok: true, bytes, summary: ctx.summary };
  } catch (e) {
    if (e instanceof RenderError) return { ok: false, error: e };
    return {
      ok: false,
      error: new RenderError(
        'render_failed',
        e instanceof Error ? e.message : 'unknown render failure',
      ),
    };
  }
}
