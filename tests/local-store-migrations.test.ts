import { describe, expect, it } from 'vitest';
import { openDatabase, closeDatabase } from '../src/main/local-store/db';
import { migrate, MIGRATIONS } from '../src/main/local-store/migrations';
import { StoreError } from '../src/main/local-store/errors';

describe('migrate', () => {
  it('applies all pending migrations to a fresh database and records them', () => {
    const db = openDatabase({ file: null });
    const ran = migrate(db);
    expect(ran).toBe(MIGRATIONS.length);
    const tables = db
      .prepare("select name from sqlite_master where type='table' order by name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain('jobs');
    expect(tables).toContain('job_attempts');
    expect(tables).toContain('schema_migrations');
    closeDatabase(db);
  });

  it('is idempotent — second run applies nothing', () => {
    const db = openDatabase({ file: null });
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(migrate(db)).toBe(0);
    closeDatabase(db);
  });

  it('enforces the unique idempotency index across restarts', () => {
    const db = openDatabase({ file: null });
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
    closeDatabase(db);
  });

  it('refuses to open a database migrated by a newer build (no downgrade)', () => {
    const db = openDatabase({ file: null });
    db.exec('create table schema_migrations (version integer primary key, name text not null, applied_at integer not null)');
    db.prepare('insert into schema_migrations values (?, ?, ?)').run(9_999, 'from_the_future', 0);
    expect(() => migrate(db)).toThrow(StoreError);
    closeDatabase(db);
  });
});
