// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { emptyAuroraNodeConfigDocumentV2, TauriLocalTransport, type AuroraNodeConfigDocumentV2 } from '@aurora/client'
import { getAuroraSurfaceProfile, type AuroraSurfaceProfile } from './platform-surface'
import type { RouteAvailability } from './shell-data'
import {
  nativeSpeechPolicyAvailable,
  resolveNativeSpeechRoutePolicy,
  routingForSpeechChoice,
  speechRoutingChoice,
  useNativeSpeechPolicy,
  type NativeSpeechPolicyController,
} from './native-speech-policy'

const roots: Root[] = []
let originalDocumentTokenDescriptor: PropertyDescriptor | undefined

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount() })
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  if (originalDocumentTokenDescriptor) {
    Object.defineProperty(window, '__AURORA_NODE_CONFIG_DOCUMENT_TOKEN__', originalDocumentTokenDescriptor)
  } else {
    Reflect.deleteProperty(window, '__AURORA_NODE_CONFIG_DOCUMENT_TOKEN__')
  }
  originalDocumentTokenDescriptor = undefined
})

describe('native speech policy routing', () => {
  it('keeps transcription and spoken-reply choices independent', () => {
    const config = emptyAuroraNodeConfigDocumentV2(1)
    config.speech.stages.stt.routing = { prefer: 'network_only', fallback: 'error' }
    config.speech.stages.tts.routing = { prefer: 'local_only', fallback: 'error' }
    const surface = localSurface()
    const route = speechRoute()

    const stt = resolveNativeSpeechRoutePolicy({ config, stage: 'stt', route, surface })
    const tts = resolveNativeSpeechRoutePolicy({ config, stage: 'tts', route, surface })

    expect(stt.peerId).toBe('peer-a')
    expect(stt.providerId).toBe('remote:peer-a:transcription')
    expect(tts.peerId).toBeNull()
    expect(tts.providerId).toBeNull()
    expect(speechRoutingChoice(config.speech.stages.stt)).toBe('network_only')
    expect(routingForSpeechChoice('local_first')).toEqual({ prefer: 'local', fallback: 'network' })
  })

  it('requires the central native-shell and local-ownership capabilities', () => {
    expect(nativeSpeechPolicyAvailable(localSurface())).toBe(true)
    expect(nativeSpeechPolicyAvailable({
      ...localSurface(),
      ownsLocalNodeState: false,
    })).toBe(false)
    expect(nativeSpeechPolicyAvailable({
      ...localSurface(),
      usesNativeShell: false,
    })).toBe(false)
  })

  it('allows native mesh nodes to own speech settings without a local sidecar', () => {
    const profiles = [
      getAuroraSurfaceProfile({ transportKind: 'native-mobile', nativePlatform: 'android', nodeMode: 'mesh-node' }),
      getAuroraSurfaceProfile({ transportKind: 'native-mobile', nativePlatform: 'ios', nodeMode: 'mesh-node' }),
      getAuroraSurfaceProfile({ runtimeMode: 'desktop-thin', transportKind: 'tauri-thin', nodeMode: 'mesh-node' }),
    ]

    for (const profile of profiles) {
      expect(profile.canManageLocalServiceConfiguration).toBe(false)
      expect(profile.canManageNativeSpeechPolicy).toBe(true)
      expect(nativeSpeechPolicyAvailable(profile)).toBe(true)
    }
  })

  it('saves background transcription separately from Android capture status', async () => {
    originalDocumentTokenDescriptor = Object.getOwnPropertyDescriptor(window, '__AURORA_NODE_CONFIG_DOCUMENT_TOKEN__')
    Object.defineProperty(window, '__AURORA_NODE_CONFIG_DOCUMENT_TOKEN__', {
      configurable: true,
      value: 'e'.repeat(64),
    })
    let stored = emptyAuroraNodeConfigDocumentV2(1)
    let microphonePermission: 'granted' | 'not_requested' = 'not_requested'
    const nativeInvoke = vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
      if (command === 'aurora_node_config_policy_read') {
        return {
          documentJson: JSON.stringify(stored),
          draftHandle: 'f'.repeat(64),
        }
      }
      if (command === 'aurora_node_config_policy_compare_and_swap') {
        expect(args.expectedRevision).toBe(stored.revision)
        stored = JSON.parse(args.draftJson as string) as AuroraNodeConfigDocumentV2
        return { documentJson: JSON.stringify(stored), savedRevision: stored.revision }
      }
      if (command === 'requestAndroidPermission') {
        microphonePermission = 'granted'
        return { started: true, permission: 'microphone' }
      }
      throw new Error(`unexpected native command: ${command}`)
    })
    vi.stubGlobal('__TAURI__', { core: { invoke: nativeInvoke } })

    const pollTick: { current: (() => void) | null } = { current: null }
    let pollTimer: number | null = null
    const nativeSetTimeout = window.setTimeout.bind(window)
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(window, 'setTimeout')
    window.setTimeout = ((handler: TimerHandler, timeout?: number) => {
      const handle = nativeSetTimeout(handler, timeout)
      if (timeout === 5_000 && typeof handler === 'function') {
        pollTick.current = handler as () => void
        pollTimer = handle
      }
      return handle
    }) as typeof window.setTimeout

    const liveFacts = () => ({
      capability: 'supported' as const,
      permission: microphonePermission,
      foreground: false,
      sttAvailable: true,
      archiveAvailable: true,
      captureMode: null,
      state: 'idle' as const,
      reason: microphonePermission === 'not_requested' ? 'permission_required' : null,
    })
    let includeTranscriptionStatus = true
    let holdNextStatusRead = false
    const pendingStatusRead: { current: ((value: Awaited<ReturnType<TauriLocalTransport['getAndroidVoiceForegroundServiceStatus']>>) => void) | null } = { current: null }
    const sync = vi.fn(async () => ({ transcription: liveFacts() }) as Awaited<ReturnType<TauriLocalTransport['synchronizeAndroidBackgroundTranscription']>>)
    const originalSynchronize = TauriLocalTransport.prototype.synchronizeAndroidBackgroundTranscription
    Object.defineProperty(TauriLocalTransport.prototype, 'synchronizeAndroidBackgroundTranscription', {
      configurable: true,
      value: sync,
    })
    const originalStatus = TauriLocalTransport.prototype.getAndroidVoiceForegroundServiceStatus
    TauriLocalTransport.prototype.getAndroidVoiceForegroundServiceStatus = async () => {
      if (holdNextStatusRead) {
        holdNextStatusRead = false
        return new Promise((resolve) => { pendingStatusRead.current = resolve })
      }
      return (includeTranscriptionStatus
        ? { transcription: liveFacts() }
        : {}) as Awaited<ReturnType<typeof originalStatus>>
    }

    try {
      const policyRef: { current: NativeSpeechPolicyController | null } = { current: null }
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      roots.push(root)
      const android = getAuroraSurfaceProfile({ transportKind: 'native-mobile', nativePlatform: 'android', nodeMode: 'mesh-node' })
      await act(async () => {
        root.render(createElement(PolicyHarness, { scopeKey: 'android-profile-a', surface: android, onPolicy: (value) => { policyRef.current = value } }))
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      if (!policyRef.current) throw new Error('Speech policy hook did not mount')
      expect(policyRef.current!.backgroundTranscription).toMatchObject({
        enabled: false,
        ambient: false,
        notification: false,
        retentionDays: 30,
      })
      expect(policyRef.current!.backgroundTranscriptionStatus.captureState).toBe('idle')
      expect(policyRef.current!.backgroundTranscriptionStatus.reason).toBe('permission_required')
      expect(policyRef.current!.backgroundTranscriptionStatus.policyState?.recording).toBe(false)
      expect(sync).toHaveBeenCalledTimes(1)

      await act(async () => {
        policyRef.current!.changeBackgroundTranscription({ ambient: true, retentionDays: 90 })
      })
      expect(policyRef.current!.backgroundTranscriptionStatus.captureState).toBe('idle')

      holdNextStatusRead = true
      if (!pollTick.current || pollTimer === null) throw new Error('Android status poll was not scheduled')
      window.clearTimeout(pollTimer)
      await act(async () => {
        pollTick.current?.()
        await Promise.resolve()
      })
      expect(pendingStatusRead.current).not.toBeNull()

      await act(async () => { await policyRef.current!.save() })
      expect(stored.backgroundTranscription).toMatchObject({ enabled: true, ambient: true, notification: false, retentionDays: 90 })
      expect(sync).toHaveBeenCalledTimes(2)
      expect(policyRef.current!.backgroundTranscriptionStatus.captureState).toBe('idle')
      expect(policyRef.current!.backgroundTranscriptionStatus.policyState?.ambientRequested).toBe(true)
      expect(policyRef.current!.backgroundTranscriptionStatus.policyState?.recording).toBe(false)
      const resolvePendingStatusRead = pendingStatusRead.current
      pendingStatusRead.current = null
      if (!resolvePendingStatusRead) throw new Error('Pending Android status read was lost')
      await act(async () => {
        resolvePendingStatusRead({
          transcription: { ...liveFacts(), permission: 'not_requested', state: 'listening', captureMode: 'ambient' },
        } as Awaited<ReturnType<typeof originalStatus>>)
        await Promise.resolve()
      })
      expect(policyRef.current!.backgroundTranscriptionStatus.captureState).toBe('idle')
      expect(policyRef.current!.backgroundTranscriptionStatus.policyState?.recording).toBe(false)

      await act(async () => { policyRef.current!.changeBackgroundTranscription({ notification: true, retentionDays: 90 }) })
      await act(async () => {
        root.render(createElement(PolicyHarness, {
          scopeKey: 'android-profile-a',
          surface: getAuroraSurfaceProfile({ transportKind: 'native-mobile', nativePlatform: 'android', nodeMode: 'mesh-node' }),
          onPolicy: (value) => { policyRef.current = value },
        }))
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(policyRef.current!.backgroundTranscription).toMatchObject({ notification: true, ambient: false, retentionDays: 90 })

      await act(async () => { await policyRef.current!.requestMicrophonePermission() })
      expect(nativeInvoke).toHaveBeenCalledWith('requestAndroidPermission', { permission: 'microphone' })
      expect(sync).toHaveBeenCalledTimes(3)
      expect(policyRef.current!.backgroundTranscriptionStatus.facts?.permission).toBe('granted')
      expect(policyRef.current!.backgroundTranscriptionStatus.policyState?.ambientRequested).toBe(true)

      includeTranscriptionStatus = false
      await act(async () => { await policyRef.current!.requestMicrophonePermission() })
      expect(sync).toHaveBeenCalledTimes(3)
      expect(policyRef.current!.backgroundTranscriptionStatus.availability).toBe('unavailable')
      expect(policyRef.current!.backgroundTranscriptionStatus.captureState).toBeNull()
    } finally {
      if (timeoutDescriptor) Object.defineProperty(window, 'setTimeout', timeoutDescriptor)
      else Reflect.deleteProperty(window, 'setTimeout')
      TauriLocalTransport.prototype.synchronizeAndroidBackgroundTranscription = originalSynchronize
      TauriLocalTransport.prototype.getAndroidVoiceForegroundServiceStatus = originalStatus
    }
  })

  it('rejects stale edits and refreshes other mounted policy views after an acknowledged save', async () => {
    originalDocumentTokenDescriptor = Object.getOwnPropertyDescriptor(window, '__AURORA_NODE_CONFIG_DOCUMENT_TOKEN__')
    Object.defineProperty(window, '__AURORA_NODE_CONFIG_DOCUMENT_TOKEN__', {
      configurable: true,
      value: 'd'.repeat(64),
    })
    const nativeInvoke = vi.fn()
    vi.stubGlobal('__TAURI__', { core: { invoke: nativeInvoke } })
    let stored = emptyAuroraNodeConfigDocumentV2(1)
    const calls: Array<{ command: string; args: Record<string, unknown> }> = []
    nativeInvoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
        calls.push({ command, args })
        if (command === 'aurora_node_config_policy_read') {
          return {
            documentJson: JSON.stringify(stored),
            draftHandle: calls.length.toString(16).padStart(64, '0'),
          }
        }
        if (command === 'aurora_node_config_policy_compare_and_swap') {
          if (args.expectedRevision !== stored.revision) throw new Error('stale revision')
          stored = JSON.parse(args.draftJson as string) as AuroraNodeConfigDocumentV2
          return { documentJson: JSON.stringify(stored), savedRevision: stored.revision }
        }
        throw new Error('unexpected native command')
      })

    const policies: {
      settings: NativeSpeechPolicyController | null
      assistant: NativeSpeechPolicyController | null
    } = { settings: null, assistant: null }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => {
      root.render(createElement('div', null,
        createElement(PolicyHarness, { scopeKey: 'scope-a', surface: localSurface(), onPolicy: (policy) => { policies.settings = policy } }),
        createElement(PolicyHarness, { scopeKey: 'scope-a', surface: localSurface(), onPolicy: (policy) => { policies.assistant = policy } }),
      ))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    if (!policies.settings || !policies.assistant) throw new Error('Speech policy hooks did not mount')
    expect(policies.settings.state).toBe('ready')
    expect(policies.assistant.state).toBe('ready')

    stored = {
      ...stored,
      revision: 2,
      speech: {
        ...stored.speech,
        stages: {
          ...stored.speech.stages,
          stt: { ...stored.speech.stages.stt, routing: { prefer: 'network_only', fallback: 'error' } },
        },
      },
    }
    const readsBeforeStaleSave = calls.filter(({ command }) => command === 'aurora_node_config_policy_read').length
    await act(async () => {
      policies.settings!.changeChoice('stt', 'local_only')
    })
    await act(async () => {
      await policies.settings!.save()
    })
    expect(calls[readsBeforeStaleSave]?.command).toBe('aurora_node_config_policy_compare_and_swap')
    expect(calls[readsBeforeStaleSave]?.args.expectedRevision).toBe(1)
    expect(stored.revision).toBe(2)
    expect(policies.settings!.sttChoice).toBe('network_only')

    await act(async () => {
      policies.settings!.changeChoice('stt', 'local_only')
    })
    await act(async () => {
      await policies.settings!.save()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(stored.speech.stages.stt.routing).toEqual({ prefer: 'local_only', fallback: 'error' })
    expect(policies.assistant!.sttChoice).toBe('local_only')
  })
})

function localSurface(): AuroraSurfaceProfile {
  return {
    usesNativeShell: true,
    ownsLocalNodeState: true,
    canManageLocalServiceConfiguration: true,
    canManageNativeSpeechPolicy: true,
    localSpeechPack: { canRunLocalStt: true, canRunLocalTts: true },
  } as AuroraSurfaceProfile
}

function PolicyHarness({
  scopeKey,
  surface,
  onPolicy,
}: {
  scopeKey: string
  surface: AuroraSurfaceProfile
  onPolicy: (policy: NativeSpeechPolicyController) => void
}) {
  const policy = useNativeSpeechPolicy(surface, scopeKey)
  onPolicy(policy)
  return null
}

function speechRoute(): RouteAvailability {
  return {
    item: { privacyClass: 'personal' },
    state: 'available-local',
    selectorRequired: false,
    approvalRequired: false,
    candidateProviders: [
      {
        id: 'local-transcription',
        providerId: 'local-transcription',
        providerKind: 'local',
        label: 'This device',
        state: 'available-local',
        selectable: true,
        reason: '',
        requiredAction: null,
      },
      {
        id: 'remote:peer-a:transcription',
        providerId: 'remote:peer-a:transcription',
        providerKind: 'remote',
        peerId: 'peer-a',
        serviceInstanceId: 'remote:peer-a:transcription-service',
        label: 'Connected device',
        state: 'available-remote',
        selectable: true,
        reason: '',
        requiredAction: null,
      },
    ],
  } as unknown as RouteAvailability
}
