import { useState } from 'react';
import { useAsync, useService, useSnapshotTick } from '../../services/service-context';
import type { LogLevel, UiSettings } from '../../services/types';
import type { Theme } from '../../App';
import { Card, ErrorBanner, Field, LoadingBlock } from '../primitives';
import { ConnectionPill } from '../status';

const LOG_LEVELS: ReadonlyArray<{ readonly value: LogLevel; readonly label: string }> = [
  { value: 'debug', label: 'Debug (most detail)' },
  { value: 'info', label: 'Info (recommended)' },
  { value: 'warn', label: 'Warnings only' },
  { value: 'error', label: 'Errors only' },
];

export function SettingsScreen(props: {
  readonly theme: Theme;
  readonly onThemeChange: (theme: Theme) => void;
}): React.JSX.Element {
  const service = useService();
  const tick = useSnapshotTick();
  const settingsState = useAsync<UiSettings>(() => service.getSettings(), [service, tick]);
  const snapshotState = useAsync(() => service.getSnapshot(), [service, tick]);
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

      <Card title="Appearance">
        <div className="setting-row">
          <div className="setting-text">
            <span className="row-title">Dark theme</span>
            <span className="row-sub">
              Easier on the eyes in a dim kitchen. The choice is remembered on this PC.
            </span>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={props.theme === 'dark'}
              onChange={(e) => {
                props.onThemeChange(e.target.checked ? 'dark' : 'light');
              }}
            />
            <span className="switch-track" aria-hidden="true" />
            <span className="sr-only">
              {props.theme === 'dark' ? 'Dark theme: on' : 'Dark theme: off'}
            </span>
          </label>
        </div>
      </Card>

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
              {settings.launchAtLogin ? 'Start when I log in: on' : 'Start when I log in: off'}
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
              {settings.startMinimized ? 'Start minimized: on' : 'Start minimized: off'}
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
    </div>
  );
}
