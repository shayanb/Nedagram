import { render } from 'preact';
import { signal } from '@preact/signals';
import { App } from './app';
import './index.css';

// Signal to track when a new SW version is available
export const swUpdateAvailable = signal<ServiceWorker | null>(null);

// Function to apply the update (skip waiting and reload)
export function applySwUpdate() {
  const waiting = swUpdateAvailable.value;
  if (waiting) {
    waiting.postMessage({ type: 'SKIP_WAITING' });
  }
}

// Register service worker with update detection
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js');
      console.log('[App] SW registered');

      // Check for updates on registration
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (!newWorker) return;

        console.log('[App] New SW installing...');

        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // New version available, waiting to activate
            console.log('[App] New version available!');
            swUpdateAvailable.value = newWorker;
          }
        });
      });

      // If there's already a waiting worker, show update prompt
      if (registration.waiting) {
        console.log('[App] SW already waiting');
        swUpdateAvailable.value = registration.waiting;
      }

      // Listen for controller change (new SW took over) - reload to get fresh content
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return;
        refreshing = true;
        console.log('[App] Controller changed, reloading...');
        window.location.reload();
      });

      // Periodically check for updates (every 60 minutes)
      setInterval(() => {
        registration.update().catch(() => {});
      }, 60 * 60 * 1000);

    } catch (err) {
      console.warn('[App] SW registration failed:', err);
    }
  });
}

render(<App />, document.getElementById('app')!);
