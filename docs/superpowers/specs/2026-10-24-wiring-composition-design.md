# Wiring / Composition Phase — Design

Date: 2026-10-24
Status: approved (pending implementation plan)

## Goal

Make the print agent a real application: instantiate the existing, tested
modules (cloud-client poller, job engine, transport registry, printers) in the
Electron main process, expose them over the validated IPC bridge, and replace
the renderer's mock service with the real one. After this phase no screen runs
on demo data, and jobs flow end-to-end: poll → engine → transport → ack.

Out of scope (explicitly): WSS transport, spooler transport (P7),
packaging/updates (P8), config application FR-16, duplicate banner FR-14,
hardware validation (P9), Electron E2E harness.

## 1. AgentRuntime — composition root

New module `src/main/agent-runtime.ts`. `main.ts` shrinks to: security guards
→ settings store → `createAgentRuntime(...)` → IPC router → window/tray.

```ts
interface RuntimeDeps {
  settings: SettingsStore;
  paths: { dbFile: string; printersFile: string; settingsFile: string };
  log: Logger;
  agentVersion: string;
  safeStorage: SafeStorageLike;                  // injected per secret-store.ts seam
  env?: { now?; schedule?; random?; transport? } // test seams, defaulting to real
}
interface AgentRuntime {
  start(): void;   // idempotent
  stop(): void;    // idempotent; flushes acks, closes DB
  snapshot(): AgentSnapshot;
  pair(code: string): Promise<PairResult>;
  unpair(): Promise<void>;
  printers: { list; add; update; remove; testPrint };
  jobs: { list; retry; reprint };
  diagnostics: { report(); checks(); recentLogs() };
}
```

Build order: `openDatabase → migrate → sqliteJobStore → createPrinterStore →
createTransportRegistry → createJobEngine → createSafeStorageSecretStore →
createHttpTransport → createPollingCloudClient → createPrinterService`.

## 2. Cloud event plumbing

- `client.on('job')` → map validated envelope `job` → `engine.submit(...)`
  (`expires_at` parsed to epoch ms). Poller already did scope + signature
  checks; no re-validation.
- Engine `AckSink` → `AckBuffer` (same module): flushes to
  `client.submitAcks(...)` at 20 acks, on a 5 s timer, and on `stop()`.
- `client.on('state')` → recorded; `snapshot()` maps to renderer state.
- `client.on('config')` → validated `ConfigUpdate` persisted to a new
  `cloud_config` kv table (one local-store migration). Nothing applies it yet;
  diagnostics shows the stored version. (FR-16 application is a later phase.)
- Heartbeat: `heartbeatSample()` reports `engine.pendingCount()`, printer
  count, uptime.
- Revocation and unpair share `wipeLocalState()`: stop client → clear secrets
  → clear job store → clear printer store. Requires one small module change:
  add `clear()` to `PrinterStore` (tested).

### State vocabulary (decision)

Renderer `ConnectionState` becomes exactly the cloud client's union:
`'unpaired' | 'connecting' | 'online' | 'offline' | 'revoked'`.
`AgentInfoSchema.connectionState` widens from `z.literal('disabled')` to the
same union. `disabled`/`error` are dropped from the renderer type.

## 3. IPC surface

`src/shared/ipc-contract.ts` — extend `Channel`/`RequestSchemas` (strict zod,
`.max()` caps everywhere, per CLAUDE.md rule 3):

| Channel | Request schema |
|---|---|
| `agent:snapshot` | `z.undefined()` |
| `pair:with-code` | `{ code: z.string().regex(/^\d{6,12}$/) }` — numeric 6–12; `pairing.ts` imposes no format, so this is the agent-side constraint |
| `agent:unpair` | `z.undefined()` |
| `printers:list` | `z.undefined()` |
| `printers:add` / `printers:update` | strict `PrinterDraftSchema` re-exported from `printers/profile.ts` (+ `printerId: z.uuid()` for update) |
| `printers:remove` / `printers:test` | `{ printerId: z.uuid() }` |
| `jobs:list` | `z.undefined()` (latest 200 rows) |
| `jobs:retry` / `jobs:reprint` | `{ jobId: z.uuid() }` |
| `diagnostics:report` / `diagnostics:checks` | `z.undefined()` |
| `logs:recent` | `z.undefined()` |

Existing 5 channels unchanged. Registration stays via `createIpcRouter`
(unknown-channel → schema → sender guard → handler). `PrinterDraftSchema`
lives once in `printers/profile.ts` — no duplicate schema in shared.

Preload: one named method per channel on `window.printAgent`. No raw `invoke`
exposure, no channel strings in renderer.

## 4. Renderer

- `production-service.ts` becomes real: each `AgentService` method maps to one
  bridge call; `demo: false`. `MockAgentService` is deleted outright.
- `types.ts`: `ConnectionState` swapped to the cloud union. Screens updated:
  Overview renders `unpaired` (CTA → Setup) and `revoked` (wipe notice +
  re-pair CTA, honest §3.1 wording); Setup's pairing form calls real
  `pairWithCode` and renders `PairResult` failures; other screens consume real
  data unchanged in shape.
- Screen tests keep using a fake `AgentService` (seam stays injectable).

Display identity (resolved, no longer open): `IdentitySecrets` carries
deviceId/restaurantId but not restaurantName or pairedAt. Decision:
`pair()` records `pairedAt` (timestamp) in the non-secret settings store;
`AgentIdentity.restaurantName` falls back to `restaurantId` until the server
supplies a display name (candidate for the config stream, out of scope).
`snapshot()` builds the renderer identity from secrets + settings.

## 5. Errors, diagnostics, lifecycle

- Handlers throw typed errors with stable machine codes; the router serializes
  `{ code, message }` — no stack traces over the bridge. Pairing failures map
  into `PairResult` (`invalid_code | expired | already_paired | network`), not
  throws.
- Diagnostics, real data: DB health from the live handle (journal mode, queue
  depth, size via `fs.stat`); connectivity checks = cloud HTTPS reachability
  (5 s timeout), per-printer TCP connect, DB writability — best-effort, each
  returns `pass | warn | fail`, never throws. `recentLogs()` = last ~200 lines
  from the redacted log ring buffer.
- `AckBuffer` flush failures retain acks and retry on next flush; buffer cap
  500, oldest-first drop + log line. `stop()` is idempotent, flushes acks
  before closing the DB.
- Startup order: guards → settings → runtime → `engine.recover()` →
  `runtime.start()` (first poll cycle recovers pending work).
  `before-quit` → `runtime.stop()`.

## 6. Testing

- `agent-runtime.test.ts` — fake `AgentTransport`, in-memory SQLite, fake
  `schedule`: envelope → engine row; ack flush batching/timing; revocation
  wipe (identity+jobs+printers); unpair uses the same wipe path; `recover()`
  before
  client start; snapshot mapping incl. `revoked`; config persisted; heartbeat
  sample content.
- `ack-buffer.test.ts` — thresholds, failure retention, cap behavior.
- `ipc-contract.test.ts` — new schemas reject unknown fields / oversized
  strings.
- Printer store `clear()` test.
- Renderer screen tests updated for new `ConnectionState` union.
- No-LISTEN smoke test still passes (AC-4).

## 7. Acceptance for this phase

1. App launches paired-unpaired honestly; pairing via Setup screen goes
   `unpaired → connecting → online` against the real API.
2. A polled job produces a DB row, a transport attempt, and an ack batch on
   the wire (verified at module/integration level; physical printing is never
   claimed — §3.1 wording everywhere).
3. Revocation wipes identity, jobs, printers; UI shows revoked state and
   re-pair path works.
4. All six screens render real data; `demo: false`.
5. New tests pass; existing suite stays green.
