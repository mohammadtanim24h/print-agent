import { AppSettingsSchema, type AppSettings } from '../../shared/ipc-contract';

/**
 * Durable app settings (the `settings` table of architecture.md §3.5 in
 * file form for now; same schema when SQLite lands in P1). Persistence is
 * injected so the store is pure and unit-testable.
 */
export interface SettingsFileAdapter {
  read(path: string): Promise<string | null>;
  /** tmp-file + rename under the hood; either old or new content survives crashes. */
  writeAtomic(path: string, contents: string): Promise<void>;
}

/** Derived from the schema so defaults stay in sync with the contract. */
export const DEFAULT_SETTINGS: AppSettings = AppSettingsSchema.parse({ launchAtLogin: false });

export interface SettingsStore {
  get(): AppSettings;
  set(patch: Partial<AppSettings>): Promise<AppSettings>;
}

export async function createSettingsStore(options: {
  filePath: string;
  adapter: SettingsFileAdapter;
  /** Sink for recoverable problems (corrupt/invalid file). */
  report?: (message: string) => void;
}): Promise<SettingsStore> {
  const { filePath, adapter, report } = options;
  let cached: AppSettings = DEFAULT_SETTINGS;

  const raw = await adapter.read(filePath);
  if (raw !== null) {
    try {
      const parsed = AppSettingsSchema.safeParse(JSON.parse(raw) as unknown);
      if (parsed.success) {
        cached = parsed.data;
      } else {
        report?.(`settings file invalid, using defaults (${filePath})`);
      }
    } catch {
      report?.(`settings file unreadable, using defaults (${filePath})`);
    }
  }

  return {
    get() {
      return cached;
    },
    async set(patch) {
      const next = AppSettingsSchema.parse({ ...cached, ...patch });
      await adapter.writeAtomic(filePath, JSON.stringify(next));
      cached = next;
      return next;
    },
  };
}
