'use client'

import { useEffect } from 'react'

export function PwaRegistration() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    if (!window.isSecureContext && !/^localhost$|^127\.0\.0\.1$/u.test(window.location.hostname)) return
    const controller = new AbortController()
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => undefined)
    window.addEventListener('beforeunload', () => controller.abort(), { signal: controller.signal })
    return () => controller.abort()
  }, [])
  return null
}
