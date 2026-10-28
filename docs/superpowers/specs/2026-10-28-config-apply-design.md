# A1 — Apply Cloud Config to Printers (FR-16) — Design

Date: 2026-10-28
Status: implemented (2026-10-28)
Closes: `docs/production-readiness.md` A1

## Problem

`agent-runtime.ts` handles `config_update` / `GET /config` as persist-only
(`configStore.save(config)`, architecture.md: "application is a later phase").
FR-16 requires the SaaS-managed printer configuration to actually drive the
agent's printer store: printers created, updated and removed on
`config_version` increase, keyed by `printer_id`, applied atomically, cached
for offline use.

Two structural gaps make this more than a one-line change:

1. **Schema mismatch.** Cloud `PrinterConfig` (api-contract §4) carries
   `station`, `copies_default`, `codepage`, `cut_default`, `duplicate_policy`,
   `status_polling` and permits hostname hosts plus `spooler_raw`/`usb`
   transports. The local `PrinterProfile` requires physical print fields the
   cloud does not send (`paperWidthMm`, `printableDots`, `charsPerLine`,
   `capabilities`) and only models `tcp_raw` with IP-literal hosts.
2. **No initial-fetch path.** `CloudClient.refreshConfig()` (GET `/config`)
   exists but is never called by the runtime — a freshly paired agent never
   receives its printer fleet until the server happens to push a
   `config_update`.

## Decisions (user-approved)

| Decision | Choice |
| --- | --- |
| Merge policy for locally-added printers | Source-tagged coexistence: `source: 'local' \| 'cloud'`; sync only manages cloud entries |
| Physical print fields for cloud printers | `DEFAULT_80MM_PROFILE` values (80 mm / 576 dots / 48 cpl / capabilities all true); cloud-only fields preserved on the profile |
| Initial sync | Fetch `GET /config` at start + re-apply persisted config on start |
| Apply mechanics | Pure `mapCloudPrinters` mapper + atomic `PrinterStore.replaceCloud()` + runtime orchestrator |

## 1. Schema changes (`src/main/printers/profile.ts`)

`PrinterProfileSchema` (strict) gains:

- `source: z.enum(['local', 'cloud']).default('local')` — the default keeps
  existing on-disk printer files valid after upgrade (missing field →
  `'local'`, true for every pre-A1 profile) and avoids the
  "printers file invalid, starting empty" data-loss path. Drafts cannot set
  it: `PrinterDraftSchema = PrinterProfileSchema.omit({ printerId, source })`.
  The store assigns it (`add()` → `'local'`, `replaceCloud()` → `'cloud'`).
- Optional cloud-sourced fields (optional so old files parse; cloud-applied
  entries always carry them):
  - `station?: string ≤ 24`
  - `copiesDefault?: int 1..4`
  - `codepage?: string ≤ 24` (stored as sent; rendering supports
    `cp437`/`cp850` — R-VAL-1)
  - `cutDefault?: 'full' | 'partial' | 'none'`
  - `duplicatePolicy?: 'ask_operator' | 'auto_reprint' | 'never'`
  - `statusPolling?: 'auto' | 'off'`

## 2. Pure mapper — `src/main/printers/config-apply.ts`

```
mapCloudPrinters(config: ConfigUpdate):
  { ok: true; printers: PrinterProfile[] } | { ok: false; reason: string }
```

(Correction from the approved draft: the mapper only maps and validates; the
merge lives solely in `PrinterStore.replaceCloud()` — one merge point, not
two.)

- **Map** each cloud `PrinterConfig` → `PrinterProfile`:
  - `printer_id` → `printerId`, `name` → `name`.
  - `station` preserved verbatim in `station`; `role` via exact match on
    `kitchen|receipt|bar`, else `'custom'`.
  - `transport.kind` must be `tcp_raw` and its `host` must pass the local
    profile's rules (IP literal + `isApprovedEndpointHost`). Any hostname,
    `spooler_raw`, or `usb` entry ⇒ the **whole config is rejected**
    (`{ ok: false, reason }`) — all-or-nothing per contract §4/§6
    ("applies atomically", "invalid transport address rejected").
    `spooler_raw` becomes applicable with A2; `usb` is v1.1.
  - Physical fields from `DEFAULT_80MM_PROFILE`; `capabilities.statusPolling`
    = (`status_polling === 'auto'`).
  - `copies_default` → `copiesDefault`, `codepage` → `codepage`,
    `cut_default` → `cutDefault`, `duplicate_policy` → `duplicatePolicy`,
    `status_polling` → also kept in `statusPolling`.
  - `source: 'cloud'` on every mapped profile.
  - An entry with an empty `name` (the wire schema allows `bytes(64)` = empty)
    or a duplicate `printer_id` inside `printers[]` also rejects the whole
    config — the local profile schema and the store's uniqueness invariant
    cannot represent either.
- Purity: zero I/O, zero timers, does not mutate its inputs. Deterministic.

Rejection is logged by the runtime. Contract §4 mentions
`config.applied` / `config.rejected{error}` acks but no wire surface exists
for them — recorded as a contract gap for the Laravel side, **out of A1
scope**.

## 3. Store — `replaceCloud()` (`src/main/printers/store.ts`)

One new method, `replaceCloud(profiles: PrinterProfile[])`:
next list = all `source !== 'cloud'` profiles (untouched, order preserved) +
incoming cloud profiles. A cloud `printer_id` colliding with an existing
local id replaces the local entry (same printer; the server now manages it).
Single `adapter.writeAtomic` → swap cache. A failed write leaves the cache
unchanged (rollback), the same invariant as `add/update/remove/clear`.

## 4. Runtime orchestration (`src/main/agent-runtime.ts`)

`applyConfig(config)`:

1. Guard: skip when `config.config_version <= settings.appliedConfigVersion`
   (nothing saved, nothing applied). The guard must run **before** the save —
   otherwise a stale config would overwrite a newer persisted config.
   The marker is defense-in-depth on top of the poller's in-memory regression
   guard and what makes the startup re-apply safe against regressing a newer
   applied state with an older persisted config.
2. `configStore.save(config)` — the record of the latest known server config
   is persisted even when apply subsequently fails, so startup re-applies it.
3. `mapCloudPrinters(config)` → reject ⇒ `log.warn(reason)`, stop (marker unchanged).
4. `printers.replaceCloud(profiles)` → on success
   `settings.set({ appliedConfigVersion: config.config_version })`.

Startup re-apply rule: apply the persisted config only when
`persisted.config_version > appliedConfigVersion` — after the ordering above
this is exactly the "saved but not successfully applied" set.

Wiring:

- The persist-only `client.on('config')` handler becomes `applyConfig`.
- `start()` (paired at launch): apply the persisted config first (offline
  cache, FR-16; covers crash and transient-failure windows), then
  fire-and-forget `client.refreshConfig()` with catch-and-log; offline errors
  are benign (poll/push deliver later).
- `pair()` success also fires the same one-shot `refreshConfig()` — a fresh
  pair never re-enters `start()` (the poller starts inside `client.pair()`),
  so without this the initial fleet would only arrive when the server happens
  to push a `config_update`.
- Wipe path unchanged (`configStore.clear()` already runs; the settings
  marker is cleared with the rest of settings on wipe).
- `heartbeatSample()` needs no change — it lists the store, which now
  includes cloud-managed printers.
- `toPrinterInfo` (`view-model.ts`) exposes `source` (and `station`) so the
  renderer can badge managed printers later; UI changes themselves stay out
  of scope.

## 5. Settings

`appliedConfigVersion: number` added to the settings schema, default `-1`.

## 6. Docs (same change — CLAUDE.md workflow rule)

- `docs/architecture.md`: replace the "persist-only this phase" config bullet
  with the apply flow and the merge policy.
- `docs/api-contract.md` §7 note: the agent-side merge policy (source-tagged
  coexistence; reject-all on any unmappable printer; v1 applies `tcp_raw`
  only, IP-literal hosts) — the cross-team-visible statement of what a SaaS
  operator may put in a printer config.
- `docs/production-readiness.md`: tick A1 with evidence pointers.

## 7. Tests

- **Unit (`config-apply.ts`)**: create/update/remove mapping; station→role;
  hostname / loopback / `spooler_raw` / `usb` ⇒ reject-all with inputs
  unmutated (purity); local entries preserved; id collision replaces local.
- **Unit (store)**: `replaceCloud` persists and swaps; `writeAtomic` failure
  ⇒ list unchanged (rollback).
- **Regression**: config with lower/equal version ignored at the orchestrator
  level (contract §6 row), complementing the poller's existing test.
- **Runtime wiring (readiness acceptance)**: poller with mock transport
  delivers a `config_update` in a poll batch ⇒ printer store mutated with
  `source: 'cloud'` profiles; a later batch removing a printer ⇒ removed;
  a locally-added printer survives both; `refreshConfig()` applies on start.
- Existing suite stays green; renderer types updated where `PrinterInfo` is
  consumed.

## Out of scope

- `config.applied` / `config.rejected` wire acks (contract gap, needs
  cross-team change).
- UI badge for managed printers (view-model exposes the data; screens later).
- `spooler_raw` application (A2), `usb` (v1.1), printer status polling (C1).
