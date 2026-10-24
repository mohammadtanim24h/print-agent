import type {
  ConfigUpdate,
  Heartbeat,
  PairRequest,
  PairResponse,
  PollResponse,
  PrintJobEnvelope,
  RefreshResponse,
  ServerKeysResponse,
  AckBatchSchema,
} from './schemas';
import type { z } from 'zod';

/**
 * Public interface of the cloud-client module (architecture §3.1). The module
 * knows nothing about printing; consumers receive validated domain events and
 * hand acks back in. The transport seam (`AgentTransport`) is replaceable so
 * authenticated real-time wake-up (WSS) can be added later without touching
 * the client state machine.
 */

export type ConnectionState = 'unpaired' | 'offline' | 'connecting' | 'online' | 'revoked';

export type AckBatch = z.output<typeof AckBatchSchema>;

/** §3.2 heartbeat sample; queue/printer facts are filled by the caller. */
export type HeartbeatSample = Omit<Heartbeat, 'type' | 'agent_version'>;

export interface AgentIdentity {
  readonly deviceId: string;
  readonly tenantId: string;
  readonly restaurantId: string;
}

export type CloudListener<T> = (value: T) => void;

export interface CloudClient {
  /** Validated, scope-checked print-job envelopes ready for engine intake. */
  on(event: 'job', listener: CloudListener<PrintJobEnvelope>): void;
  /** Config snapshots (version-regressed ones are dropped before this fires). */
  on(event: 'config', listener: CloudListener<ConfigUpdate>): void;
  on(event: 'state', listener: CloudListener<ConnectionState>): void;
  /** Terminal credential loss — the app must wipe identity + jobs and show the revoked screen. */
  on(event: 'revoked', listener: CloudListener<{ reason: string }>): void;

  state(): ConnectionState;

  /** Exchange a dashboard-generated pairing code for a device credential.
   *  Throws CloudError('pairing_failed'-class codes) on rejection. */
  pair(request: { readonly pairingCode: string; readonly deviceName: string }): Promise<AgentIdentity>;

  /** Begin the poll loop (no-op unless paired). The first cycle runs
   *  immediately to recover pending work after (re)connect. */
  start(): void;
  stop(): void;

  /** Trigger an immediate poll cycle (e.g. network-online event). */
  pollNow(): void;

  submitAcks(batch: AckBatch): Promise<void>;
  sendHeartbeat(sample: HeartbeatSample): Promise<void>;
  /** Fetch + validate config now; fires the 'config' event on a version increase. */
  refreshConfig(): Promise<void>;
}

/**
 * Transport seam: one method per REST endpoint in api-contract §3.3.
 * Implementations own TLS, timeouts, retries and response-size caps; the
 * polling client owns state, tokens and scheduling. All methods throw
 * CloudError on failure.
 */
export interface AgentTransport {
  readonly baseUrl: string;
  pair(request: PairRequest): Promise<PairResponse>;
  /** Rotate tokens. Never auto-retried (rotation makes replay dangerous). */
  refresh(refreshToken: string): Promise<RefreshResponse>;
  pollJobs(auth: TransportAuth, since: string): Promise<PollResponse>;
  sendAcks(auth: TransportAuth, batch: AckBatch): Promise<void>;
  getConfig(auth: TransportAuth): Promise<ConfigUpdate>;
  heartbeat(auth: TransportAuth, sample: Heartbeat): Promise<void>;
  serverKeys(auth: TransportAuth): Promise<ServerKeysResponse>;
}

export interface TransportAuth {
  readonly deviceId: string;
  readonly deviceToken: string;
}
