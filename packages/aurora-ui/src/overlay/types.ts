import type { ReactNode } from 'react'

export type AuroraOverlayMode = 'hidden' | 'voice' | 'text'

export type AuroraVoiceOverlayState =
  | 'listening'
  | 'processing'
  | 'speaking'
  | 'muted'
  | 'error'

export type AuroraOverlayLevel = {
  level: number
  peak?: number
  bars?: number[]
  source: 'input' | 'output' | 'synthetic'
}

export type AuroraOverlayMessage = {
  id: string
  role: 'user' | 'assistant'
  text: ReactNode
}

export type AuroraOverlayDragOffset = {
  x: number
  y: number
}
