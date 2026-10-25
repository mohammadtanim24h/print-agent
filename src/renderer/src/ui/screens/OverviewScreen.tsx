import { useService, useAsync } from '../../services/service-context';
import type { AgentSnapshot, JobRecord, PrinterInfo } from '../../services/types';
import {
  Card,
  EmptyState,
  ErrorBanner,
  KeyVal,
  LoadingBlock,
  Timestamp,
} from '../primitives';
import { ConnectionPill, JobStatusPill, PrinterHealthPill } from '../status';
import { PlugIcon, ReceiptIcon, WarnTriangleIcon } from '../icons';

export type ScreenId = 'overview' | 'setup' | 'printers' | 'jobs' | 'settings' | 'diagnostics';

interface OverviewData {
  snapshot: AgentSnapshot;
  printers: PrinterInfo[];
  jobs: JobRecord[];
}

export function OverviewScreen(props: {
  readonly onNavigate: (screen: ScreenId) => void;
}): React.JSX.Element {
  const service = useService();
  const state = useAsync<OverviewData>(
    () =>
      Promise.all([service.getSnapshot(), service.getPrinters(), service.getJobs()]).then(
        ([snapshot, printers, jobs]) => ({ snapshot, printers: [...printers], jobs: [...jobs] }),
      ),
    [service],
  );

  if (state.loading) {
    return <LoadingBlock />;
  }
  if (state.error !== null || state.data === null) {
    return (
      <ErrorBanner
        message={`Could not load agent status. ${state.error ?? ''}`.trim()}
        onRetry={state.reload}
      />
    );
  }

  const { snapshot, printers, jobs } = state.data;
  const recent = [...jobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);
  const lastHandoff = [...jobs]
    .filter((j) => j.status === 'completed')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Overview</h1>
        <div className="screen-head-side">
          <ConnectionPill state={snapshot.connection} />
        </div>
      </header>

      {snapshot.connection === 'revoked' && (
        <div className="banner banner-error" role="alert">
          <span className="banner-text">
            This device was revoked by the restaurant. Cached credentials, jobs and printers were
            wiped from this PC. Pair again with a new code to resume.
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              props.onNavigate('setup');
            }}
          >
            Open setup
          </button>
        </div>
      )}

      {snapshot.identity === null ? (
        <Card>
          <EmptyState
            icon={<PlugIcon size={28} />}
            title="This agent is not paired yet"
            hint="Enter a pairing code from the SaaS dashboard (Settings → Printers → Add agent) to connect this PC to your restaurant."
            action={
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  props.onNavigate('setup');
                }}
              >
                Open setup
              </button>
            }
          />
        </Card>
      ) : (
        <>
          <Card title="Agent">
            <dl className="keyvals">
              <KeyVal term="Restaurant">{snapshot.identity.restaurantName}</KeyVal>
              <KeyVal term="Device" mono>
                {snapshot.identity.agentName} · {snapshot.identity.deviceId}
              </KeyVal>
              <KeyVal term="Agent version" mono>
                {snapshot.version}
              </KeyVal>
              <KeyVal term="Paired">
                <Timestamp iso={snapshot.identity.pairedAt} />
              </KeyVal>
            </dl>
          </Card>

          <div className="stat-row">
            <Card title="Pending jobs" className="stat">
              <p className="stat-value mono">{snapshot.pendingJobs}</p>
              <p className="stat-hint">stored, rendering or in flight</p>
            </Card>
            <Card title="Needs attention" className="stat">
              {snapshot.ambiguousJobs > 0 ? (
                <>
                  <p className="stat-value mono stat-warn">
                    {snapshot.ambiguousJobs}
                    <WarnTriangleIcon size={16} />
                  </p>
                  <button
                    type="button"
                    className="linklike"
                    onClick={() => {
                      props.onNavigate('jobs');
                    }}
                  >
                    Outcome unknown — review in job history
                  </button>
                </>
              ) : (
                <>
                  <p className="stat-value mono">0</p>
                  <p className="stat-hint">no ambiguous jobs</p>
                </>
              )}
            </Card>
            <Card title="Last activity" className="stat">
              <p className="stat-value">
                <Timestamp iso={snapshot.lastActivityAt} />
              </p>
              <p className="stat-hint">
                {lastHandoff === undefined
                  ? 'no successful hand-off yet'
                  : `last hand-off: ${lastHandoff.destinationPrinterName}`}
              </p>
            </Card>
          </div>

          <Card
            title="Printer health"
            actions={
              <button
                type="button"
                className="linklike"
                onClick={() => {
                  props.onNavigate('printers');
                }}
              >
                Manage printers
              </button>
            }
          >
            {printers.length === 0 ? (
              <EmptyState
                title="No printers configured"
                hint="Printer configuration is synced from the SaaS dashboard."
              />
            ) : (
              <ul className="rows">
                {printers.map((printer) => (
                  <li key={printer.config.printerId} className="row">
                    <span className="row-title">{printer.config.name}</span>
                    <span className="row-sub">{printer.config.role}</span>
                    <PrinterHealthPill health={printer.health} />
                    <span className="row-meta">
                      last print <Timestamp iso={printer.lastPrintAt} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card
            title="Recent jobs"
            actions={
              <button
                type="button"
                className="linklike"
                onClick={() => {
                  props.onNavigate('jobs');
                }}
              >
                View all
              </button>
            }
          >
            {recent.length === 0 ? (
              <EmptyState
                icon={<ReceiptIcon size={28} />}
                title="No print jobs yet"
                hint="Jobs sent from the SaaS will appear here as they are received."
              />
            ) : (
              <ul className="rows">
                {recent.map((job) => (
                  <li key={job.jobId} className="row">
                    <JobStatusPill status={job.status} />
                    <span className="row-title">{docTypeLabel(job.docType)}</span>
                    <span className="row-sub">{job.destinationPrinterName}</span>
                    <span className="row-meta">
                      <Timestamp iso={job.updatedAt} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <p className="footnote">
            “Sent to printer” means the job was handed to the printer or driver. The agent cannot
            confirm that paper physically printed.
          </p>
        </>
      )}
    </div>
  );
}

export function docTypeLabel(docType: JobRecord['docType']): string {
  switch (docType) {
    case 'customer_receipt':
      return 'Customer receipt';
    case 'kitchen_ticket':
      return 'Kitchen ticket';
    case 'bar_ticket':
      return 'Bar ticket';
    case 'station_ticket':
      return 'Station ticket';
  }
}
