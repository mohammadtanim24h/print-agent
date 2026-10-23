import { useState } from 'react';
import { useAsync, useService } from './services/service-context';
import {
  GearIcon,
  GaugeIcon,
  ListIcon,
  PlugIcon,
  PrinterIcon,
  PulseIcon,
  ReceiptIcon,
} from './ui/icons';
import { Timestamp } from './ui/primitives';
import type { ScreenId } from './ui/screens/OverviewScreen';
import { OverviewScreen } from './ui/screens/OverviewScreen';
import { SetupScreen } from './ui/screens/SetupScreen';
import { PrintersScreen } from './ui/screens/PrintersScreen';
import { JobHistoryScreen } from './ui/screens/JobHistoryScreen';
import { SettingsScreen } from './ui/screens/SettingsScreen';
import { DiagnosticsScreen } from './ui/screens/DiagnosticsScreen';

const NAV: ReadonlyArray<{
  readonly id: ScreenId;
  readonly label: string;
  readonly Icon: (props: { readonly size?: number }) => React.JSX.Element;
}> = [
  { id: 'overview', label: 'Overview', Icon: GaugeIcon },
  { id: 'setup', label: 'Setup', Icon: PlugIcon },
  { id: 'printers', label: 'Printers', Icon: PrinterIcon },
  { id: 'jobs', label: 'Job history', Icon: ListIcon },
  { id: 'settings', label: 'Settings', Icon: GearIcon },
  { id: 'diagnostics', label: 'Diagnostics', Icon: PulseIcon },
];

export function App(): React.JSX.Element {
  const service = useService();
  const [screen, setScreen] = useState<ScreenId>('overview');
  const snapshotState = useAsync(() => service.getSnapshot(), [service]);
  const identity = snapshotState.data?.identity ?? null;

  const navigate = (next: ScreenId): void => {
    setScreen(next);
  };

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Sections">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <ReceiptIcon size={18} />
          </span>
          <span className="brand-name">
            Print Agent
            <span className="brand-sub">kitchen &amp; receipt printing</span>
          </span>
        </div>
        <ul className="nav">
          {NAV.map(({ id, label, Icon }) => (
            <li key={id}>
              <button
                type="button"
                className={`nav-item${screen === id ? ' nav-item-active' : ''}`}
                aria-current={screen === id ? 'page' : undefined}
                onClick={() => {
                  navigate(id);
                }}
              >
                <Icon size={16} />
                <span>{label}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="sidebar-foot">
          {identity !== null ? (
            <>
              <span className="sidebar-restaurant">{identity.restaurantName}</span>
              <span className="sidebar-device mono">{identity.agentName}</span>
            </>
          ) : (
            <span className="sidebar-device">Not paired</span>
          )}
          {service.demo && <span className="demo-tag">demo data</span>}
        </div>
      </nav>

      <main className="content">
        {screen === 'overview' && <OverviewScreen onNavigate={navigate} />}
        {screen === 'setup' && (
          <SetupScreen
            onPaired={() => {
              navigate('overview');
            }}
          />
        )}
        {screen === 'printers' && <PrintersScreen />}
        {screen === 'jobs' && <JobHistoryScreen />}
        {screen === 'settings' && <SettingsScreen onNavigate={navigate} />}
        {screen === 'diagnostics' && <DiagnosticsScreen />}
        <footer className="content-foot">
          {snapshotState.data !== null && snapshotState.data.lastActivityAt !== null && (
            <span>
              Last activity <Timestamp iso={snapshotState.data.lastActivityAt} />
            </span>
          )}
          <button
            type="button"
            className="linklike"
            onClick={() => void window.printAgent.quitApp()}
          >
            Quit Print Agent
          </button>
        </footer>
      </main>
    </div>
  );
}
