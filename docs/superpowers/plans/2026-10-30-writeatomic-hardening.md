# writeAtomic Concurrent-Write Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden `createNodeSettingsAdapter().writeAtomic` against concurrent writers: per-path write queue, unique tmp names, crash-orphan sweep, and EPERM/EBUSY rename retry.

**Architecture:** All changes stay inside `src/main/services/settings-fs.ts` (adapter-level only, per spec). A `Map<string, Promise>` serializes same-path writes in call order; each write uses a UUID-suffixed tmp file so concurrent writers never collide; the first write to a path sweeps orphaned tmp siblings; failed renames are cleaned up. I/O functions are injectable via an optional `deps` parameter for testing.

**Tech Stack:** TypeScript strict, `node:fs/promises`, `node:crypto.randomUUID`, `node:path`, Vitest with real-fs `mkdtemp` tests.

**Spec:** `docs/superpowers/specs/2026-10-30-writeatomic-hardening-design.md`

---

### Task 1: Per-path queue + unique tmp names

**Files:**
- Create: `tests/settings-fs.test.ts`
- Modify: `src/main/services/settings-fs.ts` (full rewrite, current content is 21 lines)

- [ ] **Step 1: Write the failing tests**

Create `tests/settings-fs.test.ts`:

```ts
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeSettingsAdapter } from '../src/main/services/settings-fs';

describe('node settings adapter writeAtomic (concurrent-write hardening)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'settings-fs-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('serializes concurrent writes on one path — last-issued wins, no tmp litter', async () => {
    const path = join(dir, 'settings.json');
    const adapter = createNodeSettingsAdapter();
    const writes = Array.from({ length: 20 }, (_, i) =>
      adapter.writeAtomic(path, JSON.stringify({ i })),
    );
    await Promise.all(writes);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ i: 19 });
    expect(readdirSync(dir)).toEqual(['settings.json']);
  });

  it('keeps different paths independent', async () => {
    const adapter = createNodeSettingsAdapter();
    const a = join(dir, 'a.json');
    const b = join(dir, 'b.json');
    await Promise.all([
      adapter.writeAtomic(a, '"A1"'),
      adapter.writeAtomic(b, '"B1"'),
      adapter.writeAtomic(a, '"A2"'),
      adapter.writeAtomic(b, '"B2"'),
    ]);
    expect(readFileSync(a, 'utf8')).toBe('"A2"');
    expect(readFileSync(b, 'utf8')).toBe('"B2"');
    expect(readdirSync(dir).sort()).toEqual(['a.json', 'b.json']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/settings-fs.test.ts`
Expected: FAIL — the current fixed-`${path}.tmp` implementation interleaves: concurrent writes collide on the tmp file (ENOENT on rename / wrong final content / leftover litter). The second test may pass by luck on a fast machine; the first must fail deterministically enough (20 writers on one tmp path).

- [ ] **Step 3: Implement queue + unique tmp**

Replace the entire content of `src/main/services/settings-fs.ts` with:

```ts
import { randomUUID } from 'node:crypto';
import { readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { SettingsFileAdapter } from './settings';

/** Injectable I/O; production defaults to node's fs/crypto (used by tests). */
export interface SettingsFsDeps {
  readFile: typeof readFile;
  writeFile: typeof writeFile;
  rename: typeof rename;
  unlink: typeof unlink;
  readdir: typeof readdir;
  randomUUID: () => string;
}

export function createNodeSettingsAdapter(deps: Partial<SettingsFsDeps> = {}): SettingsFileAdapter {
  const io = { readFile, writeFile, rename, unlink, readdir, randomUUID, ...deps };
  // Per-path FIFO of in-flight writes: same-path writes serialize in call
  // order (last-issued write wins the rename); different paths run parallel.
  const queues = new Map<string, Promise<void>>();

  async function writeOnce(path: string, contents: string): Promise<void> {
    const tmp = `${path}.${io.randomUUID()}.tmp`;
    await io.writeFile(tmp, contents, 'utf8');
    await io.rename(tmp, path);
  }

  return {
    async read(path) {
      try {
        return await io.readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    writeAtomic(path, contents) {
      const run = async () => {
        await writeOnce(path, contents);
      };
      // `.then(run, run)`: a previous failed write must not poison the queue.
      const tail = queues.get(path) ?? Promise.resolve();
      const next = tail.then(run, run);
      queues.set(path, next);
      return next;
    },
  };
}
```

Note: `unlink` and `readdir` are already wired into `io` here so Tasks 2–3 only add functions, not plumbing. The module doc comment "(node glue, untested)" is dropped — tests now exist.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/settings-fs.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Check existing store tests still pass (adapter signature is backward compatible — optional param)**

Run: `npx vitest run tests/settings.test.ts tests/printer-store.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/services/settings-fs.ts tests/settings-fs.test.ts
git commit -m "feat: serialize writeAtomic per path with unique tmp names"
```

---

### Task 2: Crash-orphan sweep on first write

**Files:**
- Modify: `tests/settings-fs.test.ts` (add one test)
- Modify: `src/main/services/settings-fs.ts`

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe` block in `tests/settings-fs.test.ts`:

```ts
  it('sweeps crash-orphan tmp siblings on the first write to a path', async () => {
    const path = join(dir, 'printers.json');
    writeFileSync(`${path}.deadbeef.tmp`, 'orphan');
    const adapter = createNodeSettingsAdapter();
    await adapter.writeAtomic(path, '{"ok":true}');
    expect(readdirSync(dir)).toEqual(['printers.json']);
  });
```

Also add `writeFileSync` to the existing `node:fs` import at the top of the file:

```ts
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/settings-fs.test.ts`
Expected: FAIL — the orphan `${path}.deadbeef.tmp` survives because no sweep exists (`expected [ 'printers.json', 'printers.json.deadbeef.tmp' ] to equal [ 'printers.json' ]`).

- [ ] **Step 3: Implement the sweep**

In `src/main/services/settings-fs.ts`, add a `swept` set next to `queues` and a `sweepOrphans` function, then call it from `writeAtomic` before `writeOnce`. The relevant additions (full function bodies shown; everything else unchanged from Task 1):

```ts
  const queues = new Map<string, Promise<void>>();
  const swept = new Set<string>();

  // Crash mid-write can orphan `${path}.${uuid}.tmp` siblings. This process is
  // the only legitimate writer (queue above + Electron single-instance), so on
  // the first write to a path any pre-existing sibling tmp is an orphan.
  async function sweepOrphans(path: string): Promise<void> {
    if (swept.has(path)) return;
    swept.add(path);
    const base = basename(path);
    try {
      for (const entry of await io.readdir(dirname(path))) {
        if (entry.startsWith(`${base}.`) && entry.endsWith('.tmp')) {
          await io.unlink(join(dirname(path), entry)).catch(() => undefined);
        }
      }
    } catch {
      // unreadable directory — skip; orphans get swept on a later launch
    }
  }
```

Change `writeAtomic` to sweep first:

```ts
    writeAtomic(path, contents) {
      const run = async () => {
        await sweepOrphans(path);
        await writeOnce(path, contents);
      };
      // `.then(run, run)`: a previous failed write must not poison the queue.
      const tail = queues.get(path) ?? Promise.resolve();
      const next = tail.then(run, run);
      queues.set(path, next);
      return next;
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/settings-fs.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/services/settings-fs.ts tests/settings-fs.test.ts
git commit -m "feat: sweep crash-orphaned tmp siblings on first writeAtomic per path"
```

---

### Task 3: Rename retry (EPERM/EBUSY) + self-cleanup

**Files:**
- Modify: `tests/settings-fs.test.ts` (add three tests)
- Modify: `src/main/services/settings-fs.ts`

- [ ] **Step 1: Write the failing tests**

Add at the top of `tests/settings-fs.test.ts` (new import alongside the existing `node:fs/promises`-free imports — this file does not import it yet):

```ts
import { rename as realRename } from 'node:fs/promises';
```

Add inside the existing `describe` block:

```ts
  it('retries EPERM renames and succeeds', async () => {
    const path = join(dir, 'retry.json');
    let failures = 0;
    const adapter = createNodeSettingsAdapter({
      rename: async (from, to) => {
        if (failures < 2) {
          failures += 1;
          throw Object.assign(new Error('held by scanner'), { code: 'EPERM' });
        }
        await realRename(from, to);
      },
    });
    await adapter.writeAtomic(path, '{"ok":1}');
    expect(failures).toBe(2);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ ok: 1 });
  });

  it('fails fast on non-retryable rename errors and cleans its tmp', async () => {
    const path = join(dir, 'strict.json');
    const adapter = createNodeSettingsAdapter({
      rename: () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })),
    });
    await expect(adapter.writeAtomic(path, '{"x":1}')).rejects.toThrow('denied');
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('unlinks its tmp when the write itself fails', async () => {
    const path = join(dir, 'fail.json');
    const adapter = createNodeSettingsAdapter({
      writeFile: () => Promise.reject(new Error('disk full')),
    });
    await expect(adapter.writeAtomic(path, '{"x":1}')).rejects.toThrow('disk full');
    expect(readdirSync(dir)).toEqual([]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/settings-fs.test.ts`
Expected: FAIL — first test: writeAtomic rejects after one `EPERM` (no retry exists). Second and third tests: tmp file is left behind (no self-cleanup), so the `.tmp` filter assertion finds one entry / `readdirSync(dir)` is non-empty.

- [ ] **Step 3: Implement retry + self-cleanup**

In `src/main/services/settings-fs.ts`, add below the `SettingsFsDeps` interface:

```ts
const RENAME_ATTEMPTS = 3;
const RENAME_BACKOFF_MS = 25;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
```

Replace `writeOnce` with:

```ts
  async function writeOnce(path: string, contents: string): Promise<void> {
    const tmp = `${path}.${io.randomUUID()}.tmp`;
    try {
      await io.writeFile(tmp, contents, 'utf8');
      for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt += 1) {
        try {
          await io.rename(tmp, path);
          return;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          // Windows: AV/indexer scanners transiently hold the destination handle.
          if ((code !== 'EPERM' && code !== 'EBUSY') || attempt === RENAME_ATTEMPTS) {
            throw error;
          }
          await sleep(RENAME_BACKOFF_MS);
        }
      }
    } catch (error) {
      // Self-cleanup; never masks the original error. If the tmp was never
      // created the unlink ENOENTs and is swallowed.
      await io.unlink(tmp).catch(() => undefined);
      throw error;
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/settings-fs.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — no regressions anywhere (adapter signature is backward compatible; `agent-runtime.ts` and `main.ts` call `createNodeSettingsAdapter()` with no args).

- [ ] **Step 6: Commit**

```bash
git add src/main/services/settings-fs.ts tests/settings-fs.test.ts
git commit -m "feat: retry EPERM/EBUSY renames and self-clean failed writeAtomic tmps"
```

---

### Task 4: Docs — adapter contract comment + production-readiness §D

**Files:**
- Modify: `src/main/services/settings.ts:8-12` (doc comment only)
- Modify: `docs/production-readiness.md` (§D deferred table)

- [ ] **Step 1: Update the `writeAtomic` doc comment in `src/main/services/settings.ts`**

Replace:

```ts
  /** tmp-file + rename under the hood; either old or new content survives crashes. */
  writeAtomic(path: string, contents: string): Promise<void>;
```

with:

```ts
  /**
   * tmp-file + rename under the hood; either old or new content survives
   * crashes. Concurrent writes to the same path serialize in call order —
   * the last-issued write wins (settings-fs.ts queue + unique tmp names).
   */
  writeAtomic(path: string, contents: string): Promise<void>;
```

- [ ] **Step 2: Mark the §D row done in `docs/production-readiness.md`**

Replace the last row of the deferred table:

```markdown
| Concurrent-write hardening for `writeAtomic` | settings-fs.ts fixed `.tmp` path | Bounded, recoverable (failed rename logged; next apply self-heals); revisit before pilot if concurrent-writer count grows |
```

with:

```markdown
| Concurrent-write hardening for `writeAtomic` | settings-fs.ts fixed `.tmp` path | Done (2026-10-30) — per-path write queue + unique tmp names + crash-orphan sweep + EPERM/EBUSY rename retry; evidence `tests/settings-fs.test.ts`, spec `docs/superpowers/specs/2026-10-30-writeatomic-hardening-design.md` |
```

- [ ] **Step 3: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/main/services/settings-fs.ts tests/settings-fs.test.ts`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/main/services/settings.ts docs/production-readiness.md
git commit -m "docs: writeAtomic last-issued-write-wins contract; close §D hardening item"
```
