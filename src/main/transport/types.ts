/**
 * Transport contract (architecture.md §3.4). `write()` resolving means the
 * OS/driver accepted the bytes — "sent to printer", never "physically
 * printed" (api-contract.md §3.1 wording is normative).
 */

/** Mirrors the UI `PrinterHealth` union (renderer types.ts); unified when the
 *  IPC contract grows printer channels. */
export type PrinterStatus = 'ok' | 'unknown' | 'offline' | 'paper_out' | 'paper_low' | 'cover_open';

export interface PrinterTransport {
  /** Resolves when the connection is established; rejects with TransportError. */
  open(): Promise<void>;
  /** Resolves on kernel/driver acceptance — "sent to printer", NOT "printed". */
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  /** Cheap connect(+close) probe; rejects with TransportError on failure. */
  healthCheck(): Promise<void>;
  /** Reserved for best-effort DLE EOT status (R-VAL-3). Not implemented by
   *  tcp-raw in v1 — leave undefined. */
  status?(): Promise<PrinterStatus>;
}
