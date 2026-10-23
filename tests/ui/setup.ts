import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';

// React 19 requires an explicit act() environment for component tests.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Vitest globals are off, so RTL cannot auto-register cleanup itself.
afterEach(() => {
  cleanup();
});
