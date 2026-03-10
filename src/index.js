import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// ============================================================
// Service Worker Registration
// ============================================================
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/service-worker.js', {
        scope: '/',
      });

      // Check for updates on every load
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        newWorker?.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // New version available — tell SW to skip waiting
            newWorker.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });

      // Reload when a new SW takes control (ensures fresh assets)
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!refreshing) {
          refreshing = true;
          window.location.reload();
        }
      });

      // Handle notification click messages from service worker
      navigator.serviceWorker.addEventListener('message', event => {
        if (event.data?.type === 'NOTIFICATION_CLICK') {
          // App can listen to this via a global event
          window.dispatchEvent(new CustomEvent('ea:notification-click', {
            detail: event.data,
          }));
        }
      });

    } catch (err) {
      console.warn('Service worker registration failed:', err.message);
    }
  });
}

registerServiceWorker();

// ============================================================
// React Root
// ============================================================
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
