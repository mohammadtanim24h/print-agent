import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JobHistoryScreen } from '../../src/renderer/src/ui/screens/JobHistoryScreen';
import { makeService, renderWithService } from './helpers';

function findRow(label: RegExp): HTMLLIElement {
  const matches = screen.getAllByText(label);
  const text = matches[0]?.closest('li');
  expect(text).not.toBeNull();
  return text as HTMLLIElement;
}

async function clickRowButton(row: HTMLLIElement, name: RegExp): Promise<void> {
  const user = userEvent.setup();
  const button = within(row).getByRole('button', { name });
  await user.click(button);
}

describe('JobHistoryScreen', () => {
  it('renders jobs with statuses, destinations and error details', async () => {
    renderWithService(<JobHistoryScreen />, makeService());
    expect((await screen.findAllByText('Kitchen ticket')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Customer receipt').length).toBeGreaterThan(0);
    expect(screen.getByText(/transport_timeout/)).toBeInTheDocument();
  });

  it('offers retry only for failed jobs', async () => {
    renderWithService(<JobHistoryScreen />, makeService());
    await screen.findByText(/transport_timeout/);
    const failedRow = findRow(/transport_timeout/);
    within(failedRow).getByRole('button', { name: /retry/i });
    const completedRow = findRow(/Kitchen ticket/);
    expect(within(completedRow).queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('offers reprint only for completed and ambiguous jobs', async () => {
    renderWithService(<JobHistoryScreen />, makeService());
    await screen.findByText(/transport_timeout/);
    within(findRow(/Kitchen ticket/)).getByRole('button', { name: /reprint/i });
    const ambiguousRow = findRow(/Outcome unknown/);
    within(ambiguousRow).getByRole('button', { name: /reprint/i });
    const failedRow = findRow(/transport_timeout/);
    expect(within(failedRow).queryByRole('button', { name: /reprint/i })).toBeNull();
  });

  it('requires confirmation for retry and cancels safely', async () => {
    const user = userEvent.setup();
    const service = makeService();
    renderWithService(<JobHistoryScreen />, service);
    await screen.findByText(/transport_timeout/);
    await clickRowButton(findRow(/transport_timeout/), /retry/i);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toMatch(/retry/i);
    expect(dialog.textContent).toMatch(/duplicate/i);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    const jobs = await service.getJobs();
    expect(jobs.find((j) => j.jobId === 'job-1005')?.attempts).toBe(3);
  });

  it('retries a failed job after confirmation and shows the new status', async () => {
    const user = userEvent.setup();
    const service = makeService();
    renderWithService(<JobHistoryScreen />, service);
    await screen.findByText(/transport_timeout/);
    await clickRowButton(findRow(/transport_timeout/), /retry/i);
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: /retry job/i }),
    );
    const note = await screen.findByRole('status');
    expect(note.textContent).toMatch(/re-sent/i);
    const jobs = await service.getJobs();
    const retried = jobs.find((j) => j.jobId === 'job-1005');
    expect(retried?.status).toBe('completed');
    expect(retried?.attempts).toBe(4);
  });

  it('warns about duplicate risk when reprinting an ambiguous job', async () => {
    const user = userEvent.setup();
    const service = makeService();
    renderWithService(<JobHistoryScreen />, service);
    await screen.findByText(/transport_timeout/);
    await clickRowButton(findRow(/Outcome unknown/), /reprint/i);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toMatch(/DUPLICATE banner/);
    expect(dialog.textContent).toMatch(/may have already printed/);
    await user.click(within(dialog).getByRole('button', { name: /reprint \(marked duplicate\)/i }));
    await screen.findByRole('status');
    const jobs = await service.getJobs();
    const reprint = jobs.find((j) => j.idempotencyKey.includes('#reprint-'));
    expect(reprint?.status).toBe('completed');
  });

  it('filters jobs by status', async () => {
    const user = userEvent.setup();
    renderWithService(<JobHistoryScreen />, makeService());
    await screen.findByText(/transport_timeout/);
    await user.click(screen.getByRole('tab', { name: 'Needs attention' }));
    expect(screen.getByText(/transport_timeout/)).toBeInTheDocument();
    expect(screen.queryByText('Customer receipt')).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Sent to printer' }));
    expect(screen.getAllByText('Kitchen ticket').length).toBeGreaterThan(0);
    expect(screen.queryByText(/transport_timeout/)).toBeNull();
  });

  it('explains that sent-to-printer is not a print confirmation', () => {
    renderWithService(<JobHistoryScreen />, makeService());
    const info = document.querySelector('.banner-info');
    expect(info?.textContent).toMatch(/cannot see whether/i);
    expect(info?.textContent).toMatch(/check the printer/i);
  });

  it('shows an empty state when there are no jobs at all', async () => {
    const service = makeService({ getJobs: () => Promise.resolve([]) });
    renderWithService(<JobHistoryScreen />, service);
    expect(await screen.findByText(/no jobs yet/i)).toBeInTheDocument();
  });

  it('shows a filter-specific empty state', async () => {
    const user = userEvent.setup();
    // Seed jobs that contain no failed entries, so the "Failed" filter is empty.
    const jobs = (await makeService().getJobs()).filter((j) => j.status !== 'failed');
    const service = makeService({ getJobs: () => Promise.resolve(jobs) });
    renderWithService(<JobHistoryScreen />, service);
    await screen.findAllByText(/Kitchen ticket/);
    await user.click(screen.getByRole('tab', { name: 'Failed' }));
    expect(screen.getByText(/nothing matches this filter/i)).toBeInTheDocument();
  });
});
