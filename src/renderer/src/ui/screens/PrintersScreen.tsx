import { useState } from 'react';
import { useAsync, useService } from '../../services/service-context';
import type { PrinterDraft, PrinterInfo, PrinterProfile, TestPrintResult } from '../../services/types';
import {
  Card,
  EmptyState,
  ErrorBanner,
  Field,
  LoadingBlock,
  Timestamp,
} from '../primitives';
import { PrinterHealthPill } from '../status';
import { ConfirmDialog } from '../ConfirmDialog';
import { PlusIcon, PrinterIcon } from '../icons';

type TestOutcome =
  | { readonly kind: 'ok' | 'fail'; readonly text: string }
  | { readonly kind: 'error'; readonly text: string };

type Capabilities = PrinterProfile['capabilities'];

// Mirrors PRINTER_ROLES in main/printers/profile (a value import would drag
// node:net/zod into the renderer bundle — hoist to shared/ if this grows).
const PRINTER_ROLES = ['kitchen', 'receipt', 'bar', 'custom'] as const;

const emptyDraft: PrinterDraft = {
  name: '',
  role: 'kitchen',
  paperWidthMm: 80,
  printableDots: 576,
  charsPerLine: 48,
  capabilities: {
    cut: true,
    qrCode: true,
    barcode128: false,
    statusPolling: false,
    cashDrawer: false,
  },
  transport: { kind: 'tcp_raw', host: '', port: 9100 },
};

/** Sensible starting points per paper width. They only prefill the form —
 *  the real per-printer values stay editable (profile.ts: never derived). */
const PAPER_DEFAULTS: Readonly<Record<PrinterProfile['paperWidthMm'], { readonly printableDots: number; readonly charsPerLine: number }>> = {
  80: { printableDots: 576, charsPerLine: 48 },
  58: { printableDots: 384, charsPerLine: 32 },
};

const CAPABILITIES: ReadonlyArray<{ readonly key: keyof Capabilities; readonly label: string }> = [
  { key: 'cut', label: 'Auto cut' },
  { key: 'qrCode', label: 'QR code' },
  { key: 'barcode128', label: 'Code128' },
  { key: 'statusPolling', label: 'Status polling' },
  { key: 'cashDrawer', label: 'Cash drawer' },
];

/** Keeps the previous value when a number input is momentarily empty/invalid. */
function parseIntOr(raw: string, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : fallback;
}

export function transportLabel(transport: PrinterProfile['transport']): string {
  return `TCP ${transport.host}:${String(transport.port)}`;
}

export function PrintersScreen(): React.JSX.Element {
  const service = useService();
  const printersState = useAsync(() => service.getPrinters(), [service]);

  const [form, setForm] = useState<{
    readonly mode: 'add' | 'edit';
    readonly printer: PrinterInfo | null;
  } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<PrinterInfo | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [testBusy, setTestBusy] = useState<string | null>(null);
  const [testOutcomes, setTestOutcomes] = useState<Readonly<Record<string, TestOutcome>>>({});

  if (printersState.loading) {
    return <LoadingBlock />;
  }
  if (printersState.error !== null || printersState.data === null) {
    return (
      <ErrorBanner
        message={`Could not load printers. ${printersState.error ?? ''}`.trim()}
        onRetry={printersState.reload}
      />
    );
  }
  const printers = printersState.data;

  const runTestPrint = (printer: PrinterInfo): void => {
    setTestBusy(printer.config.printerId);
    void service
      .testPrint(printer.config.printerId)
      .then((result: TestPrintResult) => {
        setTestBusy(null);
        setTestOutcomes((prev) => ({
          ...prev,
          [printer.config.printerId]: { kind: result.ok ? 'ok' : 'fail', text: result.detail },
        }));
      })
      .catch((e: unknown) => {
        setTestBusy(null);
        setTestOutcomes((prev) => ({
          ...prev,
          [printer.config.printerId]: {
            kind: 'error',
            text: e instanceof Error ? e.message : String(e),
          },
        }));
      });
  };

  const removePrinter = (): void => {
    if (confirmRemove === null) {
      return;
    }
    setRemoveBusy(true);
    setRemoveError(null);
    void service
      .removePrinter(confirmRemove.config.printerId)
      .then(() => {
        setRemoveBusy(false);
        setConfirmRemove(null);
        printersState.reload();
      })
      .catch((e: unknown) => {
        setRemoveBusy(false);
        setRemoveError(e instanceof Error ? e.message : String(e));
        setConfirmRemove(null);
      });
  };

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Printers</h1>
        <div className="screen-head-side">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setForm({ mode: 'add', printer: null });
            }}
          >
            <PlusIcon size={13} /> Add printer
          </button>
        </div>
      </header>

      {removeError !== null && <ErrorBanner message={removeError} />}

      {printers.length === 0 ? (
        <Card>
          <EmptyState
            icon={<PrinterIcon size={28} />}
            title="No printers configured"
            hint="Add a printer to test it, or let the SaaS dashboard sync your station configuration."
            action={
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setForm({ mode: 'add', printer: null });
                }}
              >
                <PlusIcon size={13} /> Add printer
              </button>
            }
          />
        </Card>
      ) : (
        <Card>
          <ul className="rows">
            {printers.map((printer) => {
              const outcome = testOutcomes[printer.config.printerId];
              return (
                <li key={printer.config.printerId} className="printer-row">
                  <div className="printer-row-main">
                    <div className="printer-row-head">
                      <span className="row-title">{printer.config.name}</span>
                      <span className="tag">{printer.config.role}</span>
                      <PrinterHealthPill health={printer.health} />
                    </div>
                    <p className="row-sub mono">{transportLabel(printer.config.transport)}</p>
                    <p className="row-sub">
                      {printer.config.paperWidthMm} mm paper · {printer.config.printableDots} dots ·{' '}
                      {printer.config.charsPerLine} chars/line
                    </p>
                    <p className="row-sub">
                      last print <Timestamp iso={printer.lastPrintAt} />
                    </p>
                    {outcome !== undefined && (
                      <div
                        className={`banner ${
                          outcome.kind === 'ok'
                            ? 'banner-success'
                            : outcome.kind === 'fail'
                              ? 'banner-warn'
                              : 'banner-error'
                        }`}
                        role="status"
                      >
                        <span className="banner-text">{outcome.text}</span>
                      </div>
                    )}
                  </div>
                  <div className="printer-row-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={testBusy !== null}
                      onClick={() => {
                        runTestPrint(printer);
                      }}
                    >
                      {testBusy === printer.config.printerId ? 'Testing…' : 'Test print'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        setForm({ mode: 'edit', printer });
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger-ghost btn-sm"
                      onClick={() => {
                        setConfirmRemove(printer);
                      }}
                    >
                      Remove…
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {form !== null && (
        <PrinterFormDialog
          mode={form.mode}
          printer={form.printer}
          onClose={() => {
            setForm(null);
          }}
          onSaved={() => {
            setForm(null);
            printersState.reload();
          }}
        />
      )}

      {confirmRemove !== null && (
        <ConfirmDialog
          title={`Remove ${confirmRemove.config.name}?`}
          tone="danger"
          confirmLabel="Remove printer"
          busy={removeBusy}
          body={
            <p>
              The agent will no longer send jobs to <strong>{confirmRemove.config.name}</strong>.
              Queued jobs for this printer will fail. You can add it back at any time.
            </p>
          }
          onConfirm={removePrinter}
          onCancel={() => {
            setConfirmRemove(null);
          }}
        />
      )}
    </div>
  );
}

function PrinterFormDialog(props: {
  readonly mode: 'add' | 'edit';
  readonly printer: PrinterInfo | null;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}): React.JSX.Element {
  const service = useService();
  const initial = props.printer?.config ?? null;
  const [name, setName] = useState(initial?.name ?? emptyDraft.name);
  const [role, setRole] = useState<PrinterProfile['role']>(initial?.role ?? emptyDraft.role);
  const [paperWidthMm, setPaperWidthMm] = useState<PrinterProfile['paperWidthMm']>(
    initial?.paperWidthMm ?? emptyDraft.paperWidthMm,
  );
  const [printableDots, setPrintableDots] = useState(
    initial?.printableDots ?? emptyDraft.printableDots,
  );
  const [charsPerLine, setCharsPerLine] = useState(
    initial?.charsPerLine ?? emptyDraft.charsPerLine,
  );
  const [capabilities, setCapabilities] = useState<Capabilities>(
    initial?.capabilities ?? emptyDraft.capabilities,
  );
  const [transport, setTransport] = useState<PrinterProfile['transport']>(
    initial?.transport ?? emptyDraft.transport,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changePaperWidth = (width: PrinterProfile['paperWidthMm']): void => {
    setPaperWidthMm(width);
    // Prefill the physical metrics with the width's defaults; both stay editable.
    setPrintableDots(PAPER_DEFAULTS[width].printableDots);
    setCharsPerLine(PAPER_DEFAULTS[width].charsPerLine);
  };

  const submit = (): void => {
    if (name.trim().length === 0) {
      setError('Give the printer a name.');
      return;
    }
    if (transport.host.trim().length === 0) {
      setError('Enter the printer IP address.');
      return;
    }
    const draft: PrinterDraft = {
      name: name.trim(),
      role,
      paperWidthMm,
      printableDots,
      charsPerLine,
      capabilities,
      transport,
    };
    setBusy(true);
    setError(null);
    const op =
      props.mode === 'add'
        ? service.addPrinter(draft)
        : props.printer === null
          ? Promise.reject(new Error('missing printer'))
          : service.updatePrinter(props.printer.config.printerId, draft);
    void op.then(props.onSaved).catch((e: unknown) => {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    });
  };

  return (
    <div className="dialog-overlay">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={props.mode === 'add' ? 'Add printer' : 'Edit printer'}
        className="dialog dialog-wide"
      >
        <h2 className="dialog-title">
          {props.mode === 'add' ? 'Add printer' : `Edit ${props.printer?.config.name ?? 'printer'}`}
        </h2>
        <div className="dialog-body form-grid">
          <Field label="Name">
            <input
              className="input"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              disabled={busy}
            />
          </Field>
          <div className="form-grid-2">
            <Field label="Role" hint="Which tickets this printer receives.">
              <select
                className="input"
                value={role}
                onChange={(e) => {
                  const match = PRINTER_ROLES.find((r) => r === e.target.value);
                  if (match !== undefined) {
                    setRole(match);
                  }
                }}
                disabled={busy}
              >
                {PRINTER_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Paper width">
              <select
                className="input"
                value={paperWidthMm}
                onChange={(e) => {
                  changePaperWidth(e.target.value === '58' ? 58 : 80);
                }}
                disabled={busy}
              >
                <option value={80}>80 mm</option>
                <option value={58}>58 mm</option>
              </select>
            </Field>
          </div>
          <div className="field">
            <span className="field-label">Capabilities</span>
            <div className="check-row">
              {CAPABILITIES.map((cap) => (
                <label key={cap.key} className="check-item">
                  <input
                    type="checkbox"
                    checked={capabilities[cap.key]}
                    disabled={busy}
                    onChange={(e) => {
                      setCapabilities({ ...capabilities, [cap.key]: e.target.checked });
                    }}
                  />
                  <span>{cap.label}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="form-grid-2">
            <Field label="Address">
              <input
                className="input mono"
                value={transport.host}
                onChange={(e) => {
                  setTransport({ kind: 'tcp_raw', host: e.target.value, port: transport.port });
                }}
                placeholder="192.168.1.87"
                disabled={busy}
              />
            </Field>
            <Field label="Port">
              <input
                className="input mono"
                type="number"
                min={1}
                max={65535}
                value={transport.port}
                onChange={(e) => {
                  const parsed = Number(e.target.value);
                  setTransport({
                    kind: 'tcp_raw',
                    host: transport.host,
                    port: Number.isInteger(parsed) ? parsed : transport.port,
                  });
                }}
                disabled={busy}
              />
            </Field>
          </div>
          <div className="form-grid-2">
            <Field label="Printable dots" hint="Advanced: printable width in dots (192–800).">
              <input
                className="input mono"
                type="number"
                min={192}
                max={800}
                value={printableDots}
                onChange={(e) => {
                  setPrintableDots(parseIntOr(e.target.value, printableDots));
                }}
                disabled={busy}
              />
            </Field>
            <Field label="Characters per line" hint="Advanced: 16–96.">
              <input
                className="input mono"
                type="number"
                min={16}
                max={96}
                value={charsPerLine}
                onChange={(e) => {
                  setCharsPerLine(parseIntOr(e.target.value, charsPerLine));
                }}
                disabled={busy}
              />
            </Field>
          </div>
          {error !== null && <ErrorBanner message={error} />}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={props.onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={submit}>
            {busy ? 'Saving…' : props.mode === 'add' ? 'Add printer' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
