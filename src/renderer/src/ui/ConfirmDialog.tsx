import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { WarnTriangleIcon } from './icons';

/**
 * Accessible confirmation for destructive or print-affecting actions
 * (unpair, remove printer, retry, duplicate-banner reprint). Escape and
 * backdrop click cancel; focus starts on Cancel for danger confirmations so
 * a stray Enter can't fire the destructive path.
 */
export function ConfirmDialog(props: {
  readonly title: string;
  readonly body: ReactNode;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly tone?: 'danger' | 'default';
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    const preferred =
      props.tone === 'danger'
        ? dialog.querySelector<HTMLButtonElement>('[data-role="cancel"]')
        : dialog.querySelector<HTMLButtonElement>('[data-role="confirm"]');
    (preferred ?? dialog).focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        props.onCancel();
        return;
      }
      if (event.key === 'Tab') {
        const focusables = Array.from(
          dialog.querySelectorAll<HTMLElement>('button:not([disabled])'),
        );
        if (focusables.length === 0) {
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (first === undefined || last === undefined) {
          return;
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    dialog.addEventListener('keydown', onKeyDown);
    return () => {
      dialog.removeEventListener('keydown', onKeyDown);
    };
    // Handlers are stable per render invocation of the dialog.
  }, []);

  const tone = props.tone ?? 'default';

  return (
    <div
      className="dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && props.busy !== true) {
          props.onCancel();
        }
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-body"
        className={`dialog dialog-${tone}`}
        tabIndex={-1}
      >
        <div className="dialog-icon">
          <WarnTriangleIcon size={20} />
        </div>
        <h2 id="confirm-title" className="dialog-title">
          {props.title}
        </h2>
        <div id="confirm-body" className="dialog-body">
          {props.body}
        </div>
        <div className="dialog-actions">
          <button
            type="button"
            data-role="cancel"
            className="btn btn-ghost"
            disabled={props.busy === true}
            onClick={props.onCancel}
          >
            {props.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            data-role="confirm"
            className={`btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`}
            disabled={props.busy === true}
            onClick={props.onConfirm}
          >
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
