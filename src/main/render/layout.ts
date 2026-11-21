/**
 * Pure text layout for fixed-width receipt columns. All inputs are already
 * sanitized (control chars stripped), so `length` is a safe width proxy.
 */

export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const words = text.split(' ').filter((word) => word !== '');
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let current = '';
  for (let word of words) {
    if (word.length > w) {
      if (current !== '') {
        lines.push(current);
        current = '';
      }
      while (word.length > w) {
        lines.push(word.slice(0, w));
        word = word.slice(w);
      }
      current = word;
      continue;
    }
    if (current === '') current = word;
    else if (current.length + 1 + word.length <= w) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

export function splitTwoColumns(left: string, right: string, width: number, gap = 2): string[] {
  if (right.length >= width - 1) return wrapText(`${left} ${right}`, width);
  const leftWidth = Math.max(1, width - right.length - gap);
  const leftLines = wrapText(left, leftWidth);
  const first = leftLines[0] ?? '';
  return [first.padEnd(width - right.length, ' ') + right, ...leftLines.slice(1)];
}

export function formatQty(qty: number): string {
  return Number.isInteger(qty) ? String(qty) : String(Number(qty.toFixed(3)));
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/**
 * Human local format for doc.meta.created_at (RFC 3339, offset-aware):
 * the agent device runs in the restaurant, so its local timezone IS the
 * deployment's wall clock — "21 Nov 2026, 10:09 PM", mirroring the
 * server's delta footer stamp. Falls back to the raw string (T → space,
 * the pre-format rendering) when the timestamp does not parse — a bad
 * date must never fabricate one.
 */
export function formatOrderTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.replace('T', ' ');
  const hh = d.getHours();
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${h12}:${min} ${hh < 12 ? 'AM' : 'PM'}`;
}

export function formatMinorUnits(amountMinor: number): string {
  const sign = amountMinor < 0 ? '-' : '';
  const abs = Math.abs(amountMinor);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${grouped}.${frac}`;
}
