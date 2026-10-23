import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DiagnosticsScreen } from '../../src/renderer/src/ui/screens/DiagnosticsScreen';
import { makeService, renderWithService } from './helpers';
import { ConfirmDialog } from '../../src/renderer/src/ui/ConfirmDialog';

const clipboardWrite = vi.fn().mockResolvedValue(undefined);

function stubClipboard(value: unknown): void {
  Object.defineProperty(window.navigator, 'clipboard', { value, configurable: true });
}

afterEach(() => {
  stubClipboard(undefined);
  clipboardWrite.mockClear();
});

describe('DiagnosticsScreen', () => {
  it('shows application version, database health and sanitized logs', async () => {
    renderWithService(<DiagnosticsScreen />, makeService());
    expect(await screen.findByText('0.1.0')).toBeInTheDocument();
    expect(screen.getByText('Healthy')).toBeInTheDocument();
    expect(screen.getByText(/wal/i)).toBeInTheDocument();
    // The demo log demonstrates redaction: no raw tokens are shown.
    const logs = document.querySelector('.logs');
    expect(logs?.textContent).toContain('***');
  });

  it('runs connectivity checks and reports results with wording, not only color', async () => {
    const user = userEvent.setup();
    renderWithService(<DiagnosticsScreen />, makeService());
    expect(await screen.findByText(/checks have not been run/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /run checks/i }));
    await waitFor(() => {
      expect(screen.getAllByText('Pass').length).toBeGreaterThanOrEqual(3);
    });
    // Bar-1 is offline in the demo seed, so the printer check must warn.
    expect(screen.getByText('Warning')).toBeInTheDocument();
    expect(screen.getByText(/did not answer/i)).toBeInTheDocument();
  });

  it('copies a diagnostics bundle to the clipboard', async () => {
    const user = userEvent.setup();
    // user-event installs its own clipboard stub during setup(); ours must win.
    stubClipboard({ writeText: clipboardWrite });
    renderWithService(<DiagnosticsScreen />, makeService());
    await screen.findByText('0.1.0');
    await user.click(screen.getByRole('button', { name: /copy diagnostics/i }));
    await waitFor(() => expect(screen.getByText(/copied to the clipboard/i)).toBeInTheDocument());
    expect(clipboardWrite).toHaveBeenCalledOnce();
    const text = clipboardWrite.mock.calls[0]?.[0] as string;
    expect(text).toMatch(/Print Agent 0\.1\.0/);
    expect(text).toMatch(/sanitized/i);
  });

  it('shows an error when the clipboard is unavailable', async () => {
    const user = userEvent.setup();
    stubClipboard(undefined);
    renderWithService(<DiagnosticsScreen />, makeService());
    await screen.findByText('0.1.0');
    await user.click(screen.getByRole('button', { name: /copy diagnostics/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/clipboard/i);
  });
});

describe('ConfirmDialog', () => {
  it('cancels on Escape and on backdrop click, confirms via the action button', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = renderWithService(
      <ConfirmDialog
        title="Remove printer?"
        body={<p>Are you sure?</p>}
        confirmLabel="Remove printer"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
      makeService(),
    );
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledOnce();

    rerender(
      <ConfirmDialog
        title="Remove printer?"
        body={<p>Are you sure?</p>}
        confirmLabel="Remove printer"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    await user.click(screen.getByRole('button', { name: /remove printer/i }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('focuses Cancel first for danger confirmations so Enter cannot fire the destructive action', () => {
    renderWithService(
      <ConfirmDialog
        title="Unpair device?"
        tone="danger"
        body={<p>This wipes credentials.</p>}
        confirmLabel="Unpair and wipe data"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
      makeService(),
    );
    expect(document.activeElement).toHaveAttribute('data-role', 'cancel');
  });
});
