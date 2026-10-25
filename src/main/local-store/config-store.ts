import { z } from 'zod';
import type { SqliteDatabase } from './db';

/** Schema mirrors the cloud-client's ConfigUpdate loosely (looseObject upstream);
 *  we persist what arrived so FR-16 application can be built against real data. */
const StoredConfigSchema = z.looseObject({
  config_version: z.number().int().min(0),
});
export type StoredCloudConfig = z.output<typeof StoredConfigSchema>;

export interface ConfigStore {
  get(): StoredCloudConfig | null;
  save(config: StoredCloudConfig): void;
  clear(): void;
}

export function createConfigStore(db: SqliteDatabase): ConfigStore {
  const select = db.prepare('SELECT config_version, payload_json FROM cloud_config WHERE id = 1');
  const upsert = db.prepare(
    `INSERT INTO cloud_config (id, config_version, payload_json, updated_at) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET config_version = excluded.config_version,
       payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
  );
  const del = db.prepare('DELETE FROM cloud_config WHERE id = 1');
  return {
    get() {
      const row = select.get() as { config_version: number; payload_json: string } | undefined;
      if (row === undefined) return null;
      try {
        const parsed = StoredConfigSchema.parse(JSON.parse(row.payload_json) as unknown);
        return parsed;
      } catch {
        return null; // unreadable config is treated as no config
      }
    },
    save(config) {
      const validated = StoredConfigSchema.parse(config);
      upsert.run(validated.config_version, JSON.stringify(config), Date.now());
    },
    clear() {
      del.run();
    },
  };
}
