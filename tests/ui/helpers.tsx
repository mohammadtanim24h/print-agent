import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { ServiceProvider } from '../../src/renderer/src/services/service-context';
import type { AgentService } from '../../src/renderer/src/services/agent-service';
import { MockAgentService } from '../../src/renderer/src/services/mock-agent-service';

/** Deterministic mock (no latency) with selected methods overridden. */
export function makeService(overrides: Partial<AgentService> = {}): AgentService {
  const base = new MockAgentService({ latencyMs: 0 });
  return Object.assign(base, overrides);
}

export function renderWithService(
  ui: ReactElement,
  service: AgentService,
): ReturnType<typeof render> {
  return render(<ServiceProvider service={service}>{ui}</ServiceProvider>);
}
