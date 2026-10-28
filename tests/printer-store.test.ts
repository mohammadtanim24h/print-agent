import { describe, expect, it } from 'vitest';
import { createPrinterStore } from '../src/main/printers/store';
import type { SettingsFileAdapter } from '../src/main/services/settings';
import { memoryAdapter } from './helpers/memory-adapter';
import { makeDraft, makeProfile } from './helpers/printers';

let idCounter = 0;
function createStore(adapter: SettingsFileAdapter, report?: (message: string) => void) {
  return createPrinterStore({
    filePath: 'printers.json',
    adapter,
    // Deterministic but schema-valid UUIDs (PrinterProfileSchema requires z.uuid()).
    newId: () => `00000000-0000-4000-8000-${String(++idCounter).padStart(12, '0')}`,
    // exactOptionalPropertyTypes: omit `report` rather than pass undefined.
    ...(report === undefined ? {} : { report }),
  });
}

describe('printer store', () => {
  it('starts empty when no file exists', async () => {
    const store = await createStore(memoryAdapter(null));
    expect(store.list()).toEqual([]);
  });

  it('adds a printer, assigns an id, persists atomically', async () => {
    const adapter = memoryAdapter(null);
    const store = await createStore(adapter);
    const profile = await store.add(makeDraft());
    expect(adapter.written).toHaveLength(1);
    expect(JSON.parse(adapter.written[0] ?? '')).toEqual([profile]);
    expect(store.get(profile.printerId)?.name).toBe('Kitchen');
  });

  it('round-trips a saved file', async () => {
    const first = await createStore(memoryAdapter(null));
    const saved = await first.add(makeDraft());
    const raw = JSON.stringify([saved]);
    const second = await createStore(memoryAdapter(raw));
    expect(second.get(saved.printerId)?.printableDots).toBe(576);
  });

  it('starts empty on a corrupt file and reports it', async () => {
    const reported: string[] = [];
    const store = await createStore(memoryAdapter('{not json'), (m) => reported.push(m));
    expect(store.list()).toEqual([]);
    expect(reported).toHaveLength(1);
  });

  it('starts empty when the file has unknown fields (strict)', async () => {
    const store = await createStore(
      memoryAdapter(JSON.stringify([{ ...makeDraft(), printerId: 'x', admin: true }])),
    );
    expect(store.list()).toEqual([]);
  });

  it('rejects invalid drafts and persists nothing', async () => {
    const adapter = memoryAdapter(null);
    const store = await createStore(adapter);
    await expect(store.add(makeDraft({ name: '' }))).rejects.toThrow();
    await expect(
      store.add(makeDraft({ transport: { kind: 'tcp_raw', host: '127.0.0.1', port: 9100 } })),
    ).rejects.toThrow();
    expect(store.list()).toHaveLength(0);
    expect(adapter.written).toHaveLength(0);
  });

  it('updates a printer and persists', async () => {
    const adapter = memoryAdapter(null);
    const store = await createStore(adapter);
    const saved = await store.add(makeDraft());
    const updated = await store.update(saved.printerId, { name: 'Bar', role: 'bar' });
    expect(updated.name).toBe('Bar');
    expect(updated.role).toBe('bar');
    expect(JSON.parse(adapter.written.at(-1) ?? '')).toEqual([updated]);
  });

  it('rejects an invalid update without persisting', async () => {
    const store = await createStore(memoryAdapter(null));
    const saved = await store.add(makeDraft());
    await expect(store.update(saved.printerId, { printableDots: 9999 })).rejects.toThrow();
    expect(store.get(saved.printerId)?.printableDots).toBe(576);
  });

  it('throws when updating an unknown id', async () => {
    const store = await createStore(memoryAdapter(null));
    await expect(store.update('missing', { name: 'X' })).rejects.toThrow('printer not found');
  });

  it('removes a printer and persists; returns false for unknown ids', async () => {
    const adapter = memoryAdapter(null);
    const store = await createStore(adapter);
    const saved = await store.add(makeDraft());
    expect(await store.remove('missing')).toBe(false);
    expect(await store.remove(saved.printerId)).toBe(true);
    expect(adapter.written.at(-1)).toBe('[]');
    expect(store.get(saved.printerId)).toBeNull();
  });

  it('rejects attempts to re-key a printer via update', async () => {
    const store = await createStore(memoryAdapter(null));
    const saved = await store.add(makeDraft());
    await expect(
      store.update(saved.printerId, {
        printerId: '00000000-0000-4000-8000-000000000099',
      } as never),
    ).rejects.toThrow('printerId is immutable');
    expect(store.get(saved.printerId)?.printerId).toBe(saved.printerId);
  });

  it('rolls back in-memory state when persistence fails', async () => {
    const adapter = memoryAdapter(null);
    const failing: SettingsFileAdapter = {
      read: (path) => adapter.read(path),
      writeAtomic: () => Promise.reject(new Error('disk full')),
    };
    const store = await createStore(failing);
    await expect(store.add(makeDraft())).rejects.toThrow('disk full');
    expect(store.list()).toEqual([]);
  });

  it('clear removes all printers and persists the empty list', async () => {
    const adapter = memoryAdapter(null);
    const store = await createStore(adapter);
    await store.add(makeDraft());
    await store.clear();
    expect(store.list()).toEqual([]);
    expect(adapter.written.at(-1)).toBe('[]');
    // A fresh store over the same file sees the wipe.
    const reopened = await createStore(adapter);
    expect(reopened.list()).toEqual([]);
  });

  it('rejects a colliding generated id instead of shadowing', async () => {
    const store = await createStore(memoryAdapter(null));
    const saved = await store.add(makeDraft());
    const colliding = await createPrinterStore({
      filePath: 'printers.json',
      adapter: memoryAdapter(JSON.stringify([saved])),
      newId: () => saved.printerId,
    });
    await expect(colliding.add(makeDraft({ name: 'Bar' }))).rejects.toThrow('duplicate printerId');
    expect(colliding.list()).toHaveLength(1);
  });
});

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
    // Seed the local through a working adapter; the store under test reads the
    // same file but its writeAtomic always fails (as in the add() rollback test).
    const adapter = memoryAdapter(null);
    const local = await (await createStore(adapter)).add(makeDraft());
    const failing: SettingsFileAdapter = {
      read: (path) => adapter.read(path),
      writeAtomic: () => Promise.reject(new Error('disk full')),
    };
    const store = await createStore(failing);
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

  it('update() rejects a patch that tries to flip source (runtime guard)', async () => {
    const store = await createStore(memoryAdapter(null));
    const saved = await store.add(makeDraft());
    await expect(
      store.update(saved.printerId, { source: 'cloud' } as never),
    ).rejects.toThrow('source is managed by the store');
    expect(store.get(saved.printerId)?.source).toBe('local');
  });
});
