/**
 * Inline SVG glyphs. Status is never conveyed by color alone (WCAG 1.4.1):
 * every status tone pairs a distinct icon *shape* with its text label, so
 * color-blind operators still tell states apart.
 */
interface IconProps {
  readonly className?: string;
  readonly size?: number;
}

function svgProps(
  props: IconProps,
  viewBox = '0 0 16 16',
): {
  className: string | undefined;
  width: number;
  height: number;
  viewBox: string;
  fill: 'none';
  stroke: 'currentColor';
  strokeWidth: number;
  strokeLinecap: 'round';
  strokeLinejoin: 'round';
  'aria-hidden': true;
} {
  const size = props.size ?? 16;
  return {
    className: props.className,
    width: size,
    height: size,
    viewBox,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  };
}

export function CheckCircleIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M5.2 8.2l1.9 1.9 3.7-4" />
    </svg>
  );
}

export function CrossCircleIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" />
    </svg>
  );
}

export function WarnTriangleIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M8 2.2L14.3 13H1.7L8 2.2z" />
      <path d="M8 6.4v3.1" />
      <path d="M8 11.6h.01" strokeWidth="2.2" />
    </svg>
  );
}

export function QuestionCircleIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M6.3 6.2c.2-1 1-1.6 1.9-1.5.9.1 1.6.8 1.6 1.7 0 1.2-1.7 1.4-1.7 2.6" />
      <path d="M8 11.7h.01" strokeWidth="2.2" />
    </svg>
  );
}

export function ClockIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.6V8l2.3 1.5" />
    </svg>
  );
}

/** Outbound arrow — "sent to printer" (bytes handed over, no guarantee). */
export function ArrowOutIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M2.5 8h8.5" />
      <path d="M8.4 4.6L11.8 8l-3.4 3.4" />
      <path d="M13.5 3v10" strokeDasharray="1.6 2" />
    </svg>
  );
}

/** Slash circle — rejected/blocked. */
export function BanIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M3.8 3.8l8.4 8.4" />
    </svg>
  );
}

export function InfoIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 7.4v3.2" />
      <path d="M8 5.2h.01" strokeWidth="2.2" />
    </svg>
  );
}

/** Receipt mark — brand + documents. */
export function ReceiptIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M4 1.8h8v12.4l-2-1.2-2 1.2-2-1.2-2 1.2V1.8z" />
      <path d="M6 5h4M6 7.5h4M6 10h2.5" />
    </svg>
  );
}

export function GaugeIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M2.2 11.5a6.2 6.2 0 1111.6 0" />
      <path d="M8 11.5L10.8 7" />
      <circle cx="8" cy="11.5" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function PlugIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M5.5 1.8v3M10.5 1.8v3" />
      <path d="M3.8 4.8h8.4v2.4a4.2 4.2 0 01-8.4 0V4.8z" />
      <path d="M8 11.4v2.8" />
    </svg>
  );
}

export function PrinterIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M4.5 5.5V2h7v3.5" />
      <path d="M4.5 11H2.8V6.3h10.4V11h-1.7" />
      <path d="M4.5 9h7v5h-7V9z" />
    </svg>
  );
}

export function ListIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M5 4h8.5M5 8h8.5M5 12h8.5" />
      <path d="M2.4 4h.01M2.4 8h.01M2.4 12h.01" strokeWidth="2.2" />
    </svg>
  );
}

export function GearIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.8v1.9M8 12.3v1.9M1.8 8h1.9M12.3 8h1.9M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4" />
    </svg>
  );
}

export function PulseIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M1.8 8.5h3l1.6-4 2.6 7 1.5-3h3.7" />
    </svg>
  );
}

export function RefreshIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M13.2 6.4A5.4 5.4 0 003.4 4.9M2.8 9.6a5.4 5.4 0 009.8 1.5" />
      <path d="M13.4 2.6v3.8H9.6M2.6 13.4V9.6h3.8" />
    </svg>
  );
}

export function DownloadIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M8 2.2v7.4" />
      <path d="M4.9 6.6L8 9.7l3.1-3.1" />
      <path d="M2.8 12.2v1h10.4v-1" />
    </svg>
  );
}

export function PlusIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

export function TrashIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M2.8 4.2h10.4" />
      <path d="M5.8 4.2V2.8h4.4v1.4" />
      <path d="M4.2 4.2l.7 9h6.2l.7-9" />
      <path d="M6.6 6.8v4M9.4 6.8v4" />
    </svg>
  );
}

export function PlayIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M5 3.2l7.2 4.8L5 12.8V3.2z" />
    </svg>
  );
}
