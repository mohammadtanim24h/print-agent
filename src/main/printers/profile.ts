import { isIP } from 'node:net';
import { z } from 'zod';

export const PRINTER_ROLES = ['kitchen', 'receipt', 'bar', 'custom'] as const;
export type PrinterRole = (typeof PRINTER_ROLES)[number];

/**
 * Approved-destination policy (spec §3): hosts must be IPv4/IPv6 literals.
 * Rejected: unspecified, loopback, and multicast in every notation —
 * including zone-scoped (`::1%eth0`) and IPv4-mapped/compatible
 * (`::ffff:127.0.0.1`) spellings, i.e. the whole `::/80` IPv6 prefix — plus
 * the embedded-IPv4 forms of those addresses. Allowed: global unicast,
 * private LAN ranges (10/8, 172.16/12, 192.168/16, ULA fc00::/7), link-local
 * and documentation ranges (a failed connect is a normal operational error).
 * No DNS — there is no name-resolution surface in v1 — and no network
 * scanning anywhere.
 */

/** Expands an IPv6 literal into its 8 16-bit groups, or null when the string
 *  is malformed, zone-scoped, or uses unsupported syntax. */
function expandIPv6Groups(host: string): number[] | null {
  if (host.includes('%')) return null; // zone-scoped (e.g. '::1%eth0') — not a plain literal
  let head: string[];
  let tail: string[];
  const compression = host.indexOf('::');
  if (compression === -1) {
    head = host.split(':');
    tail = [];
    if (head.length !== 8) return null;
  } else {
    if (host.indexOf('::', compression + 1) !== -1) return null; // only one '::'
    const headPart = host.slice(0, compression);
    const tailPart = host.slice(compression + 2);
    head = headPart === '' ? [] : headPart.split(':');
    tail = tailPart === '' ? [] : tailPart.split(':');
    if (head.length + tail.length > 7) return null;
  }
  const parts = [...head, ...tail];
  const groups: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined) return null;
    if (part.includes('.')) {
      // Embedded IPv4 — only valid as the final group pair.
      if (i !== parts.length - 1) return null;
      const octets = part.split('.').map((o) => Number.parseInt(o, 10));
      if (octets.length !== 4) return null;
      if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
        return null;
      }
      let embedded = 0;
      for (const octet of octets) {
        embedded = embedded * 256 + octet;
      }
      groups.push(Math.floor(embedded / 65536), embedded % 65536);
    } else if (part === '' || !/^[0-9a-fA-F]{1,4}$/.test(part)) {
      return null;
    } else {
      groups.push(Number.parseInt(part, 16));
    }
  }
  while (groups.length < 8) {
    groups.splice(head.length, 0, 0); // '::' expands to zeros at the compression point
  }
  return groups;
}

export function isApprovedEndpointHost(host: string): boolean {
  const version = isIP(host);
  if (version === 4) {
    const first = Number.parseInt(host.split('.')[0] ?? '', 10);
    return first !== 0 && first !== 127 && first < 224;
  }
  if (version === 6) {
    const groups = expandIPv6Groups(host);
    if (groups === null || groups.length !== 8) return false;
    const firstGroup = groups[0] ?? 0x1_0000; // length-checked above; sentinel never passes
    const multicast = firstGroup >>> 8 === 0xff; // ff00::/8
    const compressedPrefix =
      groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0;
    // '::/80' covers '::', '::1', and every IPv4-mapped/compatible spelling
    // ('::ffff:127.0.0.1', '::127.0.0.1', '0:0:0:0:0:0:0:1', …). No LAN
    // printer is legitimately addressed inside that prefix.
    return !multicast && !compressedPrefix;
  }
  return false;
}

const EndpointTcpRawSchema = z.strictObject({
  kind: z.literal('tcp_raw'),
  host: z
    .string()
    .refine((h) => isIP(h) !== 0, 'host must be an IPv4 or IPv6 literal (no hostnames)')
    .refine(
      isApprovedEndpointHost,
      'host is loopback, unspecified, multicast or otherwise not approved',
    ),
  port: z.number().int().min(1).max(65535).default(9100),
});

export const PrinterCapabilitiesSchema = z.strictObject({
  cut: z.boolean(),
  qrCode: z.boolean(),
  barcode128: z.boolean(),
  statusPolling: z.boolean(),
  cashDrawer: z.boolean(),
});
export type PrinterCapabilities = z.output<typeof PrinterCapabilitiesSchema>;

export const PrinterProfileSchema = z.strictObject({
  printerId: z.uuid(),
  name: z.string().min(1).max(64),
  role: z.enum(PRINTER_ROLES),
  paperWidthMm: z.union([z.literal(58), z.literal(80)]),
  // Per-printer physical values — never derived from paper width (spec §4).
  printableDots: z.number().int().min(192).max(800),
  charsPerLine: z.number().int().min(16).max(96),
  capabilities: PrinterCapabilitiesSchema,
  transport: EndpointTcpRawSchema,
  /** Who manages this profile: the local UI or the SaaS config stream (FR-16).
   *  Default keeps pre-A1 on-disk files valid (they are all local). */
  source: z.enum(['local', 'cloud']).default('local'),
  // Cloud-sourced fields (api-contract §4) — optional: local profiles never
  // carry them; cloud-applied profiles always do. Preserved for FR-14
  // (duplicate_policy) and C1 (status_polling) to consume.
  station: z.string().max(24).optional(),
  copiesDefault: z.number().int().min(1).max(4).optional(),
  codepage: z.string().max(24).optional(),
  cutDefault: z.enum(['full', 'partial', 'none']).optional(),
  duplicatePolicy: z.enum(['ask_operator', 'auto_reprint', 'never']).optional(),
  statusPolling: z.enum(['auto', 'off']).optional(),
});
export type PrinterProfile = z.output<typeof PrinterProfileSchema>;

export const PrinterDraftSchema = PrinterProfileSchema.omit({ printerId: true, source: true });
export type PrinterDraft = z.output<typeof PrinterDraftSchema>;
