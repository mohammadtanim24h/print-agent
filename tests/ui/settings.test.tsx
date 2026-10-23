import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsScreen } from '../../src/renderer/src/ui/screens/SettingsScreen';
import { makeService, renderWithService } from './helpers';

describe('SettingsScreen', () => {
  it('renders startup, connection, logging and diagnostics sections', async () => {
    renderWithService(<SettingsScreen onNavigate={() => undefined} />, makeService());
    expect(await screen.findByText('Startup')).toBeInTheDocument();
    expect(screen.getByText('Connection')).toBeInTheDocument();
    expect(screen.getByText('Logging')).toBeInTheDocument();
    expect(screen.getByText('Diagnostics')).toBeInTheDocument();
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
    renderWithService(
      <SettingsScreen onNavigate={() => undefined} />,
      makeService({ updateSettings }),
    );
    await screen.findByText('Startup');
    const switches = screen.getAllByRole('checkbox');
    expect(switches).toHaveLength(2);
    await user.click(switches[0] as HTMLElement);
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
    renderWithService(
      <SettingsScreen onNavigate={() => undefined} />,
      makeService({ updateSettings }),
    );
    await user.selectOptions(await screen.findByRole('combobox'), 'warn');
    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith({ logLevel: 'warn' });
    });
  });

  it('shows an error banner when saving fails', async () => {
    const user = userEvent.setup();
    renderWithService(
      <SettingsScreen onNavigate={() => undefined} />,
      makeService({
        updateSettings: () => Promise.reject(new Error('disk full')),
      }),
    );
    await screen.findByText('Startup');
    await user.click(screen.getAllByRole('checkbox')[0] as HTMLElement);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('disk full');
  });

  it('navigates to diagnostics', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    renderWithService(<SettingsScreen onNavigate={onNavigate} />, makeService());
    await user.click(await screen.findByRole('button', { name: /open diagnostics/i }));
    expect(onNavigate).toHaveBeenCalledWith('diagnostics');
  });
});
