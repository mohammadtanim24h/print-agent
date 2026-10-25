import type { JobRow } from './local-store/job-store';
import type { PrinterProfile } from './printers/profile';
import type { CloudError } from './cloud-client/errors';
import type {
  DocType, JobRecord, PairFailureReason, PairResult, PrinterHealth,
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
 * Interim view of a printer for the renderer: mirrors the renderer's
 * `PrinterInfo` as it will be once its fictional `PrinterConfig` (station,
 * copiesDefault, codepage, cutDefault, duplicatePolicy — fields the real
 * store does not have) is replaced by a type-only re-export of the real
 * `PrinterProfile` (wiring-composition plan Task 9 + design amendment
 * "Printer view model alignment"). After that swap the two are structurally
 * identical, so nothing here is a shim that survives. Health stays 'unknown'
 * until status polling lands (R-VAL-3); lastPrintAt is null — the agent
 * never claims a physical print (§3.1).
 */
export interface PrinterView {
  readonly config: PrinterProfile;
  readonly health: PrinterHealth;
  readonly lastPrintAt: string | null;
}

export function toPrinterInfo(profile: PrinterProfile): PrinterView {
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
