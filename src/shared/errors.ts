/** Typed errors carry a stable machine code (surfaces in acks/logs; CLAUDE.md). */
export interface TypedError extends Error {
  readonly code: string;
}
