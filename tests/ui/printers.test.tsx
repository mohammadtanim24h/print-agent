import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
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

  it('collects role, paper width, capabilities and endpoint in the add form', async () => {
    const user = userEvent.setup();
    const service = makeService();
    renderWithService(<PrintersScreen />, service);
    await user.click(await screen.findByRole('button', { name: /add printer/i }));
    const dialog = screen.getByRole('dialog');

    await user.type(within(dialog).getByLabelText(/name/i), 'Fry-1');
    await user.selectOptions(within(dialog).getByDisplayValue('kitchen'), 'bar');
    await user.type(within(dialog).getByPlaceholderText('192.168.1.87'), '192.168.1.55');

    // Paper width drives printableDots/charsPerLine defaults (still editable).
    const widthSelect = within(dialog).getByLabelText(/paper width/i);
    expect(widthSelect).toHaveValue('80');
    await user.selectOptions(widthSelect, '58');
    expect(within(dialog).getByDisplayValue('384')).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue('32')).toBeInTheDocument();

    // Capabilities: five checkboxes, toggled individually.
    const checkboxes = within(dialog).getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(5);
    expect(within(dialog).getByRole('checkbox', { name: /auto cut/i })).toBeChecked();
    await user.click(within(dialog).getByRole('checkbox', { name: /auto cut/i }));
    expect(within(dialog).getByRole('checkbox', { name: /auto cut/i })).not.toBeChecked();

    await user.click(within(dialog).getByRole('button', { name: /add printer/i }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const printers = await service.getPrinters();
    expect(printers).toHaveLength(4);
    const added = printers.find((p) => p.config.name === 'Fry-1');
    expect(added?.config).toMatchObject({
      role: 'bar',
      paperWidthMm: 58,
      printableDots: 384,
      charsPerLine: 32,
      transport: { kind: 'tcp_raw', host: '192.168.1.55', port: 9100 },
    });
    expect(added?.config.capabilities.cut).toBe(false);
    expect(added?.config.capabilities.qrCode).toBe(true);
  });

  it('prefills every field when editing an existing printer', async () => {
    const user = userEvent.setup();
    const service = makeService();
    renderWithService(<PrintersScreen />, service);
    const kitchenRow = await screen.findByText('Kitchen-1');
    const row = kitchenRow.closest('li');
    const editBtn = Array.from(row?.querySelectorAll('button') ?? []).find((b) =>
      /^edit$/i.test(b.textContent),
    );
    await user.click(editBtn as HTMLElement);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText(/name/i)).toHaveValue('Kitchen-1');
    expect(within(dialog).getByDisplayValue('kitchen')).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/paper width/i)).toHaveValue('80');
    expect(within(dialog).getByDisplayValue('576')).toBeInTheDocument(); // dots
    expect(within(dialog).getByDisplayValue('48')).toBeInTheDocument(); // chars/line
    expect(within(dialog).getByRole('checkbox', { name: /auto cut/i })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: /cash drawer/i })).not.toBeChecked();
    expect(within(dialog).getByPlaceholderText('192.168.1.87')).toHaveValue('192.168.1.87');
  });

  it('surfaces store-schema validation errors without closing the dialog', async () => {
    const user = userEvent.setup();
    const service = makeService({
      // The real bridge validates the draft against PrinterDraftSchema in the
      // printer store; the fake stands in for that rejection.
      addPrinter: () =>
        Promise.reject(new Error('host must be an IPv4 or IPv6 literal (no hostnames)')),
    });
    renderWithService(<PrintersScreen />, service);
    await user.click(await screen.findByRole('button', { name: /add printer/i }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/name/i), 'Bad-1');
    await user.type(within(dialog).getByPlaceholderText('192.168.1.87'), 'printer.local');
    await user.click(within(dialog).getByRole('button', { name: /add printer/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('IPv4 or IPv6');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(await service.getPrinters()).toHaveLength(3);
  });
});
