import type { ReactNode } from 'react';
import { CrossCircleIcon, RefreshIcon } from './icons';

export function Card(props: {
  readonly title?: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}): React.JSX.Element {
  return (
    <section className={`card${props.className === undefined ? '' : ` ${props.className}`}`}>
      {(props.title !== undefined || props.actions !== undefined) && (
        <header className="card-head">
          {props.title !== undefined && <h2 className="card-title">{props.title}</h2>}
          {props.actions !== undefined && <div className="card-actions">{props.actions}</div>}
        </header>
      )}
      {props.children}
    </section>
  );
}

export function EmptyState(props: {
  readonly icon?: ReactNode;
  readonly title: string;
  readonly hint?: string;
  readonly action?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="empty">
      {props.icon !== undefined && <div className="empty-icon">{props.icon}</div>}
      <p className="empty-title">{props.title}</p>
      {props.hint !== undefined && <p className="empty-hint">{props.hint}</p>}
      {props.action !== undefined && <div className="empty-action">{props.action}</div>}
    </div>
  );
}

export function Spinner(props: { readonly label?: string }): React.JSX.Element {
  const label = props.label ?? 'Loading';
  return (
    <span className="spinner-wrap" role="status">
      <span className="spinner" aria-hidden="true" />
      <span className="spinner-label">{label}…</span>
    </span>
  );
}

export function LoadingBlock(): React.JSX.Element {
  return (
    <div className="loading-block">
      <Spinner />
    </div>
  );
}

export function ErrorBanner(props: {
  readonly message: string;
  readonly onRetry?: () => void;
}): React.JSX.Element {
  return (
    <div className="banner banner-error" role="alert">
      <CrossCircleIcon size={16} />
      <span className="banner-text">{props.message}</span>
      {props.onRetry !== undefined && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={props.onRetry}>
          <RefreshIcon size={13} /> Retry
        </button>
      )}
    </div>
  );
}

/** Shown while any screen is backed by demo data — keeps mock output honest. */
export function DemoBadge(): React.JSX.Element {
  return (
    <span
      className="pill pill-demo"
      title="This screen shows demonstration data. Cloud and printer services are not connected yet."
    >
      Demo data
    </span>
  );
}

export function Field(props: {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      {props.children}
      {props.hint !== undefined && <span className="field-hint">{props.hint}</span>}
    </label>
  );
}

export function KeyVal(props: {
  readonly term: string;
  readonly children: ReactNode;
  readonly mono?: boolean;
}): React.JSX.Element {
  return (
    <div className="keyval">
      <dt>{props.term}</dt>
      <dd className={props.mono === true ? 'mono' : undefined}>{props.children}</dd>
    </div>
  );
}

/** Short local timestamp; full RFC 3339 in the tooltip. */
export function Timestamp(props: { readonly iso: string | null }): React.JSX.Element {
  if (props.iso === null) {
    return <span className="muted">—</span>;
  }
  const date = new Date(props.iso);
  const formatted = Number.isNaN(date.getTime())
    ? props.iso
    : date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
  return (
    <time className="mono muted" dateTime={props.iso} title={props.iso}>
      {formatted}
    </time>
  );
}
