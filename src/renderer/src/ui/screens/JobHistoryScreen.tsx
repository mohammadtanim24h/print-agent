import { useMemo, useState } from 'react';
import { useAsync, useService } from '../../services/service-context';
import type { JobRecord } from '../../services/types';
import { Card, EmptyState, ErrorBanner, LoadingBlock, Timestamp } from '../primitives';
import { JOB_STATUS_META, JobStatusPill } from '../status';
import { ConfirmDialog } from '../ConfirmDialog';
import { ReceiptIcon, RefreshIcon } from '../icons';
import { docTypeLabel } from './OverviewScreen';

type StatusFilter = 'all' | 'attention' | 'completed' | 'failed';

const FILTERS: ReadonlyArray<{ readonly id: StatusFilter; readonly label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'completed', label: 'Sent to printer' },
  { id: 'failed', label: 'Failed' },
];

function matchesFilter(job: JobRecord, filter: StatusFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'attention':
      return job.status === 'ambiguous' || job.status === 'failed';
    case 'completed':
      return (
        job.status === 'completed' ||
        job.status === 'sent_to_printer' ||
        job.status === 'printer_ack'
      );
    case 'failed':
      return job.status === 'failed';
  }
}

export function JobHistoryScreen(): React.JSX.Element {
  const service = useService();
  const jobsState = useAsync(() => service.getJobs(), [service]);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmRetry, setConfirmRetry] = useState<JobRecord | null>(null);
  const [confirmReprint, setConfirmReprint] = useState<JobRecord | null>(null);

  const jobs = jobsState.data;
  const visible = useMemo(
    () =>
      (jobs ?? [])
        .filter((job) => matchesFilter(job, filter))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [jobs, filter],
  );

  const runAction = (job: JobRecord, action: 'retry' | 'reprint'): void => {
    setActionBusy(job.jobId);
    setActionError(null);
    setActionNote(null);
    const op = action === 'retry' ? service.retryJob(job.jobId) : service.reprintJob(job.jobId);
    void op
      .then((updated) => {
        setActionBusy(null);
        setConfirmRetry(null);
        setConfirmReprint(null);
        setActionNote(
          action === 'retry'
            ? `Job re-sent. New status: ${JOB_STATUS_META[updated.status].label}.`
            : `Reprint queued for ${updated.destinationPrinterName} with a DUPLICATE banner.`,
        );
        jobsState.reload();
      })
      .catch((e: unknown) => {
        setActionBusy(null);
        setConfirmRetry(null);
        setConfirmReprint(null);
        setActionError(e instanceof Error ? e.message : String(e));
      });
  };

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Job history</h1>
      </header>

      <div className="banner banner-info">
        <span className="banner-text">
          <strong>Sent to printer</strong> means the agent handed the job to the printer or driver.
          The agent cannot see whether the paper physically printed — when in doubt, check the
          printer before reprinting.
        </span>
      </div>

      <div className="filter-row" role="tablist" aria-label="Filter jobs">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            className={`chip${filter === f.id ? ' chip-active' : ''}`}
            onClick={() => {
              setFilter(f.id);
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {actionNote !== null && (
        <div className="banner banner-success" role="status">
          <span className="banner-text">{actionNote}</span>
        </div>
      )}
      {actionError !== null && <ErrorBanner message={actionError} />}

      {jobsState.loading ? (
        <LoadingBlock />
      ) : jobsState.error !== null || jobs === null ? (
        <ErrorBanner
          message={`Could not load job history. ${jobsState.error ?? ''}`.trim()}
          onRetry={jobsState.reload}
        />
      ) : jobs.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ReceiptIcon size={28} />}
            title="No jobs yet"
            hint="Print jobs received from the SaaS will be listed here with their outcome."
          />
        </Card>
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState
            title="Nothing matches this filter"
            hint="Try a different filter to see more jobs."
          />
        </Card>
      ) : (
        <Card>
          <ul className="rows">
            {visible.map((job) => (
              <li key={job.jobId} className="job-row">
                <div className="job-row-main">
                  <div className="job-row-head">
                    <JobStatusPill status={job.status} />
                    <span className="row-title">{docTypeLabel(job.docType)}</span>
                    <span className="row-sub">→ {job.destinationPrinterName}</span>
                  </div>
                  <p className="row-sub mono">
                    {job.idempotencyKey} · attempt {job.attempts}
                  </p>
                  {job.lastError !== null && <p className="row-error">{job.lastError}</p>}
                </div>
                <div className="job-row-side">
                  <span className="row-meta">
                    <Timestamp iso={job.updatedAt} />
                  </span>
                  <div className="job-row-actions">
                    {job.status === 'failed' && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={actionBusy !== null}
                        onClick={() => {
                          setConfirmRetry(job);
                        }}
                      >
                        <RefreshIcon size={12} /> Retry…
                      </button>
                    )}
                    {(job.status === 'completed' || job.status === 'ambiguous') && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={actionBusy !== null}
                        onClick={() => {
                          setConfirmReprint(job);
                        }}
                      >
                        Reprint…
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {confirmRetry !== null && (
        <ConfirmDialog
          title="Retry this failed job?"
          confirmLabel="Retry job"
          busy={actionBusy === confirmRetry.jobId}
          body={
            <>
              <p>
                The job will be sent again to <strong>{confirmRetry.destinationPrinterName}</strong>
                .
              </p>
              <p>
                If the paper actually fed despite the reported failure, this produces a duplicate
                ticket — check the printer first if you are unsure.
              </p>
            </>
          }
          onConfirm={() => {
            runAction(confirmRetry, 'retry');
          }}
          onCancel={() => {
            setConfirmRetry(null);
          }}
        />
      )}

      {confirmReprint !== null && (
        <ConfirmDialog
          title="Reprint with DUPLICATE banner?"
          tone={confirmReprint.status === 'ambiguous' ? 'danger' : 'default'}
          confirmLabel="Reprint (marked DUPLICATE)"
          busy={actionBusy === confirmReprint.jobId}
          body={
            <>
              <p>
                A copy of this {docTypeLabel(confirmReprint.docType).toLowerCase()} will be sent to{' '}
                <strong>{confirmReprint.destinationPrinterName}</strong> with a printed DUPLICATE
                banner.
              </p>
              {confirmReprint.status === 'ambiguous' && (
                <p>
                  This job's outcome is unknown — it may have already printed. Reprinting risks two
                  copies; verify at the printer if you can.
                </p>
              )}
            </>
          }
          onConfirm={() => {
            runAction(confirmReprint, 'reprint');
          }}
          onCancel={() => {
            setConfirmReprint(null);
          }}
        />
      )}
    </div>
  );
}
