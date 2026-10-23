import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AgentService } from './agent-service';

const ServiceContext = createContext<AgentService | null>(null);

export function ServiceProvider(props: {
  service: AgentService;
  children: ReactNode;
}): React.JSX.Element {
  return <ServiceContext.Provider value={props.service}>{props.children}</ServiceContext.Provider>;
}

export function useService(): AgentService {
  const service = useContext(ServiceContext);
  if (service === null) {
    throw new Error('useService must be used inside <ServiceProvider>');
  }
  return service;
}

export interface AsyncState<T> {
  readonly data: T | null;
  readonly loading: boolean;
  readonly error: string | null;
  reload: () => void;
}

/**
 * Minimal async data hook: load on mount / deps change, expose reload.
 * Stale responses are ignored (last write wins) so rapid reloads can't
 * interleave out-of-order results.
 */
export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadRef
      .current()
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [...deps, tick]);

  const reload = (): void => {
    setTick((t) => t + 1);
  };

  return { data, loading, error, reload };
}
