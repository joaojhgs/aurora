import React from 'react'
import { createRoot } from 'react-dom/client'
import '@aurora/ui/styles.css'
import './styles.css'
import { AuroraOverlayApp } from './overlay-app'
import { AuroraTauriApp } from './tauri-app'

const root = document.getElementById('root') as HTMLElement
const isOverlaySurface = new URLSearchParams(window.location.search).get('surface') === 'overlay' || window.location.hash.includes('overlay')

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
