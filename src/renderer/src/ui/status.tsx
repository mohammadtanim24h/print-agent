import type { ConnectionState, JobStatus, PrinterHealth } from '../services/types';
import {
  ArrowOutIcon,
  BanIcon,
  CheckCircleIcon,
  ClockIcon,
  CrossCircleIcon,
  InfoIcon,
  QuestionCircleIcon,
  WarnTriangleIcon,
} from './icons';

export type Tone = 'success' | 'warn' | 'danger' | 'info' | 'neutral';

interface IconComponent {
  (props: { readonly size?: number }): React.JSX.Element;
}

export interface StatusMeta {
  readonly label: string;
  readonly tone: Tone;
  readonly Icon: IconComponent;
  /** Tooltip/expanded explanation — the semantics behind the short label. */
  readonly title: string;
}

/**
 * Job status wording follows docs/api-contract.md §3.1 (normative):
 * `completed` is rendered as a hand-off confirmation, never as "printed".
 */
export const JOB_STATUS_META: Readonly<Record<JobStatus, StatusMeta>> = {
  accepted: {
    label: 'Queued on device',
    tone: 'info',
    Icon: ClockIcon,
    title: 'Durably stored on this agent. Not yet sent to a printer.',
  },
  rendered: {
    label: 'Rendered',
    tone: 'info',
    Icon: InfoIcon,
    title: 'Printer-ready data produced. Not yet sent to a printer.',
  },
  sending: {
    label: 'Sending',
    tone: 'info',
    Icon: ArrowOutIcon,
    title: 'Write to the printer is in flight.',
  },
  sent_to_printer: {
    label: 'Sent to printer',
    tone: 'info',
    Icon: ArrowOutIcon,
    title:
      'Bytes were handed to the printer connection. The printer may still be off, ' +
      'out of paper, or jammed — this is not a print confirmation.',
  },
  printer_ack: {
    label: 'Printer acknowledged',
    tone: 'success',
    Icon: CheckCircleIcon,
    title: 'Best-effort printer status says it received the job. Still not a guarantee it printed.',
  },
  completed: {
    label: 'Sent to printer (hand-off)',
    tone: 'success',
    Icon: CheckCircleIcon,
    title:
      'Hand-off to the printer/driver succeeded. Physical printing is never confirmed by ' +
      'the agent — check the printer if in doubt.',
  },
  failed: {
    label: 'Failed',
    tone: 'danger',
    Icon: CrossCircleIcon,
    title: 'Terminal error after bounded retries. A manual reprint is available.',
  },
  ambiguous: {
    label: 'Outcome unknown — verify',
    tone: 'warn',
    Icon: QuestionCircleIcon,
    title:
      'The agent lost track of this job (e.g. restart while sending). It may or may not have ' +
      'printed. Resolve by verifying at the printer; a DUPLICATE-banner reprint is available.',
  },
  rejected: {
    label: 'Rejected',
    tone: 'neutral',
    Icon: BanIcon,
    title: 'The job was refused (validation, expiry, or scope) and will never print.',
  },
};

export const CONNECTION_META: Readonly<Record<ConnectionState, StatusMeta>> = {
  disabled: {
    label: 'Not configured',
    tone: 'neutral',
    Icon: InfoIcon,
    title: 'The cloud link has not been set up yet.',
  },
  connecting: {
    label: 'Connecting…',
    tone: 'info',
    Icon: ClockIcon,
    title: 'Establishing the outbound connection.',
  },
  online: {
    label: 'Connected',
    tone: 'success',
    Icon: CheckCircleIcon,
    title: 'Outbound connection to the cloud is established.',
  },
  offline: {
    label: 'Offline',
    tone: 'danger',
    Icon: CrossCircleIcon,
    title:
      'No connection to the cloud. Jobs sent while offline queue on the server and replay on reconnect.',
  },
  error: {
    label: 'Connection error',
    tone: 'danger',
    Icon: WarnTriangleIcon,
    title: 'The last connection attempt failed. Retrying with backoff.',
  },
};

const PRINTER_HEALTH_META: Readonly<Record<PrinterHealth, StatusMeta>> = {
  ok: {
    label: 'Ready',
    tone: 'success',
    Icon: CheckCircleIcon,
    title: 'Transport answered; no paper or cover problems reported.',
  },
  unknown: {
    label: 'Unknown',
    tone: 'neutral',
    Icon: InfoIcon,
    title: 'No health information yet. Run a test print to check this printer.',
  },
  offline: {
    label: 'Offline',
    tone: 'danger',
    Icon: CrossCircleIcon,
    title: 'The printer did not answer. Check power and network.',
  },
  paper_out: {
    label: 'Paper out',
    tone: 'danger',
    Icon: WarnTriangleIcon,
    title: 'The printer reports no paper.',
  },
  paper_low: {
    label: 'Paper low',
    tone: 'warn',
    Icon: WarnTriangleIcon,
    title: 'The printer reports paper running low.',
  },
  cover_open: {
    label: 'Cover open',
    tone: 'danger',
    Icon: WarnTriangleIcon,
    title: 'The printer cover is open.',
  },
};

export function StatusPill(props: { readonly meta: StatusMeta }): React.JSX.Element {
  const { meta } = props;
  return (
    <span className={`pill pill-${meta.tone}`} title={meta.title}>
      <meta.Icon size={13} />
      <span>{meta.label}</span>
    </span>
  );
}

export function JobStatusPill(props: { readonly status: JobStatus }): React.JSX.Element {
  return <StatusPill meta={JOB_STATUS_META[props.status]} />;
}

export function ConnectionPill(props: { readonly state: ConnectionState }): React.JSX.Element {
  return <StatusPill meta={CONNECTION_META[props.state]} />;
}

export function PrinterHealthPill(props: { readonly health: PrinterHealth }): React.JSX.Element {
  return <StatusPill meta={PRINTER_HEALTH_META[props.health]} />;
}
