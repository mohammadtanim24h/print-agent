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

const RENAME_ATTEMPTS = 3;
const RENAME_BACKOFF_MS = 25;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function createNodeSettingsAdapter(deps: Partial<SettingsFsDeps> = {}): SettingsFileAdapter {
  const io = { readFile, writeFile, rename, unlink, readdir, randomUUID, ...deps };
  // Per-path FIFO of in-flight writes: same-path writes serialize in call
  // order (last-issued write wins the rename); different paths run parallel.
  const queues = new Map<string, Promise<void>>();
  const swept = new Set<string>();

  // Crash mid-write can orphan `${path}.${uuid}.tmp` siblings. The queue above
  // makes this adapter instance the only writer to the path (each production
  // file is owned by exactly one adapter instance), so on the first write to a
  // path any pre-existing sibling tmp is an orphan.
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
