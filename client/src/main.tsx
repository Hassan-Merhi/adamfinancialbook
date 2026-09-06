import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { LanguageProvider } from './i18n';
import { initializeOfflineStorage } from './offline';
import './multilingual-offline';

// Apply an explicit appearance before React renders so returning users do not
// get a flash of the opposite theme. System preference remains the default.
try {
  const savedTheme = localStorage.getItem('book.theme');
  if (savedTheme === 'light' || savedTheme === 'dark') {
    document.documentElement.setAttribute('data-theme', savedTheme);
  }
} catch { /* private mode */ }

// Installed to the home screen, the app must still open with no signal.
// This lives here rather than inline in the page: the Content-Security-Policy
// allows scripts from this origin only, and an inline one would be refused.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

async function boot() {
  // IndexedDB must be hydrated before App reads the last user, snapshot or
  // outbox.  This also performs the one-time migration from the old global
  // localStorage keys into the correct user scope.
  await initializeOfflineStorage();

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <LanguageProvider>
        <App />
      </LanguageProvider>
    </StrictMode>,
  );
}

void boot();
