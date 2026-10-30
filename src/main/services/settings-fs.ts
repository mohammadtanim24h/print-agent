import { randomUUID } from 'node:crypto';
import { readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
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
