import type { JobRow } from './local-store/job-store';
import type { CloudError } from './cloud-client/errors';
import type {
  DocType, JobRecord, PairFailureReason, PairResult, PrinterInfo,
} from '../renderer/src/services/types';

/** Rows only ever enter the store from contract-validated envelopes
 *  (doc_type is an enum at the boundary), so this cast is safe; a stray
 *  legacy value would only mislabel a list row. */
const toDocType = (value: string): DocType => value as DocType;

export function toJobRecord(
  row: JobRow,
  printerName: (printerId: string) => string | null,
): JobRecord {
  return {
    jobId: row.id,
    idempotencyKey: row.idempotencyKey,
    docType: toDocType(row.docType),
    destinationPrinterName: printerName(row.printerId) ?? row.printerId,
    status: row.status,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    attempts: row.attempts,
    lastError: row.lastError,
  };
}

/**
 * Wraps a store profile as the renderer's `PrinterInfo`. Health stays
 * 'unknown' until status polling lands (R-VAL-3); lastPrintAt is null — the
 * agent never claims a physical print (§3.1).
 */
export function toPrinterInfo(profile: PrinterInfo['config']): PrinterInfo {
  return { config: profile, health: 'unknown', lastPrintAt: null };
}

export function mapPairFailure(err: CloudError): PairResult {
  const reason: PairFailureReason =
    err.code === 'request_rejected'
      ? err.serverCode !== undefined && err.serverCode.includes('expired')
        ? 'expired'
        : 'invalid_code'
      : 'network';
  const message =
    reason === 'expired'
      ? 'That pairing code expired. Generate a new one in the dashboard.'
      : reason === 'invalid_code'
        ? 'The pairing code was rejected. Check it and try a fresh code.'
        : 'Could not reach the server. Check the connection and try again.';
  return { ok: false, reason, message };
}
