import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OverviewScreen } from '../../src/renderer/src/ui/screens/OverviewScreen';
import { makeService, renderWithService } from './helpers';

const never = (): Promise<never> => new Promise(() => undefined);

describe('OverviewScreen', () => {
  it('shows a loading state while data is in flight', () => {
    renderWithService(
      <OverviewScreen onNavigate={() => undefined} />,
      makeService({ getSnapshot: never }),
    );
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('shows an error banner with retry when the snapshot fails', async () => {
    const user = userEvent.setup();
    renderWithService(
      <OverviewScreen onNavigate={() => undefined} />,
      makeService({ getSnapshot: () => Promise.reject(new Error('backend exploded')) }),
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('backend exploded');
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /retry/i }));
    // Reload keeps the screen mounted without throwing.
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });

  it('shows the unpaired empty state and routes to setup', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const service = makeService();
    await service.unpair();
    renderWithService(<OverviewScreen onNavigate={onNavigate} />, service);
    expect(await screen.findByText(/not paired yet/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /open setup/i }));
    expect(onNavigate).toHaveBeenCalledWith('setup');
  });

  it('renders connection, identity, printer health and recent jobs when paired', async () => {
    renderWithService(<OverviewScreen onNavigate={() => undefined} />, makeService());
    expect(await screen.findByText('Trattoria Bella (demo)')).toBeInTheDocument();
    // Connection pill + demo badge (honesty: mock data is labelled).
    expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(screen.getByText(/demo data/i)).toBeInTheDocument();
    // Printer health uses wording, not just color.
    expect(screen.getByText('Paper low')).toBeInTheDocument();
    expect(screen.getByText('Offline')).toBeInTheDocument();
    // Recent jobs list present with a completed job.
    expect(screen.getAllByText('Kitchen ticket').length).toBeGreaterThan(0);
  });

  it('shows an empty state when there are no jobs', async () => {
    const service = makeService({ getJobs: () => Promise.resolve([]) });
    renderWithService(<OverviewScreen onNavigate={() => undefined} />, service);
    expect(await screen.findByText(/no print jobs yet/i)).toBeInTheDocument();
  });

  it('surfaces ambiguous jobs as needing attention with a link to job history', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    renderWithService(<OverviewScreen onNavigate={onNavigate} />, makeService());
    expect(await screen.findByText(/needs attention/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /review in job history/i }));
    expect(onNavigate).toHaveBeenCalledWith('jobs');
  });
});
