import { describe, expect, it, vi } from 'vitest';
import { createJsonFileKv } from '../src/main/secret-kv';
import { memoryAdapter } from './helpers/memory-adapter';

describe('createJsonFileKv', () => {
  it('set/get/delete round-trips through the backing file', async () => {
    const adapter = memoryAdapter();
    const kv = await createJsonFileKv('identity-kv.json', adapter);
    expect(kv.get('cloud.identity')).toBeNull();
    kv.set('cloud.identity', 'blob-1');
    expect(kv.get('cloud.identity')).toBe('blob-1');
    kv.delete('cloud.identity');
    expect(kv.get('cloud.identity')).toBeNull();
    expect(kv.get('other')).toBeNull();
  });

  it('persists across reopen', async () => {
    const adapter = memoryAdapter();
    const first = await createJsonFileKv('identity-kv.json', adapter);
    first.set('cloud.identity', 'blob-2');
    first.set('other.key', 'v');
    await first.flush();

    const second = await createJsonFileKv('identity-kv.json', adapter);
    expect(second.get('cloud.identity')).toBe('blob-2');
    expect(second.get('other.key')).toBe('v');
    second.delete('cloud.identity');
    await second.flush();

    const third = await createJsonFileKv('identity-kv.json', adapter);
    expect(third.get('cloud.identity')).toBeNull();
    expect(third.get('other.key')).toBe('v');
  });

  it('treats a corrupt file as empty instead of throwing', async () => {
    const adapter = memoryAdapter('{ not json');
    const kv = await createJsonFileKv('identity-kv.json', adapter);
    expect(kv.get('cloud.identity')).toBeNull();
    kv.set('cloud.identity', 'fresh');
    await kv.flush();
    expect(JSON.parse(adapter.written[0] ?? '{}')).toMatchObject({ 'cloud.identity': 'fresh' });
  });

  it('ignores non-string values read from disk', async () => {
    const adapter = memoryAdapter(JSON.stringify({ a: 'ok', b: 42, c: { nested: true } }));
    const kv = await createJsonFileKv('identity-kv.json', adapter);
    expect(kv.get('a')).toBe('ok');
    expect(kv.get('b')).toBeNull();
    expect(kv.get('c')).toBeNull();
  });

  it('reports persist failures through onError instead of throwing', async () => {
    const onError = vi.fn();
    const failing = {
      read: () => Promise.resolve(null),
      writeAtomic: () => Promise.reject(new Error('disk full')),
    };
    const kv = await createJsonFileKv('identity-kv.json', failing, onError);
    kv.set('cloud.identity', 'blob-3');
    await kv.flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(kv.get('cloud.identity')).toBe('blob-3'); // cache retains; disk is stale
  });
});
