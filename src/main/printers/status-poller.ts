import type { PrinterStatus } from '../transport/types';

/**
 * DLE EOT response → health mapping (production-readiness C1, R-VAL-3).
 * Bit semantics follow the ESC/POS R&P spec; exact fleet behavior is what
 * R-VAL-3 must confirm on hardware, hence the profile-level gate defaults
 * to off (`statusPolling` undefined or 'off').
 */

/** DLE EOT 1 (printer status) bit 2: cover open. */
const COVER_OPEN_BIT = 0x04;
/** DLE EOT 1 bit 5: printer error (offline-class). */
const PRINTER_ERROR_BIT = 0x20;
/** DLE EOT 2 bits 0–2: roll paper near-end (any sensor). */
const PAPER_NEAR_END_MASK = 0x07;
/** DLE EOT 2 bits 3–5: roll paper end (any sensor). */
const PAPER_OUT_MASK = 0x38;

/** Severity precedence: paper_out > cover_open > paper_low > ok; the error
 *  bit beats everything. */
export function parseDleEotStatus(printerByte: number, paperByte: number): PrinterStatus {
  if ((printerByte & PRINTER_ERROR_BIT) !== 0) return 'offline';
  if ((paperByte & PAPER_OUT_MASK) !== 0) return 'paper_out';
  if ((printerByte & COVER_OPEN_BIT) !== 0) return 'cover_open';
  if ((paperByte & PAPER_NEAR_END_MASK) !== 0) return 'paper_low';
  return 'ok';
}
