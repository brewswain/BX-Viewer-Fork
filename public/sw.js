/**
 * BounceX Viewer: service worker kill switch.
 *
 * The old worker served pages, CSS and API reads cache-first, so every change
 * needed a hard refresh. The app no longer registers a worker, but browsers that
 * installed the old one keep running it until it is replaced. A browser rechecks
 * this file on navigation, installs this stub, and the stub wipes the caches,
 * unregisters itself and reloads its open tabs so they load straight from the
 * network. It has no fetch handler, so nothing is intercepted meanwhile.
 *
 * Delete this file (and the /sw.js headers in next.config.ts) once every machine
 * that ran the old worker has loaded the app once.
 */

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.map((key) => caches.delete(key)))
      await self.registration.unregister()
      const clients = await self.clients.matchAll({ type: 'window' })
      for (const client of clients) client.navigate(client.url)
    })(),
  )
})
