import type { SettingsFileAdapter } from './services/settings';
import type { SecretKv } from './cloud-client/secret-store';

/**
 * `SecretKv` over a `{ [key: string]: string }` JSON file. The injected
 * `SettingsFileAdapter` writes atomically (tmp file + rename), so one key =
 * one whole-file rewrite — the all-or-nothing single-record requirement of
 * the identity store (secret-store.ts) holds even across a crash mid-write.
 *
 * Reads are served from an in-memory cache loaded once at creation; writes
 * update the cache synchronously and persist through a serialized write
 * chain. If the file is corrupt or missing, the kv starts empty: an unreadable
 * identity presents as "unpaired" (fail-safe — no plaintext ever leaks and
 * re-pairing is always possible).
 */
export interface JsonFileKv extends SecretKv {
  /** Resolves when every queued persist has settled (durability seam for tests and shutdown). */
  flush(): Promise<void>;
}

export async function createJsonFileKv(
  filePath: string,
  adapter: SettingsFileAdapter,
  onError?: (err: unknown) => void,
): Promise<JsonFileKv> {
  let cache: Record<string, string> = {};
  const raw = await adapter.read(filePath);
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        cache = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        );
      }
    } catch {
      // Corrupt file → start empty (see module note); never throw past this boundary.
    }
  }

  // Serialize persists: concurrent set/delete must never interleave the
  // tmp+rename sequences of two writes. The chain itself never rejects.
  let writeTail: Promise<void> = Promise.resolve();
  const persist = (): void => {
    writeTail = writeTail
      .then(() => adapter.writeAtomic(filePath, JSON.stringify(cache)))
      .catch((err: unknown) => {
        onError?.(err); // cache keeps the value; disk may be stale (fail-safe on restart)
      });
  };

  return {
    get: (key) => cache[key] ?? null,
    set(key, value) {
      cache = { ...cache, [key]: value };
      persist();
    },
    delete(key) {
      if (!(key in cache)) return;
      // Rest-destructure instead of `delete` (no dynamic delete, still one rewrite).
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- _removed is the omitted entry
      const { [key]: _removed, ...rest } = cache;
      cache = rest;
      persist();
    },
    flush() {
      return writeTail.then(() => undefined);
    },
  };
}
