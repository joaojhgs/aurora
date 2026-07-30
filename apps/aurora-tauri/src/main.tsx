import './legacy-webview-polyfills'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { getAuroraSurfaceProfile } from '@aurora/ui'
import '@aurora/ui/styles.css'
import './styles.css'
import { installDesktopLiveE2eHook } from './desktop-live-e2e'
import { AuroraOverlayApp } from './overlay-app'
import { AuroraTauriApp } from './tauri-app'

const root = document.getElementById('root') as HTMLElement
const isOverlaySurface = new URLSearchParams(window.location.search).get('surface') === 'overlay' || window.location.hash.includes('overlay')
const surfaceProfile = getAuroraSurfaceProfile({
  runtimeMode: import.meta.env.VITE_AURORA_RUNTIME_MODE,
  userAgent: window.navigator.userAgent,
})

document.documentElement.dataset.auroraPlatform = surfaceProfile.kind
document.body.dataset.auroraPlatform = surfaceProfile.kind
installDesktopLiveE2eHook()

if (isOverlaySurface) {
  document.documentElement.classList.add('aurora-overlay-surface')
  document.documentElement.dataset.auroraSurface = 'overlay'
  document.body.classList.add('aurora-overlay-surface')
  document.body.dataset.auroraSurface = 'overlay'
}

if (import.meta.env.VITE_AURORA_EVENTSTREAM_SMOKE === '1') {
  void import('./eventstream-smoke').then(({ mountEventStreamSmoke }) => {
    mountEventStreamSmoke(root)
  })
} else {
  createRoot(root).render(
    <React.StrictMode>
      {isOverlaySurface ? <AuroraOverlayApp /> : <AuroraTauriApp />}
    </React.StrictMode>
  )
}
