import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, closeDatabase } from '../src/main/local-store/db';

describe('openDatabase', () => {
  it('opens an in-memory database when file is null', () => {
    const db = openDatabase({ file: null });
    expect(db.prepare('select 1 as v').get()).toEqual({ v: 1 });
    closeDatabase(db);
  });

  it('enables WAL and full fsync on a file database (ADR-9 durability)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'print-agent-db-'));
    try {
      const db = openDatabase({ file: join(dir, 'jobs.db') });
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.pragma('synchronous', { simple: true })).toBe(2); // FULL
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      closeDatabase(db);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('survives reopen — data persists across restarts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'print-agent-db-'));
    try {
      const file = join(dir, 'jobs.db');
      const db1 = openDatabase({ file });
      db1.exec('create table t (v text)');
      db1.prepare('insert into t values (?)').run('kept');
      closeDatabase(db1);
      const db2 = openDatabase({ file });
      expect(db2.prepare('select v from t').get()).toEqual({ v: 'kept' });
      closeDatabase(db2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
