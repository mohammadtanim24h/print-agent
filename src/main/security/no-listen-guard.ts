import type { TypedError } from '../../shared/errors';

export class ListenForbiddenError extends Error implements TypedError {
  readonly code = 'LISTEN_FORBIDDEN';
  constructor() {
    super(
      'Inbound listeners are forbidden (PRD AC-4, architecture.md §8: "Nothing listens. Ever.")',
    );
    this.name = 'ListenForbiddenError';
  }
}

type ListenFn = (...args: unknown[]) => unknown;

/**
 * Defense-in-depth for AC-4: any attempt to open a server socket inside the
 * main process throws immediately. Call once at startup, before any module
 * init. The agent only ever opens client sockets (outbound WSS / TCP :9100).
 *
 * Returns an uninstall function (used by tests and by future transports that
 * legitimately need the guard temporarily lifted — none today).
 */
export function installNoListenGuard(target: { listen?: unknown }): () => void {
  const original = target.listen as ListenFn | undefined;
  if (typeof original !== 'function') {
    throw new TypeError('no-listen guard target must have a listen() method');
  }
  const guarded = function guardedListen(): never {
    throw new ListenForbiddenError();
  } as ListenFn;
  target.listen = guarded;
  return function uninstall(): void {
    // Only restore if nothing replaced our guard in the meantime.
    if (target.listen === guarded) {
      target.listen = original;
    }
  };
}
