import { describe, expect, it } from 'vitest';
import { openDatabase, closeDatabase } from '../src/main/local-store/db';
import { migrate } from '../src/main/local-store/migrations';
import { createSqliteJobStore } from '../src/main/local-store/job-store';
import type { NewJobRow } from '../src/main/local-store/job-store';

function makeStore() {
  const db = openDatabase({ file: null });
  migrate(db);
  return { db, store: createSqliteJobStore(db) };
}

function makeRow(overrides: Partial<NewJobRow> = {}): NewJobRow {
  return {
    id: 'job-1',
    idempotencyKey: 'key-1',
    tenantId: 'tenant-1',
    restaurantId: 'rest-1',
    printerId: 'printer-1',
    docType: 'customer_receipt',
    docVersion: 1,
    payloadJson: '{"kind":"customer_receipt_v1"}',
    priority: 5,
    copies: 1,
    status: 'accepted',
    attempts: 0,
    reprintOf: null,
    createdAt: 1_000,
    expiresAt: null,
    sentAt: null,
    completedAt: null,
    updatedAt: 1_000,
    lastError: null,
    ...overrides,
  };
}

describe('sqlite JobStore', () => {
  it('persists and reads back every field', () => {
    const { db, store } = makeStore();
    try {
      store.insert(makeRow());
      const row = store.get('job-1');
      expect(row).toEqual(makeRow());
    } finally {
      closeDatabase(db);
    }
  });

  it('returns null for unknown ids and finds rows by idempotency scope', () => {
    const { db, store } = makeStore();
    try {
      store.insert(makeRow());
      expect(store.get('nope')).toBeNull();
      expect(store.findByIdempotency('rest-1', 'key-1')?.id).toBe('job-1');
      expect(store.findByIdempotency('other-restaurant', 'key-1')).toBeNull();
    } finally {
      closeDatabase(db);
    }
  });

  it('rejects duplicate (restaurant_id, idempotency_key) with unique_violation', () => {
    const { db, store } = makeStore();
    try {
      store.insert(makeRow());
      expect(() => {
        store.insert(makeRow({ id: 'job-2' }));
      }).toThrow(/unique/i);
    } finally {
      closeDatabase(db);
    }
  });

  it('updateStatus stamps updated_at, sent_at on first send, completed_at on completion', () => {
    let t = 1_000;
    const { db } = makeStore();
    try {
      const timed = createSqliteJobStore(db, { now: () => t });
      timed.insert(makeRow());
      t = 2_000;
      timed.updateStatus('job-1', 'rendered');
      t = 3_000;
      timed.updateStatus('job-1', 'sending');
      t = 4_000;
      timed.updateStatus('job-1', 'sent_to_printer');
      expect(timed.get('job-1')?.sentAt).toBe(4_000);
      t = 5_000;
      timed.updateStatus('job-1', 'completed');
      const row = timed.get('job-1');
      expect(row?.sentAt).toBe(4_000); // first send time is preserved
      expect(row?.completedAt).toBe(5_000);
    } finally {
      closeDatabase(db);
    }
  });

  it('updateStatus records and can clear last_error', () => {
    const { db, store } = makeStore();
    try {
      store.insert(makeRow());
      store.updateStatus('job-1', 'failed', { lastError: 'connect_refused: printer down' });
      expect(store.get('job-1')?.lastError).toBe('connect_refused: printer down');
      store.updateStatus('job-1', 'accepted', { clearError: true });
      expect(store.get('job-1')?.lastError).toBeNull();
    } finally {
      closeDatabase(db);
    }
  });

  it('updateStatus on a missing row throws', () => {
    const { db, store } = makeStore();
    try {
      expect(() => {
        store.updateStatus('ghost', 'rendered');
      }).toThrow();
    } finally {
      closeDatabase(db);
    }
  });

  it('incrementAttempts and resetAttempts manage the counter', () => {
    const { db, store } = makeStore();
    try {
      store.insert(makeRow());
      expect(store.incrementAttempts('job-1')).toBe(1);
      expect(store.incrementAttempts('job-1')).toBe(2);
      store.resetAttempts('job-1');
      expect(store.get('job-1')?.attempts).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('recordAttempt appends to the durable attempt history', () => {
    const { db, store } = makeStore();
    try {
      store.insert(makeRow());
      store.recordAttempt('job-1', 1, { outcome: 'connect_error', errorCode: 'connect_refused', errorMessage: 'ECONNREFUSED' }, 5_000);
      store.recordAttempt('job-1', 2, { outcome: 'completed' }, 6_000);
      const attempts = store.listAttempts('job-1');
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toMatchObject({ attempt: 1, outcome: 'connect_error', errorCode: 'connect_refused' });
      expect(attempts[1]).toMatchObject({ attempt: 2, outcome: 'completed' });
    } finally {
      closeDatabase(db);
    }
  });

  it('listByStatus orders by priority then created_at, and counts non-terminal rows', () => {
    const { db, store } = makeStore();
    try {
      store.insert(makeRow({ id: 'b', idempotencyKey: 'k-b', priority: 3, createdAt: 1 }));
      store.insert(makeRow({ id: 'a', idempotencyKey: 'k-a', priority: 3, createdAt: 2 }));
      store.insert(makeRow({ id: 'c', idempotencyKey: 'k-c', priority: 9, createdAt: 0 }));
      store.insert(makeRow({ id: 'z', idempotencyKey: 'k-z', status: 'completed', updatedAt: 1 }));
      expect(store.listByStatus('accepted').map((r) => r.id)).toEqual(['b', 'a', 'c']);
      expect(store.countByStatus('accepted', 'rendered', 'sending')).toBe(3);
    } finally {
      closeDatabase(db);
    }
  });

  it('terminalIdsOlderThan returns oldest terminal ids under the limit, excluding non-terminal', () => {
    const { db, store } = makeStore();
    try {
      store.insert(makeRow({ id: 't1', idempotencyKey: 'k-t1', status: 'completed', updatedAt: 100 }));
      store.insert(makeRow({ id: 't2', idempotencyKey: 'k-t2', status: 'failed', updatedAt: 200 }));
      store.insert(makeRow({ id: 'keep', idempotencyKey: 'k-keep', status: 'completed', updatedAt: 900 }));
      store.insert(makeRow({ id: 'live', idempotencyKey: 'k-live', status: 'accepted', updatedAt: 50 }));
      expect(store.terminalIdsOlderThan(500, 10)).toEqual(['t1', 't2']);
      expect(store.terminalIdsOlderThan(500, 1)).toEqual(['t1']);
    } finally {
      closeDatabase(db);
    }
  });

  it('deleteWithAttempts removes the job and its history in one transaction', () => {
    const { db, store } = makeStore();
    try {
      store.insert(makeRow());
      store.recordAttempt('job-1', 1, { outcome: 'completed' }, 1);
      store.deleteWithAttempts(['job-1']);
      expect(store.get('job-1')).toBeNull();
      const left = db.prepare('select count(*) as n from job_attempts').get() as { n: number };
      expect(left.n).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });
});
