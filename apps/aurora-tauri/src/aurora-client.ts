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
  mode: 'desktop-local' | 'desktop-thin' | 'mobile-native' | 'mock'
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
  overlayShow?: (mode: AuroraOverlayRuntimeMode) => Promise<AuroraOverlayCommandStatus | null>
  overlayHide?: () => Promise<AuroraOverlayCommandStatus | null>
  overlayStatus?: () => Promise<AuroraOverlayCommandStatus | null>
  overlaySetPassthrough?: (enabled: boolean) => Promise<AuroraOverlayCommandStatus | null>
  overlayStartDrag?: () => Promise<AuroraOverlayCommandStatus | null>
  overlayMoveBy?: (dx: number, dy: number) => Promise<AuroraOverlayCommandStatus | null>
  overlayRegisterHotkey?: (accelerator: string) => Promise<AuroraOverlayCommandStatus | null>
  overlayUnregisterHotkey?: () => Promise<AuroraOverlayCommandStatus | null>
  listenOverlayMode?: (handler: AuroraOverlayModeListener) => Promise<() => void>
  shutdown: () => Promise<void>
}

export interface AuroraModePreferenceStore {
  evidence: string
  readSelectedMode: () => Promise<string | null>
  writeSelectedMode: (modeId: string) => Promise<boolean>
}

export type AuroraOverlayRuntimeMode = 'voice' | 'text'
export type AuroraOverlayModeListener = (payload: unknown) => void

export interface AuroraOverlayCommandStatus {
  ok?: boolean
  mode?: AuroraOverlayRuntimeMode | 'hidden'
  visible?: boolean
  pointerPassthrough?: boolean
  accelerator?: string
  reason?: string
  [key: string]: unknown
}

const ONBOARDING_MODE_KEY = 'aurora.session.onboarding-mode'

export function createAuroraTauriRuntime(): AuroraTauriRuntime {
  const configuredGatewayUrl = import.meta.env.VITE_AURORA_GATEWAY_URL

  if (isTauriRuntime()) {
    const nativeTransport = new TauriLocalTransport({ invoke, listen })
    const isMobileNative = isMobileTauriRuntime()

    if (isMobileNative) {
      const mobileTransport = configuredGatewayUrl
        ? new HttpGatewayTransport({
            baseUrl: configuredGatewayUrl,
            bearerToken: import.meta.env.VITE_AURORA_GATEWAY_TOKEN
          })
        : nativeTransport

      return {
        client: new AuroraClient({ transport: mobileTransport }),
        mode: 'mobile-native',
        modePreferenceStore: secureModePreferenceStore(nativeTransport, 'Tauri secure storage for mobile native mode preference'),
        sidecarStatus: async () => null,
        startSidecar: async () => null,
        stopSidecar: async () => null,
        nativePermissionStatus: () => nativeTransport.getNativePermissionStatus(),
        trayStatus: async () => null,
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
        ...noopOverlayControls('mobile-native-runtime'),
        shutdown: async () => undefined
      }
    }

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
        ...tauriOverlayControls(),
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
      ...tauriOverlayControls(),
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
      ...noopOverlayControls(),
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
    ...noopOverlayControls(),
    shutdown: async () => undefined
  }
}

function tauriOverlayControls(): Pick<
  AuroraTauriRuntime,
  'overlayShow' | 'overlayHide' | 'overlayStatus' | 'overlaySetPassthrough' | 'overlayStartDrag' | 'overlayMoveBy' | 'overlayRegisterHotkey' | 'overlayUnregisterHotkey' | 'listenOverlayMode'
> {
  return {
    overlayShow: (mode) => invokeOverlayCommand('aurora_overlay_show', { mode }),
    overlayHide: () => invokeOverlayCommand('aurora_overlay_hide'),
    overlayStatus: () => invokeOverlayCommand('aurora_overlay_status'),
    overlaySetPassthrough: (enabled) => invokeOverlayCommand('aurora_overlay_set_passthrough', { enabled }),
    overlayStartDrag: () => invokeOverlayCommand('aurora_overlay_start_drag'),
    overlayMoveBy: (dx, dy) => invokeOverlayCommand('aurora_overlay_move_by', { dx, dy }),
    overlayRegisterHotkey: (accelerator) => invokeOverlayCommand('aurora_overlay_register_hotkey', { accelerator }),
    overlayUnregisterHotkey: () => invokeOverlayCommand('aurora_overlay_unregister_hotkey'),
    listenOverlayMode: (handler) => listen<unknown>('aurora://overlay-mode', (event) => handler(event.payload))
  }
}

function noopOverlayControls(reason = 'not-tauri-runtime'): Pick<
  AuroraTauriRuntime,
  'overlayShow' | 'overlayHide' | 'overlayStatus' | 'overlaySetPassthrough' | 'overlayStartDrag' | 'overlayMoveBy' | 'overlayRegisterHotkey' | 'overlayUnregisterHotkey' | 'listenOverlayMode'
> {
  const unavailable = { ok: false, available: false, disabled: true, visible: false, hotkeyRegistered: false, reason }

  return {
    overlayShow: async (mode) => ({ ...unavailable, mode, visible: false }),
    overlayHide: async () => ({ ...unavailable, mode: 'hidden', visible: false }),
    overlayStatus: async () => ({ ...unavailable, mode: 'hidden', visible: false }),
    overlaySetPassthrough: async (enabled) => ({ ...unavailable, pointerPassthrough: enabled }),
    overlayStartDrag: async () => ({ ...unavailable }),
    overlayMoveBy: async () => ({ ...unavailable }),
    overlayRegisterHotkey: async (accelerator) => ({ ...unavailable, accelerator }),
    overlayUnregisterHotkey: async () => ({ ...unavailable, mode: 'hidden' }),
    listenOverlayMode: async () => () => undefined
  }
}

async function invokeOverlayCommand(
  command: string,
  args?: Record<string, unknown>
): Promise<AuroraOverlayCommandStatus | null> {
  try {
    return await invoke<AuroraOverlayCommandStatus | null>(command, args)
  } catch (error) {
    if (isUnavailableOverlayCommandError(error)) return null
    console.warn(`Aurora overlay command failed: ${command}`, error)
    return null
  }
}

function isUnavailableOverlayCommandError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /command.+not found|unknown command|not allowed|permission denied|missing/i.test(message)
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

function isMobileTauriRuntime(): boolean {
  if (typeof navigator === 'undefined') return false
  const userAgent = navigator.userAgent
  if (/Android|iPhone|iPad|iPod/i.test(userAgent)) return true
  return /Macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1
}

function devLoopbackGatewayUrl(): string | undefined {
  if (!import.meta.env.DEV || typeof window === 'undefined') return undefined
  if (!['127.0.0.1', 'localhost'].includes(window.location.hostname)) return undefined
  return 'http://127.0.0.1:8000'
}
