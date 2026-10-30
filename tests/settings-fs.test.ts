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
