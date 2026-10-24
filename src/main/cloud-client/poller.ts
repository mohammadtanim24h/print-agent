import { CloudError } from './errors';
import { decodeEd25519PublicKey, verifyEnvelopeSig } from './envelope-sig';
import { parseServerMessage, ENVELOPE_VERSION } from './schemas';
import type { ConfigUpdate, PrintJobEnvelope } from './schemas';
import { pairDevice } from './pairing';
import type {
  AgentTransport,
  CloudClient,
  CloudListener,
  ConnectionState,
  HeartbeatSample,
  AckBatch,
} from './types';
import type { IdentitySecrets, SecretStore } from './secret-store';

/**
 * Polling implementation of `CloudClient` — authenticated HTTPS job polling is
 * the v1 delivery mechanism (architecture §8, REST row). The transport seam is
 * replaceable so an authenticated real-time wake-up channel (WSS) can be added
 * later; this state machine (tokens, backoff, revocation, scope checks) is the
 * part that stays.
 *
 * Loop semantics:
 * - `start()` runs the first cycle immediately to recover pending work after
 *   (re)connect; healthy cadence is `pollIntervalMs` (contract §3.2 cadence).
 * - Failures back off exponentially with jitter; success resets the backoff.
 * - A 401/403 triggers a single token refresh (single-flight, cooldown-
 *   limited) and at most one retried request. Refresh refusal ⇒ `revoked`
 *   (terminal): loop stops, credentials wiped, `revoked` event emitted. No
 *   infinite retry loop is possible: at most one refresh per cooldown window,
 *   and `revoked` stops the loop entirely.
 * - `pollNow()` forces an immediate cycle (network-online / reconnect seams).
 */

export interface PollingClientDeps {
  readonly transport: AgentTransport;
  readonly secrets: SecretStore;
  readonly agentVersion: string;
  /** Static-message log sink (never payloads — secrets redaction is upstream). */
  readonly log?: (message: string) => void;
  readonly now?: () => number;
  /** Replaceable timer; returns a cancel function. */
  readonly schedule?: (fn: () => void, delayMs: number) => () => void;
  readonly pollIntervalMs?: number;
  /** Minimum spacing between token refresh attempts (loop prevention). */
  readonly refreshCooldownMs?: number;
  /** Queue/printer facts for the in-cycle heartbeat; cycle heartbeat is sent only when provided. */
  readonly heartbeatSample?: () => HeartbeatSample;
  /** Wired in composition: wipes jobs + cached printers on revocation (§3.5). */
  readonly onRevoked?: (reason: string) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_REFRESH_COOLDOWN_MS = 30_000;
const MAX_BACKOFF_MS = 10 * 60_000;

/** Identifies a v1 print_job envelope that failed schema validation but is
 *  still nameable (type/version recognizable, `job.job_id` a string). Returns
 *  the rejection code to ack: `bad_signature` when the `sig` field is
 *  null/missing/not base64url(64 bytes), `invalid_envelope` otherwise. Only
 *  unnameable garbage stays `malformed`. */
function unsignableOrInvalidAck(raw: unknown): {
  readonly jobId: string;
  readonly code: 'bad_signature' | 'invalid_envelope';
} | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record['type'] !== 'print_job' || record['envelope_version'] !== ENVELOPE_VERSION) {
    return null;
  }
  const job = record['job'];
  if (typeof job !== 'object' || job === null) return null;
  const jobId = (job as Record<string, unknown>)['job_id'];
  if (typeof jobId !== 'string' || jobId === '') return null;
  const sig = record['sig'];
  const sigShaped = typeof sig === 'string' && /^[A-Za-z0-9_-]{86}$/.test(sig);
  return { jobId, code: sigShaped ? 'invalid_envelope' : 'bad_signature' };
}

type Listeners = {
  job: Set<CloudListener<PrintJobEnvelope>>;
  config: Set<CloudListener<ConfigUpdate>>;
  state: Set<CloudListener<ConnectionState>>;
  revoked: Set<CloudListener<{ reason: string }>>;
};

export function createPollingCloudClient(deps: PollingClientDeps): CloudClient {
  const transport = deps.transport;
  const now = deps.now ?? Date.now;
  const schedule =
    deps.schedule ??
    ((fn: () => void, delayMs: number): (() => void) => {
      const t = setTimeout(fn, delayMs);
      return () => {
        clearTimeout(t);
      };
    });
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const refreshCooldownMs = deps.refreshCooldownMs ?? DEFAULT_REFRESH_COOLDOWN_MS;
  const log = deps.log ?? ((): void => {});
  const sampleProvider = deps.heartbeatSample;
  // Indirection through functions defeats TS control-flow narrowing of the
  // mutable `stopped`/`identity` flags, which closures reassign.
  const isStopped = (): boolean => stopped;
  const currentIdentity = (): IdentitySecrets | null => identity;

  const listeners: Listeners = {
    job: new Set(),
    config: new Set(),
    state: new Set(),
    revoked: new Set(),
  };

  let state: ConnectionState = 'unpaired';
  /** Full secret record in memory while paired; token rotations mutate a copy. */
  let identity: IdentitySecrets | null = null;
  let cursor = '';
  let stopped = true;
  let cancelTimer: (() => void) | null = null;
  let cycling = false;
  let backoffAttempt = 0;
  let appliedConfigVersion = -1;
  let lastRefreshAt = -Infinity;
  let refreshInFlight: Promise<void> | null = null;

  function setState(next: ConnectionState): void {
    if (state === next) return;
    state = next;
    for (const listener of listeners.state) listener(next);
  }

  function backoffDelayMs(): number {
    const delay = Math.min(pollIntervalMs * 2 ** Math.max(0, backoffAttempt - 1), MAX_BACKOFF_MS);
    return Math.floor(delay / 2 + Math.random() * (delay / 2)); // half-jitter, never zero-cadence
  }

  function scheduleCycle(delayMs: number): void {
    cancelTimer?.();
    cancelTimer = schedule(() => {
      cancelTimer = null;
      void runCycle();
    }, delayMs);
  }

  function start(): void {
    if (!stopped) return;
    if (state === 'revoked') return; // terminal until the app resets to a fresh install state
    const loaded = deps.secrets.load();
    if (loaded === null) {
      setState('unpaired');
      return;
    }
    identity = { ...loaded };
    stopped = false;
    backoffAttempt = 0;
    setState('connecting');
    scheduleCycle(0); // immediate first poll: recover pending work
  }

  function stop(): void {
    stopped = true;
    cancelTimer?.();
    cancelTimer = null;
  }

  async function runCycle(): Promise<void> {
    if (stopped || cycling) return;
    cycling = true;
    try {
      if (identity === null) {
        setState('unpaired');
        return;
      }
      try {
        if (sampleProvider !== undefined) {
          await withAuth((auth) => transport.heartbeat(auth, sampleProvider()));
        }
        const res = await withAuth((auth) => transport.pollJobs(auth, cursor));
        cursor = res.next_cursor ?? '';
        for (const raw of res.jobs) handleServerMessage(raw);
        // A revoke envelope mid-batch stops the loop — never surface 'online' over 'revoked'.
        if (isStopped()) return;
        backoffAttempt = 0;
        setState('online');
      } catch (err) {
        handleCycleError(err);
      }
    } finally {
      cycling = false;
      if (!isStopped()) scheduleCycle(backoffAttempt === 0 ? pollIntervalMs : backoffDelayMs());
    }
  }

  function handleCycleError(err: unknown): void {
    // A refusal-driven revocation (or revoke envelope) already transitioned the
    // client to its terminal state — never overwrite it with 'offline'.
    if (isStopped() || state === 'revoked') return;
    if (err instanceof CloudError && err.code === 'revoked') return; // already handled
    if (err instanceof CloudError && err.code === 'not_paired') {
      setState('unpaired');
      return;
    }
    if (err instanceof CloudError && err.code === 'malformed_response') {
      // Reachable server, unusable body — most likely a protocol mismatch.
      // Stay online but keep the regular cadence (never a tight loop).
      log('cloud: server response failed validation');
      backoffAttempt = 0;
      setState('online');
      return;
    }
    backoffAttempt += 1;
    setState('offline');
    if (err instanceof CloudError) {
      log(`cloud: cycle failed (${err.code})`); // code + static detail only
    } else {
      log('cloud: cycle failed (unexpected error)');
    }
  }

  /** One token refresh per cooldown window; refusal is terminal (§3.5). */
  function refreshTokens(): Promise<void> {
    if (refreshInFlight !== null) return refreshInFlight;
    if (now() - lastRefreshAt < refreshCooldownMs) {
      return Promise.reject(new CloudError('unauthorized', 'refresh cooldown active'));
    }
    lastRefreshAt = now();
    const attempt = (async () => {
      const before = currentIdentity();
      if (before === null) throw new CloudError('not_paired');
      let res;
      try {
        res = await transport.refresh(before.refreshToken);
      } catch (err) {
        if (
          err instanceof CloudError &&
          (err.code === 'unauthorized' || err.code === 'forbidden')
        ) {
          handleRevocation('token_refresh_refused');
        }
        throw err;
      }
      // Re-read: a concurrent revocation may have cleared the identity while awaiting.
      const after = currentIdentity();
      if (after === null) throw new CloudError('revoked', 'identity cleared during refresh');
      identity = { ...after, deviceToken: res.device_token, refreshToken: res.refresh_token };
      deps.secrets.save(identity);
    })();
    refreshInFlight = attempt.finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }

  async function withAuth<T>(
    fn: (auth: { deviceId: string; deviceToken: string }) => Promise<T>,
  ): Promise<T> {
    const id = identity;
    if (id === null) throw new CloudError('not_paired');
    const auth = (): { deviceId: string; deviceToken: string } => ({
      deviceId: id.deviceId,
      deviceToken: id.deviceToken,
    });
    try {
      return await fn(auth());
    } catch (err) {
      if (
        !(err instanceof CloudError) ||
        (err.code !== 'unauthorized' && err.code !== 'forbidden')
      ) {
        throw err;
      }
      await refreshTokens(); // throws 'revoked' downstream when refused
      return await fn(auth()); // single retry with the rotated token
    }
  }

  function handleServerMessage(raw: unknown): void {
    const msg = parseServerMessage(raw);
    switch (msg.kind) {
      case 'print_job':
        handleJobEnvelope(msg.envelope, msg.rawJob);
        return;
      case 'config_update':
        handleConfig(msg.config);
        return;
      case 'revoke':
        handleRevocation(msg.reason);
        return;
      case 'unsupported_version':
        log(
          `cloud: refused envelope with unsupported envelope_version ${String(msg.envelopeVersion)}`,
        );
        return;
      case 'malformed': {
        // A print_job whose `sig` is null/missing/malformed fails the envelope
        // schema before signature verification. The pull IS the claim (§7
        // note 6), so dropping it silently would strand the server-side lease
        // until it auto-fails — ack it rejected instead when we can name the job.
        const stranded = unsignableOrInvalidAck(raw);
        if (stranded !== null) {
          log(`cloud: rejected unparseable print_job (${stranded.code})`);
          void doSubmitAcks({
            envelope_version: ENVELOPE_VERSION,
            type: 'ack',
            acks: [
              rejectionAck(
                stranded.jobId,
                stranded.code,
                stranded.code === 'bad_signature'
                  ? 'envelope signature missing or malformed'
                  : 'envelope failed schema validation',
              ),
            ],
          }).catch(() => undefined);
          return;
        }
        log('cloud: dropped malformed server message');
        return;
      }
      case 'ping':
        return;
    }
  }

  /** Defense in depth (architecture §7): the token scopes us to one
   *  restaurant; the agent re-checks every job against that scope before the
   *  engine ever sees it. Signature verified against the pairing-pinned key. */
  function handleJobEnvelope(envelope: PrintJobEnvelope, rawJob: unknown): void {
    if (identity === null) return;
    const job = envelope.job;
    if (job.tenant_id !== identity.tenantId || job.restaurant_id !== identity.restaurantId) {
      log('cloud: dropped out-of-scope job');
      void doSubmitAcks({
        envelope_version: ENVELOPE_VERSION,
        type: 'ack',
        acks: [rejectionAck(job.job_id, 'wrong_scope', 'job does not match device scope')],
      }).catch(() => undefined);
      return;
    }
    // Sig covers the raw wire bytes of `job` (schema defaults must not leak
    // into the canonical form the server signed).
    let sigOk = false;
    try {
      sigOk = verifyEnvelopeSig(
        rawJob,
        envelope.sig,
        decodeEd25519PublicKey(identity.serverSigningPubkey),
      );
    } catch {
      sigOk = false;
    }
    if (!sigOk) {
      log('cloud: dropped job with invalid signature');
      void doSubmitAcks({
        envelope_version: ENVELOPE_VERSION,
        type: 'ack',
        acks: [rejectionAck(job.job_id, 'bad_signature', 'envelope signature verification failed')],
      }).catch(() => undefined);
      return;
    }
    for (const listener of listeners.job) listener(envelope);
  }

  function rejectionAck(jobId: string, code: string, message: string): AckBatch['acks'][number] {
    return {
      job_id: jobId,
      status: 'rejected',
      printer_status: 'unknown',
      printed: false,
      attempt: 1,
      at: new Date(now()).toISOString(),
      error: { code, message },
    };
  }

  function handleConfig(config: ConfigUpdate): void {
    if (config.config_version <= appliedConfigVersion) {
      log('cloud: ignored config version regression');
      return;
    }
    appliedConfigVersion = config.config_version;
    for (const listener of listeners.config) listener(config);
  }

  function doSubmitAcks(batch: AckBatch): Promise<void> {
    return withAuth(async (auth) => {
      const res = await transport.sendAcks(auth, batch);
      for (const r of res.results) {
        // duplicate/stale are success-no-ops (§7.1): never retry, never re-print.
        if (r.result === 'applied' || r.result === 'duplicate' || r.result === 'stale') continue;
        if (r.result === 'not_found') {
          // A job we actually hold being unknown to the server means tenant
          // trouble or retention pruning — surface it, never re-print.
          log(`cloud: ack anomaly — server has no record of job ${r.job_id} (not_found)`);
        } else {
          log(`cloud: ack rejected by server for job ${r.job_id}`);
        }
      }
    });
  }

  function handleRevocation(reason: string): void {
    if (state === 'revoked') return;
    stopped = true;
    cancelTimer?.();
    cancelTimer = null;
    deps.secrets.clear(); // wipe identity (§3.5); jobs/printers wipe via onRevoked
    identity = null;
    for (const listener of listeners.revoked) listener({ reason });
    setState('revoked');
    deps.onRevoked?.(reason);
  }

  return {
    on(event, listener) {
      (listeners[event] as Set<unknown>).add(listener);
    },
    state: () => state,
    async pair(request) {
      stop();
      const paired = await pairDevice(
        { transport, secrets: deps.secrets, agentVersion: deps.agentVersion },
        request,
      );
      cursor = '';
      appliedConfigVersion = -1;
      start();
      return paired;
    },
    start,
    stop,
    pollNow(): void {
      if (stopped || cycling) return;
      scheduleCycle(0);
    },
    async submitAcks(batch: AckBatch): Promise<void> {
      await doSubmitAcks(batch);
    },
    async sendHeartbeat(sample: HeartbeatSample): Promise<void> {
      await withAuth((auth) => transport.heartbeat(auth, sample));
    },
    async refreshConfig(): Promise<void> {
      const config = await withAuth((auth) => transport.getConfig(auth));
      handleConfig(config);
    },
  };
}
