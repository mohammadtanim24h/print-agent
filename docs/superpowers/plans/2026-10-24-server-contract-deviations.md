# Server-Contract Deviations (§7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agent comply with the six §7 deviations + two hardening extensions the Laravel team shipped (REST-only polling, ack results array, persist-then-swap refresh, bad_signature/expired_job codes, device_revoked handling, revoked→re-pair recovery).

**Architecture:** All changes land in `src/main/cloud-client/` (schemas, transport, poller, secret-store), one error-code rename in `src/main/jobs/engine.ts`, and doc cross-reference pointers in `docs/api-contract.md` §1–§6. The client is already polling-only and dispatches control envelopes; the gaps are ack-result parsing, refresh persistence ordering/atomicity, sig-rejection code naming, null-sig stranding, and revoked-device recovery.

**Tech Stack:** TypeScript strict, zod v4, vitest, node:crypto (ed25519).

---

## Audit result (what is already compliant — no code change)

1. **tenant_id == restaurant_id**: pairing stores both; scope check compares each against identity; no distinct-scope logic anywhere. ✓
2. **Polling transport**: `createPollingCloudClient` polls `GET /jobs?since=`, `POST /heartbeat` with `connection: "poll"`, dispatches `config_update`/`revoke`/`ping` from jobs batches, no redelivery assumption (jobs persisted by engine). ✓
3. **No /diagnostics client**: transport has no diagnostics method. ✓ (renderer DiagnosticsScreen is local-only)
4. **Restaurant-scoped printers**: engine looks up printer by id from config; no per-agent binding filter. ✓
5. **Offline window**: 30 s cadence < 90 s staleness. ✓

## Gaps (this plan)

| # | Gap | Fix |
|---|-----|-----|
| A | `POST /acks` parsed as 204-empty; server returns 200 `{results:[{job_id,result}]}` | Parse + handle all five outcomes |
| B | Rejection codes `bad_sig` / `job_expired` ≠ normative `bad_signature` / `expired_job` | Rename + tests |
| C | `sig: null` envelope → dropped as malformed with no ack → stranded claim | Ack `rejected{bad_signature}` when type/job_id are extractable |
| D | Refresh swaps memory **before** persist; identity saved as 8 separate kv entries (crash → mixed old/new token pair → revoke-on-replay) | Persist-then-swap; single-record atomic identity blob; poison flag blocks superseded-token replay |
| E | `error.code` collapsed to 401/403 status; `device_revoked` not distinguished | `CloudError.serverCode`; direct revocation on `device_revoked` |
| F | No jitter on healthy 30 s cadence | ±10 % jitter via injected `random` |
| G | `pair()` after `revoked` is a dead end (start() no-op) — recovery UX broken | pair() resets terminal revoked state |
| H | §1–§6 stale text contradicts §7 (acks 204, printer binding, ≥3-missed-heartbeat offline) | "superseded by §7 note N" pointers; remaining items listed as proposed amendments in final report |

---

### Task 1: Ack results schema + transport return type

**Files:**
- Modify: `src/main/cloud-client/schemas.ts`
- Modify: `src/main/cloud-client/types.ts`
- Modify: `src/main/cloud-client/http-transport.ts`
- Modify: `tests/helpers/cloud.ts` (FakeTransport `sendAcks` returns results; script accepts results)
- Test: `tests/cloud-schemas.test.ts`, `tests/cloud-http-transport.test.ts`

- [ ] **Step 1: Failing schema tests** — in `tests/cloud-schemas.test.ts` add:

```ts
import { AckResultsResponseSchema } from '../src/main/cloud-client/schemas';

describe('AckResultsResponseSchema (§7.1: 200 + per-ack results, not 204)', () => {
  it('accepts the documented results array', () => {
    const parsed = AckResultsResponseSchema.parse({
      results: [
        { job_id: '018f3c2e-0000-7000-8000-000000000005', result: 'applied' },
        { job_id: '018f3c2e-0000-7000-8000-000000000009', result: 'stale' },
      ],
    });
    expect(parsed.results).toHaveLength(2);
  });
  it('rejects unknown result values and unknown fields', () => {
    expect(
      AckResultsResponseSchema.safeParse({ results: [{ job_id: '018f3c2e-0000-7000-8000-000000000005', result: 'printed' }] }).success,
    ).toBe(false);
    expect(
      AckResultsResponseSchema.safeParse({ results: [], extra: 1 }).success,
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run** `pnpm vitest run tests/cloud-schemas.test.ts` → FAIL (export missing).

- [ ] **Step 3: Implement in `schemas.ts`** (after `AckBatchSchema`):

```ts
/** Per-ack outcome of POST /acks (§7.1 deviation: 200 + results, not 204). */
export const ACK_RESULTS = ['applied', 'duplicate', 'stale', 'not_found', 'rejected'] as const;

export const AckResultItemSchema = z.strictObject({
  job_id: z.uuid(),
  result: z.enum(ACK_RESULTS),
});

export const AckResultsResponseSchema = z.strictObject({
  results: z.array(AckResultItemSchema).max(100),
});

export type AckResultsResponse = z.output<typeof AckResultsResponseSchema>;
```

- [ ] **Step 4: Transport returns results** — in `types.ts` change the seam:

```ts
sendAcks(auth: TransportAuth, batch: AckBatch): Promise<AckResultsResponse>;
```

(import `AckResultsResponse` in the schema type import list). In `http-transport.ts`:

```ts
async sendAcks(auth: TransportAuth, batch: AckBatch): Promise<AckResultsResponse> {
  const body = AckBatchSchema.parse(batch);
  return requestWithRetry('POST', '/acks', AckResultsResponseSchema, { ...authed(auth), body });
},
```

Remove the now-unused `EmptyResponseSchema` only if heartbeat is also migrated (it is not — heartbeat stays 204; keep `EmptyResponseSchema`). Update the module doc comment: acks return 200 `{results}` per §7.1.

- [ ] **Step 5: Failing transport test** — in `tests/cloud-http-transport.test.ts` add (mirror existing fetch-mock style in that file): a 200 response body `{"results":[{"job_id":"<uuid>","result":"duplicate"}]}` parses and resolves; a 200 with `{}` rejects with `malformed_response`.

- [ ] **Step 6: Update `FakeTransport.sendAcks`** in `tests/helpers/cloud.ts`:

```ts
sendAcks(auth: TransportAuth, batch: AckBatch): Promise<AckResultsResponse> {
  this.calls.push({ op: 'acks', batch, auth });
  return Promise.resolve().then(() => {
    if (this.script.acks !== undefined) throw this.script.acks;
    return { results: [] };
  });
}
```

(`TransportScript.acks` type stays `Error | undefined`; default empty results.) Existing poller tests that assert on `callsOf('acks')` keep working. Run full cloud tests → PASS.

- [ ] **Step 7: Commit** `feat(cloud): parse §7.1 ack results array from POST /acks`.

### Task 2: Poller handles the five ack outcomes

**Files:**
- Modify: `src/main/cloud-client/poller.ts`
- Test: `tests/cloud-poller.test.ts`

- [ ] **Step 1: Failing tests** — `FakeTransport` script needs per-call ack results; extend `TransportScript.acks` to `Error | AckResultsResponse | AckResultsResponse[]` (queue consumed in call order, last repeats). Add to `tests/cloud-poller.test.ts`:

```ts
describe('ack results handling (§7.1)', () => {
  it.each(['applied', 'duplicate', 'stale'] as const)(
    'result %s is a success-no-op: loop stays online, no retry',
    async (result) => {
      const h = makeHarness({});
      (h.transport.script as { acks?: unknown }).acks = {
        results: [{ job_id: JOB_ID, result }],
      };
      await startAndSettle(h);
      await h.client.submitAcks({ envelope_version: 1, type: 'ack', acks: [makeAckItem()] });
      expect(h.client.state()).toBe('online');
      expect(h.transport.callsOf('acks')).toHaveLength(1); // no retry
    },
  );
  it('not_found is surfaced as an anomaly log and not retried', async () => { /* log sink assertion contains 'not_found' */ });
  it('rejected outcome is logged for diagnostics and not retried', async () => { /* ... */ });
});
```

with helper `makeAckItem()` building a valid `AckBatch['acks'][number]` (status 'completed', `printed: false`, attempt 1, ISO `at`). Harness gains a `logs: string[]` sink wired to `log`.

- [ ] **Step 2: Run** → FAIL (submitAcks currently discards results).

- [ ] **Step 3: Implement** in `poller.ts` — `doSubmitAcks` inspects results:

```ts
async function doSubmitAcks(batch: AckBatch): Promise<void> {
  const res = await withAuth((auth) => transport.sendAcks(auth, batch));
  for (const r of res.results) {
    if (r.result === 'applied') continue;
    if (r.result === 'duplicate' || r.result === 'stale') continue; // success-no-ops (§7.1): never retry, never re-print
    if (r.result === 'not_found') {
      log(`cloud: ack anomaly — server has no record of job ${r.job_id} (retention prune or tenant mismatch)`);
    } else {
      log(`cloud: ack rejected by server for job ${r.job_id}`);
    }
  }
}
```

- [ ] **Step 4: Run cloud tests** → PASS. **Commit** `feat(cloud): handle per-ack results (duplicate/stale no-op, not_found/rejected surfaced)`.

### Task 3: Normative rejection codes + null/invalid-sig ack

**Files:**
- Modify: `src/main/cloud-client/poller.ts` (bad_signature, null-sig path)
- Modify: `src/main/jobs/engine.ts:193` (`job_expired` → `expired_job`)
- Test: `tests/cloud-poller.test.ts`, `tests/job-engine-intake.test.ts:42`

- [ ] **Step 1: Update existing tests to the normative names** (they fail first): `tests/cloud-poller.test.ts:145` asserts ack error code — change expectation to `bad_signature`; `tests/job-engine-intake.test.ts:42` → `expired_job`.

- [ ] **Step 2: Poller** — in `rejectionAck` call sites and the message dispatch, rename `'bad_sig'` → `'bad_signature'`. Add explicit null/invalid-sig handling in `handleServerMessage`: when `parseServerMessage` returns `malformed` but the raw object has `type === 'print_job'` and `envelope_version === 1` and `job.job_id` is a string, ack `rejected{code:'bad_signature'}` instead of dropping silently (a dropped claim strands until lease expiry ×3 → `max_attempts_exceeded`):

```ts
case 'malformed': {
  const stranded = extractUnsignableJobId(raw); // {jobId} | null, guarded by type/envelope_version checks
  if (stranded !== null) {
    log('cloud: rejected print_job with missing/invalid signature fields');
    void doSubmitAcks({ envelope_version: ENVELOPE_VERSION, type: 'ack', acks: [
      rejectionAck(stranded.jobId, 'bad_signature', 'envelope signature missing or malformed'),
    ]}).catch(() => undefined);
    return;
  }
  log('cloud: dropped malformed server message');
}
```

- [ ] **Step 3: New tests**: (a) envelope with `"sig": null` → ack `rejected` `bad_signature`, no job emitted; (b) pinned key absent/garbage (`makeB64Url32()` wrong key) → same ack (already covered, assert code now).

- [ ] **Step 4: Run** `pnpm vitest run tests/cloud-poller.test.ts tests/job-engine-intake.test.ts` → PASS. **Commit** `fix(contract): normative rejected codes bad_signature/expired_job; ack unsignable print_jobs instead of stranding`.

### Task 4: Refresh persist-then-swap + atomic identity record

**Files:**
- Modify: `src/main/cloud-client/secret-store.ts`
- Modify: `src/main/cloud-client/poller.ts` (`refreshTokens`)
- Test: `tests/cloud-identity.test.ts`, `tests/cloud-poller.test.ts`

- [ ] **Step 1: Failing identity tests** (in `tests/cloud-identity.test.ts`):

```ts
it('persists the identity as a single atomic record', () => {
  const kv = new MemoryKv();
  const store = createSafeStorageSecretStore(kv, new FakeSafeStorage());
  store.save(makeSecrets());
  const keys = [...kv.map.keys()];
  expect(keys).toEqual(['cloud.identity']); // one key ⇒ one atomic kv write
});
it('refuses to load a record encrypted with a different context (fail closed)', () => { /* FakeSafeStorage.corruption='decrypt' → CloudError secure_storage_unavailable */ });
```

- [ ] **Step 2: Implement** — `secret-store.ts`: replace per-field FIELDS/KV_PREFIX writes with one record:

```ts
const IDENTITY_KV_KEY = 'cloud.identity';
// save(): JSON.stringify(IdentitySchema.parse(secrets)) → encrypt once → kv.set(IDENTITY_KV_KEY, blob)
// load(): kv.get → null if absent → decrypt → JSON.parse → IdentitySchema.safeParse
// clear(): kv.delete(IDENTITY_KV_KEY)
```

Doc comment must state: the single-key record exists so a rotation (two token fields) can never persist partially — the kv backing store must provide all-or-nothing per-key writes (settings store is tmp+rename atomic).

- [ ] **Step 3: Failing poller tests**:

```ts
it('persists rotated tokens BEFORE the in-memory swap (persist-then-swap)', async () => {
  // script: save() records kv state at call time; after refresh, durable store already has token-v2
});
it('a failed durable persist after successful rotation poisons refresh for the session (never replays the superseded token)', async () => {
  // make save throw (FakeSafeStorage.available=false after start); 401 poll → refresh succeeds → save throws
  // → state offline, loop stops scheduling; further 401 cycles NEVER call transport.refresh again
  // → load() still returns the PRE-rotation pair; assert no second refresh call for the rest of the session
});
```

- [ ] **Step 4: Implement in `poller.ts`**:

```ts
let refreshPersistBroken = false; // set when a rotation could not be durably persisted
// refreshTokens():
const after = currentIdentity();
if (after === null) throw new CloudError('revoked', 'identity cleared during refresh');
const next = { ...after, deviceToken: res.device_token, refreshToken: res.refresh_token };
deps.secrets.save(next); // persist BEFORE the swap — a crash here leaves a coherent pre-rotation record
identity = next;
// in the attempt's catch: if err is the save failure → refreshPersistBroken = true; stop loop; log
// withAuth(): if refreshPersistBroken → rethrow original auth error without attempting refresh
```

- [ ] **Step 5: Run** cloud tests → PASS. **Commit** `fix(cloud): persist-then-swap refresh rotation; atomic single-record identity storage`.

### Task 5: `error.code` parsing, `device_revoked`, heartbeat jitter, re-pair after revocation

**Files:**
- Modify: `src/main/cloud-client/errors.ts`, `http-transport.ts`, `poller.ts`
- Test: `tests/cloud-poller.test.ts`, `tests/cloud-http-transport.test.ts`

- [ ] **Step 1: `CloudError` gains `readonly serverCode?: string`** (set from the parsed `error.code` in `statusToError` — reuse the existing safe-code regex).

- [ ] **Step 2: Poller**: in `withAuth` and the `refresh` catch — if `err.serverCode === 'device_revoked'` → `handleRevocation('device_revoked')` immediately (no refresh attempt). 401 with any other code keeps the existing refresh-then-retry path.

- [ ] **Step 3: Jitter** — `PollingClientDeps.random?: () => number` (defaults `Math.random`); healthy cadence delay = `Math.floor(pollIntervalMs * (0.9 + 0.2 * random()))`; backoff jitter uses the same injected fn. Test harness passes `random: () => 0.5` so existing `toBe(30_000)` assertions hold; add one test that `random: () => 0` yields `27_000` (−10 %).

- [ ] **Step 4: Recovery UX** — `pair()` clears the terminal `revoked` state first:

```ts
async pair(request) {
  stop();
  if (state === 'revoked') setState('unpaired'); // §3.5 recovery: wiped identity ⇒ fresh pairing screen
  ...
}
```

Test: drive client to `revoked`, then `pair()` with a fresh code → state reaches `online`, identity persisted.

- [ ] **Step 5: Transport tests**: 401 body `{"error":{"code":"device_revoked","message":"..."}}` → poller goes `revoked` (wiped, onRevoked fired) without calling refresh; 401 `invalid_token` → refresh called. **Commit** `feat(cloud): honor error.code device_revoked, cadence jitter, re-pair after revocation`.

### Task 6: Doc cross-references + full verification

**Files:**
- Modify: `docs/api-contract.md` (§1–§6 stale pointers only)
- Modify: `src/renderer/src/services/*` — **no change** (cloud client not yet composed into main.ts; pre-existing, reported as gap)

- [ ] **Step 1:** Add "*(superseded by §7 note N)*" pointers: §1 WSS endpoint line → note 0 (REST-only); §2 `printer_id` "must be bound to this agent" → note 5; §3.2 "Missed heartbeats (≥3)" → note 7; §3.3 additive bullet "Response: `204`" for /acks → §7.1 results array (rewrite the bullet to the 200+results shape); §3.3 `/diagnostics` row → note 4 (deferred).

- [ ] **Step 2:** `pnpm typecheck && pnpm lint && pnpm test` — full suite green. **Commit** `docs(api-contract): mark §1–§6 text superseded by §7 where the shipped server diverges`.

## Self-review notes

- Spec coverage: deviations 1–6 → audit/no-op (1,2 partial,3,4,5 via Tasks 1–2,6-f via Task 5-3); hardening 7 → Task 4; hardening 8 → Task 3 + existing verification; §7.1 error codes → Task 5; expired_job → Task 3. All deliverable-2 tests present.
- Known reported gaps (not coded around): cloud client still not composed into main.ts (connection state 'disabled'); `not_found` surfaced via log only (no UI alert channel yet); `attempt: 1` on poller-generated rejection acks.
