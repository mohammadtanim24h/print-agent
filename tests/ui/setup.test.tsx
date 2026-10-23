import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SetupScreen } from '../../src/renderer/src/ui/screens/SetupScreen';
import { makeService, renderWithService } from './helpers';

describe('SetupScreen', () => {
  it('validates the pairing code format before submitting', async () => {
    const user = userEvent.setup();
    const pairWithCode = vi.fn().mockResolvedValue({ ok: true });
    renderWithService(
      <SetupScreen />,
      makeService({
        getSnapshot: () =>
          Promise.resolve({
            version: '0.1.0',
            connection: 'disabled' as const,
            connectionDetail: '',
            identity: null,
            pendingJobs: 0,
            ambiguousJobs: 0,
            lastActivityAt: null,
          }),
        pairWithCode,
      }),
    );
    expect(await screen.findByText(/pair with your restaurant/i)).toBeInTheDocument();
    const input = screen.getByLabelText(/pairing code/i);
    await user.type(input, 'ABC');
    expect(screen.getByText(/5 more characters to go/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /pair agent/i })).toBeDisabled();
    await user.type(input, '12345');
    expect(screen.getByText(/ready to pair/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /pair agent/i })).toBeEnabled();
    // A ninth character is ignored (codes are exactly 8).
    await user.type(input, 'X');
    expect(screen.getByText(/ready to pair/i)).toBeInTheDocument();
    expect(input).toHaveValue('ABC12345');
  });

  it('pairs successfully and calls onPaired', async () => {
    const user = userEvent.setup();
    const onPaired = vi.fn();
    const service = makeService();
    await service.unpair();
    renderWithService(<SetupScreen onPaired={onPaired} />, service);
    await user.type(await screen.findByLabelText(/pairing code/i), '7QJ2K9XD');
    await user.click(screen.getByRole('button', { name: /pair agent/i }));
    await waitFor(() => {
      expect(onPaired).toHaveBeenCalledOnce();
    });
  });

  it('shows the failure message when pairing is rejected', async () => {
    const user = userEvent.setup();
    const service = makeService();
    await service.unpair();
    renderWithService(
      <SetupScreen />,
      makeService({
        getSnapshot: () => service.getSnapshot(),
        pairWithCode: () =>
          Promise.resolve({
            ok: false as const,
            reason: 'expired' as const,
            message: 'This code has expired. Generate a new one in the dashboard.',
          }),
      }),
    );
    await user.type(await screen.findByLabelText(/pairing code/i), '7QJ2K9XD');
    await user.click(screen.getByRole('button', { name: /pair agent/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('expired');
  });

  it('requires confirmation before unpairing and cancel keeps the pairing', async () => {
    const user = userEvent.setup();
    const service = makeService();
    renderWithService(<SetupScreen />, service);
    expect(await screen.findByText(/Paired device/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /unpair this device/i }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('wipes');
    // Cancel keeps everything.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByText(/Trattoria Bella \(demo\)/i)).toBeInTheDocument();
    expect((await service.getSnapshot()).identity).not.toBeNull();
  });

  it('unpairs after confirmation', async () => {
    const user = userEvent.setup();
    const service = makeService();
    renderWithService(<SetupScreen />, service);
    await user.click(await screen.findByRole('button', { name: /unpair this device/i }));
    await user.click(screen.getByRole('button', { name: /unpair and wipe data/i }));
    await waitFor(() => expect(screen.getByText(/pair with your restaurant/i)).toBeInTheDocument());
    expect((await service.getSnapshot()).identity).toBeNull();
  });
});
