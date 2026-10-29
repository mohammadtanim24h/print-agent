/** Native addon surface (spooler_raw.cc). writeRaw rejects with a plain Error
 *  carrying the Windows failure text; classification happens in the TS adapter. */
interface NativeSpooler {
  printerExists(name: string): boolean;
  writeRaw(name: string, buffer: Uint8Array): Promise<void>;
  enumeratePrinters(): string[];
}

export default NativeSpooler;
export type { NativeSpooler };
