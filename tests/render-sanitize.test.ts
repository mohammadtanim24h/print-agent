import { describe, expect, it } from 'vitest';
import { isAsciiPrintable, sanitizeText } from '../src/main/render/sanitize';

describe('sanitizeText', () => {
  it('strips all C0 control bytes and DEL, counting them', () => {
    const input = `A\x1bB\tC\nD\x00E\x7fF`;
    expect(sanitizeText(input)).toEqual({ text: 'ABCDEF', stripped: 5 });
  });

  it('leaves an attempted ESC/POS injection inert (introducers stripped)', () => {
    const evil = 'x\x1b@y\x1dV0z'; // ESC @ init + GS V cut injection attempt
    const { text, stripped } = sanitizeText(evil);
    // Only the control-char introducers are stripped; the orphaned printable
    // bytes print as text and carry no command semantics.
    expect(text).toBe('x@yV0z');
    expect(stripped).toBe(2);
  });

  it('leaves printable ASCII untouched', () => {
    expect(sanitizeText('Coffee 2x — 12.00')).toEqual({ text: 'Coffee 2x — 12.00', stripped: 0 });
  });

  it('leaves non-Latin printable text (Bangla) untouched', () => {
    const b = 'প্রিন্ট';
    expect(sanitizeText(b)).toEqual({ text: b, stripped: 0 });
  });

  it('handles empty strings', () => {
    expect(sanitizeText('')).toEqual({ text: '', stripped: 0 });
  });
});

describe('isAsciiPrintable', () => {
  it('accepts printable ASCII only', () => {
    expect(isAsciiPrintable('OK 123')).toBe(true);
    expect(isAsciiPrintable('café')).toBe(false);
    expect(isAsciiPrintable('প্রিন্ট')).toBe(false);
    expect(isAsciiPrintable('tab\tchar')).toBe(false);
    expect(isAsciiPrintable('')).toBe(true);
  });
});
