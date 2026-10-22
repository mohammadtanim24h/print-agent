import { z } from 'zod';

/**
 * The complete IPC surface between renderer and main. Single source of truth:
 * preload exposes exactly these channels, main handles exactly these channels,
 * request payloads are validated with these strict schemas (unknown fields
 * rejected). Size caps: current payloads carry no strings; every future
 * string-bearing schema MUST declare `.max()` bounds (CLAUDE.md rule 3).
 */

export const Channel = {
  GetAgentInfo: 'app:info',
  GetSettings: 'settings:get',
  SetLaunchAtLogin: 'settings:set-launch-at-login',
  HideWindow: 'window:hide',
  QuitApp: 'app:quit',
} as const;
export type Channel = (typeof Channel)[keyof typeof Channel];

const noPayload = z.undefined();

export const RequestSchemas = {
  [Channel.GetAgentInfo]: noPayload,
  [Channel.GetSettings]: noPayload,
  [Channel.SetLaunchAtLogin]: z.strictObject({ enabled: z.boolean() }),
  [Channel.HideWindow]: noPayload,
  [Channel.QuitApp]: noPayload,
} as const satisfies Record<Channel, z.ZodType>;

export type RequestOf<C extends Channel> = z.output<(typeof RequestSchemas)[C]>;

/** Cloud connectivity arrives in P4; until then the state is fixed. */
export const AgentInfoSchema = z.strictObject({
  name: z.string(),
  version: z.string(),
  connectionState: z.literal('disabled'),
});

export const AppSettingsSchema = z.strictObject({
  launchAtLogin: z.boolean(),
});

export type AgentInfo = z.output<typeof AgentInfoSchema>;
export type AppSettings = z.output<typeof AppSettingsSchema>;
