import type { TypedError } from '../../shared/errors';

/**
 * Stable machine codes for cloud-layer failures. These never carry token
 * material or server-provided strings that could contain credentials
 * (CLAUDE.md rules 6/7) — `detail` is a static, agent-authored string.
 */
export type CloudErrorCode =
  /** Base URL is not https (or insecure transport was explicitly allowed but is forbidden in production). */
  | 'insecure_transport'
  /** Request could not reach the server (DNS, TCP, TLS handshake). */
  | 'network'
  /** Request exceeded its per-request timeout. */
  | 'timeout'
  /** 401 — device token rejected. */
  | 'unauthorized'
  /** 403 — device token valid but not permitted (typically revoked scope). */
  | 'forbidden'
  /** 429 — rate limited; `retryAfterMs` carries the parsed Retry-After when present. */
  | 'rate_limited'
  /** 5xx after bounded retries. */
  | 'server_error'
  /** 4xx request rejection that is not auth (validation, used/expired pairing code, …). */
  | 'request_rejected'
  /** Body was oversized, not JSON, or failed its zod schema. */
  | 'malformed_response'
  /** Credential confirmed dead (refresh refused or revoke envelope received). Terminal. */
  | 'revoked'
  /** safeStorage unavailable or decrypt failed — secrets are never written plaintext. */
  | 'secure_storage_unavailable'
  /** No paired identity for an operation that requires one. */
  | 'not_paired';

export class CloudError extends Error implements TypedError {
  readonly code: CloudErrorCode;
  /** Static agent-authored context; never a raw server response body. */
  readonly detail?: string;
  readonly retryAfterMs?: number;
  /** The server's machine `error.code` from a 4xx body (§7.1), when present
   *  and code-shaped. Drives behavior like `device_revoked` handling; never
   *  logged raw and never echoed to the renderer. */
  readonly serverCode?: string;

  constructor(
    code: CloudErrorCode,
    detail?: string,
    retryAfterMs?: number,
    serverCode?: string,
  ) {
    super(detail === undefined ? `cloud: ${code}` : `cloud: ${code} (${detail})`);
    this.name = 'CloudError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
    if (serverCode !== undefined) this.serverCode = serverCode;
  }

  /** Network-class failures that a bounded retry with backoff may resolve. */
  static isRetryable(err: unknown): boolean {
    return (
      err instanceof CloudError &&
      (err.code === 'network' ||
        err.code === 'timeout' ||
        err.code === 'rate_limited' ||
        err.code === 'server_error')
    );
  }
}
