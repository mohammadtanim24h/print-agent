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
      return await handler(parsed as never);
    },
  };
}
