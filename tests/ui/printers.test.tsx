import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PrintersScreen } from '../../src/renderer/src/ui/screens/PrintersScreen';
import { makeService, renderWithService } from './helpers';

describe('PrintersScreen', () => {
  it('shows an empty state with an add action when no printers exist', async () => {
    const service = makeService();
    for (const printer of await service.getPrinters()) {
      await service.removePrinter(printer.config.printerId);
    }
    renderWithService(<PrintersScreen />, service);
    expect(await screen.findByText(/no printers configured/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /add printer/i }).length).toBeGreaterThan(0);
  });

  it('lists printers with health wording and transport details', async () => {
    renderWithService(<PrintersScreen />, makeService());
    expect(await screen.findByText('Kitchen-1')).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('Paper low')).toBeInTheDocument();
    expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(screen.getByText(/192\.168\.1\.87:9100/)).toBeInTheDocument();
    // TCP-only transports now (no spooler); the second printer's endpoint shows too.
    expect(screen.getByText(/192\.168\.1\.90:9100/)).toBeInTheDocument();
  });

  it('runs a test print and shows hand-off wording, not a print claim', async () => {
    const user = userEvent.setup();
    const service = makeService();
    renderWithService(<PrintersScreen />, service);
    const kitchenRow = (await screen.findByText('Kitchen-1')).closest('li');
    expect(kitchenRow).not.toBeNull();
    const testBtn = Array.from(kitchenRow?.querySelectorAll('button') ?? []).find((b) =>
      /test print/i.test(b.textContent),
    );
    expect(testBtn).not.toBeUndefined();
    await user.click(testBtn as HTMLElement);
    const banner = await screen.findByRole('status');
    expect(banner.textContent).toMatch(/handed to the printer/i);
    expect(banner.textContent.toLowerCase()).not.toContain('printed successfully');
  });

  it('shows a failure banner when the printer is unreachable', async () => {
    const user = userEvent.setup();
    renderWithService(<PrintersScreen />, makeService());
    const barRow = (await screen.findByText('Bar-1')).closest('li');
    const testBtn = Array.from(barRow?.querySelectorAll('button') ?? []).find((b) =>
      /test print/i.test(b.textContent),
    );
    await user.click(testBtn as HTMLElement);
    const banner = await screen.findByRole('status');
    expect(banner.textContent).toContain('offline');
  });

  it('cancelling remove keeps the printer', async () => {
    const user = userEvent.setup();
    const service = makeService();
    renderWithService(<PrintersScreen />, service);
    const kitchenRow = (await screen.findByText('Kitchen-1')).closest('li');
    const removeBtn = Array.from(kitchenRow?.querySelectorAll('button') ?? []).find((b) =>
      /remove/i.test(b.textContent),
    );
    await user.click(removeBtn as HTMLElement);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('Kitchen-1');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(await service.getPrinters()).toHaveLength(3);
  });

  it('removes a printer after confirmation', async () => {
    const user = userEvent.setup();
    const service = makeService();
    renderWithService(<PrintersScreen />, service);
    const kitchenRow = (await screen.findByText('Kitchen-1')).closest('li');
    const removeBtn = Array.from(kitchenRow?.querySelectorAll('button') ?? []).find((b) =>
      /remove/i.test(b.textContent),
    );
    await user.click(removeBtn as HTMLElement);
    await user.click(screen.getByRole('button', { name: /remove printer/i }));
    await waitFor(() => {
      expect(screen.queryByText('Kitchen-1')).toBeNull();
    });
    expect(await service.getPrinters()).toHaveLength(2);
  });
});
