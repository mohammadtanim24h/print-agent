import { writeText, type RenderContext } from './context';
import type { DocV1 } from './doc';

/**
 * Customer receipt template — STUB. Task 9 fills in the full layout; the
 * header name is emitted already so the encodability policy (writeText) is
 * exercised end-to-end by tests/render-core.test.ts.
 */
export function renderReceipt(doc: DocV1, ctx: RenderContext): void {
  writeText(ctx, doc.header.restaurant_name, 'center', 'double_height');
}
