import { useEffect, useState } from 'react';
import type { AgentInfo, AppSettings } from '../../shared/ipc-contract';

// Local-only UI (architecture.md §3.9). All state comes through the
// validated contextBridge API; the renderer never touches the network.
export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.printAgent
      .getAgentInfo()
      .then(setInfo)
      .catch((e: unknown) => setError(String(e)));
    void window.printAgent
      .getSettings()
      .then(setSettings)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  const toggleLaunchAtLogin = (enabled: boolean): void => {
    void window.printAgent
      .setLaunchAtLogin(enabled)
      .then(setSettings)
      .catch((e: unknown) => setError(String(e)));
  };

  return (
    <main className="shell">
      <h1>Print Agent</h1>
      {error !== null && <p className="error">{error}</p>}
      <section className="card">
        <h2>Status</h2>
        {info === null ? (
          <p>Loading…</p>
        ) : (
          <dl>
            <dt>Version</dt>
            <dd>{info.version}</dd>
            <dt>Cloud connection</dt>
            <dd>Not configured (disabled in this phase)</dd>
          </dl>
        )}
      </section>
      <section className="card">
        <h2>Settings</h2>
        {settings === null ? (
          <p>Loading…</p>
        ) : (
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.launchAtLogin}
              onChange={(e) => toggleLaunchAtLogin(e.target.checked)}
            />
            Start Print Agent when I log in
          </label>
        )}
      </section>
      <button className="quit" type="button" onClick={() => void window.printAgent.quitApp()}>
        Quit Print Agent
      </button>
    </main>
  );
}
