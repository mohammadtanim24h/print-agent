import { readFile, rename, writeFile } from 'node:fs/promises';
import type { SettingsFileAdapter } from './settings';

/** Node filesystem adapter for the settings store (node glue, untested). */
export function createNodeSettingsAdapter(): SettingsFileAdapter {
  return {
    async read(path) {
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async writeAtomic(path, contents) {
      const tmp = `${path}.tmp`;
      await writeFile(tmp, contents, 'utf8');
      await rename(tmp, path);
    },
  };
}
