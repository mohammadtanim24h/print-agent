import { z } from 'zod';

/**
 * The complete IPC surface between renderer and main. Single source of truth:
 * preload exposes exactly these channels, main handles exactly these channels,
 * request payloads are validated with these strict schemas (unknown fields
 * rejected). Size caps: the only string payloads are the 8-char pairing code
 * (`pair:with-code`), UUIDs (printer/job ids) and bounded enums (log levels);
 * no free text crosses IPC.
 * Every future string-bearing schema MUST declare `.max()` bounds
 * (CLAUDE.md rule 3).
 */

export const Channel = {
  GetAgentInfo: 'app:info',
  GetSettings: 'settings:get',
  SetLaunchAtLogin: 'settings:set-launch-at-login',
  SettingsUpdate: 'settings:update',
  HideWindow: 'window:hide',
  QuitApp: 'app:quit',
  AgentSnapshot: 'agent:snapshot',
  PairWithCode: 'pair:with-code',
  AgentUnpair: 'agent:unpair',
  PrintersList: 'printers:list',
  PrintersAdd: 'printers:add',
  PrintersUpdate: 'printers:update',
  PrintersRemove: 'printers:remove',
  PrintersTest: 'printers:test',
  JobsList: 'jobs:list',
  JobsRetry: 'jobs:retry',
  JobsReprint: 'jobs:reprint',
  DiagnosticsReport: 'diagnostics:report',
  DiagnosticsChecks: 'diagnostics:checks',
  LogsRecent: 'logs:recent',
} as const;
export type Channel = (typeof Channel)[keyof typeof Channel];

const noPayload = z.undefined();

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

const printerIdPayload = z.strictObject({ printerId: z.uuid() });

export const RequestSchemas = {
  [Channel.GetAgentInfo]: noPayload,
  [Channel.GetSettings]: noPayload,
  [Channel.SetLaunchAtLogin]: z.strictObject({ enabled: z.boolean() }),
  // Partial patch: every field optional; an empty object is a valid no-op.
  [Channel.SettingsUpdate]: z.strictObject({
    startMinimized: z.boolean().optional(),
    logLevel: z.enum(LOG_LEVELS).optional(),
  }),
  [Channel.HideWindow]: noPayload,
  [Channel.QuitApp]: noPayload,
  [Channel.AgentSnapshot]: noPayload,
  [Channel.PairWithCode]: z.strictObject({ code: z.string().regex(/^[A-Z0-9]{8}$/) }),
  [Channel.AgentUnpair]: noPayload,
  [Channel.PrintersList]: noPayload,
  // draft validated by PrinterDraftSchema in the printer store
  [Channel.PrintersAdd]: z.strictObject({ draft: z.unknown() }),
  [Channel.PrintersUpdate]: z.strictObject({ printerId: z.uuid(), draft: z.unknown() }),
  [Channel.PrintersRemove]: printerIdPayload,
  [Channel.PrintersTest]: printerIdPayload,
  [Channel.JobsList]: noPayload,
  [Channel.JobsRetry]: z.strictObject({ jobId: z.uuid() }),
  [Channel.JobsReprint]: z.strictObject({ jobId: z.uuid() }),
  [Channel.DiagnosticsReport]: noPayload,
  [Channel.DiagnosticsChecks]: noPayload,
  [Channel.LogsRecent]: noPayload,
} as const satisfies Record<Channel, z.ZodType>;

export type RequestOf<C extends Channel> = z.output<(typeof RequestSchemas)[C]>;

/** Derived from the schema — main.ts and preload must not re-declare it. */
export type SettingsUpdatePayload = RequestOf<(typeof Channel)['SettingsUpdate']>;

export const CONNECTION_STATES = ['unpaired', 'connecting', 'online', 'offline', 'revoked'] as const;

export const AgentInfoSchema = z.strictObject({
  name: z.string(),
  version: z.string(),
  connectionState: z.enum(CONNECTION_STATES),
});

export const AppSettingsSchema = z.strictObject({
  launchAtLogin: z.boolean(),
  startMinimized: z.boolean().default(true),
  logLevel: z.enum(LOG_LEVELS).default('info'),
  /** Non-secret: when the device was paired (RFC 3339), null before pairing. */
  pairedAt: z.string().nullable().default(null),
  /** FR-16 marker: config_version of the last SUCCESSFULLY applied cloud
   *  config. -1 = none. Read by the runtime's config guard; the renderer
   *  never sets it (main-only concern living in the shared schema because
   *  the settings file is one schema). */
  appliedConfigVersion: z.number().int().default(-1),
});

export type AgentInfo = z.output<typeof AgentInfoSchema>;
export type AppSettings = z.output<typeof AppSettingsSchema>;
