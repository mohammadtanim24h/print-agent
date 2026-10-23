import { writeText, type RenderContext } from './context';
import type { DocV1 } from './doc';

/**
 * Kitchen/bar/station ticket template — STUB. Task 10 fills in the full
 * layout; the header name is emitted already so the encodability policy
 * (writeText) is exercised end-to-end by tests/render-core.test.ts.
 */
export function renderKitchen(doc: DocV1, ctx: RenderContext): void {
  writeText(ctx, doc.header.restaurant_name, 'left', 'bold');
}
