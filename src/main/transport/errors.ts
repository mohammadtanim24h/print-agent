import type { TypedError } from '../../shared/errors';

export type TransportErrorCode =
  | 'connect_refused'
  | 'connect_timeout'
  | 'host_unreachable'
  | 'dns_unsupported'
  | 'write_timeout'
  | 'write_failed'
  | 'disconnected'
  | 'not_open';

/** Stable machine code; surfaces in logs and future acks (CLAUDE.md). */
export class TransportError extends Error implements TypedError {
  readonly code: TransportErrorCode;

  constructor(code: TransportErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'TransportError';
    this.code = code;
  }
}
