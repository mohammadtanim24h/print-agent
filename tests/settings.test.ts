import { describe, expect, it } from 'vitest';
import { createSettingsStore, type SettingsFileAdapter } from '../src/main/services/settings';

function memoryAdapter(initial: string | null = null): SettingsFileAdapter & { written: string[] } {
  let content = initial;
  const written: string[] = [];
  return {
    get written() {
      return written;
    },
    read: () => Promise.resolve(content),
    writeAtomic: (_path, contents) => {
      written.push(contents);
      content = contents;
      return Promise.resolve();
    },
  };
}

describe('settings store', () => {
  it('loads defaults when no file exists', async () => {
    const store = await createSettingsStore({
      filePath: 'settings.json',
      adapter: memoryAdapter(null),
    });
    expect(store.get()).toEqual({ launchAtLogin: false });
  });

  it('loads a valid saved file', async () => {
    const store = await createSettingsStore({
      filePath: 'settings.json',
      adapter: memoryAdapter(JSON.stringify({ launchAtLogin: true })),
    });
    expect(store.get()).toEqual({ launchAtLogin: true });
  });

  it('falls back to defaults on corrupt JSON and reports it', async () => {
    const reported: string[] = [];
    const store = await createSettingsStore({
      filePath: 'settings.json',
      adapter: memoryAdapter('{not json'),
      report: (m) => reported.push(m),
    });
    expect(store.get()).toEqual({ launchAtLogin: false });
    expect(reported).toHaveLength(1);
  });

  it('falls back to defaults when the file has unknown fields (strict)', async () => {
    const store = await createSettingsStore({
      filePath: 'settings.json',
      adapter: memoryAdapter(JSON.stringify({ launchAtLogin: true, admin: true })),
    });
    expect(store.get()).toEqual({ launchAtLogin: false });
  });

  it('set() persists atomically and updates the cache', async () => {
    const adapter = memoryAdapter(null);
    const store = await createSettingsStore({ filePath: 'settings.json', adapter });
    await store.set({ launchAtLogin: true });
    expect(store.get()).toEqual({ launchAtLogin: true });
    expect(adapter.written).toEqual([JSON.stringify({ launchAtLogin: true })]);
  });

  it('set() rejects unknown keys (strict)', async () => {
    const store = await createSettingsStore({
      filePath: 'settings.json',
      adapter: memoryAdapter(null),
    });
    await expect(store.set({ launchAtLogin: false, extra: 1 } as never)).rejects.toThrow();
  });
});
