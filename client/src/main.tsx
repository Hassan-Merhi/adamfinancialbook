import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { LanguageProvider } from './i18n';
import { initializeOfflineStorage } from './offline';
import { installOfflineExitGuards } from './offline-exit-guard';
import { installOfflineLiveRecovery } from './offline-live-recovery';
import { installLiveMutationBridge } from './live-refresh';
import { installIosPullToRefresh } from './ios-pull-refresh';
import { installSessionQuarantine } from './session-quarantine';
import { installFormAccessibility } from './form-a11y';
import './multilingual-offline';

// Apply an explicit appearance before React renders so returning users do not
// get a flash of the opposite theme. System preference remains the default.
try {
  const savedTheme = localStorage.getItem('book.theme');
  if (savedTheme === 'light' || savedTheme === 'dark') {
    document.documentElement.setAttribute('data-theme', savedTheme);
  }
} catch { /* private mode */ }

// Every successful write emits one small in-app event. App.tsx uses it to
// revalidate only the affected snapshots, so older screens that own their own
// request helper still update the rest of the app without polling or reloading.
installLiveMutationBridge();

// On touch phones, a downward pull from the very top refreshes the same book +
// dashboard snapshots in the background instead of forcing a full Safari page
// reload. This also works when the site is installed to the iOS home screen.
installIosPullToRefresh();

// Older forms consistently render visible labels, but some predate explicit
// htmlFor/id wiring. Keep those controls screen-reader named even when lazy
// views or conditional admin sections mount later.
installFormAccessibility();

// Installed to the home screen, the app must still open with no signal.
// This lives here rather than inline in the page: the Content-Security-Policy
// allows scripts from this origin only, and an inline one would be refused.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

async function boot() {
  // IndexedDB must be hydrated before App reads the last user, snapshot or
  // outbox. This also performs the one-time migration from the old global
  // localStorage keys into the correct user scope.
  await initializeOfflineStorage();
  await installOfflineExitGuards();

  // Wrap the live fetch bridge only after IndexedDB is ready. A protected 401
  // can then quarantine the cached offline identity before the response reaches
  // the UI, while preserving the user's durable per-user outbox for later
  // authenticated recovery.
  installSessionQuarantine();

  // A long mobile suspension can delay retry timers without producing a clean
  // offline/online transition. Live recovery nudges the same single-flight
  // durable outbox when the transport reconnects or the app resumes.
  installOfflineLiveRecovery();

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <LanguageProvider>
        <App />
      </LanguageProvider>
    </StrictMode>,
  );
}

void boot();
