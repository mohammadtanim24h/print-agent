import type { PrintAgentApi } from '../../preload/index';

declare global {
  interface Window {
    readonly printAgent: PrintAgentApi;
  }
}

export {};
