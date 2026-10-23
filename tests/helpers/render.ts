import type { DocV1Input } from '../../src/main/render/doc';
import { DEFAULT_80MM_PROFILE, type RenderProfile } from '../../src/main/render/profile';

// Overrides use the schema *input* type: fields with zod defaults (emphasis,
// align, totals, ...) are optional here and applied on parse.
export function makeDoc(overrides: Partial<DocV1Input> = {}): DocV1Input {
  return {
    header: {
      restaurant_name: 'Test Cafe',
      address_lines: ['12 Main St'],
    },
    meta: {
      title: 'RECEIPT',
      order_ref: 'ORD-1001',
      created_at: '2026-10-22T10:00:00.000Z',
    },
    lines: [{ text: 'Coffee', qty: 2, unit_price: 1200, emphasis: 'none', align: 'left' }],
    totals: [{ label: 'TOTAL', amount_minor: 2400, emphasis: 'bold' }],
    payments: [],
    footer: { text_lines: [] },
    station_hints: {},
    ...overrides,
  };
}

export function makeRenderProfile(overrides: Partial<RenderProfile> = {}): RenderProfile {
  return { ...DEFAULT_80MM_PROFILE, ...overrides };
}
