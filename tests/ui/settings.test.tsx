import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsScreen } from '../../src/renderer/src/ui/screens/SettingsScreen';
import { makeService, renderWithService } from './helpers';
import type { Theme } from '../../src/renderer/src/App';

const defaultTheme: Theme = 'dark';

function renderSettings(
  serviceOverrides?: Parameters<typeof makeService>[0],
  onThemeChange?: (theme: Theme) => void,
): void {
  renderWithService(
    <SettingsScreen
      onNavigate={() => undefined}
      theme={defaultTheme}
      onThemeChange={onThemeChange ?? (() => undefined)}
    />,
    makeService(serviceOverrides),
  );
}

describe('SettingsScreen', () => {
  it('renders appearance, startup, connection, logging and diagnostics sections', async () => {
    renderSettings();
    expect(await screen.findByText('Appearance')).toBeInTheDocument();
    expect(screen.getByText('Startup')).toBeInTheDocument();
    expect(screen.getByText('Connection')).toBeInTheDocument();
    expect(screen.getByText('Logging')).toBeInTheDocument();
    expect(screen.getByText('Diagnostics')).toBeInTheDocument();
  });

  it('toggles the dark-theme switch through onThemeChange', async () => {
    const user = userEvent.setup();
    const onThemeChange = vi.fn();
    renderSettings(undefined, onThemeChange);
    await user.click(await screen.findByRole('checkbox', { name: /dark theme/i }));
    expect(onThemeChange).toHaveBeenCalledWith('light');
  });

  it('applies the launch-at-login toggle through the service', async () => {
    const user = userEvent.setup();
    const updateSettings = vi.fn((patch: { launchAtLogin?: boolean }) =>
      Promise.resolve({
        launchAtLogin: patch.launchAtLogin ?? false,
        startMinimized: true,
        logLevel: 'info' as const,
      }),
    );
    renderSettings({ updateSettings });
    await screen.findByText('Startup');
    const switches = screen.getAllByRole('checkbox');
    expect(switches).toHaveLength(3);
    await user.click(screen.getByRole('checkbox', { name: /when I log in/i }));
    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith({ launchAtLogin: true });
    });
    expect(await screen.findByText(/settings saved/i)).toBeInTheDocument();
  });

  it('changes the log level via the select', async () => {
    const user = userEvent.setup();
    const updateSettings = vi.fn(() =>
      Promise.resolve({ launchAtLogin: false, startMinimized: true, logLevel: 'warn' as const }),
    );
    renderSettings({ updateSettings });
    await user.selectOptions(await screen.findByRole('combobox'), 'warn');
    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith({ logLevel: 'warn' });
    });
  });

  it('persists the start-minimized toggle through the service', async () => {
    const user = userEvent.setup();
    const service = makeService();
    renderWithService(
      <SettingsScreen
        onNavigate={() => undefined}
        theme={defaultTheme}
        onThemeChange={() => undefined}
      />,
      service,
    );
    await screen.findByText('Startup');
    await user.click(screen.getByRole('checkbox', { name: /minimized/i }));
    await waitFor(async () => {
      await expect(service.getSettings()).resolves.toMatchObject({ startMinimized: false });
    });
  });

  it('shows an error banner when saving fails', async () => {
    const user = userEvent.setup();
    renderSettings({
      updateSettings: () => Promise.reject(new Error('disk full')),
    });
    await screen.findByText('Startup');
    await user.click(screen.getByRole('checkbox', { name: /when I log in/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('disk full');
  });

  it('navigates to diagnostics', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    renderWithService(
      <SettingsScreen
        onNavigate={onNavigate}
        theme={defaultTheme}
        onThemeChange={() => undefined}
      />,
      makeService(),
    );
    await user.click(await screen.findByRole('button', { name: /open diagnostics/i }));
    expect(onNavigate).toHaveBeenCalledWith('diagnostics');
  });
});
