// Module-SW variant for @chaos-maker/core/sw. Registered with
// `{ type: 'module' }`  -  see sw-module.html for the registration call.
import { installChaosSW } from '/sw-app/chaos-maker-sw.mjs';

installChaosSW();

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/sw-app/sw-api/')) {
    event.respondWith(self.fetch('/api/data.json'));
  }
});
