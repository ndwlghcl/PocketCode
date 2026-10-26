import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { AppearanceProvider } from './app/Appearance';
import './app/theme.css';
import './app/nightfall.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root container missing in index.html');
}

createRoot(container).render(
  <StrictMode>
    <AppearanceProvider><App /></AppearanceProvider>
  </StrictMode>,
);
