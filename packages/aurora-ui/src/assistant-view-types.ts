import type {
  AssistantRoutePolicy,
  AuroraClient,
  VoiceRuntimeEvent,
  ModelRuntimeModelInfo,
  ModelRuntimeProviderInfo,
} from '@aurora/client'
import type { LightweightAssistantDependencies } from './local-assistant/lightweight-assistant'
import type { ModelOption } from '#components/assistant-ui/model-selector'
import type { AuroraBrowserSpeechPacksRuntimeStatus } from './browser-speech-pack'
import type { NativeDesktopVoicePort } from './native-desktop-voice'
import type { NativeMobileVoicePort } from './native-mobile-voice'
import type { AuroraSurfaceProfile } from './platform-surface'
import type { AssistantVoiceRoutes, RouteAvailability } from './shell-data'
import type { AssistantSessionSnapshot } from './assistant-session-persistence'


export const defaultAssistantStorageKey = 'aurora.assistant.session.v1'
export const emptyNativePermissionList: Array<{ name: string; granted: boolean }> = []
export const emptyNativeCapabilityList: Array<{ name: string; enabled: boolean }> = []
export const emptyVoiceEventList: VoiceRuntimeEvent[] = []
export const assistantAttachmentPickerAccept = 'image/*,application/pdf,application/json,text/plain,text/markdown,.txt,.md,.markdown,.json'

export interface AssistantViewProps {
  client: AuroraClient
  route: RouteAvailability
  cancellationRoute?: RouteAvailability | undefined
  voiceRoutes?: AssistantVoiceRoutes | undefined
  nativePlatform?: string | undefined
  nativeAvailable?: boolean | undefined
  nativePermissions?: Array<{ name: string; granted: boolean }> | undefined
  nativeCapabilities?: Array<{ name: string; enabled: boolean }> | undefined
  recentVoiceEvents?: VoiceRuntimeEvent[] | undefined
  storageKey?: string
  initialSession?: AssistantSessionSnapshot | undefined
  runtimeHealth?: AssistantRuntimeHealth | undefined
  executionHost?: 'this-device' | 'connected-device'
  localAssistant?: LightweightAssistantDependencies | null | undefined
  surfaceProfile?: AuroraSurfaceProfile | undefined
  nativeVoice?: NativeDesktopVoicePort | null | undefined
  nativeMobileVoice?: NativeMobileVoicePort | null | undefined
  browserSpeechPacks?: AuroraBrowserSpeechPacksRuntimeStatus | null | undefined
}

export interface AssistantRuntimeHealth {
  selectedModel: string | null
  routeLabel: string
  sidecarHealth: string
  gatewayHealth: string
}

export interface AssistantExecutionOption {
  id: string
  mode: 'local' | 'dispatch'
  runner: 'aurora-route' | 'lightweight-local'
  label: string
  description: string
  routePolicy: AssistantRoutePolicy
  executionPeerId: string | null
  transportHost: boolean
  modelCatalogHost: 'mixed' | 'this-device' | 'connected-device'
}

export interface AssistantModelChoice {
  id: string
  model: ModelOption
  provider: ModelRuntimeProviderInfo | null
  runtimeModel: ModelRuntimeModelInfo | null
  automatic: boolean
}

export interface AssistantModelChoiceGroup {
  id: string
  heading: string
  choices: AssistantModelChoice[]
  scope: 'default' | 'this device' | 'connected device'
}

export interface AssistantModelSourceGroup {
  id: string
  heading: string
  description: string
  providerGroups: AssistantModelChoiceGroup[]
  modelCount: number
  scope: 'local' | 'peer'
}

export interface AssistantConversationRow {
  id: string
  title: string
  route: string
  updated: string
  active: boolean
}

export type AssistantStreamStatus = 'idle' | 'streaming' | 'fallback' | 'lost' | 'cancelled'

export interface AssistantStreamState {
  status: AssistantStreamStatus
  lastEventId: string | null
  message: string | null
}

export interface AssistantControlState {
  canSend: boolean
  canCancel: boolean
  cancelReason: string
}


export function idleAssistantStreamState(): AssistantStreamState {
  return { status: 'idle', lastEventId: null, message: null }
}
