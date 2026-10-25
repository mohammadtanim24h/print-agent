import type { TypedError } from '../../shared/errors';

/**
 * Validates that an IPC call originates from our own bundled renderer frame.
 * Pure/structural (no electron import) so it is unit-testable; main.ts feeds
 * it real `IpcMainInvokeEvent` values.
 */
export interface SenderGuard {
  assertTrusted(event: { readonly senderFrame?: { readonly url: string } | null }): void;
}

export class IpcAccessError extends Error implements TypedError {
  readonly code = 'IPC_ACCESS_DENIED';
  constructor(message = 'IPC call from untrusted frame') {
    super(message);
    this.name = 'IpcAccessError';
  }
}

export function createSenderGuard(options: {
  /** URL prefixes the bundled renderer may be served from (prod: app:// bundled renderer; dev: vite origin). */
  readonly allowedUrlPrefixes: readonly string[];
  /** Denial sink (redacted logger). Never logs payloads. */
  readonly log?: (message: string) => void;
}): SenderGuard {
  const prefixes = options.allowedUrlPrefixes.map((p) => p.toLowerCase());
  return {
    assertTrusted(event) {
      const url = event.senderFrame?.url;
      const normalized = url?.toLowerCase() ?? '';
      const ok = prefixes.some((prefix) => {
        if (!normalized.startsWith(prefix)) return false;
        // Reject userinfo tricks: "http://allowed@evil/" must not match "http://allowed".
        const rest = normalized.slice(prefix.length);
        if (rest.startsWith('@')) return false;
        // A prefix ending in "/" can only match inside that directory.
        return prefix.endsWith('/');
      });
      if (!ok) {
        options.log?.(`ipc denied from ${describeOrigin(normalized)}`);
        throw new IpcAccessError();
      }
    },
  };
}

/** Logs only scheme+host shape, never paths/query — keeps logs free of user data. */
function describeOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return 'unknown-frame';
  }
}
