import { z } from 'zod';
import type { SettingsFileAdapter } from '../services/settings';
import {
  PrinterDraftSchema,
  PrinterProfileSchema,
  type PrinterDraft,
  type PrinterProfile,
} from './profile';

/**
 * Durable printer profiles — the `printers` table of architecture.md §3.5 in
 * file form until SQLite lands (same injected-adapter pattern as settings.ts;
 * migrates to SQLite with local-store). Profiles contain no secrets → plain
 * atomic JSON is sufficient (spec §3); the DPAPI identity store is untouched.
 */
export interface PrinterStore {
  list(): PrinterProfile[];
  get(printerId: string): PrinterProfile | null;
  add(draft: PrinterDraft): Promise<PrinterProfile>;
  update(printerId: string, patch: Partial<PrinterDraft>): Promise<PrinterProfile>;
  remove(printerId: string): Promise<boolean>;
}

export async function createPrinterStore(options: {
  filePath: string;
  adapter: SettingsFileAdapter;
  /** Injected UUID source (crypto.randomUUID in production). */
  newId: () => string;
  /** Sink for recoverable problems (corrupt/invalid file). */
  report?: (message: string) => void;
}): Promise<PrinterStore> {
  const { filePath, adapter, newId, report } = options;
  let cached: PrinterProfile[] = [];

  const raw = await adapter.read(filePath);
  if (raw !== null) {
    try {
      const parsed = z.array(PrinterProfileSchema).safeParse(JSON.parse(raw) as unknown);
      if (parsed.success) {
        cached = parsed.data;
      } else {
        report?.(`printers file invalid, starting empty (${filePath})`);
      }
    } catch {
      report?.(`printers file unreadable, starting empty (${filePath})`);
    }
  }

  const persist = async (): Promise<void> => {
    await adapter.writeAtomic(filePath, JSON.stringify(cached));
  };

  return {
    list: () => [...cached],
    get: (printerId) => cached.find((p) => p.printerId === printerId) ?? null,
    async add(draft) {
      const validated = PrinterDraftSchema.parse(draft);
      const profile: PrinterProfile = { ...validated, printerId: newId() };
      cached = [...cached, profile];
      await persist();
      return profile;
    },
    async update(printerId, patch) {
      const current = cached.find((p) => p.printerId === printerId);
      if (current === undefined) throw new Error(`printer not found: ${printerId}`);
      const next = PrinterProfileSchema.parse({ ...current, ...patch });
      cached = cached.map((p) => (p.printerId === printerId ? next : p));
      await persist();
      return next;
    },
    async remove(printerId) {
      const before = cached.length;
      cached = cached.filter((p) => p.printerId !== printerId);
      if (cached.length === before) return false;
      await persist();
      return true;
    },
  };
}
