import { describe, expect, it } from 'vitest';
import {
  AgentInfoSchema,
  AppSettingsSchema,
  Channel,
  RequestSchemas,
} from '../src/shared/ipc-contract';
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

describe('wiring-phase channels', () => {
  it('registers the new agent/pairing/printers/jobs/diagnostics channels', () => {
    expect(Channel.PairWithCode).toBe('pair:with-code');
    expect(Channel.AgentSnapshot).toBe('agent:snapshot');
    expect(Channel.AgentUnpair).toBe('agent:unpair');
    expect(Channel.PrintersList).toBe('printers:list');
    expect(Channel.PrintersAdd).toBe('printers:add');
    expect(Channel.PrintersUpdate).toBe('printers:update');
    expect(Channel.PrintersRemove).toBe('printers:remove');
    expect(Channel.PrintersTest).toBe('printers:test');
    expect(Channel.JobsList).toBe('jobs:list');
    expect(Channel.JobsRetry).toBe('jobs:retry');
    expect(Channel.JobsReprint).toBe('jobs:reprint');
    expect(Channel.DiagnosticsReport).toBe('diagnostics:report');
    expect(Channel.DiagnosticsChecks).toBe('diagnostics:checks');
    expect(Channel.LogsRecent).toBe('logs:recent');
  });

  it('validates the pairing code per api-contract §3.4 (8 alnum chars)', () => {
    expect(RequestSchemas[Channel.PairWithCode].safeParse({ code: '7QJ2K9XD' }).success).toBe(true);
    expect(RequestSchemas[Channel.PairWithCode].safeParse({ code: '7QJ2K9X' }).success).toBe(false);
    expect(RequestSchemas[Channel.PairWithCode].safeParse({ code: '7QJ2K9XD1' }).success).toBe(false);
    expect(RequestSchemas[Channel.PairWithCode].safeParse({ code: '7QJ2K9X!' }).success).toBe(false);
    expect(
      RequestSchemas[Channel.PairWithCode].safeParse({ code: '7QJ2K9XD', extra: 1 }).success,
    ).toBe(false);
  });

  it('bounds printer/job id payloads and rejects unknown fields', () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    expect(RequestSchemas[Channel.PrintersTest].safeParse({ printerId: uuid }).success).toBe(true);
    expect(RequestSchemas[Channel.PrintersTest].safeParse({ printerId: 'nope' }).success).toBe(false);
    expect(RequestSchemas[Channel.JobsRetry].safeParse({ jobId: uuid }).success).toBe(true);
  });

  it('widens AgentInfo connectionState to the cloud union', () => {
    for (const s of ['unpaired', 'connecting', 'online', 'offline', 'revoked'] as const) {
      expect(AgentInfoSchema.safeParse({ name: 'print-agent', version: '0.1.0', connectionState: s }).success).toBe(true);
    }
    expect(AgentInfoSchema.safeParse({ name: 'print-agent', version: '0.1.0', connectionState: 'disabled' }).success).toBe(false);
  });

  it('extends AppSettings with startMinimized and logLevel (defaults for old files)', () => {
    expect(AppSettingsSchema.safeParse({ launchAtLogin: false }).success).toBe(true);
    const parsed = AppSettingsSchema.parse({ launchAtLogin: false });
    expect(parsed.startMinimized).toBe(true);
    expect(parsed.logLevel).toBe('info');
    expect(parsed.pairedAt).toBeNull();
    expect(AppSettingsSchema.safeParse({ launchAtLogin: false, logLevel: 'verbose' }).success).toBe(false);
  });
});
