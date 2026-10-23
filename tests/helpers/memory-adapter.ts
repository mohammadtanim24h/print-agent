import type { SettingsFileAdapter } from '../../src/main/services/settings';

/** In-memory SettingsFileAdapter recording every atomic write (test double). */
export function memoryAdapter(
  initial: string | null = null,
): SettingsFileAdapter & { written: string[] } {
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
