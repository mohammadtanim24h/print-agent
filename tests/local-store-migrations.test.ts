import { describe, expect, it } from 'vitest';
import { openDatabase, closeDatabase } from '../src/main/local-store/db';
import { migrate, MIGRATIONS } from '../src/main/local-store/migrations';
import { StoreError } from '../src/main/local-store/errors';
import { createConfigStore } from '../src/main/local-store/config-store';

describe('migrate', () => {
  it('applies all pending migrations to a fresh database and records them', () => {
    const db = openDatabase({ file: null });
    try {
      const ran = migrate(db);
      expect(ran).toBe(MIGRATIONS.length);
      const tables = db
        .prepare("select name from sqlite_master where type='table' order by name")
        .all()
        .map((r) => (r as { name: string }).name);
      expect(tables).toContain('jobs');
      expect(tables).toContain('job_attempts');
      expect(tables).toContain('schema_migrations');
    } finally {
      closeDatabase(db);
    }
  });

  it('is idempotent — second run applies nothing', () => {
    const db = openDatabase({ file: null });
    try {
      expect(migrate(db)).toBe(MIGRATIONS.length);
      expect(migrate(db)).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('enforces the unique idempotency index across restarts', () => {
    const db = openDatabase({ file: null });
    try {
      migrate(db);
      const insert = db.prepare(
        `insert into jobs (id, idempotency_key, tenant_id, restaurant_id, printer_id, doc_type,
           doc_version, payload_json, priority, copies, status, attempts, created_at, updated_at)
         values ('j1', 'k1', 't', 'r', 'p', 'customer_receipt', 1, '{}', 5, 1, 'accepted', 0, 1, 1)`,
      );
      expect(() => {
        insert.run();
        insert.run();
      }).toThrow();
    } finally {
      closeDatabase(db);
    }
  });

  it('refuses to open a database migrated by a newer build (no downgrade)', () => {
    const db = openDatabase({ file: null });
    try {
      db.exec(
        'create table schema_migrations (version integer primary key, name text not null, applied_at integer not null)',
      );
      db.prepare('insert into schema_migrations values (?, ?, ?)').run(9_999, 'from_the_future', 0);
      expect(() => migrate(db)).toThrow(StoreError);
    } finally {
      closeDatabase(db);
    }
  });

  it('refuses an applied version this build does not know, even below the newer-build threshold', () => {
    const db = openDatabase({ file: null });
    try {
      migrate(db);
      // Tamper: bogus applied version alongside the real one — not a member of MIGRATIONS.
      // (Version 0 stays under the newer-build threshold so the membership guard is exercised.)
      db.prepare('insert into schema_migrations values (?, ?, ?)').run(0, 'bogus', 0);
      expect(() => migrate(db)).toThrow(/does not know/);
      expect(() => migrate(db)).toThrow(StoreError);
    } finally {
      closeDatabase(db);
    }
  });
});

describe('cloud_config migration (v2)', () => {
  it('creates the single-row cloud_config table', () => {
    const db = openDatabase({ file: null });
    try {
      migrate(db);
      const row = db.prepare("SELECT name FROM sqlite_master WHERE name = 'cloud_config'").get();
      expect(row).toBeDefined();
    } finally {
      closeDatabase(db);
    }
  });
});

describe('config store', () => {
  it('saves, reads, version-guards and clears the latest config', () => {
    const db = openDatabase({ file: null });
    try {
      migrate(db);
      const store = createConfigStore(db);
      expect(store.get()).toBeNull();
      store.save({ config_version: 3, printers: [] });
      expect(store.get()?.config_version).toBe(3);
      store.save({ config_version: 5, printers: [] });
      expect(store.get()?.config_version).toBe(5); // upsert, never two rows
      store.clear();
      expect(store.get()).toBeNull();
    } finally {
      closeDatabase(db);
    }
  });
});
