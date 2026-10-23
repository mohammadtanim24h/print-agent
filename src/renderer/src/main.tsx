import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ServiceProvider } from './services/service-context';
import { createProductionService } from './services/production-service';
import './app.css';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('missing #root element');
}
// Demo-backed until the cloud/printer/job services land; launch-at-login is
// already real via the validated IPC bridge (see production-service.ts).
createRoot(root).render(
  <StrictMode>
    <ServiceProvider service={createProductionService()}>
      <App />
    </ServiceProvider>
  </StrictMode>,
);
