// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { LocalInferenceSettingsView } from '../src/local-inference-settings-view'
import { getAuroraSurfaceProfile } from '../src/platform-surface'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('downloads offline answers before the user turns them on', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const onEnabledChange = vi.fn(async () => {})
  const client = {
    modelStatus: vi.fn(async () => ({ modelId: 'chat-qwen3-0b8', state: 'absent' as const })),
    downloadModel: vi.fn(async () => ({ modelId: 'chat-qwen3-0b8', state: 'ready' as const, bytesOnDisk: 563036064 })),
    deleteModel: vi.fn(async () => ({ modelId: 'chat-qwen3-0b8', state: 'absent' as const })),
  }
  try {
    await act(async () => root.render(<LocalInferenceSettingsView client={client} modelId="chat-qwen3-0b8" enabled={false} onEnabledChange={onEnabledChange} />))
    const download = [...container.querySelectorAll('button')].find(button => button.textContent === 'Download offline answers')
    expect(download).toBeDefined()
    await act(async () => download?.click())
    expect(client.downloadModel).toHaveBeenCalledWith('chat-qwen3-0b8')
    expect(onEnabledChange).not.toHaveBeenCalled()
    const toggle = container.querySelector<HTMLElement>('#offline-assistant-enabled')
    expect(toggle).not.toBeNull()
    expect(toggle?.hasAttribute('disabled')).toBe(false)
    await act(async () => toggle?.click())
    expect(onEnabledChange).toHaveBeenCalledWith(true)
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})

it('offers native offline preparation on Android and iOS through the shared surface policy', () => {
  for (const nativePlatform of ['android', 'ios'] as const) {
    const surface = getAuroraSurfaceProfile({ runtimeMode: 'mobile-native', nativePlatform, nodeMode: 'mesh-node', runtimeTier: 'lightweight-ts', enabledCapabilityPacks: ['local-inference'] })
    expect(surface.canManageLocalAssistant).toBe(true)
    expect(surface.localInferenceEnabled).toBe(true)
  }
  for (const runtimeMode of ['desktop-local', 'desktop-thin', 'web-thin'] as const) {
    const surface = getAuroraSurfaceProfile({ runtimeMode, nodeMode: 'mesh-node', runtimeTier: 'lightweight-ts', enabledCapabilityPacks: ['local-inference'] })
    expect(surface.canManageLocalAssistant).toBe(false)
    expect(surface.localInferenceEnabled).toBe(false)
  }
})
