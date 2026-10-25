import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createJsonFileKv } from '../src/main/secret-kv';

const dirs: string[] = [];

function tempFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'secret-kv-'));
  dirs.push(dir);
  return join(dir, name);
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

describe('createJsonFileKv', () => {
  it('set/get/delete round-trips through the backing file', () => {
    const file = tempFile('identity.json');
    const kv = createJsonFileKv(file);
    expect(kv.get('cloud.identity')).toBeNull();
    kv.set('cloud.identity', 'blob-1');
    expect(kv.get('cloud.identity')).toBe('blob-1');
    kv.delete('cloud.identity');
    expect(kv.get('cloud.identity')).toBeNull();
    expect(kv.get('other')).toBeNull();
  });

  it('persists across reopen with no awaits — durability before set() returns', () => {
    const file = tempFile('identity.json');
    const first = createJsonFileKv(file);
    first.set('cloud.identity', 'blob-2');
    first.set('other.key', 'v');
    // No flush(), no await: a new store over the same path MUST see the value.
    const second = createJsonFileKv(file);
    expect(second.get('cloud.identity')).toBe('blob-2');
    expect(second.get('other.key')).toBe('v');
    second.delete('cloud.identity');
    const third = createJsonFileKv(file);
    expect(third.get('cloud.identity')).toBeNull();
    expect(third.get('other.key')).toBe('v');
  });

  it('treats a corrupt file as empty instead of throwing', () => {
    const file = tempFile('identity.json');
    const kv = createJsonFileKv(file, { readSync: () => '{ not json' });
    expect(kv.get('cloud.identity')).toBeNull();
    kv.set('cloud.identity', 'fresh');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ 'cloud.identity': 'fresh' });
  });

  it('ignores non-string values read from disk', () => {
    const raw = JSON.stringify({ a: 'ok', b: 42, c: { nested: true } });
    const kv = createJsonFileKv('unused.json', { readSync: () => raw });
    expect(kv.get('a')).toBe('ok');
    expect(kv.get('b')).toBeNull();
    expect(kv.get('c')).toBeNull();
  });

  it('set() throws when the target directory is unwritable and the cache does not claim success', () => {
    // The parent directory does not exist → the tmp-file write fails.
    const file = join(tempFile('unused'), 'missing-dir', 'identity.json');
    const kv = createJsonFileKv(file);
    expect(() => kv.set('cloud.identity', 'blob-3')).toThrow();
    expect(kv.get('cloud.identity')).toBeNull();
  });

  it('delete() propagates write failures the same way', () => {
    const file = tempFile('identity.json');
    const kv = createJsonFileKv(file);
    kv.set('cloud.identity', 'blob-4');
    const failing = createJsonFileKv(file, {
      writeSync: (_path, _contents) => {
        throw new Error('disk full');
      },
    });
    expect(() => failing.delete('cloud.identity')).toThrow('disk full');
    // The real store on disk still holds the value; a fresh reopen sees it.
    const reopened = createJsonFileKv(file);
    expect(reopened.get('cloud.identity')).toBe('blob-4');
  });
});
