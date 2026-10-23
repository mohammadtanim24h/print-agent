import { z } from 'zod';

/**
 * Doc model v1 — the normative payload of `docs/api-contract.md` §4. Strict
 * schemas: unknown fields inside payloads are rejected, not ignored (ADR-11).
 * String limits are BYTES of UTF-8 per the contract's "hard limits", so a
 * helper is used instead of zod's UTF-16-code-unit `max()`.
 */
export const PAYLOAD_MAX_BYTES = 32 * 1024;

const bytes = (max: number) =>
  z
    .string()
    .refine(
      (s) => Buffer.byteLength(s, 'utf8') <= max,
      `must be at most ${String(max)} UTF-8 bytes`,
    );

export const EMPHASIS = ['none', 'bold', 'double_height', 'double'] as const;
export const ALIGN = ['left', 'center', 'right'] as const;
export type Emphasis = (typeof EMPHASIS)[number];
export type Align = (typeof ALIGN)[number];

export const DocLineSchema = z.strictObject({
  text: bytes(96),
  qty: z.number().min(0).optional(),
  unit_price: z.number().int().optional(), // integer minor units; negative = discount
  note: bytes(64).optional(),
  emphasis: z.enum(EMPHASIS).default('none'),
  align: z.enum(ALIGN).default('left'),
});

export const DocV1Schema = z.strictObject({
  header: z.strictObject({
    restaurant_name: bytes(64),
    address_lines: z.array(bytes(48)).max(6),
    tax_id: bytes(32).optional(),
    logo_asset_id: z.uuid().optional(),
  }),
  meta: z.strictObject({
    title: bytes(24),
    order_ref: bytes(24),
    created_at: z.iso.datetime(),
    server_name: bytes(32).optional(),
    table: bytes(16).optional(),
  }),
  lines: z.array(DocLineSchema).max(200),
  totals: z
    .array(
      z.strictObject({
        label: bytes(24),
        amount_minor: z.number().int(),
        emphasis: z.enum(['none', 'bold']).default('none'),
      }),
    )
    .default([]),
  payments: z
    .array(
      z.strictObject({
        method: bytes(16),
        amount_minor: z.number().int(),
        change_minor: z.number().int().optional(),
      }),
    )
    .default([]),
  footer: z
    .strictObject({
      text_lines: z.array(bytes(48)).max(8),
      qr_data: bytes(512).optional(),
      barcode_data: bytes(48).optional(),
    })
    .default({ text_lines: [] }),
  station_hints: z
    .strictObject({
      copies: z.number().int().min(1).max(4).optional(),
      cut: z.enum(['full', 'partial', 'none']).optional(),
    })
    .default({}),
});

export type DocV1Input = z.input<typeof DocV1Schema>;
export type DocV1 = z.output<typeof DocV1Schema>;

export const DOC_TYPES = [
  'customer_receipt',
  'kitchen_ticket',
  'bar_ticket',
  'station_ticket',
] as const;
export type DocType = (typeof DOC_TYPES)[number];
