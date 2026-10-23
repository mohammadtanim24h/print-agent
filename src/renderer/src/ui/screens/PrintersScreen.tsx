import { useState } from 'react';
import { useAsync, useService } from '../../services/service-context';
import type {
  CutMode,
  DuplicatePolicy,
  PrinterDraft,
  PrinterInfo,
  TestPrintResult,
  TransportConfig,
} from '../../services/types';
import {
  Card,
  DemoBadge,
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

const emptyDraft: PrinterDraft = {
  name: '',
  station: 'kitchen',
  transport: { kind: 'tcp_raw', host: '', port: 9100 },
  copiesDefault: 1,
  codepage: 'cp437',
  cutDefault: 'partial',
  duplicatePolicy: 'ask_operator',
};

export function transportLabel(transport: TransportConfig): string {
  return transport.kind === 'tcp_raw'
    ? `TCP ${transport.host}:${String(transport.port)}`
    : `Spooler · ${transport.windowsPrinterName}`;
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
          {service.demo && <DemoBadge />}
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
                      <span className="tag">{printer.config.station}</span>
                      <PrinterHealthPill health={printer.health} />
                    </div>
                    <p className="row-sub mono">{transportLabel(printer.config.transport)}</p>
                    <p className="row-sub">
                      {printer.config.copiesDefault}× copies · cut: {printer.config.cutDefault} ·
                      duplicate policy: {policyLabel(printer.config.duplicatePolicy)}
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

export function policyLabel(policy: DuplicatePolicy): string {
  switch (policy) {
    case 'ask_operator':
      return 'ask operator';
    case 'auto_reprint':
      return 'auto reprint';
    case 'never':
      return 'never reprint';
  }
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
  const [station, setStation] = useState(initial?.station ?? emptyDraft.station);
  const [transport, setTransport] = useState<TransportConfig>(
    initial?.transport ?? emptyDraft.transport,
  );
  const [copies, setCopies] = useState(String(initial?.copiesDefault ?? emptyDraft.copiesDefault));
  const [codepage, setCodepage] = useState(initial?.codepage ?? emptyDraft.codepage);
  const [cut, setCut] = useState<CutMode>(initial?.cutDefault ?? emptyDraft.cutDefault);
  const [policy, setPolicy] = useState<DuplicatePolicy>(
    initial?.duplicatePolicy ?? emptyDraft.duplicatePolicy,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setTransportKind = (kind: TransportConfig['kind']): void => {
    setTransport(
      kind === 'tcp_raw'
        ? {
            kind,
            host: transport.kind === 'tcp_raw' ? transport.host : '',
            port: transport.kind === 'tcp_raw' ? transport.port : 9100,
          }
        : {
            kind,
            windowsPrinterName:
              transport.kind === 'spooler_raw' ? transport.windowsPrinterName : '',
          },
    );
  };

  const submit = (): void => {
    if (name.trim().length === 0) {
      setError('Give the printer a name.');
      return;
    }
    const nextTransport: TransportConfig =
      transport.kind === 'tcp_raw'
        ? transport.host.trim().length === 0
          ? { ...transport, host: '' }
          : transport
        : transport.windowsPrinterName.trim().length === 0
          ? { ...transport, windowsPrinterName: '' }
          : transport;
    if (nextTransport.kind === 'tcp_raw' && nextTransport.host.trim().length === 0) {
      setError('Enter the printer IP address or hostname.');
      return;
    }
    if (
      nextTransport.kind === 'spooler_raw' &&
      nextTransport.windowsPrinterName.trim().length === 0
    ) {
      setError('Enter the exact Windows printer name.');
      return;
    }
    const copiesNum = Number(copies);
    if (!Number.isInteger(copiesNum) || copiesNum < 1 || copiesNum > 4) {
      setError('Copies must be a whole number between 1 and 4.');
      return;
    }
    const draft: PrinterDraft = {
      name: name.trim(),
      station: station.trim().length > 0 ? station.trim() : 'cashier',
      transport: nextTransport,
      copiesDefault: copiesNum,
      codepage,
      cutDefault: cut,
      duplicatePolicy: policy,
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
          <Field label="Station" hint="Free-form label, e.g. kitchen, bar, cashier.">
            <input
              className="input"
              value={station}
              onChange={(e) => {
                setStation(e.target.value);
              }}
              disabled={busy}
            />
          </Field>
          <Field label="Transport">
            <select
              className="input"
              value={transport.kind}
              onChange={(e) => {
                setTransportKind(e.target.value as TransportConfig['kind']);
              }}
              disabled={busy}
            >
              <option value="tcp_raw">Network (TCP 9100)</option>
              <option value="spooler_raw">Windows spooler (RAW)</option>
            </select>
          </Field>
          {transport.kind === 'tcp_raw' ? (
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
          ) : (
            <Field
              label="Windows printer name"
              hint="Must match the name in Windows Settings → Printers."
            >
              <input
                className="input mono"
                value={transport.windowsPrinterName}
                onChange={(e) => {
                  setTransport({ kind: 'spooler_raw', windowsPrinterName: e.target.value });
                }}
                placeholder="EPSON TM-T88VI"
                disabled={busy}
              />
            </Field>
          )}
          <div className="form-grid-2">
            <Field label="Copies">
              <select
                className="input"
                value={copies}
                onChange={(e) => {
                  setCopies(e.target.value);
                }}
                disabled={busy}
              >
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={String(n)}>
                    {n}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Codepage">
              <select
                className="input"
                value={codepage}
                onChange={(e) => {
                  setCodepage(e.target.value);
                }}
                disabled={busy}
              >
                <option value="cp437">CP437 (US ASCII)</option>
                <option value="cp850">CP850 (Western European)</option>
                <option value="utf8_double_byte">UTF-8 double-byte</option>
              </select>
            </Field>
          </div>
          <div className="form-grid-2">
            <Field label="Cut">
              <select
                className="input"
                value={cut}
                onChange={(e) => {
                  setCut(e.target.value as CutMode);
                }}
                disabled={busy}
              >
                <option value="partial">Partial</option>
                <option value="full">Full</option>
                <option value="none">None</option>
              </select>
            </Field>
            <Field label="Duplicate policy" hint="What happens when a job's outcome is unknown.">
              <select
                className="input"
                value={policy}
                onChange={(e) => {
                  setPolicy(e.target.value as DuplicatePolicy);
                }}
                disabled={busy}
              >
                <option value="ask_operator">Ask operator</option>
                <option value="auto_reprint">Auto reprint (DUPLICATE banner)</option>
                <option value="never">Never reprint</option>
              </select>
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
