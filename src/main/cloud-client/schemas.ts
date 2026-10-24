import { z } from 'zod';
import { DocV1Schema, DOC_TYPES } from '../render/doc';
import { ACK_STATUSES } from '../jobs/types';

/**
 * Wire schemas for `docs/api-contract.md` v1 (normative). Every boundary
 * message is validated here first; unknown fields inside payloads are
 * rejected, unknown fields at envelope top level are ignored (forward-safe,
 * contract §5.2). String limits are UTF-8 bytes like the contract's hard
 * limits. Size caps are part of every schema (CLAUDE.md rule 3).
 */

export const PROTOCOL_VERSION = '1';
export const ENVELOPE_VERSION = 1;

const bytes = (max: number) =>
  z
    .string()
    .refine(
      (s) => Buffer.byteLength(s, 'utf8') <= max,
      `must be at most ${String(max)} UTF-8 bytes`,
    );

const b64url = (bytesLen: number) =>
  z
    .string()
    .refine((s) => {
      const buf = Buffer.from(s, 'base64url');
      return buf.length === bytesLen && Buffer.from(buf.toString('base64url')).equals(Buffer.from(s));
    }, `must be base64url-encoded ${String(bytesLen)} bytes`);

/** Printer/transport health values shared by heartbeats and acks. */
export const PRINTER_STATUSES = [
  'ok',
  'unknown',
  'offline',
  'paper_out',
  'paper_low',
  'cover_open',
] as const;

// ---------------------------------------------------------------------------
// Inbound: job envelope (§2)
// ---------------------------------------------------------------------------

export const PrintJobSchema = z.strictObject({
  job_id: z.uuid(),
  idempotency_key: bytes(128),
  tenant_id: z.uuid(),
  restaurant_id: z.uuid(),
  printer_id: z.uuid(),
  priority: z.number().int().min(1).max(9),
  copies: z.number().int().min(1).max(4),
  doc_type: z.enum(DOC_TYPES),
  doc_version: z.number().int().min(1).max(99),
  issued_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  payload: DocV1Schema,
});

export type PrintJob = z.output<typeof PrintJobSchema>;

/** Envelope top level is loose (§5.2: additive fields forward-safe); `job` is strict. */
export const PrintJobEnvelopeSchema = z.looseObject({
  envelope_version: z.literal(ENVELOPE_VERSION),
  type: z.literal('print_job'),
  job: PrintJobSchema,
  sig: b64url(64), // ed25519 signature = 64 raw bytes
});

export type PrintJobEnvelope = z.output<typeof PrintJobEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Inbound: config update (§4)
// ---------------------------------------------------------------------------

const TRANSPORT_TIMEOUT_MIN = 100;
const TRANSPORT_TIMEOUT_MAX = 60_000;

export const PrinterConfigSchema = z.strictObject({
  printer_id: z.uuid(),
  name: bytes(64),
  transport: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('tcp_raw'),
      /** Hostname or IP literal; never executed directly — the transport
       *  registry binds it to a configured printer_id at print time. */
      host: bytes(253).refine((s) => !/[\s\x00-\x1f\x7f/\\]/.test(s), 'invalid host'),
      port: z.number().int().min(1).max(65535),
      connect_timeout_ms: z
        .number()
        .int()
        .min(TRANSPORT_TIMEOUT_MIN)
        .max(TRANSPORT_TIMEOUT_MAX),
      write_timeout_ms: z.number().int().min(TRANSPORT_TIMEOUT_MIN).max(TRANSPORT_TIMEOUT_MAX),
    }),
    z.strictObject({
      kind: z.literal('spooler_raw'),
      windows_printer_name: bytes(128),
    }),
    z.strictObject({
      kind: z.literal('usb'),
      vid: z.string().regex(/^[0-9a-fA-F]{4}$/),
      pid: z.string().regex(/^[0-9a-fA-F]{4}$/),
    }),
  ]),
  station: bytes(24),
  copies_default: z.number().int().min(1).max(4),
  codepage: bytes(24),
  cut_default: z.enum(['full', 'partial', 'none']),
  duplicate_policy: z.enum(['ask_operator', 'auto_reprint', 'never']),
  status_polling: z.enum(['auto', 'off']),
});

export type PrinterConfig = z.output<typeof PrinterConfigSchema>;

export const ConfigUpdateSchema = z.looseObject({
  envelope_version: z.literal(ENVELOPE_VERSION).optional(),
  type: z.literal('config_update'),
  config_version: z.number().int().min(0).max(2_147_483_647),
  printers: z.array(PrinterConfigSchema).max(50),
});

export type ConfigUpdate = z.output<typeof ConfigUpdateSchema>;

// ---------------------------------------------------------------------------
// Inbound: revoke / ping (§3.5)
// ---------------------------------------------------------------------------

export const RevokeMessageSchema = z.looseObject({
  type: z.literal('revoke'),
  reason: bytes(64),
});

export const PingMessageSchema = z.looseObject({
  type: z.literal('ping'),
});

/** One validated server → agent message (poll item or future WSS frame). */
export type ServerMessage =
  | { readonly kind: 'print_job'; readonly envelope: PrintJobEnvelope }
  | { readonly kind: 'config_update'; readonly config: ConfigUpdate }
  | { readonly kind: 'revoke'; readonly reason: string }
  | { readonly kind: 'ping' }
  /** Known type with unknown envelope_version major — refused with a
   *  structured error (§5.1) so the server can hold or route to upgrade. */
  | { readonly kind: 'unsupported_version'; readonly envelopeVersion: number }
  | { readonly kind: 'malformed' };

export function parseServerMessage(raw: unknown): ServerMessage {
  if (typeof raw !== 'object' || raw === null) return { kind: 'malformed' };
  const version = (raw as { envelope_version?: unknown }).envelope_version;
  const type = (raw as { type?: unknown }).type;
  if (
    (type === 'print_job' || type === 'config_update') &&
    typeof version === 'number' &&
    version !== ENVELOPE_VERSION
  ) {
    return { kind: 'unsupported_version', envelopeVersion: version };
  }
  const asJob = PrintJobEnvelopeSchema.safeParse(raw);
  if (asJob.success) return { kind: 'print_job', envelope: asJob.data };
  const asConfig = ConfigUpdateSchema.safeParse(raw);
  if (asConfig.success) return { kind: 'config_update', config: asConfig.data };
  const asRevoke = RevokeMessageSchema.safeParse(raw);
  if (asRevoke.success) return { kind: 'revoke', reason: asRevoke.data.reason };
  const asPing = PingMessageSchema.safeParse(raw);
  if (asPing.success) return { kind: 'ping' };
  return { kind: 'malformed' };
}

// ---------------------------------------------------------------------------
// Inbound: poll response, pairing, refresh, server keys, RFC 7807 errors
// ---------------------------------------------------------------------------

export const PollResponseSchema = z.strictObject({
  jobs: z.array(z.unknown()).max(100),
  /** Server cursor for the next poll; omitted/empty when the agent is caught up. */
  next_cursor: bytes(128).optional(),
});

export type PollResponse = z.output<typeof PollResponseSchema>;

export const PairResponseSchema = z.strictObject({
  device_id: z.uuid(),
  device_token: bytes(2048),
  refresh_token: bytes(2048),
  server_signing_pubkey: b64url(32),
  restaurant_id: z.uuid(),
  tenant_id: z.uuid(),
  token_ttl_s: z.number().int().min(1).max(86_400),
});

export type PairResponse = z.output<typeof PairResponseSchema>;

export const RefreshResponseSchema = z.strictObject({
  device_token: bytes(2048),
  refresh_token: bytes(2048),
  token_ttl_s: z.number().int().min(1).max(86_400),
});

export type RefreshResponse = z.output<typeof RefreshResponseSchema>;

export const ServerKeysResponseSchema = z.strictObject({
  keys: z
    .array(
      z.strictObject({
        kid: bytes(64),
        public_key: b64url(32),
        active: z.boolean(),
      }),
    )
    .max(5),
});

export type ServerKeysResponse = z.output<typeof ServerKeysResponseSchema>;

/** RFC 7807-style error body (§1). Parsed for `code` only — message/details
 *  are never echoed into logs (they could carry injected content). */
export const ApiErrorSchema = z.looseObject({
  error: z.looseObject({
    code: bytes(64),
    message: bytes(1024).optional(),
    details: z.unknown().optional(),
  }),
});

// ---------------------------------------------------------------------------
// Outbound: pairing, acks, heartbeat (§3.1, §3.2, §3.4)
// ---------------------------------------------------------------------------

export const PairRequestSchema = z.strictObject({
  pairing_code: bytes(64),
  device_pubkey: b64url(32),
  device_name: bytes(64),
  agent_version: bytes(32),
});

export type PairRequest = z.output<typeof PairRequestSchema>;

export const AckItemSchema = z.strictObject({
  job_id: z.uuid(),
  status: z.enum(ACK_STATUSES),
  printer_status: z.enum(PRINTER_STATUSES),
  printed: z.literal(false), // contract v1 has no printed:true (§3.1)
  attempt: z.number().int().min(1).max(999),
  at: z.iso.datetime(),
  error: z
    .strictObject({
      code: bytes(64),
      message: bytes(512),
    })
    .optional(),
});

export const AckBatchSchema = z.strictObject({
  envelope_version: z.literal(ENVELOPE_VERSION),
  type: z.literal('ack'),
  acks: z.array(AckItemSchema).max(100),
});

export const HeartbeatSchema = z.strictObject({
  type: z.literal('heartbeat'),
  agent_version: bytes(32),
  uptime_s: z.number().int().min(0),
  queue_depth: z.number().int().min(0),
  /** 'wss' when a wake-up channel exists; 'poll' for polling-only agents
   *  (additive value documented in api-contract.md §3.2). */
  connection: z.enum(['wss', 'poll']),
  printers: z
    .array(
      z.strictObject({
        printer_id: z.uuid(),
        health: z.enum(PRINTER_STATUSES),
        last_print_at: z.iso.datetime().optional(),
      }),
    )
    .max(50),
});

export type Heartbeat = z.output<typeof HeartbeatSchema>;
