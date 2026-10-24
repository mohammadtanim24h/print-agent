import { describe, expect, it } from 'vitest';
import { createHttpTransport } from '../src/main/cloud-client/http-transport';
import { CloudError } from '../src/main/cloud-client/errors';
import {
  makeB64Url32,
  makeConfig,
  makePairResponse,
  makePollResponse,
  makeRefreshResponse,
  makeSecrets,
  JOB_ID,
} from './helpers/cloud';

/** Mocked-API tests for the HTTPS transport: success, unauthorized, malformed
 *  responses, network failures, rate limits — no real network. */

type FetchCall = { url: string; init: RequestInit };

function fetchScript(
  handler: (url: string, init: RequestInit, call: number) => Response | Promise<Response>,
): { fetchMock: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchMock = (async (url: string | URL, init: RequestInit = {}) => {
    const call = calls.length;
    calls.push({ url: String(url), init });
    return await handler(String(url), init, call);
  }) as unknown as typeof fetch;
  return { fetchMock, calls };
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const sleepInstant = (): Promise<void> => Promise.resolve();

function makeTransport(
  fetchMock: typeof fetch,
  extra: Partial<Parameters<typeof createHttpTransport>[0]> = {},
) {
  return createHttpTransport({
    baseUrl: 'https://cloud.test/api/agent/v1',
    agentVersion: '0.1.0',
    fetchImpl: fetchMock,
    sleep: sleepInstant,
    random: () => 0.5,
    ...extra,
  });
}

const auth = { deviceId: makeSecrets().deviceId, deviceToken: 'tok' };

describe('HTTPS enforcement', () => {
  it('rejects an http:// base URL', () => {
    const { fetchMock } = fetchScript(() => jsonResponse(200, {}));
    expect(() => makeTransport(fetchMock, { baseUrl: 'http://cloud.test' })).toThrow(CloudError);
  });
  it('allows http:// only with the explicit local-testing flag', () => {
    const { fetchMock } = fetchScript(() => jsonResponse(200, makePollResponse()));
    const t = makeTransport(fetchMock, {
      baseUrl: 'http://localhost:8080',
      allowInsecureHttp: true,
    });
    expect(t.baseUrl).toBe('http://localhost:8080');
  });
  it('refuses http:// even with the flag when NODE_ENV=production', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() =>
        createHttpTransport({
          baseUrl: 'http://cloud.test',
          agentVersion: '0.1.0',
          allowInsecureHttp: true,
        }),
      ).toThrow(/forbidden in production/);
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });
});

describe('success + request shape', () => {
  it('sends contract headers and parses a valid poll response', async () => {
    const { fetchMock, calls } = fetchScript(() => jsonResponse(200, makePollResponse([], 'c2')));
    const t = makeTransport(fetchMock);
    const res = await t.pollJobs(auth, 'c1');
    expect(res.next_cursor).toBe('c2');
    expect(calls[0]?.url).toBe('https://cloud.test/api/agent/v1/jobs?since=c1');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok');
    expect(headers['X-Device-Id']).toBe(auth.deviceId);
    expect(headers['X-Protocol-Version']).toBe('1');
    expect(headers['X-Agent-Version']).toBe('0.1.0');
  });

  it('omits the cursor param on the first poll', async () => {
    const { fetchMock, calls } = fetchScript(() => jsonResponse(200, makePollResponse()));
    const t = makeTransport(fetchMock);
    await t.pollJobs(auth, '');
    expect(calls[0]?.url).toBe('https://cloud.test/api/agent/v1/jobs');
  });

  it('pair posts the pairing body and returns the credential', async () => {
    const { fetchMock, calls } = fetchScript(() => jsonResponse(200, makePairResponse()));
    const t = makeTransport(fetchMock);
    const res = await t.pair({
      pairing_code: 'ABCD1234',
      device_pubkey: makeB64Url32(),
      device_name: 'Cashier PC',
      agent_version: '0.1.0',
    });
    expect(res.device_id).toBeDefined();
    expect(calls[0]?.init.method).toBe('POST');
  });

  it('refresh posts the refresh token without a bearer header', async () => {
    const { fetchMock, calls } = fetchScript(() => jsonResponse(200, makeRefreshResponse()));
    const t = makeTransport(fetchMock);
    await t.refresh('refresh-token-abc');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      refresh_token: 'refresh-token-abc',
    });
  });
});

describe('error mapping', () => {
  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
  ])('maps %i to %s', async (status, code) => {
    const { fetchMock } = fetchScript(() => jsonResponse(status, { error: { code, message: '' } }));
    await expect(makeTransport(fetchMock).pollJobs(auth, '')).rejects.toMatchObject({ code });
  });

  it('maps 429 to rate_limited and parses Retry-After seconds', async () => {
    const { fetchMock } = fetchScript(() =>
      jsonResponse(429, { error: { code: 'rate_limited' } }, { 'Retry-After': '7' }),
    );
    const err = await makeTransport(fetchMock)
      .pollJobs(auth, '')
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'rate_limited', retryAfterMs: 7000 });
  });

  it('maps 5xx to server_error with the status code', async () => {
    const { fetchMock } = fetchScript(() => jsonResponse(503, {}));
    await expect(makeTransport(fetchMock).pollJobs(auth, '')).rejects.toMatchObject({
      code: 'server_error',
      detail: 'status 503',
    });
  });

  it('surfaces a code-shaped server error code on 4xx without echoing free text', async () => {
    const { fetchMock } = fetchScript(() =>
      jsonResponse(422, { error: { code: 'pairing_code_expired', message: 'secret-ish detail' } }),
    );
    const err = await makeTransport(fetchMock)
      .pair({
        pairing_code: 'BADCODE1',
        device_pubkey: makeB64Url32(),
        device_name: 'n',
        agent_version: 'v',
      })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'request_rejected',
      detail: 'status 422: pairing_code_expired',
    });
  });

  it('network failure maps to network', async () => {
    const { fetchMock } = fetchScript(() => {
      throw new TypeError('fetch failed');
    });
    await expect(makeTransport(fetchMock).pollJobs(auth, '')).rejects.toMatchObject({
      code: 'network',
    });
  });

  it('abort timeout maps to timeout', async () => {
    const { fetchMock } = fetchScript(() => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    });
    await expect(makeTransport(fetchMock).pollJobs(auth, '')).rejects.toMatchObject({
      code: 'timeout',
    });
  });
});

describe('malformed responses', () => {
  it('non-JSON 200 body', async () => {
    const { fetchMock } = fetchScript(() => new Response('<html>not json</html>', { status: 200 }));
    await expect(makeTransport(fetchMock).pollJobs(auth, '')).rejects.toMatchObject({
      code: 'malformed_response',
    });
  });

  it('schema-invalid 200 body (unknown field in poll response)', async () => {
    const { fetchMock } = fetchScript(() =>
      jsonResponse(200, { jobs: [], next_cursor: 'c', extra: 1 }),
    );
    await expect(makeTransport(fetchMock).pollJobs(auth, '')).rejects.toMatchObject({
      code: 'malformed_response',
    });
  });

  it('oversized declared body is rejected before parsing', async () => {
    const { fetchMock } = fetchScript(() =>
      jsonResponse(200, makeConfig(1), { 'Content-Length': String(5 * 1024 * 1024) }),
    );
    await expect(makeTransport(fetchMock).getConfig(auth)).rejects.toMatchObject({
      code: 'malformed_response',
    });
  });

  it('204 is accepted for empty-body endpoints', async () => {
    const { fetchMock, calls } = fetchScript(() => new Response(null, { status: 204 }));
    const t = makeTransport(fetchMock);
    await expect(
      t.heartbeat(auth, {
        uptime_s: 1,
        queue_depth: 0,
        connection: 'poll',
        printers: [],
      }),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

describe('bounded retries', () => {
  it('retries idempotent GETs on 5xx with backoff and succeeds', async () => {
    let count = 0;
    const { fetchMock, calls } = fetchScript(() => {
      count += 1;
      return count < 3 ? jsonResponse(502, {}) : jsonResponse(200, makePollResponse());
    });
    const t = makeTransport(fetchMock);
    await expect(t.pollJobs(auth, '')).resolves.toBeDefined();
    expect(calls).toHaveLength(3);
  });

  it('honours Retry-After on 429 then succeeds', async () => {
    const sleeps: number[] = [];
    let count = 0;
    const { fetchMock, calls } = fetchScript(() => {
      count += 1;
      return count === 1
        ? jsonResponse(429, {}, { 'Retry-After': '2' })
        : jsonResponse(200, makePollResponse());
    });
    const t = makeTransport(fetchMock, {
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    await expect(t.pollJobs(auth, '')).resolves.toBeDefined();
    expect(sleeps).toEqual([2000]);
    expect(calls).toHaveLength(2);
  });

  it('gives up after maxAttempts and throws the last error', async () => {
    const { fetchMock, calls } = fetchScript(() => jsonResponse(500, {}));
    const t = makeTransport(fetchMock, { retry: { maxAttempts: 3 } });
    await expect(t.pollJobs(auth, '')).rejects.toMatchObject({ code: 'server_error' });
    expect(calls).toHaveLength(3);
  });

  it('never retries 401', async () => {
    const { fetchMock, calls } = fetchScript(() => jsonResponse(401, {}));
    await expect(makeTransport(fetchMock).pollJobs(auth, '')).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect(calls).toHaveLength(1);
  });

  it('never retries pair (single-use code) even on network failure', async () => {
    const { fetchMock, calls } = fetchScript(() => {
      throw new TypeError('fetch failed');
    });
    const t = makeTransport(fetchMock);
    await expect(
      t.pair({
        pairing_code: 'XCODE',
        device_pubkey: makeB64Url32(),
        device_name: 'n',
        agent_version: 'v',
      }),
    ).rejects.toMatchObject({ code: 'network' });
    expect(calls).toHaveLength(1);
  });

  it('never retries refresh (token rotation) even on network failure', async () => {
    const { fetchMock, calls } = fetchScript(() => {
      throw new TypeError('fetch failed');
    });
    await expect(makeTransport(fetchMock).refresh('r')).rejects.toMatchObject({ code: 'network' });
    expect(calls).toHaveLength(1);
  });

  it('retries ack batches (idempotent by job_id+attempt)', async () => {
    let count = 0;
    const { fetchMock, calls } = fetchScript(() => {
      count += 1;
      return count < 2
        ? jsonResponse(503, {})
        : jsonResponse(200, { results: [{ job_id: JOB_ID, result: 'applied' }] });
    });
    const t = makeTransport(fetchMock);
    await expect(
      t.sendAcks(auth, {
        envelope_version: 1,
        type: 'ack',
        acks: [
          {
            job_id: JOB_ID,
            status: 'accepted',
            printer_status: 'unknown',
            printed: false,
            attempt: 1,
            at: '2026-10-22T10:00:01.250Z',
          },
        ],
      }),
    ).resolves.toEqual({ results: [{ job_id: JOB_ID, result: 'applied' }] });
    expect(calls).toHaveLength(2);
  });

  it('parses every §7.1 ack result value', async () => {
    const results = [
      { job_id: JOB_ID, result: 'applied' },
      { job_id: JOB_ID, result: 'duplicate' },
      { job_id: JOB_ID, result: 'stale' },
      { job_id: JOB_ID, result: 'not_found' },
      { job_id: JOB_ID, result: 'rejected' },
    ];
    const { fetchMock } = fetchScript(() => jsonResponse(200, { results }));
    const t = makeTransport(fetchMock);
    await expect(t.sendAcks(auth, makeAckBatch())).resolves.toEqual({ results });
  });

  it('rejects a 200 ack response without the results array (malformed_response)', async () => {
    const { fetchMock, calls } = fetchScript(() => jsonResponse(200, {}));
    const t = makeTransport(fetchMock);
    await expect(t.sendAcks(auth, makeAckBatch())).rejects.toMatchObject({
      code: 'malformed_response',
    });
    expect(calls).toHaveLength(1);
  });
});

function makeAckBatch(): {
  envelope_version: 1;
  type: 'ack';
  acks: [
    {
      job_id: string;
      status: 'accepted';
      printer_status: 'unknown';
      printed: false;
      attempt: number;
      at: string;
    },
  ];
} {
  return {
    envelope_version: 1,
    type: 'ack',
    acks: [
      {
        job_id: JOB_ID,
        status: 'accepted',
        printer_status: 'unknown',
        printed: false,
        attempt: 1,
        at: '2026-10-22T10:00:01.250Z',
      },
    ],
  };
}

describe('outbound payloads are schema-checked', () => {
  it('rejects an ack batch with an invalid shape before any request', async () => {
    const { fetchMock, calls } = fetchScript(() => new Response(null, { status: 204 }));
    const t = makeTransport(fetchMock);
    await expect(
      t.sendAcks(auth, {
        envelope_version: 1,
        type: 'ack',
        acks: [
          {
            job_id: 'not-a-uuid',
            status: 'accepted',
            printer_status: 'ok',
            printed: false,
            attempt: 1,
            at: 'x',
          } as never,
        ],
      }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('server error.code capture (§7.1)', () => {
  it('attaches the machine error.code from a 401 body', async () => {
    const { fetchMock } = fetchScript(() =>
      jsonResponse(401, { error: { code: 'device_revoked', message: 'revoked' } }),
    );
    await expect(makeTransport(fetchMock).pollJobs(auth, '')).rejects.toMatchObject({
      code: 'unauthorized',
      serverCode: 'device_revoked',
    });
  });

  it('attaches error.code from 4xx rejections (pairing UX)', async () => {
    const { fetchMock } = fetchScript(() =>
      jsonResponse(410, { error: { code: 'pairing_code_expired', message: 'x' } }),
    );
    await expect(
      makeTransport(fetchMock).pair({
        pairing_code: 'ABCD1234',
        device_pubkey: makeB64Url32(),
        device_name: 'n',
        agent_version: 'v',
      }),
    ).rejects.toMatchObject({ code: 'request_rejected', serverCode: 'pairing_code_expired' });
  });

  it('omits serverCode when the body carries no code-shaped error.code', async () => {
    const { fetchMock } = fetchScript(() => jsonResponse(401, { nope: true }));
    await expect(makeTransport(fetchMock).pollJobs(auth, '')).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });
});
