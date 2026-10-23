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

  return {
    list: () => [...cached],
    get: (printerId) => cached.find((p) => p.printerId === printerId) ?? null,
    async add(draft) {
      const validated = PrinterDraftSchema.parse(draft);
      const printerId = newId();
      // Spec §4: the store enforces printerId uniqueness. crypto.randomUUID
      // collisions are astronomically unlikely — fail loudly rather than
      // silently shadowing an existing profile.
      if (cached.some((p) => p.printerId === printerId)) {
        throw new Error(`duplicate printerId: ${printerId}`);
      }
      const profile: PrinterProfile = { ...validated, printerId };
      const next = [...cached, profile];
      await adapter.writeAtomic(filePath, JSON.stringify(next));
      cached = next;
      return profile;
    },
    async update(printerId, patch) {
      const current = cached.find((p) => p.printerId === printerId);
      if (current === undefined) throw new Error(`printer not found: ${printerId}`);
      if ('printerId' in patch) {
        throw new Error('printerId is immutable'); // strict re-parse alone would accept a valid UUID
      }
      const next = PrinterProfileSchema.parse({ ...current, ...patch });
      const nextList = cached.map((p) => (p.printerId === printerId ? next : p));
      await adapter.writeAtomic(filePath, JSON.stringify(nextList));
      cached = nextList;
      return next;
    },
    async remove(printerId) {
      const nextList = cached.filter((p) => p.printerId !== printerId);
      if (nextList.length === cached.length) return false;
      await adapter.writeAtomic(filePath, JSON.stringify(nextList));
      cached = nextList;
      return true;
    },
  };
}
