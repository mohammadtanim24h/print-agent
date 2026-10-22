import { describe, expect, it } from 'vitest';
import { Channel, RequestSchemas } from '../src/shared/ipc-contract';
import { createIpcRouter, IpcUnknownChannelError } from '../src/main/ipc/register';

describe('ipc contract', () => {
  it('has a strict schema for every channel', () => {
    for (const channel of Object.values(Channel)) {
      expect(RequestSchemas[channel]).toBeDefined();
    }
  });

  it('rejects payloads with unknown fields (strict)', () => {
    const result = RequestSchemas[Channel.SetLaunchAtLogin].safeParse({
      enabled: true,
      extra: 'x',
    });
    expect(result.success).toBe(false);
  });

  it('rejects wrong types and missing fields', () => {
    expect(RequestSchemas[Channel.SetLaunchAtLogin].safeParse({ enabled: 'yes' }).success).toBe(
      false,
    );
    expect(RequestSchemas[Channel.SetLaunchAtLogin].safeParse({}).success).toBe(false);
    expect(RequestSchemas[Channel.SetLaunchAtLogin].safeParse({ enabled: false }).success).toBe(
      true,
    );
  });

  it('no-payload channels accept only undefined', () => {
    expect(RequestSchemas[Channel.GetSettings].safeParse(undefined).success).toBe(true);
    expect(RequestSchemas[Channel.GetSettings].safeParse({}).success).toBe(false);
  });
});

describe('ipc router', () => {
  const trustedFrame = { senderFrame: { url: 'file:///app/out/renderer/index.html' } };
  const schemas = {
    'settings:set-launch-at-login': RequestSchemas[Channel.SetLaunchAtLogin],
  };
  const calls: unknown[] = [];
  const router = createIpcRouter({
    guard: {
      assertTrusted(event) {
        if (event.senderFrame?.url !== 'file:///app/out/renderer/index.html') {
          throw new Error('denied');
        }
      },
    },
    schemas,
    handlers: {
      'settings:set-launch-at-login': (payload: unknown) => {
        calls.push(payload);
        return { launchAtLogin: (payload as { enabled: boolean }).enabled };
      },
    },
  });

  it('dispatches valid payloads from trusted senders', async () => {
    const res = await router.dispatch(
      'settings:set-launch-at-login',
      { enabled: true },
      trustedFrame,
    );
    expect(res).toEqual({ launchAtLogin: true });
  });

  it('rejects unknown channels without invoking anything', async () => {
    await expect(router.dispatch('app:admin-backdoor', {}, trustedFrame)).rejects.toThrow(
      IpcUnknownChannelError,
    );
    expect(calls).toHaveLength(1);
  });

  it('rejects untrusted senders before schema parsing/handler invocation', async () => {
    await expect(
      router.dispatch(
        'settings:set-launch-at-login',
        { enabled: true },
        {
          senderFrame: { url: 'https://evil.example/' },
        },
      ),
    ).rejects.toThrow('denied');
    expect(calls).toHaveLength(1);
  });

  it('rejects invalid payloads before handler invocation', async () => {
    await expect(
      router.dispatch('settings:set-launch-at-login', { enabled: 'yes' }, trustedFrame),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('rejects channels with a schema but no handler (incomplete wiring)', async () => {
    const incomplete = createIpcRouter({
      guard: { assertTrusted: () => undefined },
      schemas,
      handlers: {},
    });
    await expect(
      incomplete.dispatch('settings:set-launch-at-login', { enabled: true }, trustedFrame),
    ).rejects.toThrow(IpcUnknownChannelError);
  });
});
