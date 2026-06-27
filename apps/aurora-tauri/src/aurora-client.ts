import {
  AuroraClient,
  HttpGatewayTransport,
  MockAuroraTransport,
  TauriLocalTransport,
  type TauriAndroidBaselineStatus,
  type TauriIosInvocationStatus,
  type TauriNativeFeatureStatus,
  type TauriNativePermissionStatus,
  type TauriSidecarStatus
} from '@aurora/client'
import { invoke } from '@tauri-apps/api/core'

export interface AuroraTauriRuntime {
  client: AuroraClient
  mode: 'desktop-local' | 'desktop-thin' | 'mock'
  sidecarStatus: () => Promise<TauriSidecarStatus | null>
  startSidecar: () => Promise<TauriSidecarStatus | null>
  stopSidecar: () => Promise<TauriSidecarStatus | null>
  nativePermissionStatus: () => Promise<TauriNativePermissionStatus | null>
  trayStatus: () => Promise<TauriNativeFeatureStatus | null>
  notificationStatus: () => Promise<TauriNativeFeatureStatus | null>
  iosVoiceStatus: () => Promise<TauriNativeFeatureStatus | null>
  iosInvocationStatus: () => Promise<TauriIosInvocationStatus | null>
  iosBackgroundStatus: () => Promise<TauriNativeFeatureStatus | null>
  dialogStatus: () => Promise<TauriNativeFeatureStatus | null>
  audioBridgeStatus: () => Promise<TauriNativeFeatureStatus | null>
  iosSecureStorageStatus: () => Promise<TauriNativeFeatureStatus | null>
  iosBiometricStatus: () => Promise<TauriNativeFeatureStatus | null>
  androidBaselineStatus: () => Promise<TauriAndroidBaselineStatus | null>
  shutdown: () => Promise<void>
}

export function createAuroraTauriRuntime(): AuroraTauriRuntime {
  if (isTauriRuntime()) {
    const transport = new TauriLocalTransport({ invoke })
    return {
      client: new AuroraClient({ transport }),
      mode: import.meta.env.VITE_AURORA_GATEWAY_URL ? 'desktop-thin' : 'desktop-local',
      sidecarStatus: () => transport.getSidecarStatus(),
      startSidecar: () => transport.startSidecar(),
      stopSidecar: () => transport.stopSidecar(),
      nativePermissionStatus: () => transport.getNativePermissionStatus(),
      trayStatus: () => transport.getTrayStatus(),
      notificationStatus: () => transport.getNotificationStatus(),
      iosVoiceStatus: () => transport.getIosVoiceStatus(),
      iosInvocationStatus: () => transport.getIosInvocationStatus(),
      iosBackgroundStatus: () => transport.getIosBackgroundStatus(),
      dialogStatus: () => transport.getDialogStatus(),
      audioBridgeStatus: () => transport.getAudioBridgeStatus(),
      iosSecureStorageStatus: () => transport.getIosSecureStorageStatus(),
      iosBiometricStatus: () => transport.getIosBiometricStatus(),
      androidBaselineStatus: () => transport.getAndroidBaselineStatus(),
      shutdown: () => invoke<void>('aurora_shutdown')
    }
  }

  const gatewayUrl = import.meta.env.VITE_AURORA_GATEWAY_URL
  if (gatewayUrl) {
    return {
      client: new AuroraClient({
        transport: new HttpGatewayTransport({
          baseUrl: gatewayUrl,
          bearerToken: import.meta.env.VITE_AURORA_GATEWAY_TOKEN
        })
      }),
      mode: 'desktop-thin',
      sidecarStatus: async () => null,
      startSidecar: async () => null,
      stopSidecar: async () => null,
      nativePermissionStatus: async () => null,
      trayStatus: async () => null,
      notificationStatus: async () => null,
      iosVoiceStatus: async () => null,
      iosInvocationStatus: async () => null,
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
    sidecarStatus: async () => null,
    startSidecar: async () => null,
    stopSidecar: async () => null,
    nativePermissionStatus: async () => null,
    trayStatus: async () => null,
    notificationStatus: async () => null,
    iosVoiceStatus: async () => null,
    iosInvocationStatus: async () => null,
    iosBackgroundStatus: async () => null,
    dialogStatus: async () => null,
    audioBridgeStatus: async () => null,
    iosSecureStorageStatus: async () => null,
    iosBiometricStatus: async () => null,
    androidBaselineStatus: async () => null,
    shutdown: async () => undefined
  }
}

function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window
}
