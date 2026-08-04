const CACHE_NAME = 'bx-video-v1785879764'
/**
 * BounceX Viewer – Service Worker
 *
 * Video byte-range requests (seeking, moov discovery, buffering) pass straight
 * through to the network. The browser and server handle these natively — any SW
 * interception of Range requests corrupts the responses and breaks seeking.
 *
 * Non-range requests (settings, manifests, first metadata load) are cached
 * normally so the app works offline and loads faster on repeat visits.
 */


function isVideoRequest(url) {
  try {
    const u = new URL(url)
    const path = u.pathname
    if (!path.includes('/videos/')) return false
    return /\.(mp4|webm|mkv|m4v)(\?|$)/i.test(path)
  } catch {
    return false
  }
}

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter((key) => key !== CACHE_NAME)
              .map((key) => caches.delete(key)),
          ),
        ),
    ]),
  )
})

function isMutableRequest(url) {
  // These files are frequently updated — always fetch fresh.
  try {
    const path = new URL(url).pathname
    return (
      path.endsWith('/manifest.json') ||
      path.endsWith('/meta.json') ||
      path.endsWith('.bx') ||
      path.endsWith('.js')
    )
  } catch {
    return false
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  // Pass ALL video requests straight through — Range or not.
  // Caching a 10+ GB non-range response clones the entire response body,
  // which stalls the stream the browser is reading for moov atom discovery.
  if (isVideoRequest(request.url)) return

  // manifest.json and meta.json must always be fresh so manager changes
  // show immediately without a hard refresh.
  if (isMutableRequest(request.url)) {
    event.respondWith(fetch(request).catch(() => caches.match(request)))
    return
  }

  // Non-video requests are safe to cache normally.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME)
      const cached = await cache.match(request)
      if (cached) return cached

      const response = await fetch(request)
      if (!response.ok) return response

      try {
        cache.put(request, response.clone())
      } catch (_) {}
      return response
    })(),
  )
})
