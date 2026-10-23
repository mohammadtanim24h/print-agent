import type { TypedError } from '../../shared/errors';

export type RenderErrorCode =
  | 'invalid_doc'
  | 'payload_too_large'
  | 'unsupported_doc_type'
  | 'text_not_encodable'
  | 'render_failed';

export class RenderError extends Error implements TypedError {
  readonly code: RenderErrorCode;
  constructor(
    code: RenderErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'RenderError';
    this.code = code;
  }
}
