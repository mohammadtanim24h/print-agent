import { useState } from 'react';
import { useAsync, useService } from '../../services/service-context';
import type {
  CheckStatus,
  ConnectivityCheck,
  DiagnosticsReport,
  LogLine,
} from '../../services/types';
import { Card, DemoBadge, EmptyState, ErrorBanner, KeyVal, LoadingBlock } from '../primitives';
import { StatusPill } from '../status';
import type { StatusMeta } from '../status';
import {
  CheckCircleIcon,
  CrossCircleIcon,
  DownloadIcon,
  InfoIcon,
  WarnTriangleIcon,
  PulseIcon,
} from '../icons';

const CHECK_META: Readonly<Record<CheckStatus, StatusMeta>> = {
  pass: { label: 'Pass', tone: 'success', Icon: CheckCircleIcon, title: 'Check passed.' },
  warn: {
    label: 'Warning',
    tone: 'warn',
    Icon: WarnTriangleIcon,
    title: 'Check passed with warnings.',
  },
  fail: { label: 'Fail', tone: 'danger', Icon: CrossCircleIcon, title: 'Check failed.' },
};

const LOG_LEVEL_TAG: Readonly<Record<LogLine['level'], string>> = {
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
};

function humanUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${String(h)} h ${String(m)} min` : `${String(m)} min`;
}

function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`;
}

interface DiagnosticsBundle {
  report: DiagnosticsReport;
  logs: LogLine[];
}

export function DiagnosticsScreen(): React.JSX.Element {
  const service = useService();
  const dataState = useAsync<DiagnosticsBundle>(
    () =>
      Promise.all([service.getDiagnostics(), service.getRecentLogs()]).then(([report, logs]) => ({
        report,
        logs: [...logs],
      })),
    [service],
  );

  const [checks, setChecks] = useState<readonly ConnectivityCheck[] | null>(null);
  const [checksBusy, setChecksBusy] = useState(false);
  const [checksError, setChecksError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'error'>('idle');

  if (dataState.loading) {
    return <LoadingBlock />;
  }
  if (dataState.error !== null || dataState.data === null) {
    return (
      <ErrorBanner
        message={`Could not load diagnostics. ${dataState.error ?? ''}`.trim()}
        onRetry={dataState.reload}
      />
    );
  }
  const { report, logs } = dataState.data;

  const runChecks = (): void => {
    setChecksBusy(true);
    setChecksError(null);
    void service
      .runConnectivityChecks()
      .then((results) => {
        setChecks(results);
        setChecksBusy(false);
      })
      .catch((e: unknown) => {
        setChecksError(e instanceof Error ? e.message : String(e));
        setChecksBusy(false);
      });
  };

  const copyDiagnostics = (): void => {
    const lines = [
      `Print Agent ${report.version} — diagnostics`,
      `Platform: ${report.platform} (Electron ${report.electronVersion})`,
      `Uptime: ${humanUptime(report.uptimeS)}`,
      `Database: ${report.db.ok ? 'ok' : 'degraded'}, ${humanSize(report.db.sizeBytes)}, mode ${report.db.journalMode}, queue depth ${String(report.db.queueDepth)}`,
      '',
      'Connectivity:',
      ...(checks ?? [{ id: '-', label: '(not run)', status: 'pass', detail: '' }]).map(
        (c) => `  [${c.status.toUpperCase()}] ${c.label} — ${c.detail}`,
      ),
      '',
      'Recent sanitized logs:',
      ...logs.map((l) => `  ${l.ts} ${LOG_LEVEL_TAG[l.level]} ${l.module}: ${l.message}`),
    ];
    const text = lines.join('\n');
    const clipboard: Clipboard | undefined =
      'clipboard' in navigator ? navigator.clipboard : undefined;
    if (clipboard === undefined) {
      setCopyState('error');
      return;
    }
    clipboard
      .writeText(text)
      .then(() => {
        setCopyState('ok');
      })
      .catch(() => {
        setCopyState('error');
      });
  };

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Diagnostics</h1>
        {service.demo && <DemoBadge />}
      </header>

      <Card title="Application">
        <dl className="keyvals">
          <KeyVal term="Agent version" mono>
            {report.version}
          </KeyVal>
          <KeyVal term="Electron" mono>
            {report.electronVersion}
          </KeyVal>
          <KeyVal term="Platform">{report.platform}</KeyVal>
          <KeyVal term="Uptime">{humanUptime(report.uptimeS)}</KeyVal>
        </dl>
      </Card>

      <Card
        title="Connectivity checks"
        actions={
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={checksBusy}
            onClick={runChecks}
          >
            {checksBusy ? 'Running…' : 'Run checks'}
          </button>
        }
      >
        {checksError !== null && <ErrorBanner message={checksError} onRetry={runChecks} />}
        {checks === null && checksError === null ? (
          <EmptyState
            icon={<PulseIcon size={24} />}
            title="Checks have not been run"
            hint="Run checks to verify cloud reachability, device credentials, printer network and the local database."
          />
        ) : (
          checks !== null && (
            <ul className="rows">
              {checks.map((check) => (
                <li key={check.id} className="row">
                  <StatusPill meta={CHECK_META[check.status]} />
                  <span className="row-title">{check.label}</span>
                  <span className="row-sub">{check.detail}</span>
                </li>
              ))}
            </ul>
          )
        )}
      </Card>

      <Card title="Local database">
        <dl className="keyvals">
          <KeyVal term="Health">
            <StatusPill
              meta={
                report.db.ok
                  ? {
                      label: 'Healthy',
                      tone: 'success',
                      Icon: CheckCircleIcon,
                      title: 'Database opened and integrity checks pass.',
                    }
                  : {
                      label: 'Degraded',
                      tone: 'danger',
                      Icon: CrossCircleIcon,
                      title: 'The database reported problems.',
                    }
              }
            />
          </KeyVal>
          <KeyVal term="Size">{humanSize(report.db.sizeBytes)}</KeyVal>
          <KeyVal term="Queue depth" mono>
            {report.db.queueDepth}
          </KeyVal>
          <KeyVal term="Journal mode" mono>
            {report.db.journalMode}
          </KeyVal>
        </dl>
      </Card>

      <Card
        title="Recent logs (sanitized)"
        actions={
          <button type="button" className="btn btn-ghost btn-sm" onClick={copyDiagnostics}>
            <DownloadIcon size={13} /> Copy diagnostics
          </button>
        }
      >
        {copyState === 'ok' && (
          <div className="banner banner-success" role="status">
            <span className="banner-text">Diagnostics copied to the clipboard as text.</span>
          </div>
        )}
        {copyState === 'error' && (
          <ErrorBanner message="Could not access the clipboard. Try again or take a screenshot." />
        )}
        {logs.length === 0 ? (
          <EmptyState icon={<InfoIcon size={24} />} title="No recent log lines" />
        ) : (
          <>
            <p className="footnote">
              Credentials and personal data are removed before logs are shown or exported. Exporting
              sends nothing anywhere — the text is placed on your clipboard for you to share.
            </p>
            <ul className="logs">
              {logs.map((line) => (
                <li key={`${line.ts}-${line.module}`} className="log-line">
                  <span className="log-ts mono">{line.ts.slice(11, 19)}</span>
                  <span className={`log-level log-level-${line.level}`}>
                    {LOG_LEVEL_TAG[line.level]}
                  </span>
                  <span className="log-module mono">{line.module}</span>
                  <span className="log-msg mono">{line.message}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </div>
  );
}
