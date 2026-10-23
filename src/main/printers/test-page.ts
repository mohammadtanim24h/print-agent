import type { PrinterProfile } from './profile';

/**
 * Minimal ESC/POS connectivity page for transport validation. NOT the document
 * pipeline (the doc renderer is a separate future module) — a small fixed
 * payload proving the transport delivers bytes end to end. All configured text
 * is sanitized to printable ASCII (threat-model T2: no control-character
 * injection). Wording stays honest: this page says "sent to printer", never
 * claims a physical print.
 */
export function buildTestPage(profile: PrinterProfile, now: Date = new Date()): Uint8Array {
  const sanitize = (text: string): string => text.replace(/[^\x20-\x7E]/g, '?');
  const lines = [
    sanitize(profile.name),
    `role: ${profile.role}`,
    `paper: ${String(profile.paperWidthMm)}mm, ${String(profile.printableDots)} dots, ${String(profile.charsPerLine)} cols`,
    `test print - ${now.toISOString()}`,
    'sent to printer (not a print confirmation)',
  ];
  const bytes: number[] = [
    0x1b,
    0x40, // ESC @ — initialize printer
    0x1b,
    0x61,
    0x01, // ESC a 1 — center alignment
  ];
  for (const line of lines) {
    bytes.push(...Buffer.from(line, 'ascii'), 0x0a);
  }
  bytes.push(
    0x1b,
    0x61,
    0x00, // ESC a 0 — left alignment
    0x1b,
    0x64,
    0x02, // ESC d 2 — feed 2 lines
  );
  if (profile.capabilities.cut) {
    bytes.push(0x1d, 0x56, 0x01); // GS V 1 — partial cut
  }
  return Uint8Array.from(bytes);
}
