/**
 * Content-Security-Policy for the renderer.
 *
 * Production policy is the strict default: everything from bundled app
 * resources only, no inline, no eval, no remote.
 *
 * The dev variant exists solely for the local Vite dev server: React fast
 * refresh requires an inline bootstrap script and HMR needs a websocket to
 * the local dev origin. It is never shipped — the built renderer bakes the
 * strict policy into index.html (and window.ts injects the matching header).
 */
export interface CspEnv {
  readonly dev?: boolean;
}

export function getCsp(env: CspEnv = {}): string {
  const dev = env.dev === true;
  const scriptSrc = dev ? "'self' 'unsafe-inline'" : "'self'";
  const styleSrc = dev ? "'self' 'unsafe-inline'" : "'self'";
  const connectSrc = dev ? "'self' ws://localhost:* ws://127.0.0.1:*" : "'self'";
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    `style-src ${styleSrc}`,
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connectSrc}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}
