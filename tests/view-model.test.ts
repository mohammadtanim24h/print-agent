import { describe, expect, it } from 'vitest';
import { toJobRecord, toPrinterInfo, mapPairFailure } from '../src/main/view-model';
import type { JobRow } from '../src/main/local-store/job-store';
import type { PrinterProfile } from '../src/main/printers/profile';
import { CloudError } from '../src/main/cloud-client/errors';

const row: JobRow = {
  id: '018f0000-0000-7000-8000-000000000001',
  idempotencyKey: 'idem',
  tenantId: '11111111-1111-4111-8111-111111111111',
  restaurantId: '22222222-2222-4222-8222-222222222222',
  printerId: '33333333-3333-4333-8333-333333333333',
  docType: 'kitchen_ticket',
  docVersion: 1,
  payloadJson: '{}',
  priority: 5,
  copies: 1,
  status: 'completed',
  attempts: 1,
  reprintOf: null,
  createdAt: 0,
  expiresAt: null,
  sentAt: 1,
  completedAt: 2,
  updatedAt: 2,
  lastError: null,
};

const profile: PrinterProfile = {
  printerId: '33333333-3333-4333-8333-333333333333',
  name: 'Kitchen-1',
  role: 'kitchen',
  paperWidthMm: 80,
  printableDots: 576,
  charsPerLine: 48,
  capabilities: { cut: true, qrCode: true, barcode128: false, statusPolling: false, cashDrawer: false },
  transport: { kind: 'tcp_raw', host: '192.168.1.87', port: 9100 },
  source: 'local',
};

describe('view-model mappers', () => {
  it('maps a job row, resolving the printer name', () => {
    const record = toJobRecord(row, (id) => (id === profile.printerId ? profile.name : null));
    expect(record).toMatchObject({
      jobId: row.id, docType: 'kitchen_ticket', status: 'completed',
      destinationPrinterName: 'Kitchen-1', attempts: 1, lastError: null,
    });
    expect(record.createdAt).toBe(new Date(0).toISOString());
    expect(record.updatedAt).toBe(new Date(2).toISOString());
  });

  it('falls back to the printer id when the printer is gone', () => {
    expect(toJobRecord(row, () => null).destinationPrinterName).toBe(row.printerId);
  });

  it('passes stored lastError through', () => {
    const failed = { ...row, status: 'failed' as const, lastError: 'connect_timeout: no route' };
    expect(toJobRecord(failed, () => null).lastError).toBe('connect_timeout: no route');
  });

  it('maps a profile to PrinterInfo with honest unknown health', () => {
    const info = toPrinterInfo(profile);
    expect(info.config).toEqual(profile);
    expect(info.health).toBe('unknown');
    expect(info.lastPrintAt).toBeNull(); // no status polling this phase (R-VAL-3)
  });

  it('maps cloud errors to PairFailureReason', () => {
    expect(mapPairFailure(new CloudError('network'))).toMatchObject({ ok: false, reason: 'network' });
    expect(mapPairFailure(new CloudError('timeout'))).toMatchObject({ ok: false, reason: 'network' });
    expect(mapPairFailure(new CloudError('request_rejected', 'status 422: code_expired', undefined, 'code_expired')))
      .toMatchObject({ ok: false, reason: 'expired' });
    expect(mapPairFailure(new CloudError('request_rejected', 'status 422: bad_code')))
      .toMatchObject({ ok: false, reason: 'invalid_code' });
    // Rejection with no machine-readable serverCode at all → generic invalid_code.
    expect(mapPairFailure(new CloudError('request_rejected', 'status 422')))
      .toMatchObject({ ok: false, reason: 'invalid_code' });
  });

  it('keeps secure_storage_unavailable in the network reason but tells the truth about the cause', () => {
    // No new wire reason this phase — 'network' is the least-wrong bucket —
    // but "check the connection" would send the operator debugging the wrong
    // machine component.
    const result = mapPairFailure(new CloudError('secure_storage_unavailable'));
    expect(result).toEqual({
      ok: false,
      reason: 'network',
      message:
        'This PC cannot securely store credentials (OS key storage unavailable). Pairing was cancelled — nothing was saved.',
    });
  });
});
