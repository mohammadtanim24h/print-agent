import { CloudError } from './errors';

/**
 * WSS push channel (api-contract §1): agent-initiated, outbound-only socket
 * that receives server envelopes and carries §3.2 heartbeats. Owns the
 * socket lifecycle only — tokens, envelope validation and scheduling stay
 * with the polling client.
 *
 * Security posture (mirrors http-transport.ts):
 * - wss:// only; plaintext ws:// is refused outright in production builds
 *   (`allowInsecureWs` exists solely for local integration tests).
 * - TLS certificate verification is never disabled.
 * - The device token travels in the upgrade `Authorization` header and is
 *   never logged; logs carry close codes and static messages only.
 * - Inbound frames are size-capped and JSON-parsed defensively; zod
 *   validation happens downstream in `parseServerMessage` (single funnel).
 */

/** Close code the server uses for auth failures on the socket (§1, additive). */
export const WS_AUTH_CLOSE_CODE = 4401;

/**
 * REST base URL → §1 WSS endpoint (https→wss; http→ws for local dev).
 * Precondition: `baseUrl` has already been validated by the HTTP transport's
 * `assertSecureBaseUrl` (https/http only) — any other scheme maps blindly to ws.
 */
export function deriveWssUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/agent/v1/ws';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function assertWssUrl(raw: string, allowInsecureWs: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CloudError('insecure_transport', 'WSS URL is not a valid URL');
  }
  if (url.protocol === 'wss:') return raw;
  if (url.protocol === 'ws:' && allowInsecureWs) {
    if (process.env.NODE_ENV === 'production') {
      throw new CloudError('insecure_transport', 'insecure WS is forbidden in production builds');
    }
    return raw;
  }
  throw new CloudError('insecure_transport', 'WSS URL must use wss');
}
