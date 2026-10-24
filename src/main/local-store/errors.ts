import type { TypedError } from '../../shared/errors';

export type StoreErrorCode =
  | 'db_open_failed'     // could not open/create the database file
  | 'db_version_newer'   // on-disk schema is newer than this build supports
  | 'unique_violation'   // constraint rejected the row (e.g. duplicate idempotency key)
  | 'not_found'          // row does not exist — caller bug or deletion race, NOT an outage
  | 'store_unavailable'; // the store threw mid-operation (disk I/O, corruption)

export class StoreError extends Error implements TypedError {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'StoreError';
    this.code = code;
  }
}
