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
        await sweepOrphans(path);
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
