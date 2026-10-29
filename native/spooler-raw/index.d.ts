/** Native addon surface (spooler_raw.cc). writeRaw rejects with a plain Error
 *  carrying the Windows failure text; classification happens in the TS adapter.
 *  printerExists returns false only when the printer genuinely does not exist
 *  (ERROR_FILE_NOT_FOUND / ERROR_INVALID_PRINTER_NAME); any other OpenPrinterW
 *  failure throws. */
interface NativeSpooler {
  printerExists(name: string): boolean;
  writeRaw(name: string, buffer: Uint8Array): Promise<void>;
  enumeratePrinters(): string[];
}

export default NativeSpooler;
export type { NativeSpooler };
