import { isIP } from 'node:net';
import { z } from 'zod';

export const PRINTER_ROLES = ['kitchen', 'receipt', 'bar', 'custom'] as const;
export type PrinterRole = (typeof PRINTER_ROLES)[number];

/**
 * Approved-destination policy (spec §3): hosts must be IPv4/IPv6 literals.
 * Rejected: unspecified, loopback, multicast and reserved ranges. Private LAN
 * ranges (10/8, 172.16/12, 192.168/16, IPv6 ULA fc00::/7) are the normal case
 * and allowed. No DNS — there is no name-resolution surface in v1, and no
 * network scanning anywhere.
 */
export function isApprovedEndpointHost(host: string): boolean {
  const version = isIP(host);
  if (version === 4) {
    const first = Number.parseInt(host.split('.')[0] ?? '', 10);
    return first !== 0 && first !== 127 && first < 224;
  }
  if (version === 6) {
    const h = host.toLowerCase();
    return h !== '::' && h !== '::1' && !h.startsWith('ff');
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
  port: z.number().int().min(1).max(65535),
});

export const PrinterCapabilitiesSchema = z.strictObject({
  cut: z.boolean(),
  qrCode: z.boolean(),
  barcode128: z.boolean(),
  statusPolling: z.boolean(),
  cashDrawer: z.boolean(),
});
export type PrinterCapabilities = z.output<typeof PrinterCapabilitiesSchema>;

/** Conservative capability defaults (printer-compatibility.md §4 policy). */
export const PRINTER_CAPABILITIES_DEFAULTS: PrinterCapabilities = {
  cut: false,
  qrCode: false,
  barcode128: false,
  statusPolling: false,
  cashDrawer: false,
};

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
});
export type PrinterProfile = z.output<typeof PrinterProfileSchema>;

export const PrinterDraftSchema = PrinterProfileSchema.omit({ printerId: true });
export type PrinterDraft = z.output<typeof PrinterDraftSchema>;
