import React from 'react'
import { createRoot } from 'react-dom/client'
import '@aurora/ui/styles.css'
import './styles.css'
import { AuroraTauriApp } from './tauri-app'

const root = document.getElementById('root') as HTMLElement

if (import.meta.env.VITE_AURORA_EVENTSTREAM_SMOKE === '1') {
  void import('./eventstream-smoke').then(({ mountEventStreamSmoke }) => {
    mountEventStreamSmoke(root)
  })
} else {
  createRoot(root).render(
    <React.StrictMode>
      <AuroraTauriApp />
    </React.StrictMode>
  )
}
