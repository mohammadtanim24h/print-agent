import type { ZodType } from 'zod';
import type { SenderGuard } from '../security/sender-guard';

/**
 * Table-driven IPC dispatcher. Validation order matters and is asserted by
 * tests: unknown channel -> sender trust -> payload schema -> handler.
 * main.ts wires this onto `ipcMain.handle` for every registered channel;
 * the renderer has no other reachable IPC surface.
 */
export interface IpcRouter {
  dispatch(
    channel: string,
    payload: unknown,
    sender: { readonly senderFrame?: { readonly url: string } | null },
  ): Promise<unknown>;
}

export class IpcUnknownChannelError extends Error {
  constructor(channel: string) {
    super(`unknown IPC channel: ${channel}`);
    this.name = 'IpcUnknownChannelError';
  }
}

export function createIpcRouter(options: {
  guard: SenderGuard;
  /** Exact channel -> request schema map (from shared/ipc-contract). */
  schemas: Readonly<Record<string, ZodType>>;
  /** Exact channel -> handler. Channels with a schema but no handler reject. */
  handlers: Readonly<Record<string, (payload: never) => unknown>>;
  /** Rejection sink (redacted logger); payloads are never logged. */
  log?: (message: string) => void;
}): IpcRouter {
  return {
    async dispatch(channel, payload, sender) {
      const handler = options.handlers[channel];
      if (handler === undefined) {
        throw new IpcUnknownChannelError(channel);
      }
      const schema = options.schemas[channel];
      if (schema === undefined) {
        throw new IpcUnknownChannelError(channel);
      }
      options.guard.assertTrusted(sender);
      const parsed = schema.parse(payload);
      try {
        return await handler(parsed as never);
      } catch (err) {
        // Architecture §5: handlers throw typed errors; the router serializes
        // `{ code, message }` over the bridge — Electron would otherwise wrap
        // the raw rejection ("Error invoking remote method …"), burying the
        // machine code and shipping a stack across the boundary. Stacks stay
        // in main (log sink); the renderer gets `code: message` only.
        throw new Error(serializeIpcError(err));
      }
    },
  };
}

const MAX_IPC_ERROR_MESSAGE = 300;

/**
 * `code: message` — the stable machine code survives the bridge. The code is
 * sanitized to lowercase `[a-z0-9_.-]` (machine codes are lowercase snake; a
 * non-conforming value falls back to `internal_error`) and the message is
 * capped since it crosses to the renderer.
 */
function serializeIpcError(err: unknown): string {
  const rawCode = (err as { code?: unknown } | null)?.code;
  let code = 'internal_error';
  if (typeof rawCode === 'string') {
    const clean = rawCode.toLowerCase().replace(/[^a-z0-9_.-]/g, '');
    if (clean !== '') code = clean;
  }
  const rawMessage = err instanceof Error ? err.message : String(err);
  const message =
    rawMessage.length > MAX_IPC_ERROR_MESSAGE
      ? rawMessage.slice(0, MAX_IPC_ERROR_MESSAGE)
      : rawMessage;
  return `${code}: ${message}`;
}
