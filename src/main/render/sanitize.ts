/**
 * Threat-model T2 boundary: every string is stripped of 0x00–0x1F and 0x7F
 * before ESC/POS encoding, so content can never inject printer commands
 * (api-contract.md §2 "hard limits" is normative). Stripping (not escaping)
 * keeps column layout math correct — and once the command introducers are
 * gone, any orphaned printable bytes are inert text, not commands.
 */
const CONTROL_RE = /[\u0000-\u001F\u007F]/g;

export function sanitizeText(text: string): { text: string; stripped: number } {
  let stripped = 0;
  const clean = text.replace(CONTROL_RE, () => {
    stripped += 1;
    return '';
  });
  return { text: clean, stripped };
}

export function isAsciiPrintable(text: string): boolean {
  return /^[\u0020-\u007E]*$/.test(text);
}
