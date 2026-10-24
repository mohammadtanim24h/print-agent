import type { TypedError } from '../../shared/errors';

export type StoreErrorCode =
  | 'db_open_failed'     // could not open/create the database file
  | 'db_version_newer'   // on-disk schema is newer than this build supports
  | 'unique_violation'   // constraint rejected the row (e.g. duplicate idempotency key)
  | 'store_unavailable'; // the store threw mid-operation (disk I/O, corruption)

export class StoreError extends Error implements TypedError {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}
