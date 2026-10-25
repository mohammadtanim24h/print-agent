import { resolve, sep } from 'node:path';
// Type-only import: erased at runtime, so this module stays electron-free for vitest.
import type { CustomScheme } from 'electron';

/**
 * The renderer is served over a privileged custom scheme instead of file://:
 * the `GrantFileProtocolExtraPrivileges` fuse (P0 security set) disables
 * file://-from-asar reads, which broke packaged renderer loading
 * (ERR_FILE_NOT_FOUND). fs-level asar reads — how this handler serves bytes —
 * are core Electron and fuse-independent.
 */
export const RENDERER_SCHEME = 'app';
export const RENDERER_HOST = 'bundle';
export const RENDERER_ORIGIN_PREFIX = `app://${RENDERER_HOST}/`;

/** Must be passed to protocol.registerSchemesAsPrivileged BEFORE app.ready. */
export const rendererSchemePrivileges: CustomScheme[] = [
  {
    scheme: RENDERER_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      codeCache: true,
    },
  },
];

/**
 * Pure URL→disk-path resolution for `app://bundle/<path>`; returns undefined
 * for anything that is not exactly host `bundle` or escapes the renderer
 * root (path traversal). Exported for unit tests.
 */
export function resolveRendererUrl(
  rendererRoot: string,
  rawUrl: string,
): string | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== `${RENDERER_SCHEME}:` || url.hostname !== RENDERER_HOST)
    return undefined;
  if (url.pathname.includes('\0')) return undefined;
  // decodeURIComponent: standard-scheme URLs percent-encode path segments.
  let relative: string;
  try {
    relative = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  } catch {
    return undefined;
  }
  if (relative === '') return undefined;
  const root = resolve(rendererRoot);
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(root + sep)) return undefined;
  return target;
}

/** Minimal content-type map — the bundled renderer ships exactly these types. */
export function rendererContentType(filePath: string): string {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}
