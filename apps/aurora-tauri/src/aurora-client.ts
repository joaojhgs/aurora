import {
  AuroraClient,
  HttpGatewayTransport,
  MockAuroraTransport,
  TauriLocalTransport,
  type TauriAndroidBaselineStatus,
  type AndroidLocalLightInferenceStatus,
  type TauriIosInvocationStatus,
  type TauriNativeFeatureStatus,
  type TauriNativePermissionStatus,
  type TauriSidecarStatus
} from '@aurora/client'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export interface AuroraTauriRuntime {
  client: AuroraClient
  mode: 'desktop-local' | 'desktop-thin' | 'mock'
  modePreferenceStore?: AuroraModePreferenceStore
  sidecarStatus: () => Promise<TauriSidecarStatus | null>
  startSidecar: () => Promise<TauriSidecarStatus | null>
  stopSidecar: () => Promise<TauriSidecarStatus | null>
  nativePermissionStatus: () => Promise<TauriNativePermissionStatus | null>
  trayStatus: () => Promise<TauriNativeFeatureStatus | null>
  notificationStatus: () => Promise<TauriNativeFeatureStatus | null>
  iosVoiceStatus: () => Promise<TauriNativeFeatureStatus | null>
  iosInvocationStatus: () => Promise<TauriIosInvocationStatus | null>
  iosLocalLightInferenceStatus: () => Promise<AndroidLocalLightInferenceStatus | null>
  iosBackgroundStatus: () => Promise<TauriNativeFeatureStatus | null>
  dialogStatus: () => Promise<TauriNativeFeatureStatus | null>
  audioBridgeStatus: () => Promise<TauriNativeFeatureStatus | null>
  iosSecureStorageStatus: () => Promise<TauriNativeFeatureStatus | null>
  iosBiometricStatus: () => Promise<TauriNativeFeatureStatus | null>
  androidBaselineStatus: () => Promise<TauriAndroidBaselineStatus | null>
  shutdown: () => Promise<void>
}

export interface AuroraModePreferenceStore {
  evidence: string
  readSelectedMode: () => Promise<string | null>
  writeSelectedMode: (modeId: string) => Promise<boolean>
}

const ONBOARDING_MODE_KEY = 'aurora.session.onboarding-mode'

export function createAuroraTauriRuntime(): AuroraTauriRuntime {
  const configuredGatewayUrl = import.meta.env.VITE_AURORA_GATEWAY_URL

  if (isTauriRuntime()) {
    const nativeTransport = new TauriLocalTransport({ invoke, listen })
    if (configuredGatewayUrl) {
      return {
        client: new AuroraClient({
          transport: new HttpGatewayTransport({
            baseUrl: configuredGatewayUrl,
            bearerToken: import.meta.env.VITE_AURORA_GATEWAY_TOKEN
          })
        }),
        mode: 'desktop-thin',
        modePreferenceStore: secureModePreferenceStore(nativeTransport, 'Tauri secure storage for desktop thin mode preference'),
        sidecarStatus: async () => null,
        startSidecar: async () => null,
        stopSidecar: async () => null,
        nativePermissionStatus: () => nativeTransport.getNativePermissionStatus(),
        trayStatus: () => nativeTransport.getTrayStatus(),
        notificationStatus: () => nativeTransport.getNotificationStatus(),
        iosVoiceStatus: () => nativeTransport.getIosVoiceStatus(),
        iosInvocationStatus: () => nativeTransport.getIosInvocationStatus(),
        iosLocalLightInferenceStatus: () => nativeTransport.getIosLocalLightInferenceStatus(),
        iosBackgroundStatus: () => nativeTransport.getIosBackgroundStatus(),
        dialogStatus: () => nativeTransport.getDialogStatus(),
        audioBridgeStatus: () => nativeTransport.getAudioBridgeStatus(),
        iosSecureStorageStatus: () => nativeTransport.getIosSecureStorageStatus(),
        iosBiometricStatus: () => nativeTransport.getIosBiometricStatus(),
        androidBaselineStatus: () => nativeTransport.getAndroidBaselineStatus(),
        shutdown: () => invoke<void>('aurora_shutdown')
      }
    }

    return {
      client: new AuroraClient({ transport: nativeTransport }),
      mode: 'desktop-local',
      modePreferenceStore: secureModePreferenceStore(nativeTransport, 'Tauri secure storage for desktop local mode preference'),
      sidecarStatus: () => nativeTransport.getSidecarStatus(),
      startSidecar: () => nativeTransport.startSidecar(),
      stopSidecar: () => nativeTransport.stopSidecar(),
      nativePermissionStatus: () => nativeTransport.getNativePermissionStatus(),
      trayStatus: () => nativeTransport.getTrayStatus(),
      notificationStatus: () => nativeTransport.getNotificationStatus(),
      iosVoiceStatus: () => nativeTransport.getIosVoiceStatus(),
      iosInvocationStatus: () => nativeTransport.getIosInvocationStatus(),
      iosLocalLightInferenceStatus: () => nativeTransport.getIosLocalLightInferenceStatus(),
      iosBackgroundStatus: () => nativeTransport.getIosBackgroundStatus(),
      dialogStatus: () => nativeTransport.getDialogStatus(),
      audioBridgeStatus: () => nativeTransport.getAudioBridgeStatus(),
      iosSecureStorageStatus: () => nativeTransport.getIosSecureStorageStatus(),
      iosBiometricStatus: () => nativeTransport.getIosBiometricStatus(),
      androidBaselineStatus: () => nativeTransport.getAndroidBaselineStatus(),
      shutdown: () => invoke<void>('aurora_shutdown')
    }
  }

  const gatewayUrl = configuredGatewayUrl ?? devLoopbackGatewayUrl()
  if (gatewayUrl) {
    return {
      client: new AuroraClient({
        transport: new HttpGatewayTransport({
          baseUrl: gatewayUrl,
          bearerToken: import.meta.env.VITE_AURORA_GATEWAY_TOKEN
        })
      }),
      mode: 'desktop-thin',
      modePreferenceStore: memoryOnlyModePreferenceStore('browser thin mode preference is memory-only; no web storage persistence'),
      sidecarStatus: async () => null,
      startSidecar: async () => null,
      stopSidecar: async () => null,
      nativePermissionStatus: async () => null,
      trayStatus: async () => null,
      notificationStatus: async () => null,
      iosVoiceStatus: async () => null,
      iosInvocationStatus: async () => null,
      iosLocalLightInferenceStatus: async () => null,
      iosBackgroundStatus: async () => null,
      dialogStatus: async () => null,
      audioBridgeStatus: async () => null,
      iosSecureStorageStatus: async () => null,
      iosBiometricStatus: async () => null,
      androidBaselineStatus: async () => null,
      shutdown: async () => undefined
    }
  }

  return {
    client: new AuroraClient({ transport: new MockAuroraTransport() }),
    mode: 'mock',
    modePreferenceStore: memoryOnlyModePreferenceStore('mock/offline demo mode preference is memory-only fixture state'),
    sidecarStatus: async () => null,
    startSidecar: async () => null,
    stopSidecar: async () => null,
    nativePermissionStatus: async () => null,
    trayStatus: async () => null,
    notificationStatus: async () => null,
    iosVoiceStatus: async () => null,
    iosInvocationStatus: async () => null,
    iosLocalLightInferenceStatus: async () => null,
    iosBackgroundStatus: async () => null,
    dialogStatus: async () => null,
    audioBridgeStatus: async () => null,
    iosSecureStorageStatus: async () => null,
    iosBiometricStatus: async () => null,
    androidBaselineStatus: async () => null,
    shutdown: async () => undefined
  }
}

function secureModePreferenceStore(
  transport: TauriLocalTransport,
  evidence: string
): AuroraModePreferenceStore {
  return {
    evidence,
    readSelectedMode: async () => {
      const result = await transport.secureStorageGet(ONBOARDING_MODE_KEY)
      return result.value
    },
    writeSelectedMode: async (modeId: string) => {
      const result = await transport.secureStorageSet(ONBOARDING_MODE_KEY, modeId)
      return result.ok
    }
  }
}

function memoryOnlyModePreferenceStore(evidence: string): AuroraModePreferenceStore {
  let selectedMode: string | null = null
  return {
    evidence,
    readSelectedMode: async () => selectedMode,
    writeSelectedMode: async (modeId: string) => {
      selectedMode = modeId
      return true
    }
  }
}

function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window
}

function devLoopbackGatewayUrl(): string | undefined {
  if (!import.meta.env.DEV || typeof window === 'undefined') return undefined
  if (!['127.0.0.1', 'localhost'].includes(window.location.hostname)) return undefined
  return 'http://127.0.0.1:8000'
}
