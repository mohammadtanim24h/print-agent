import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readdir as realReaddir, rename as realRename } from 'node:fs/promises';
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

  it('sweeps crash-orphan tmp siblings on the first write to a path', async () => {
    const path = join(dir, 'printers.json');
    writeFileSync(`${path}.deadbeef.tmp`, 'orphan');
    const adapter = createNodeSettingsAdapter();
    await adapter.writeAtomic(path, '{"ok":true}');
    expect(readdirSync(dir)).toEqual(['printers.json']);
  });

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

  it('runs the orphan sweep once across multiple writes to a path', async () => {
    const path = join(dir, 'sweeponce.json');
    let readdirCalls = 0;
    const adapter = createNodeSettingsAdapter({
      readdir: async (d) => {
        readdirCalls += 1;
        return realReaddir(d);
      },
    });
    await adapter.writeAtomic(path, '{"n":1}');
    await adapter.writeAtomic(path, '{"n":2}');
    await adapter.writeAtomic(path, '{"n":3}');
    expect(readdirCalls).toBe(1);
  });

  it('leaves other files tmp orphans alone (strict prefix filter)', async () => {
    const path = join(dir, 'mine.json');
    writeFileSync(join(dir, 'other.json.xyz.tmp'), 'not mine');
    const adapter = createNodeSettingsAdapter();
    await adapter.writeAtomic(path, '{"ok":1}');
    expect(readdirSync(dir).sort()).toEqual(['mine.json', 'other.json.xyz.tmp']);
  });

  it('exhausts retryable rename attempts, propagates the error, cleans its tmp', async () => {
    const path = join(dir, 'exhaust.json');
    const adapter = createNodeSettingsAdapter({
      rename: () => Promise.reject(Object.assign(new Error('held by scanner'), { code: 'EBUSY' })),
    });
    await expect(adapter.writeAtomic(path, '{"x":1}')).rejects.toThrow('held by scanner');
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
