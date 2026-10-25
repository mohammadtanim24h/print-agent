import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { SecretKv } from './cloud-client/secret-store';

/**
 * `SecretKv` over a `{ [key: string]: string }` JSON file, persisted
 * SYNCHRONOUSLY (tmp file + rename on the same volume). Callers rely on
 * durability-before-return: `SecretStore.save` (secret-store.ts) is
 * sync-void, and the poller's token-rotation path (§7 note 8) treats a
 * thrown save as "on-disk token is superseded — poison refresh". An async
 * write chain would let save() return before the bytes hit disk, so a crash
 * in the persistence window would replay a rotated refresh token and get the
 * device revoked. One key = one whole-file rewrite: the all-or-nothing
 * single-record requirement holds across a crash mid-write (rename is
 * atomic on Windows and POSIX).
 *
 * Reads are served from an in-memory cache loaded once at creation; writes
 * hit disk FIRST and only then update the cache, so the cache never claims a
 * value that is not durable. If the file is corrupt or missing, the kv starts
 * empty: an unreadable identity presents as "unpaired" (fail-safe — no
 * plaintext ever leaks and re-pairing is always possible).
 */

/** Injectable sync seams over the filesystem (test double entry points).
 *  Defaults do direct `node:fs` I/O. */
export interface JsonFileKvSeams {
  readSync?: (filePath: string) => string | null;
  writeSync?: (filePath: string, contents: string) => void;
}

function defaultReadSync(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function defaultWriteSync(filePath: string, contents: string): void {
  // Temp file in the SAME directory: rename is atomic within one volume.
  const tmpPath = join(dirname(filePath), `.${basename(filePath)}.${String(process.pid)}.tmp`);
  try {
    writeFileSync(tmpPath, contents);
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true }); // best-effort cleanup of the orphaned tmp file
    } catch {
      // Nothing sensible left to do — the original error is what matters.
    }
    throw err;
  }
}

export function createJsonFileKv(filePath: string, seams: JsonFileKvSeams = {}): SecretKv {
  const readSync = seams.readSync ?? defaultReadSync;
  const writeSync = seams.writeSync ?? defaultWriteSync;

  let cache: Record<string, string> = {};
  const raw = readSync(filePath);
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

  return {
    get: (key) => cache[key] ?? null,
    // Persist first, mutate the cache second: if the write throws, the cache
    // still reflects exactly what is on disk (a failed set/delete claims nothing).
    set(key, value) {
      const next = { ...cache, [key]: value };
      writeSync(filePath, JSON.stringify(next));
      cache = next;
    },
    delete(key) {
      if (!(key in cache)) return;
      // Rebuild without the key (no dynamic `delete`, still one whole-file rewrite).
      const rest = Object.fromEntries(
        Object.entries(cache).filter(([k]) => k !== key),
      );
      writeSync(filePath, JSON.stringify(rest));
      cache = rest;
    },
  };
}
