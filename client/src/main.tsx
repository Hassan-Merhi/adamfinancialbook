import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { LanguageProvider } from './i18n';
import './browser-translation';
import './multilingual-offline';

// Installed to the home screen, the app must still open with no signal.
// This lives here rather than inline in the page: the Content-Security-Policy
// allows scripts from this origin only, and an inline one would be refused.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </StrictMode>,
);
