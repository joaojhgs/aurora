const CACHE_NAME = 'aurora-web-shell-v1'
const SHELL_URLS = ['/manifest.webmanifest', '/icons/aurora.svg']
const CACHEABLE_PATH_RE = /^(?:\/manifest\.webmanifest|\/icons\/aurora\.svg|\/_next\/static\/)/u
const NEVER_CACHE_PATH_RE = /^(?:\/api\/|\/_next\/data\/)|\.(?:onnx|ort|pt|pth|bin|safetensors|gguf|tflite|tar|bz2|gz|zip|map)$/iu

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (request.mode === 'navigate' || NEVER_CACHE_PATH_RE.test(url.pathname) || !CACHEABLE_PATH_RE.test(url.pathname)) return

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached
      return fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => undefined)
        }
        return response
      })
    })
  )
})
