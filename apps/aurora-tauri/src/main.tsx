import React from 'react'
import { createRoot } from 'react-dom/client'
import '@aurora/ui/styles.css'
import './styles.css'
import { AuroraTauriApp } from './tauri-app'

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <AuroraTauriApp />
  </React.StrictMode>
)
