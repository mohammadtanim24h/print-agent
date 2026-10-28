# A1 — Apply Cloud Config to Printers (FR-16) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server `config_update` / `GET /config` snapshots atomically drive the printer store (create/update/remove by `printer_id`, source-tagged merge), with startup fetch + persisted-config re-apply.

**Architecture:** Pure mapper (`config-apply.ts`) converts contract §4 `PrinterConfig` entries into local `PrinterProfile`s (source `'cloud'`); `PrinterStore.replaceCloud()` owns the merge (locals preserved, stale cloud entries dropped) and durability; the runtime orchestrates guard → persist → map → apply → marker.

**Tech Stack:** TypeScript strict, zod v4, vitest. Spec: `docs/superpowers/specs/2026-10-28-config-apply-design.md`.

**Conventions for this repo:** strict mode, `exactOptionalPropertyTypes` is ON (omit optional keys rather than pass `undefined` — see the spread-conditional pattern in `tests/agent-runtime.test.ts:300`), no `any` at boundaries, typed errors, comments only where non-obvious. Test commands: `pnpm vitest run <file>` for one file, `pnpm test` for all. Typecheck `pnpm typecheck`, lint `pnpm lint`.

---

### Task 1: Extend `PrinterProfileSchema` (source tag + cloud-sourced fields)

**Files:**
- Modify: `src/main/printers/profile.ts:110-124`
- Test: `tests/printer-profile.test.ts` (append new `describe` block)

- [ ] **Step 1: Write the failing tests**

Append to `tests/printer-profile.test.ts` (keep existing imports; add `PrinterProfileSchema` to the import list if not already imported — check the file's current imports first):

```ts
describe('profile schema: source tag + cloud-sourced fields', () => {
  // A pre-A1 on-disk file has no `source` field — it must parse as 'local',
  // not hit the strict rejection ("printers file invalid, starting empty").
  it('defaults a missing source to local (legacy file upgrade path)', () => {
    const legacy = {
      printerId: '018f0000-0000-7000-8000-000000000001',
      name: 'Kitchen',
      role: 'kitchen',
      paperWidthMm: 80,
      printableDots: 576,
      charsPerLine: 48,
      capabilities: { cut: true, qrCode: false, barcode128: false, statusPolling: false, cashDrawer: false },
      transport: { kind: 'tcp_raw', host: '192.168.1.50', port: 9100 },
    };
    const parsed = PrinterProfileSchema.parse(legacy);
    expect(parsed.source).toBe('local');
    expect(parsed.station).toBeUndefined();
    expect(parsed.duplicatePolicy).toBeUndefined();
  });

  it('accepts a cloud-sourced profile with the cloud-only fields', () => {
    const parsed = PrinterProfileSchema.parse({
      ...makeProfile({ source: 'cloud' }),
      station: 'kitchen',
      copiesDefault: 2,
      codepage: 'cp850',
      cutDefault: 'partial',
      duplicatePolicy: 'auto_reprint',
      statusPolling: 'auto',
    });
    expect(parsed.source).toBe('cloud');
    expect(parsed.copiesDefault).toBe(2);
    expect(parsed.station).toBe('kitchen');
  });

  it('rejects an unknown source value', () => {
    expect(() =>
      PrinterProfileSchema.parse({ ...makeProfile(), source: 'admin' }),
    ).toThrow();
  });

  it('rejects out-of-range cloud fields (copiesDefault, cutDefault)', () => {
    expect(() =>
      PrinterProfileSchema.parse({ ...makeProfile(), copiesDefault: 5 }),
    ).toThrow();
    expect(() =>
      PrinterProfileSchema.parse({ ...makeProfile(), cutDefault: 'tear' }),
    ).toThrow();
  });

  it('drafts cannot set printerId or source', () => {
    expect(() =>
      PrinterDraftSchema.parse({ ...makeDraft(), source: 'cloud' }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/printer-profile.test.ts`
Expected: FAIL — `source` does not exist on the schema output type (TS error at `parsed.source` / `makeProfile({ source: 'cloud' })`), and the draft-parses-source test fails because unknown keys are stripped?? NOTE: `PrinterDraftSchema.parse({...makeDraft(), source: 'cloud'})` currently **passes** (zod strictObject rejects unknown keys — actually it throws, which is what we assert, so this one may already pass). The other four are the failing set.

- [ ] **Step 3: Implement the schema change**

In `src/main/printers/profile.ts`, replace the `PrinterProfileSchema` / `PrinterDraftSchema` block (currently lines 110-124) with:

```ts
export const PrinterProfileSchema = z.strictObject({
  printerId: z.uuid(),
  name: z.string().min(1).max(64),
  role: z.enum(PRINTER_ROLES),
  paperWidthMm: z.union([z.literal(58), z.literal(80)]),
  // Per-printer physical values — never derived from paper width (spec §4).
  printableDots: z.number().int().min(192).max(800),
  charsPerLine: z.number().int().min(16).max(96),
  capabilities: PrinterCapabilitiesSchema,
  transport: EndpointTcpRawSchema,
  /** Who manages this profile: the local UI or the SaaS config stream (FR-16).
   *  Default keeps pre-A1 on-disk files valid (they are all local). */
  source: z.enum(['local', 'cloud']).default('local'),
  // Cloud-sourced fields (api-contract §4) — optional: local profiles never
  // carry them; cloud-applied profiles always do. Preserved for FR-14
  // (duplicate_policy) and C1 (status_polling) to consume.
  station: z.string().max(24).optional(),
  copiesDefault: z.number().int().min(1).max(4).optional(),
  codepage: z.string().max(24).optional(),
  cutDefault: z.enum(['full', 'partial', 'none']).optional(),
  duplicatePolicy: z.enum(['ask_operator', 'auto_reprint', 'never']).optional(),
  statusPolling: z.enum(['auto', 'off']).optional(),
});
export type PrinterProfile = z.output<typeof PrinterProfileSchema>;

export const PrinterDraftSchema = PrinterProfileSchema.omit({ printerId: true, source: true });
export type PrinterDraft = z.output<typeof PrinterDraftSchema>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/printer-profile.test.ts tests/printer-store.test.ts tests/view-model.test.ts`
Expected: PASS (the store/view-model suites catch accidental schema ripples).

- [ ] **Step 5: Commit**

```bash
git add src/main/printers/profile.ts tests/printer-profile.test.ts
git commit -m "feat(printers): source tag + cloud-sourced fields on PrinterProfile"
```

---

### Task 2: Pure mapper `mapCloudPrinters` (`config-apply.ts`)

**Files:**
- Create: `src/main/printers/config-apply.ts`
- Create: `tests/config-apply.test.ts`
- Create helper: `tests/helpers/cloud-config.ts`

- [ ] **Step 1: Create the §4 config fixture helper**

`tests/helpers/cloud-config.ts`:

```ts
import type { ConfigUpdate, PrinterConfig } from '../../src/main/cloud-client/schemas';

/** A contract §4 printer entry that maps cleanly to a local profile. */
export function makePrinterConfig(overrides: Partial<PrinterConfig> = {}): PrinterConfig {
  return {
    printer_id: '018f0000-0000-7000-8000-0000000000c1',
    name: 'Kitchen-1',
    transport: { kind: 'tcp_raw', host: '192.168.1.87', port: 9100, connect_timeout_ms: 3000, write_timeout_ms: 5000 },
    station: 'kitchen',
    copies_default: 1,
    codepage: 'cp437',
    cut_default: 'partial',
    duplicate_policy: 'ask_operator',
    status_polling: 'auto',
    ...overrides,
  };
}

export function makeConfigUpdate(
  printers: PrinterConfig[],
  configVersion = 1,
): ConfigUpdate {
  return { type: 'config_update', config_version: configVersion, printers };
}
```

Note: `PrinterConfig` is `z.output<typeof PrinterConfigSchema>`; `envelope_version` is optional so it is omitted. If the type rejects the literal fields (readonly output), adjust with `as PrinterConfig` — but prefer the plain object; zod output types are mutable.

- [ ] **Step 2: Write the failing tests**

`tests/config-apply.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mapCloudPrinters } from '../src/main/printers/config-apply';
import { makeProfile } from './helpers/printers';
import { makeConfigUpdate, makePrinterConfig } from './helpers/cloud-config';

describe('mapCloudPrinters', () => {
  it('maps a §4 printer entry to a cloud-sourced local profile', () => {
    const result = mapCloudPrinters(makeConfigUpdate([makePrinterConfig()]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.printers).toHaveLength(1);
    const p = result.printers[0]!;
    expect(p.printerId).toBe('018f0000-0000-7000-8000-0000000000c1');
    expect(p.name).toBe('Kitchen-1');
    expect(p.source).toBe('cloud');
    expect(p.role).toBe('kitchen');
    expect(p.station).toBe('kitchen');
    // Physical defaults — DEFAULT_80MM_PROFILE values, never fabricated variants.
    expect(p.paperWidthMm).toBe(80);
    expect(p.printableDots).toBe(576);
    expect(p.charsPerLine).toBe(48);
    expect(p.capabilities).toEqual({
      cut: true, qrCode: true, barcode128: true, statusPolling: true, cashDrawer: false,
    });
    expect(p.transport).toEqual({ kind: 'tcp_raw', host: '192.168.1.87', port: 9100 });
    // Cloud-only fields preserved for FR-14 / C1.
    expect(p.copiesDefault).toBe(1);
    expect(p.codepage).toBe('cp437');
    expect(p.cutDefault).toBe('partial');
    expect(p.duplicatePolicy).toBe('ask_operator');
    expect(p.statusPolling).toBe('auto');
  });

  it('maps station to role by exact match, else custom', () => {
    const result = mapCloudPrinters(
      makeConfigUpdate([
        makePrinterConfig({ printer_id: '018f0000-0000-7000-8000-0000000000c2', station: 'bar' }),
        makePrinterConfig({ printer_id: '018f0000-0000-7000-8000-0000000000c3', station: 'cashier' }),
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.printers.map((p) => p.role)).toEqual(['bar', 'custom']);
  });

  it('maps status_polling off to capabilities.statusPolling false', () => {
    const result = mapCloudPrinters(
      makeConfigUpdate([makePrinterConfig({ status_polling: 'off' })]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.printers[0]?.capabilities.statusPolling).toBe(false);
  });

  it('rejects a hostname host (no DNS in v1)', () => {
    const config = makeConfigUpdate([
      makePrinterConfig({ transport: { kind: 'tcp_raw', host: 'printer.example.com', port: 9100, connect_timeout_ms: 3000, write_timeout_ms: 5000 } }),
    ]);
    const result = mapCloudPrinters(config);
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.reason).toContain('IP');
    expect(result.reason).toContain('018f0000-0000-7000-8000-0000000000c1');
  });

  it('rejects loopback and multicast hosts (approved-endpoint policy)', () => {
    for (const host of ['127.0.0.1', '224.0.0.1', '::1', '0.0.0.0']) {
      const result = mapCloudPrinters(
        makeConfigUpdate([
          makePrinterConfig({ transport: { kind: 'tcp_raw', host, port: 9100, connect_timeout_ms: 3000, write_timeout_ms: 5000 } }),
        ]),
      );
      expect(result.ok).toBe(false);
    }
  });

  it('rejects spooler_raw and usb transports (not applicable in v1)', () => {
    const spooler = mapCloudPrinters(
      makeConfigUpdate([makePrinterConfig({ transport: { kind: 'spooler_raw', windows_printer_name: 'EPSON TM-T20' } })]),
    );
    const usb = mapCloudPrinters(
      makeConfigUpdate([makePrinterConfig({ transport: { kind: 'usb', vid: '04b8', pid: '0202' } })]),
    );
    expect(spooler.ok).toBe(false);
    expect(usb.ok).toBe(false);
  });

  it('reject-all: any bad entry rejects the whole config', () => {
    const config = makeConfigUpdate([
      makePrinterConfig(),
      makePrinterConfig({ printer_id: '018f0000-0000-7000-8000-0000000000c4', transport: { kind: 'usb', vid: '04b8', pid: '0202' } }),
    ]);
    const result = mapCloudPrinters(config);
    expect(result.ok).toBe(false);
    // All-or-nothing: not even the valid entry is returned.
    if (!result.ok) expect(result.reason).toContain('018f0000-0000-7000-8000-0000000000c4');
  });

  it('rejects an empty name and duplicate printer_ids', () => {
    const emptyName = mapCloudPrinters(makeConfigUpdate([makePrinterConfig({ name: '' })]));
    expect(emptyName.ok).toBe(false);
    const dup = mapCloudPrinters(
      makeConfigUpdate([makePrinterConfig(), makePrinterConfig()]),
    );
    expect(dup.ok).toBe(false);
  });

  it('accepts an empty printers array (config that removes the whole fleet)', () => {
    const result = mapCloudPrinters(makeConfigUpdate([]));
    expect(result).toEqual({ ok: true, printers: [] });
  });
});
```

Fix the sloppy line in the hostname test before committing — the assertion should simply be:

```ts
expect(result.reason).toContain('IP');
```

(Delete the `??` line; `result.reason` is a plain string.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run tests/config-apply.test.ts`
Expected: FAIL — module `../src/main/printers/config-apply` does not exist.

(The hostname-test assertion above is final — `result.reason` is a plain string; no further edits needed.)

- [ ] **Step 4: Implement the mapper**

Create `src/main/printers/config-apply.ts`:

```ts
import { isIP } from 'node:net';
import { DEFAULT_80MM_PROFILE } from '../render/profile';
import type { ConfigUpdate, PrinterConfig } from '../cloud-client/schemas';
import { isApprovedEndpointHost, type PrinterProfile } from './profile';

/**
 * FR-16 mapping: contract §4 `PrinterConfig` → local `PrinterProfile`.
 * Pure: no I/O, no timers, inputs never mutated. All-or-nothing — any
 * unmappable entry rejects the whole config (api-contract §4 "applies
 * atomically", §6 "invalid transport address rejected").
 *
 * v1 applies tcp_raw only: spooler_raw arrives with A2 (P7), usb is v1.1.
 * Hostnames are rejected — the approved-destination policy (profile.ts)
 * admits IP literals only; there is no DNS surface in v1.
 */

export type ConfigApplyResult =
  | { readonly ok: true; readonly printers: PrinterProfile[] }
  | { readonly ok: false; readonly reason: string };

function roleFromStation(station: string): 'kitchen' | 'receipt' | 'bar' | 'custom' {
  return station === 'kitchen' || station === 'receipt' || station === 'bar'
    ? station
    : 'custom';
}

function toProfile(pc: PrinterConfig): PrinterProfile | { readonly error: string } {
  if (pc.name === '') return { error: `printer ${pc.printer_id}: empty name` };
  if (pc.transport.kind !== 'tcp_raw') {
    return {
      error: `printer ${pc.printer_id}: transport ${pc.transport.kind} not applicable in v1 (tcp_raw only)`,
    };
  }
  if (isIP(pc.transport.host) === 0) {
    return { error: `printer ${pc.printer_id}: host must be an IP literal (no DNS in v1)` };
  }
  if (!isApprovedEndpointHost(pc.transport.host)) {
    return { error: `printer ${pc.printer_id}: host is loopback, multicast or otherwise not approved` };
  }
  return {
    printerId: pc.printer_id,
    name: pc.name,
    role: roleFromStation(pc.station),
    // Physical values: the renderer's existing 80mm fallback (render/profile.ts).
    // The cloud does not send physical fields — FR-16 contract extension is out of scope.
    paperWidthMm: DEFAULT_80MM_PROFILE.paperWidthMm,
    printableDots: DEFAULT_80MM_PROFILE.printableDots,
    charsPerLine: DEFAULT_80MM_PROFILE.charsPerLine,
    capabilities: {
      cut: true,
      qrCode: true,
      barcode128: true,
      statusPolling: pc.status_polling === 'auto',
      cashDrawer: false,
    },
    transport: { kind: 'tcp_raw', host: pc.transport.host, port: pc.transport.port },
    station: pc.station,
    copiesDefault: pc.copies_default,
    codepage: pc.codepage,
    cutDefault: pc.cut_default,
    duplicatePolicy: pc.duplicate_policy,
    statusPolling: pc.status_polling,
    source: 'cloud',
  };
}

export function mapCloudPrinters(config: ConfigUpdate): ConfigApplyResult {
  const printers: PrinterProfile[] = [];
  const seen = new Set<string>();
  for (const pc of config.printers) {
    const mapped = toProfile(pc);
    if ('error' in mapped) return { ok: false, reason: mapped.error };
    if (seen.has(mapped.printerId)) {
      return { ok: false, reason: `duplicate printer_id in config: ${mapped.printerId}` };
    }
    seen.add(mapped.printerId);
    printers.push(mapped);
  }
  return { ok: true, printers };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run tests/config-apply.test.ts && pnpm typecheck`
Expected: PASS. Typecheck matters here: `DEFAULT_80MM_PROFILE.paperWidthMm` is the literal `80`, which must satisfy `paperWidthMm: 58 | 80`.

- [ ] **Step 6: Commit**

```bash
git add src/main/printers/config-apply.ts tests/config-apply.test.ts tests/helpers/cloud-config.ts
git commit -m "feat(printers): pure §4→profile mapper (mapCloudPrinters, all-or-nothing)"
```

---

### Task 3: `PrinterStore.replaceCloud()` — merge + durability

**Files:**
- Modify: `src/main/printers/store.ts` (interface + implementation)
- Test: `tests/printer-store.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/printer-store.test.ts` (imports already present; also add `import { makeProfile } from './helpers/printers';` alongside `makeDraft`):

```ts
import { makeProfile } from './helpers/printers';

describe('printer store: replaceCloud (FR-16 merge)', () => {
  function cloudProfile(printerId: string, name = 'Cloud-Kitchen') {
    return { ...makeProfile({ name, source: 'cloud' }), printerId };
  }

  it('adds cloud entries and preserves locals, persisting the merged list', async () => {
    const adapter = memoryAdapter(null);
    const store = await createStore(adapter);
    const local = await store.add(makeDraft({ name: 'Front' }));
    const cloud = cloudProfile('018f0000-0000-7000-8000-0000000000d1');
    await store.replaceCloud([cloud]);
    expect(store.list()).toEqual([local, cloud]);
    expect(JSON.parse(adapter.written.at(-1) ?? '')).toEqual([local, cloud]);
  });

  it('replaces previous cloud entries wholesale; a second apply drops removed printers', async () => {
    const store = await createStore(memoryAdapter(null));
    await store.replaceCloud([cloudProfile('018f0000-0000-7000-8000-0000000000d1', 'Old')]);
    const next = cloudProfile('018f0000-0000-7000-8000-0000000000d2', 'New');
    await store.replaceCloud([next]);
    expect(store.list()).toEqual([next]);
  });

  it('a cloud id colliding with a local printer replaces the local entry', async () => {
    const store = await createStore(memoryAdapter(null));
    const local = await store.add(makeDraft({ name: 'Local-Managed' }));
    const cloud = cloudProfile(local.printerId, 'Now-Managed');
    await store.replaceCloud([cloud]);
    expect(store.list()).toEqual([cloud]);
  });

  it('rolls back when persistence fails', async () => {
    const adapter = memoryAdapter(null);
    const failing: SettingsFileAdapter = {
      read: (path) => adapter.read(path),
      writeAtomic: () => Promise.reject(new Error('disk full')),
    };
    const store = await createStore(failing);
    const local = await store.add(makeDraft());
    await expect(
      store.replaceCloud([cloudProfile('018f0000-0000-7000-8000-0000000000d3')]),
    ).rejects.toThrow('disk full');
    expect(store.list()).toEqual([local]);
  });

  it('an empty cloud list removes only cloud-managed entries', async () => {
    const store = await createStore(memoryAdapter(null));
    const local = await store.add(makeDraft());
    await store.replaceCloud([cloudProfile('018f0000-0000-7000-8000-0000000000d4')]);
    await store.replaceCloud([]);
    expect(store.list()).toEqual([local]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/printer-store.test.ts`
Expected: FAIL — `store.replaceCloud is not a function`.

- [ ] **Step 3: Implement**

In `src/main/printers/store.ts`, add to the `PrinterStore` interface (after `remove`):

```ts
/**
 * FR-16 merge point: swaps in the mapped cloud fleet. Locals (source !==
 * 'cloud') are preserved in order; a cloud id colliding with a local one
 * replaces it (the server now manages that printer). Atomic like every
 * other mutation — a failed write leaves the cache untouched.
 */
replaceCloud(cloudProfiles: PrinterProfile[]): Promise<void>;
```

And in the returned object (after `remove`):

```ts
async replaceCloud(cloudProfiles) {
  const cloudIds = new Set(cloudProfiles.map((p) => p.printerId));
  const locals = cached.filter((p) => p.source !== 'cloud' && !cloudIds.has(p.printerId));
  const next = [...locals, ...cloudProfiles];
  await adapter.writeAtomic(filePath, JSON.stringify(next));
  cached = next;
},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/printer-store.test.ts`
Expected: PASS (existing suite included).

- [ ] **Step 5: Commit**

```bash
git add src/main/printers/store.ts tests/printer-store.test.ts
git commit -m "feat(printers): atomic replaceCloud merge (locals preserved, id-collision replaces)"
```

---

### Task 4: `appliedConfigVersion` in app settings

**Files:**
- Modify: `src/shared/ipc-contract.ts:85-91`
- Test: `tests/settings.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/settings.test.ts` (reuse its existing imports/helpers — read the file first; the assertions below are self-contained against `DEFAULT_SETTINGS` and `AppSettingsSchema`, imported from `../../src/shared/ipc-contract`):

```ts
describe('appliedConfigVersion', () => {
  it('defaults to -1 (nothing applied yet) and survives a round-trip parse', () => {
    expect(DEFAULT_SETTINGS.appliedConfigVersion).toBe(-1);
    const parsed = AppSettingsSchema.parse({ launchAtLogin: false });
    expect(parsed.appliedConfigVersion).toBe(-1);
    const bumped = AppSettingsSchema.parse({
      launchAtLogin: false,
      appliedConfigVersion: 41,
    });
    expect(bumped.appliedConfigVersion).toBe(41);
  });

  it('rejects a non-integer marker', () => {
    expect(() =>
      AppSettingsSchema.parse({ launchAtLogin: false, appliedConfigVersion: 1.5 }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/settings.test.ts`
Expected: FAIL — `appliedConfigVersion` unknown (TS error / undefined).

- [ ] **Step 3: Implement**

In `src/shared/ipc-contract.ts`, extend `AppSettingsSchema`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/settings.test.ts tests/ipc-contract.test.ts && pnpm typecheck`
Expected: PASS. (If `tests/ipc-contract.test.ts` asserts the exact settings key set, update that assertion to include the new key — the schema is additive, so strict parse of old files still succeeds via the default.)

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc-contract.ts tests/settings.test.ts
git commit -m "feat(settings): appliedConfigVersion marker for the FR-16 config guard"
```

---

### Task 5: Runtime orchestration — `applyConfig`, start/pair fetch, wipe reset

**Files:**
- Modify: `src/main/agent-runtime.ts`
- Test: `tests/agent-runtime.test.ts`

- [ ] **Step 1: Extend the test transport + harness**

In `tests/agent-runtime.test.ts`:

1. `FakeTransport` gains a mutable config response (default unchanged, so existing tests are untouched):

```ts
export interface FakeTransport extends AgentTransport {
  readonly queuedJobs: unknown[];
  readonly acks: AckBatch[];
  readonly heartbeats: HeartbeatSample[];
  failNextPoll: Error | null;
  /** Mutable GET /config response for refreshConfig tests. */
  configResponse: ConfigUpdate;
  readonly configFetches: number;
}
```

In `fakeTransport()`: add `configResponse: { type: 'config_update', config_version: 0, printers: [] } as ConfigUpdate` and `configFetches: 0` to `impl`, and change `getConfig` to:

```ts
getConfig() {
  impl.configFetches += 1;
  return Promise.resolve().then(() => impl.configResponse);
},
```

Note `impl` is currently a plain object literal cast — keep the same style; if the literal is `as unknown as AgentTransport`-shaped, extend that cast object with the two new fields.

2. Add a helper next to the other helpers (module scope):

```ts
function makeCloudPrinterConfig(n: number, overrides: Partial<PrinterConfig> = {}): PrinterConfig {
  return {
    printer_id: makeUuid(100 + n),
    name: `Cloud-${String(n)}`,
    transport: { kind: 'tcp_raw', host: '192.168.1.87', port: 9100, connect_timeout_ms: 3000, write_timeout_ms: 5000 },
    station: 'kitchen',
    copies_default: 1,
    codepage: 'cp437',
    cut_default: 'partial',
    duplicate_policy: 'ask_operator',
    status_polling: 'auto',
    ...overrides,
  };
}

function makeCloudConfig(configVersion: number, printers: PrinterConfig[]): ConfigUpdate {
  return { type: 'config_update', config_version: configVersion, printers };
}
```

Add `PrinterConfig` to the existing `ConfigUpdate` import from `../src/main/cloud-client/schemas`.

- [ ] **Step 2: Write the failing runtime tests**

New `describe` block in `tests/agent-runtime.test.ts`:

```ts
describe('AgentRuntime config application (FR-16)', () => {
  it('applies a config_update from the poll batch to the printer store', async () => {
    const { runtime, transport } = await makeRuntime();
    transport.queuedJobs.push(makeCloudConfig(1, [makeCloudPrinterConfig(1)]));
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    await vi.waitFor(() => {
      const cloud = runtime.printers.list().find((p) => p.config.source === 'cloud');
      expect(cloud?.config.name).toBe('Cloud-1');
    });
    expect(runtime.printers.list().find((p) => p.config.printerId === makeUuid(101))?.config.source).toBe('cloud');
  });

  it('a later config removes a dropped cloud printer but keeps local ones', async () => {
    const { runtime, transport } = await makeRuntime();
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    const local = await runtime.printers.add(makeDraft({ name: 'Local-Front' }));

    transport.queuedJobs.push(makeCloudConfig(1, [makeCloudPrinterConfig(1), makeCloudPrinterConfig(2)]));
    await vi.waitFor(() => {
      expect(runtime.printers.list().filter((p) => p.config.source === 'cloud')).toHaveLength(2);
    });

    transport.queuedJobs.push(makeCloudConfig(2, [makeCloudPrinterConfig(1)]));
    await vi.waitFor(() => {
      const ids = runtime.printers.list().map((p) => p.config.printerId);
      expect(ids).toContain(local.printerId);
      expect(ids).toContain(makeUuid(101));
      expect(ids).not.toContain(makeUuid(102));
    });
  });

  it('ignores a config_version regression end-to-end (contract §6)', async () => {
    const { runtime, transport } = await makeRuntime();
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    transport.queuedJobs.push(makeCloudConfig(5, [makeCloudPrinterConfig(1)]));
    await vi.waitFor(() => {
      expect(runtime.printers.list()).toHaveLength(1);
    });

    transport.queuedJobs.push(makeCloudConfig(4, [makeCloudPrinterConfig(2)]));
    // Give the poll loop a moment; the regression must never mutate the store.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runtime.printers.list().map((p) => p.config.name)).toEqual(['Cloud-1']);
  });

  it('reject-all: a config with an unmappable printer mutates nothing and warns', async () => {
    const { runtime, transport, log } = await makeRuntime();
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    transport.queuedJobs.push(
      makeCloudConfig(3, [
        makeCloudPrinterConfig(1, { transport: { kind: 'usb', vid: '04b8', pid: '0202' } }),
      ]),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runtime.printers.list()).toHaveLength(0);
    expect(
      log.warn.mock.calls.some((args) => String(args[0]).includes('not applicable in v1')),
    ).toBe(true);
  });

  it('a fresh pair fetches GET /config once (initial fleet)', async () => {
    const { runtime, transport } = await makeRuntime();
    transport.configResponse = makeCloudConfig(7, [makeCloudPrinterConfig(3)]);
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    await vi.waitFor(() => {
      expect(runtime.printers.list().some((p) => p.config.name === 'Cloud-3')).toBe(true);
    });
    expect(transport.configFetches).toBeGreaterThanOrEqual(1);
  });

  it('start() re-applies a persisted config that was saved but never applied', async () => {
    const { runtime, db, transport } = await makeRuntime();
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    // Applied v1 (marker = 1), then simulate a crash after save of v2 but
    // before its apply: write v2 straight into cloud_config.
    transport.queuedJobs.push(makeCloudConfig(1, [makeCloudPrinterConfig(1)]));
    await vi.waitFor(() => {
      expect(runtime.printers.list()).toHaveLength(1);
    });
    await runtime.stop();
    const v2 = makeCloudConfig(2, [makeCloudPrinterConfig(1), makeCloudPrinterConfig(2)]);
    const upsert = db.prepare(
      `INSERT INTO cloud_config (id, config_version, payload_json, updated_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET config_version = excluded.config_version,
         payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
    );
    upsert.run(v2.config_version, JSON.stringify(v2), Date.now());

    runtime.start(); // restart path: persisted v2 > marker 1 → apply

    await vi.waitFor(() => {
      expect(runtime.printers.list()).toHaveLength(2);
    });
  });

  it('unpair resets the applied-version marker so a fresh pair can use lower versions', async () => {
    const { runtime, transport, settings } = await makeRuntime();
    runtime.start();
    await runtime.pair(PAIRING_CODE);
    transport.queuedJobs.push(makeCloudConfig(9, [makeCloudPrinterConfig(1)]));
    await vi.waitFor(() => {
      expect(runtime.printers.list()).toHaveLength(1);
    });
    expect(settings.get().appliedConfigVersion).toBe(9);

    await runtime.unpair();
    expect(settings.get().appliedConfigVersion).toBe(-1);
    expect(settings.get().pairedAt).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run tests/agent-runtime.test.ts`
Expected: FAIL — cloud printers never appear (config is persist-only today); `configFetches` stays 0; marker stays -1 after a successful apply.

- [ ] **Step 4: Implement the runtime wiring**

In `src/main/agent-runtime.ts`:

1. Add the import:

```ts
import { mapCloudPrinters } from './printers/config-apply';
```

2. Replace the persist-only handler (currently at lines 273-276) with the orchestrator. Place `applyConfig` near the lifecycle section:

```ts
  // ---- cloud config application (FR-16) ------------------------------------

  /** Reject-all semantics: nothing is applied unless every entry maps. */
  function applyConfig(config: ConfigUpdate): void {
    const marker = deps.settings.get().appliedConfigVersion;
    if (config.config_version <= marker) return; // regression — ignore (§6)
    configStore.save(config); // record of latest known config, even if apply fails
    const mapped = mapCloudPrinters(config);
    if (!mapped.ok) {
      log.warn(`runtime: rejected config v${String(config.config_version)}: ${mapped.reason}`);
      return;
    }
    printers
      .replaceCloud(mapped.printers)
      .then(() => deps.settings.set({ appliedConfigVersion: config.config_version }))
      .catch((err: unknown) => {
        // Persist failed / marker failed: the store is unchanged (replaceCloud
        // is atomic) and the marker stays old, so start() re-applies this config.
        log.error(`runtime: config v${String(config.config_version)} apply failed: ${describeErr(err)}`);
      });
  }

  /** One-shot GET /config (initial fleet for a fresh pair, catch-up at
   *  launch). Failure is benign — poll/push deliver the config later. */
  function fetchConfigOnce(): void {
    client.refreshConfig().catch((err: unknown) => {
      log.warn(`runtime: initial config fetch failed (will arrive via poll/push): ${describeErr(err)}`);
    });
  }
```

Add `ConfigUpdate` to the cloud-client types import — check `src/main/cloud-client/types.ts` exports; `ConfigUpdate` lives in `schemas.ts`, so import from `./cloud-client/schemas`:

```ts
import type { ConfigUpdate } from './cloud-client/schemas';
```

3. Replace the handler:

```ts
  client.on('config', (config) => {
    applyConfig(config);
  });
```

(Delete the old "Persist-only this phase" comment.)

4. In `start()`, after the identity pre-flight (inside the `try`, after `client.start()`), add the startup re-apply + fetch. Restructure the existing block to:

```ts
    try {
      if (readIdentity() !== null) {
        // Re-apply a config that was persisted but never successfully applied
        // (crash or transient failure window). The marker guard makes this a
        // no-op when the persisted config is already applied. The cast is safe:
        // the payload was zod-validated by the poller before the original save,
        // and mapCloudPrinters re-checks everything it consumes.
        const persisted = configStore.get();
        if (persisted !== null) applyConfig(persisted as ConfigUpdate);
        client.start();
        fetchConfigOnce();
      }
    } catch (err) {
```

5. In `pair()`, after the success path stores settings, add the initial fetch:

```ts
      const identity = await client.pair({ pairingCode: code, deviceName });
      const pairedAt = new Date(now()).toISOString();
      await deps.settings.set({ pairedAt });
      fetchConfigOnce(); // fire-and-forget; the fleet also arrives via poll/push
      return { ok: true, identity: toAgentIdentity(identity, pairedAt) };
```

6. In `wipeLocalState()`, reset the marker (otherwise a re-pair to a restaurant with lower config versions would be blocked by the stale guard):

```ts
      await deps.settings.set({ pairedAt: null, appliedConfigVersion: -1 });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run tests/agent-runtime.test.ts && pnpm typecheck`
Expected: PASS, both suites green. If the restart test hangs in `vi.waitFor`, the likely cause is the poller refusing a post-stop `start()` — the persisted-apply step runs before `client.start()` in `start()`, so it still fires; verify the assertion targets the printer store, not connection state.

- [ ] **Step 6: Full suite + lint**

Run: `pnpm test && pnpm lint`
Expected: all green, no new lint findings (the `as ConfigUpdate` cast may trip `@typescript-eslint/no-unsafe-type-assertion` if enabled — if so, type-guard instead:

```ts
  function isConfigUpdate(value: StoredCloudConfig): value is ConfigUpdate {
    return ConfigUpdateSchema.safeParse(value).success;
  }
```

and call `applyConfig` only when the guard passes, logging a warn otherwise. Prefer the guard if lint asks.)

- [ ] **Step 7: Commit**

```bash
git add src/main/agent-runtime.ts tests/agent-runtime.test.ts
git commit -m "feat(runtime): apply cloud config to the printer store (FR-16)"
```

---

### Task 6: Docs — architecture, api-contract, readiness, spec sync

**Files:**
- Modify: `docs/architecture.md:150-156` (the config bullet)
- Modify: `docs/api-contract.md` (§4 note + §7 note)
- Modify: `docs/production-readiness.md:14-28` (A1)
- Modify: `docs/superpowers/specs/2026-10-28-config-apply-design.md` (Status → implemented)

- [ ] **Step 1: architecture.md**

Replace the bullet

```
- **Config:** `config` events are persisted to the `cloud_config` table only;
  application is a later phase (FR-16).
```

with

```
- **Config (FR-16):** `config` events run the apply pipeline: runtime guard
  (`config_version` > `settings.appliedConfigVersion`) → persist to
  `cloud_config` → `mapCloudPrinters` (all-or-nothing §4→profile mapping;
  tcp_raw + IP-literal hosts only) → `PrinterStore.replaceCloud` (locals
  preserved, stale cloud entries removed, id collision replaces) → marker
  update. Rejected configs are logged and never applied. `start()` re-applies
  a persisted-but-unapplied config; `start()`/`pair()` fetch `GET /config`
  once for the initial fleet. Merge policy: source-tagged coexistence —
  locally-added printers are never touched by the sync.
```

- [ ] **Step 2: api-contract.md**

In §4, after the existing apply paragraph, append:

```
Agent-side merge policy (v1): profiles are source-tagged `local`/`cloud`; a
config_update manages only cloud-tagged entries (locally-added printers are
never removed by the sync). v1 applies `tcp_raw` with IP-literal hosts only —
a config containing a hostname, `spooler_raw` (until P7), or `usb` (v1.1)
printer, a duplicate `printer_id`, or an empty `name` is rejected whole
(nothing applied). A `codepage` value is stored but rendering supports
cp437/cp850 (R-VAL-1).
```

In §7, add a numbered note consistent with the list's existing style:

```
N. Config acks (`config.applied` / `config.rejected{error}` in §4) have no
   REST/WSS surface yet; the agent logs rejections locally. Define the
   endpoint before relying on rejection telemetry.
```

(Use the next free note number in §7's list.)

- [ ] **Step 3: production-readiness.md**

Update A1: mark `[x]`-style done by replacing the `**Status:** open —` line with the closing evidence:

```
- **Status:** done (2026-10-28) — apply pipeline in `agent-runtime.ts`
  (`applyConfig`) + `printers/config-apply.ts` + `PrinterStore.replaceCloud`;
  source-tagged merge policy documented in api-contract §4. Evidence:
  `tests/config-apply.test.ts`, `tests/printer-store.test.ts` (replaceCloud),
  runtime wiring tests in `tests/agent-runtime.test.ts` ("AgentRuntime config
  application (FR-16)"), regression-ignored test at the runtime guard.
```

Also update the "Suggested order" line at the bottom to drop A1 from the remaining sequence.

- [ ] **Step 4: spec doc**

In `docs/superpowers/specs/2026-10-28-config-apply-design.md`, change `Status: approved` to `Status: implemented (2026-10-28)`.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture.md docs/api-contract.md docs/production-readiness.md docs/superpowers/specs/2026-10-28-config-apply-design.md
git commit -m "docs: FR-16 config apply — architecture, contract merge policy, A1 closed"
```

---

### Task 7: Final verification

- [ ] **Step 1: Full gates**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all green; the ~500-test suite includes the new suites.

- [ ] **Step 2: Grep for stale claims**

Run a search for `persist-only this phase` and `FR-16 is a` in `src/` — both should be gone.

- [ ] **Step 3: No commit needed** (verification only). If anything surfaced, fix + commit before declaring done.
