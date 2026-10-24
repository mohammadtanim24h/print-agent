import type { AgentTransport, TransportAuth, AckBatch } from './types';
import {
  AckBatchSchema,
  AckResultsResponseSchema,
  ApiErrorSchema,
  ConfigUpdateSchema,
  HeartbeatSchema,
  PairRequestSchema,
  PairResponseSchema,
  PollResponseSchema,
  RefreshResponseSchema,
  ServerKeysResponseSchema,
  PROTOCOL_VERSION,
  type AckResultsResponse,
  type PairRequest,
  type PairResponse,
  type RefreshResponse,
} from './schemas';
import type { HeartbeatSample } from './types';
import { CloudError } from './errors';
import { DEFAULT_RETRY_POLICY, nextBackoffMs, type RetryPolicy } from './backoff';
import type { ZodType } from 'zod';
import { z } from 'zod';

/**
 * HTTPS fetch implementation of `AgentTransport` (api-contract §3.3).
 *
 * Security posture:
 * - HTTPS only. `allowInsecureHttp` exists solely for local integration
 *   testing; it is refused outright in production builds.
 * - TLS certificate verification is never disabled: the platform fetch is
 *   used with default certificate validation and no custom dispatcher/agent.
 * - Every response body is size-capped before parsing; every parsed body is
 *   zod-validated.
 * - Bounded retries with exponential backoff + full jitter apply only to
 *   idempotent operations (poll, config, keys, acks, heartbeat). `pair` and
 *   `refresh` are never retried here: the pairing code is single-use and
 *   token refresh rotates state, so an ambiguous result must surface to the
 *   caller instead of being replayed.
 * - `POST /acks` returns 200 with a per-ack results array (§7.1), not the
 *   draft's bare 204.
 */

const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024; // 100 jobs × 32 KiB payload + envelope overhead
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export interface HttpTransportOptions {
  readonly baseUrl: string;
  readonly agentVersion: string;
  /** Local-integration escape hatch; refused outright in production. */
  readonly allowInsecureHttp?: boolean;
  readonly requestTimeoutMs?: number;
  readonly retry?: Partial<RetryPolicy>;
  /** Injected for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

function assertSecureBaseUrl(baseUrl: string, allowInsecure: boolean): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new CloudError('insecure_transport', 'base URL is not a valid URL');
  }
  if (url.protocol === 'https:') return baseUrl;
  if (url.protocol === 'http:' && allowInsecure) {
    if (process.env.NODE_ENV === 'production') {
      throw new CloudError('insecure_transport', 'insecure HTTP is forbidden in production builds');
    }
    return baseUrl;
  }
  throw new CloudError('insecure_transport', 'base URL must use https');
}

async function parseJsonResponse(res: Response): Promise<unknown> {
  const lengthHeader = res.headers.get('content-length');
  if (lengthHeader !== null) {
    const declared = Number(lengthHeader);
    if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) {
      throw new CloudError('malformed_response', 'declared body exceeds size cap');
    }
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_JSON_BODY_BYTES) {
    throw new CloudError('malformed_response', 'body exceeds size cap');
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buf)) as unknown;
  } catch {
    throw new CloudError('malformed_response', 'body is not valid UTF-8 JSON');
  }
}

function statusToError(res: Response, body: unknown): CloudError {
  // The server's machine `error.code` (§7.1) is captured on every 4xx so the
  // client can react to semantics like `device_revoked` / `invalid_token`
  // instead of just the HTTP status.
  const parsed = ApiErrorSchema.safeParse(body);
  const rawCode = parsed.success ? parsed.data.error.code : undefined;
  const safeCode =
    typeof rawCode === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(rawCode) ? rawCode : undefined;
  const withCode = (err: CloudError): CloudError =>
    safeCode === undefined ? err : new CloudError(err.code, err.detail, err.retryAfterMs, safeCode);
  if (res.status === 401) return withCode(new CloudError('unauthorized'));
  if (res.status === 403) return withCode(new CloudError('forbidden'));
  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after');
    let retryAfterMs: number | undefined;
    if (retryAfter !== null) {
      const seconds = Number(retryAfter);
      retryAfterMs = Number.isFinite(seconds)
        ? Math.max(0, seconds) * 1000
        : Math.max(0, Date.parse(retryAfter) - Date.now());
    }
    return withCode(new CloudError('rate_limited', undefined, retryAfterMs));
  }
  if (res.status >= 500) return new CloudError('server_error', `status ${String(res.status)}`);
  // Other 4xx: surface the server's machine code for pairing/validation UX,
  // but keep the detail constrained to a code-shaped token (never echo raw
  // server text).
  return new CloudError(
    'request_rejected',
    `status ${String(res.status)}${safeCode === undefined ? '' : `: ${safeCode}`}`,
    undefined,
    safeCode,
  );
}

/** 204/empty-body endpoints still get a schema (accepting only an empty object). */
const EmptyResponseSchema: ZodType<Record<string, never>> = z.strictObject({});

export function createHttpTransport(options: HttpTransportOptions): AgentTransport {
  const baseUrl = assertSecureBaseUrl(options.baseUrl, options.allowInsecureHttp === true);
  const trimmed = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  const sleep =
    options.sleep ??
    ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const retry: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  async function parseErrorBodyOrNothing(res: Response): Promise<unknown> {
    try {
      return await parseJsonResponse(res);
    } catch {
      return undefined; // error bodies may be empty; the status is authoritative
    }
  }

  async function requestOnce<T>(
    method: 'GET' | 'POST',
    path: string,
    schema: ZodType<T>,
    init: { auth?: TransportAuth; body?: unknown },
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Agent-Version': options.agentVersion,
      'X-Protocol-Version': PROTOCOL_VERSION,
    };
    if (init.auth !== undefined) {
      headers.Authorization = `Bearer ${init.auth.deviceToken}`;
      headers['X-Device-Id'] = init.auth.deviceId;
    }
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const requestInit: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      // Intentionally no dispatcher/custom agent: certificate verification
      // stays at platform defaults and can never be disabled from here.
    };
    if (init.body !== undefined) requestInit.body = JSON.stringify(init.body);
    let res: Response;
    try {
      res = await fetchImpl(`${trimmed}${path}`, requestInit);
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new CloudError('timeout');
      }
      throw new CloudError('network');
    }
    if (!res.ok) {
      throw statusToError(res, await parseErrorBodyOrNothing(res));
    }
    const parsed = res.status === 204 ? ({} as unknown) : await parseJsonResponse(res);
    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      throw new CloudError('malformed_response', `schema rejected ${path} response`);
    }
    return validated.data;
  }

  /** Retry loop for idempotent operations only. */
  async function requestWithRetry<T>(
    method: 'GET' | 'POST',
    path: string,
    schema: ZodType<T>,
    init: { auth?: TransportAuth; body?: unknown },
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await requestOnce(method, path, schema, init);
      } catch (err) {
        if (attempt >= retry.maxAttempts || !CloudError.isRetryable(err)) throw err;
        const suggested = err instanceof CloudError ? err.retryAfterMs : undefined;
        await sleep(suggested ?? nextBackoffMs(retry, attempt, random));
      }
    }
  }

  const authed = (auth: TransportAuth): { auth: TransportAuth } => ({ auth });

  return {
    baseUrl: trimmed,
    async pair(request: PairRequest): Promise<PairResponse> {
      // Outbound is schema-checked too; async so violations reject, never throw sync.
      const body = PairRequestSchema.parse(request);
      return requestOnce('POST', '/pair', PairResponseSchema, { body });
    },
    async refresh(refreshToken: string): Promise<RefreshResponse> {
      return requestOnce('POST', '/token/refresh', RefreshResponseSchema, {
        body: { refresh_token: refreshToken },
      });
    },
    pollJobs(auth, since) {
      const query = since === '' ? '' : `?since=${encodeURIComponent(since)}`;
      return requestWithRetry('GET', `/jobs${query}`, PollResponseSchema, authed(auth));
    },
    async sendAcks(auth: TransportAuth, batch: AckBatch): Promise<AckResultsResponse> {
      const body = AckBatchSchema.parse(batch);
      // §7.1 deviation: the server answers 200 with { results: [...] }, not 204.
      return requestWithRetry('POST', '/acks', AckResultsResponseSchema, {
        ...authed(auth),
        body,
      });
    },
    getConfig(auth) {
      return requestWithRetry('GET', '/config', ConfigUpdateSchema, authed(auth));
    },
    async heartbeat(auth: TransportAuth, sample: HeartbeatSample): Promise<void> {
      const body = HeartbeatSchema.parse({
        type: 'heartbeat' as const,
        agent_version: options.agentVersion,
        ...sample,
      });
      await requestWithRetry('POST', '/heartbeat', EmptyResponseSchema, { ...authed(auth), body });
    },
    serverKeys(auth) {
      return requestWithRetry('GET', '/server-keys', ServerKeysResponseSchema, authed(auth));
    },
  };
}
