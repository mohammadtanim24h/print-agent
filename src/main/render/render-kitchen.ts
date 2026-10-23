import { applyCut, separator, writeText, type RenderContext } from './context';
import type { DocV1 } from './doc';
import { formatQty, wrapText } from './layout';
import { sanitizeText } from './sanitize';

/**
 * Kitchen/bar/station ticket. Presentation decisions: title + order ref +
 * table big and centered (rush readability), quantities as prominent `2x`
 * tokens, item names wrapped under the quantity indent, notes bold with a
 * `*` marker. Prices, totals, payments, QR and barcodes are deliberately
 * omitted from tickets (warnings recorded when the payload carries them) —
 * a kitchen ticket carries no money.
 */
export function renderKitchen(doc: DocV1, ctx: RenderContext): void {
  const { enc } = ctx;
  const width = ctx.profile.charsPerLine;

  enc.setAlign('center');
  writeText(ctx, sanitizeText(doc.meta.title).text, 'center', 'double');
  writeText(ctx, sanitizeText(doc.meta.order_ref).text, 'center', 'double_height');
  if (doc.meta.table !== undefined) {
    writeText(ctx, `Table: ${sanitizeText(doc.meta.table).text}`, 'center', 'double_height');
  }
  writeText(ctx, doc.meta.created_at.replace('T', ' '), 'center', 'none');
  separator(ctx);

  enc.setAlign('left');
  for (const line of doc.lines) {
    const text = sanitizeText(line.text).text;
    const qtyToken = line.qty !== undefined ? `${formatQty(line.qty)}x` : '';
    const indent = qtyToken === '' ? 0 : qtyToken.length + 1;
    const bodyWidth = Math.max(8, width - indent);
    if (qtyToken !== '') {
      // Quantity token: biggest readable thing on the ticket.
      enc.setEmphasis('double_height');
      enc.text(`${qtyToken} `);
    }
    const nameLines = wrapText(text, bodyWidth);
    nameLines.forEach((nameLine, i) => {
      if (i > 0) enc.text(' '.repeat(indent));
      writeText(ctx, nameLine, 'left', line.emphasis);
    });
    if (line.note !== undefined) {
      // Post-wrap indentation — wrapText splits on spaces, so a prepended
      // indent would be dropped.
      for (const noteLine of wrapText(`* ${sanitizeText(line.note).text}`, Math.max(8, width - 2))) {
        writeText(ctx, `  ${noteLine}`, 'left', 'bold');
      }
    }
  }

  if (doc.footer.text_lines.length > 0) {
    separator(ctx);
    for (const footer of doc.footer.text_lines) {
      writeText(ctx, sanitizeText(footer).text, 'center', 'none');
    }
  }
  if (doc.footer.qr_data !== undefined) ctx.summary.warnings.push('qr_skipped_kitchen');
  if (doc.footer.barcode_data !== undefined) ctx.summary.warnings.push('barcode_skipped_kitchen');

  applyCut(ctx, doc.station_hints.cut);
}
