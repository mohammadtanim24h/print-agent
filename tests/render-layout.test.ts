import { describe, expect, it } from 'vitest';
import { formatMinorUnits, formatQty, splitTwoColumns, wrapText } from '../src/main/render/layout';

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
