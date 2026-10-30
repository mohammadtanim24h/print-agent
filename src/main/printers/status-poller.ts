import { TransportError, type TransportErrorCode } from '../transport/errors';
import type { PrinterStatus } from '../transport/types';
import type { TransportRegistry } from '../transport/registry';
import type { PrinterProfile } from './profile';
import type { PrinterStore } from './store';

/**
 * DLE EOT response → health mapping (production-readiness C1, R-VAL-3).
 * Bit semantics follow the ESC/POS R&P spec; exact fleet behavior is what
 * R-VAL-3 must confirm on hardware, hence the profile-level gate defaults
 * to off (`statusPolling` undefined or 'off').
 */

/** DLE EOT 1 (printer status) bit 2: cover open. */
const COVER_OPEN_BIT = 0x04;
/** DLE EOT 1 bit 5: printer error (offline-class). */
const PRINTER_ERROR_BIT = 0x20;
/** DLE EOT 2 bits 0–2: roll paper near-end (any sensor). */
const PAPER_NEAR_END_MASK = 0x07;
/** DLE EOT 2 bits 3–5: roll paper end (any sensor). */
const PAPER_OUT_MASK = 0x38;
// DLE EOT 1 bit 0 (0x01, "offline") is deliberately unmapped: reachability is
// the poller's connect/probe-timeout job, and real-fleet bit-0 behavior is
// exactly what R-VAL-3 must confirm.

/** Severity precedence: paper_out > cover_open > paper_low > ok; the error
 *  bit beats everything. */
export function parseDleEotStatus(printerByte: number, paperByte: number): PrinterStatus {
  if ((printerByte & PRINTER_ERROR_BIT) !== 0) return 'offline';
  if ((paperByte & PAPER_OUT_MASK) !== 0) return 'paper_out';
  if ((printerByte & COVER_OPEN_BIT) !== 0) return 'cover_open';
  if ((paperByte & PAPER_NEAR_END_MASK) !== 0) return 'paper_low';
  return 'ok';
}

export const DEFAULT_STATUS_INTERVAL_MS = 30_000;
export const DEFAULT_STATUS_TTL_MS = 90_000;

/** Connect-class failures mean the printer is unreachable → 'offline'.
 *  Response-class failures ('status_failed') and anything unexpected map to
 *  'unknown' — a model that silently ignores DLE EOT is never declared
 *  offline (R-VAL-3's core uncertainty). */
const OFFLINE_CODES: ReadonlySet<TransportErrorCode> = new Set([
  'connect_refused',
  'connect_timeout',
  'host_unreachable',
  'disconnected',
  'not_open',
  'printer_not_found',
  'dns_unsupported',
]);

/** Effective R-VAL-3 gate: explicit opt-in on a transport that has a return
 *  channel. spooler_raw is a one-way pipe and never polls. */
export function statusPollingEnabled(profile: PrinterProfile): boolean {
  return profile.statusPolling === 'auto' && profile.transport.kind === 'tcp_raw';
}

export interface StatusPollerDeps {
  readonly printers: PrinterStore;
  readonly registry: TransportRegistry;
  readonly intervalMs?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
  /** Returns a cancel function (same seam as the runtime/poller). */
  readonly schedule?: (fn: () => void, delayMs: number) => () => void;
  readonly log?: (message: string) => void;
}

export interface StatusPoller {
  /** Idempotent. Runs the first cycle immediately, then re-arms on the timer. */
  start(): void;
  /** Idempotent. In-flight probes settle into the cache but no new cycle is armed. */
  stop(): void;
  /** Sync read for the heartbeat/ack path; expired or never-polled → 'unknown'. */
  get(printerId: string): PrinterStatus;
}

interface CacheEntry {
  status: PrinterStatus;
  at: number;
}

export function createStatusPoller(deps: StatusPollerDeps): StatusPoller {
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? DEFAULT_STATUS_INTERVAL_MS;
  const ttlMs = deps.ttlMs ?? DEFAULT_STATUS_TTL_MS;
  const schedule =
    deps.schedule ??
    ((fn: () => void, delayMs: number): (() => void) => {
      const t = setTimeout(fn, delayMs);
      return () => {
        clearTimeout(t);
      };
    });
  const log = deps.log ?? ((): void => {});
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Set<string>();
  let cancelTimer: (() => void) | null = null;
  let stopped = true;

  function pollOne(printerId: string, profile: PrinterProfile): void {
    if (inFlight.has(printerId)) return; // serialize per printer
    inFlight.add(printerId);
    const transport = deps.registry.forPrinter(profile);
    // Bind the optional method up front (unbound-method lint); spooler_raw
    // transports leave `status` undefined — nothing to probe there.
    const probe = transport.status?.bind(transport);
    if (probe === undefined) {
      inFlight.delete(printerId);
      return;
    }
    void Promise.resolve()
      .then(() => probe())
      .then(
        ([printerByte, paperByte]) => {
          cache.set(printerId, { status: parseDleEotStatus(printerByte, paperByte), at: now() });
        },
        (err: unknown) => {
          const offline = err instanceof TransportError && OFFLINE_CODES.has(err.code);
          cache.set(printerId, { status: offline ? 'offline' : 'unknown', at: now() });
          log(`status poll failed for ${printerId}: ${err instanceof Error ? err.message : String(err)}`);
        },
      )
      .finally(() => {
        inFlight.delete(printerId);
      });
  }

  function tick(): void {
    try {
      const live = new Set<string>();
      for (const p of deps.printers.list()) {
        live.add(p.printerId);
        if (statusPollingEnabled(p)) pollOne(p.printerId, p);
      }
      // A removed printer's stale status must not stay readable via get()
      // for a TTL window; drop its entry this cycle (inFlight defensively,
      // same rule).
      for (const id of cache.keys()) {
        if (!live.has(id)) cache.delete(id);
      }
      for (const id of inFlight) {
        if (!live.has(id)) inFlight.delete(id);
      }
    } catch (err) {
      // Same posture as the job engine's scheduleSafely: a failing store or
      // transport seam must not kill the loop uncaught inside a timer context.
      log(`status poller: cycle failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      rearm();
    }
  }

  function rearm(): void {
    if (stopped) return;
    cancelTimer?.();
    cancelTimer = schedule(tick, intervalMs);
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      tick();
    },
    stop() {
      stopped = true;
      cancelTimer?.();
      cancelTimer = null;
    },
    get(printerId) {
      const entry = cache.get(printerId);
      if (entry === undefined || now() - entry.at > ttlMs) return 'unknown';
      return entry.status;
    },
  };
}
