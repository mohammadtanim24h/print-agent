import {
  applyCut,
  separator,
  writeBarcode,
  writeQr,
  writeText,
  writeTwoColumns,
  writeWrapped,
  type RenderContext,
} from './context';
import type { DocV1 } from './doc';
import { formatMinorUnits, formatQty, wrapText } from './layout';
import { sanitizeText } from './sanitize';

/**
 * Customer receipt. Presentation decisions: header centered (name double
 * height), items as qty-name/price two-column rows with wrapped names and
 * indented notes, totals with negative amounts (discounts), payments with
 * change, centered footer + QR + barcode, then safe cut. The RFC 3339
 * timestamp is rendered verbatim — the renderer never reads the clock.
 */
export function renderReceipt(doc: DocV1, ctx: RenderContext): void {
  const { enc } = ctx;

  enc.setAlign('center');
  for (const line of wrapText(sanitizeText(doc.header.restaurant_name).text, ctx.profile.charsPerLine)) {
    writeText(ctx, line, 'center', 'double_height');
  }
  for (const address of doc.header.address_lines) {
    writeText(ctx, sanitizeText(address).text, 'center', 'none');
  }
  if (doc.header.tax_id !== undefined) {
    writeText(ctx, `Tax ID: ${sanitizeText(doc.header.tax_id).text}`, 'center', 'none');
  }
  if (doc.header.logo_asset_id !== undefined) {
    ctx.summary.warnings.push('logo_skipped_no_asset_store'); // asset pipeline deferred (R-VAL-10)
  }
  separator(ctx);

  enc.setAlign('left');
  writeText(ctx, `Order: ${sanitizeText(doc.meta.order_ref).text}`, 'left', 'bold');
  if (doc.meta.table !== undefined) writeText(ctx, `Table: ${sanitizeText(doc.meta.table).text}`, 'left', 'none');
  if (doc.meta.server_name !== undefined) writeText(ctx, `Server: ${sanitizeText(doc.meta.server_name).text}`, 'left', 'none');
  writeText(ctx, doc.meta.created_at.replace('T', ' '), 'left', 'none');
  separator(ctx);

  for (const line of doc.lines) {
    const text = sanitizeText(line.text).text;
    const qty = line.qty !== undefined ? `${formatQty(line.qty)} x ` : '';
    const price = line.unit_price !== undefined ? formatMinorUnits(line.unit_price) : undefined;
    if (price !== undefined && line.align === 'left') {
      writeTwoColumns(ctx, qty + text, price, line.emphasis);
    } else {
      writeWrapped(ctx, qty + text, line.emphasis, line.align);
    }
    if (line.note !== undefined) writeWrapped(ctx, `  ${sanitizeText(line.note).text}`, 'none');
  }

  if (doc.totals.length > 0) {
    separator(ctx);
    for (const total of doc.totals) {
      writeTwoColumns(
        ctx,
        sanitizeText(total.label).text,
        formatMinorUnits(total.amount_minor),
        total.emphasis === 'bold' ? 'bold' : 'none',
      );
    }
  }

  if (doc.payments.length > 0) {
    separator(ctx);
    for (const payment of doc.payments) {
      writeTwoColumns(ctx, sanitizeText(payment.method).text, formatMinorUnits(payment.amount_minor), 'none');
      if (payment.change_minor !== undefined) {
        writeTwoColumns(ctx, 'Change', formatMinorUnits(payment.change_minor), 'none');
      }
    }
  }

  if (doc.footer.text_lines.length > 0) {
    separator(ctx);
    enc.setAlign('center');
    for (const footer of doc.footer.text_lines) {
      writeText(ctx, sanitizeText(footer).text, 'center', 'none');
    }
  }
  writeQr(ctx, doc.footer.qr_data);
  writeBarcode(ctx, doc.footer.barcode_data);

  applyCut(ctx, doc.station_hints.cut);
}
