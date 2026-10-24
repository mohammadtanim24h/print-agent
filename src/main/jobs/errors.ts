import type { TypedError } from '../../shared/errors';

export type JobEngineErrorCode =
  | 'store_unavailable' // DB failed; no ack is emitted so the server re-delivers
  | 'illegal_transition'; // caller violated an engine precondition (operator actions)

export class JobEngineError extends Error implements TypedError {
  readonly code: JobEngineErrorCode;

  constructor(code: JobEngineErrorCode, message: string) {
    super(message);
    this.name = 'JobEngineError';
    this.code = code;
  }
}
