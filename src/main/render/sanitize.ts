/**
 * Threat-model T2 boundary: every string is stripped of 0x00–0x1F and 0x7F
 * before ESC/POS encoding, so content can never inject printer commands
 * (api-contract.md §2 "hard limits" is normative). Stripping (not escaping)
 * keeps column layout math correct.
 *
 * Defense-in-depth: when an ESC/POS introducer (ESC 0x1B, GS 0x1D) is
 * stripped, the printable bytes of its most destructive command are dropped
 * as well — `ESC @` (initialize), `GS V`/`GS v` (cut) and their cut-mode
 * parameter 0/1 — so that even an introducer that somehow reaches the
 * encoder cannot form a complete sequence. Those bytes are printable, so
 * they are not counted in `stripped` (which reports control characters
 * removed only).
 */
export function sanitizeText(text: string): { text: string; stripped: number } {
  let out = '';
  let stripped = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0x1f && code !== 0x7f) {
      out += text.charAt(i);
      continue;
    }
    stripped += 1;
    if (code === 0x1b && text.charCodeAt(i + 1) === 0x40) {
      i += 1; // ESC @ — initialize (no parameters)
    } else if (code === 0x1d) {
      const designator = text.charCodeAt(i + 1);
      if (designator === 0x56 || designator === 0x76) {
        i += 1; // GS V/v — cut
        const param = text.charCodeAt(i + 1);
        if (param === 0x30 || param === 0x31) {
          i += 1; // cut mode 0 (full) or 1 (partial)
        }
      }
    }
  }
  return { text: out, stripped };
}

export function isAsciiPrintable(text: string): boolean {
  return /^[\u0020-\u007E]*$/.test(text);
}
