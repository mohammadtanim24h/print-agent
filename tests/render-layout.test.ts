import { describe, expect, it } from 'vitest';
import {
  formatMinorUnits,
  formatOrderTime,
  formatQty,
  splitTwoColumns,
  wrapText,
} from '../src/main/render/layout';

describe('wrapText', () => {
  it('wraps greedily on spaces within the width', () => {
    expect(wrapText('one two three four', 7)).toEqual(['one two', 'three', 'four']);
  });
  it('hard-breaks words longer than the width', () => {
    expect(wrapText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });
  it('collapses runs of spaces', () => {
    expect(wrapText('a   b', 4)).toEqual(['a b']);
  });
  it('returns one empty line for empty input', () => {
    expect(wrapText('', 10)).toEqual(['']);
  });
  it('handles very long Bangla words by hard-breaking', () => {
    const word = 'প্রিন্ট'.repeat(10);
    const lines = wrapText(word, 10);
    expect(lines.every((l) => l.length <= 10)).toBe(true);
    expect(lines.join('')).toBe(word);
  });
});

describe('splitTwoColumns', () => {
  it('puts the right column flush right on the first line', () => {
    expect(splitTwoColumns('Coffee', '12.00', 20)).toEqual(['Coffee'.padEnd(15) + '12.00']);
  });
  it('wraps the left column while the right stays put', () => {
    const lines = splitTwoColumns('Iced Caramel Macchiato Extra Shot', '6.50', 20);
    expect(lines[0]).toBe('Iced Caramel'.padEnd(16) + '6.50');
    expect(lines.slice(1)).toEqual(['Macchiato', 'Extra Shot']);
  });
  it('falls back to plain wrapping when the right column would not fit', () => {
    const lines = splitTwoColumns('Item', '1,234,567.89', 12);
    expect(lines.join(' ')).toContain('Item');
    expect(lines.every((l) => l.length <= 12)).toBe(true);
  });
});

describe('formatQty', () => {
  it('renders integers plainly', () => {
    expect(formatQty(2)).toBe('2');
    expect(formatQty(9999)).toBe('9999');
  });
  it('renders fractional quantities compactly', () => {
    expect(formatQty(0.5)).toBe('0.5');
    expect(formatQty(1.25)).toBe('1.25');
  });
});

describe('formatMinorUnits', () => {
  it('formats integer minor units with grouping', () => {
    expect(formatMinorUnits(0)).toBe('0.00');
    expect(formatMinorUnits(5)).toBe('0.05');
    expect(formatMinorUnits(1200)).toBe('12.00');
    expect(formatMinorUnits(123456789)).toBe('1,234,567.89');
  });
  it('formats negatives (discounts) with a minus sign', () => {
    expect(formatMinorUnits(-500)).toBe('-5.00');
  });
});

describe('formatOrderTime', () => {
  // Timezone-independent checks: the shape and the parse/fallback behavior
  // (the local wall clock itself is deployment-dependent by design — the
  // device's timezone IS the restaurant's).
  it('renders the d M Y, g:i A shape in the device-local timezone', () => {
    expect(formatOrderTime('2026-10-22T16:09:29+00:00')).toMatch(
      /^\d{2} Oct 2026, \d{1,2}:\d{2} [AP]M$/,
    );
  });
  it('keeps the same instant across offset spellings (UTC vs +06:00)', () => {
    // 16:09Z == 22:09+06:00 — the local wall clock must agree.
    expect(formatOrderTime('2026-10-22T16:09:29+00:00')).toBe(
      formatOrderTime('2026-10-22T22:09:29+06:00'),
    );
  });
  it('falls back to the raw T→space rendering when the timestamp does not parse', () => {
    expect(formatOrderTime('not-a-date')).toBe('not-a-date');
  });
});
