import { useState } from 'react';
import { useAsync, useService } from '../../services/service-context';
import type { LogLevel, UiSettings } from '../../services/types';
import { Card, ErrorBanner, Field, LoadingBlock } from '../primitives';
import { ConnectionPill } from '../status';

const LOG_LEVELS: ReadonlyArray<{ readonly value: LogLevel; readonly label: string }> = [
  { value: 'debug', label: 'Debug (most detail)' },
  { value: 'info', label: 'Info (recommended)' },
  { value: 'warn', label: 'Warnings only' },
  { value: 'error', label: 'Errors only' },
];

export function SettingsScreen(props: {
  readonly onNavigate: (screen: 'diagnostics') => void;
}): React.JSX.Element {
  const service = useService();
  const settingsState = useAsync<UiSettings>(() => service.getSettings(), [service]);
  const snapshotState = useAsync(() => service.getSnapshot(), [service]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState(false);

  if (settingsState.loading || snapshotState.loading) {
    return <LoadingBlock />;
  }
  if (settingsState.error !== null || settingsState.data === null) {
    return (
      <ErrorBanner
        message={`Could not load settings. ${settingsState.error ?? ''}`.trim()}
        onRetry={settingsState.reload}
      />
    );
  }
  const settings = settingsState.data;
  const snapshot = snapshotState.data;

  const apply = (patch: Partial<UiSettings>): void => {
    setSaving(true);
    setSaveError(null);
    setSavedNote(false);
    void service
      .updateSettings(patch)
      .then(() => {
        setSaving(false);
        setSavedNote(true);
        settingsState.reload();
      })
      .catch((e: unknown) => {
        setSaving(false);
        setSaveError(e instanceof Error ? e.message : String(e));
      });
  };

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Settings</h1>
      </header>

      {savedNote && (
        <div className="banner banner-success" role="status">
          <span className="banner-text">Settings saved.</span>
        </div>
      )}
      {saveError !== null && (
        <ErrorBanner
          message={saveError}
          onRetry={() => {
            settingsState.reload();
          }}
        />
      )}

      <Card title="Startup">
        <div className="setting-row">
          <div className="setting-text">
            <span className="row-title">Start Print Agent when I log in</span>
            <span className="row-sub">Keeps the agent ready without anyone opening it.</span>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={settings.launchAtLogin}
              disabled={saving}
              onChange={(e) => {
                apply({ launchAtLogin: e.target.checked });
              }}
            />
            <span className="switch-track" aria-hidden="true" />
            <span className="sr-only">
              {settings.launchAtLogin ? 'On — starts at login' : 'Off — starts manually'}
            </span>
          </label>
        </div>
        <div className="setting-row">
          <div className="setting-text">
            <span className="row-title">Start minimized to the notification area</span>
            <span className="row-sub">The window stays hidden; open it from the tray icon.</span>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={settings.startMinimized}
              disabled={saving}
              onChange={(e) => {
                apply({ startMinimized: e.target.checked });
              }}
            />
            <span className="switch-track" aria-hidden="true" />
            <span className="sr-only">
              {settings.startMinimized ? 'On — starts minimized' : 'Off — opens the window'}
            </span>
          </label>
        </div>
      </Card>

      <Card title="Connection">
        {snapshot !== null && <ConnectionPill state={snapshot.connection} />}
        <p className="row-sub">
          {snapshot?.connectionDetail ??
            'The agent uses one outbound, encrypted connection to your SaaS. No inbound ports are opened — nothing on the network can connect to this PC.'}
        </p>
        <p className="footnote">
          Server address and credentials are managed by pairing (see Setup). They are stored
          encrypted and never shown in this window.
        </p>
      </Card>

      <Card title="Logging">
        <Field
          label="Log detail level"
          hint="Logs are sanitized: credentials and personal data are removed before display or export."
        >
          <select
            className="input"
            value={settings.logLevel}
            disabled={saving}
            onChange={(e) => {
              const match = LOG_LEVELS.find((l) => l.value === e.target.value);
              if (match !== undefined) {
                apply({ logLevel: match.value });
              }
            }}
          >
            {LOG_LEVELS.map((level) => (
              <option key={level.value} value={level.value}>
                {level.label}
              </option>
            ))}
          </select>
        </Field>
      </Card>

      <Card title="Diagnostics">
        <p className="row-sub">
          Run connectivity checks, inspect sanitized logs and export a support bundle.
        </p>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            props.onNavigate('diagnostics');
          }}
        >
          Open diagnostics
        </button>
      </Card>
    </div>
  );
}
