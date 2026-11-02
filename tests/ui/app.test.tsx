import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { App } from '../../src/renderer/src/App';
import { makeService, renderWithService } from './helpers';

describe('App', () => {
  it('refreshes the sidebar identity when main pushes a snapshot change', async () => {
    const service = makeService();
    renderWithService(<App />, service);
    expect((await screen.findAllByText('Trattoria Bella (demo)')).length).toBeGreaterThan(0);

    // Simulate an unpair that main performs without the renderer asking
    // (a server-side revoke behaves the same way): state changes behind the
    // UI's back, then the push signal arrives.
    await service.unpair();
    service.emitSnapshotChanged('pairing');

    await waitFor(() => {
      expect(screen.queryAllByText('Trattoria Bella (demo)')).toHaveLength(0);
    });
    expect(screen.getAllByText('Not paired').length).toBeGreaterThan(0);
  });
});
