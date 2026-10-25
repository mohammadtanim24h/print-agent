import { useRef, useState } from 'react';
import { useAsync, useService } from '../../services/service-context';
import type { AgentSnapshot, PairResult } from '../../services/types';
import { Card, ErrorBanner, KeyVal, LoadingBlock, Timestamp } from '../primitives';
import { ConnectionPill } from '../status';
import { ConfirmDialog } from '../ConfirmDialog';

const CODE_LENGTH = 8;

export function SetupScreen(props: { readonly onPaired?: () => void }): React.JSX.Element {
  const service = useService();
  const snapshotState = useAsync<AgentSnapshot>(() => service.getSnapshot(), [service]);

  const [code, setCode] = useState('');
  const [pairing, setPairing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  const [unpairError, setUnpairError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  if (snapshotState.loading) {
    return <LoadingBlock />;
  }
  if (snapshotState.error !== null || snapshotState.data === null) {
    return (
      <ErrorBanner
        message={`Could not load pairing status. ${snapshotState.error ?? ''}`.trim()}
        onRetry={snapshotState.reload}
      />
    );
  }
  const snapshot = snapshotState.data;

  const formatCode = (raw: string): string =>
    raw
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, CODE_LENGTH);

  const submit = (): void => {
    const cleaned = formatCode(code);
    if (cleaned.length !== CODE_LENGTH) {
      setFailure(`Enter all ${String(CODE_LENGTH)} characters of the pairing code.`);
      return;
    }
    setPairing(true);
    setFailure(null);
    void service
      .pairWithCode(cleaned)
      .then((result: PairResult) => {
        setPairing(false);
        if (result.ok) {
          setCode('');
          snapshotState.reload();
          props.onPaired?.();
        } else {
          setFailure(result.message);
        }
      })
      .catch((e: unknown) => {
        setPairing(false);
        setFailure(e instanceof Error ? e.message : String(e));
      });
  };

  const unpair = (): void => {
    setConfirmUnpair(false);
    setUnpairError(null);
    void service
      .unpair()
      .then(() => {
        snapshotState.reload();
      })
      .catch((e: unknown) => {
        setUnpairError(e instanceof Error ? e.message : String(e));
      });
  };

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Setup</h1>
        <div className="screen-head-side">
          <ConnectionPill state={snapshot.connection} />
        </div>
      </header>

      {snapshot.identity !== null ? (
        <>
          <Card title="Paired device">
            <dl className="keyvals">
              <KeyVal term="Restaurant">{snapshot.identity.restaurantName}</KeyVal>
              <KeyVal term="Device" mono>
                {snapshot.identity.agentName} · {snapshot.identity.deviceId}
              </KeyVal>
              <KeyVal term="Paired">
                <Timestamp iso={snapshot.identity.pairedAt} />
              </KeyVal>
            </dl>
            <p className="footnote">
              This agent is bound to one restaurant. Jobs are only accepted for the paired
              restaurant's scope.
            </p>
            <div className="card-actions">
              <button
                type="button"
                className="btn btn-danger-ghost"
                onClick={() => {
                  setConfirmUnpair(true);
                }}
              >
                Unpair this device…
              </button>
            </div>
            {unpairError !== null && <ErrorBanner message={unpairError} />}
          </Card>
          {confirmUnpair && (
            <ConfirmDialog
              title="Unpair this device?"
              tone="danger"
              confirmLabel="Unpair and wipe data"
              busy={false}
              body={
                <>
                  <p>
                    Unpairing wipes the device credentials, all queued jobs and the cached printer
                    configuration from this PC. The agent stops accepting jobs immediately.
                  </p>
                  <p>
                    To use this PC again you must pair it with a new code from the SaaS dashboard.
                  </p>
                </>
              }
              onConfirm={unpair}
              onCancel={() => {
                setConfirmUnpair(false);
              }}
            />
          )}
        </>
      ) : (
        <Card title="Pair with your restaurant">
          <ol className="steps">
            <li>
              In the SaaS web app, open <strong>Settings → Printers → Add agent</strong>.
            </li>
            <li>
              Enter the 8-character pairing code below. Codes are single-use and expire after 10
              minutes.
            </li>
          </ol>
          <form
            className="pair-form"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <label className="field">
              <span className="field-label">Pairing code</span>
              <input
                ref={codeRef}
                className="input input-code mono"
                value={code}
                onChange={(e) => {
                  setCode(formatCode(e.target.value));
                  setFailure(null);
                }}
                placeholder="e.g. 7QJ2K9XD"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                aria-describedby="pair-code-hint"
                aria-invalid={failure !== null}
                disabled={pairing}
              />
              <span className="field-hint" id="pair-code-hint">
                {CODE_LENGTH - code.length > 0
                  ? `${String(CODE_LENGTH - code.length)} more character${CODE_LENGTH - code.length === 1 ? '' : 's'} to go`
                  : 'Ready to pair'}
              </span>
            </label>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={pairing || code.length !== CODE_LENGTH}
            >
              {pairing ? 'Pairing…' : 'Pair agent'}
            </button>
          </form>
          {failure !== null && (
            <div className="banner banner-error" role="alert">
              <span className="banner-text">{failure}</span>
            </div>
          )}
          <p className="footnote">
            Pairing generates this device's keys on this PC; the private key never leaves it.
          </p>
        </Card>
      )}
    </div>
  );
}
