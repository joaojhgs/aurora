import type {
  AndroidNativeState,
  AndroidVoiceForegroundServiceRequestResult,
  AndroidVoiceForegroundServiceStatus,
  JsonObject,
  JsonValue,
  NativeCapabilityManifest,
  TauriSidecarStatus
} from '@aurora/client'
import { AuroraError } from '@aurora/client'
import {
  AURORA_NATIVE_TOOL_IDS,
  LocalToolHandlerError,
  NATIVE_TOOL_DESCRIPTORS,
  type AuroraNativeToolId,
  type LocalToolDescriptorV1,
  type LocalToolRegistry
} from '@aurora/client/local-tools'

export interface TauriNativeCapabilityTransport {
  getNativeCapabilityManifest(): Promise<NativeCapabilityManifest>
  getSidecarStatus(): Promise<TauriSidecarStatus>
  getAndroidVoiceForegroundServiceStatus(): Promise<AndroidVoiceForegroundServiceStatus>
  startAndroidVoiceForegroundService(): Promise<AndroidVoiceForegroundServiceRequestResult>
  shareNativeText(request: { text: string, title?: string }): Promise<{ shared: boolean }>
  openNativeDeepLink(request: { url: string }): Promise<{ opened: boolean }>
  showNativeNotification(request: { title: string, body?: string }): Promise<{ shown: boolean }>
}

export interface RegisterTauriNativeCapabilityPackOptions {
  readonly registry: LocalToolRegistry
  readonly transport: TauriNativeCapabilityTransport
}

export interface TauriNativeCapabilityPackResult {
  readonly registered: readonly AuroraNativeToolId[]
}

const DEVICE_STATUS_CAPABILITY_ID = 'native.deviceStatus'
const ANDROID_FOREGROUND_VOICE_CAPABILITY_ID = 'android.voiceForegroundService.start'
const NATIVE_ACTIONS = Object.freeze([
  {
    toolId: AURORA_NATIVE_TOOL_IDS.shareText,
    permissionName: 'shareText',
    capabilityName: 'shareText',
    osPermissions: []
  },
  {
    toolId: AURORA_NATIVE_TOOL_IDS.openDeepLink,
    permissionName: 'openDeepLink',
    capabilityName: 'openDeepLink',
    osPermissions: []
  },
  {
    toolId: AURORA_NATIVE_TOOL_IDS.showNotification,
    permissionName: 'showNotification',
    capabilityName: 'showNotification',
    osPermissions: ['notifications']
  }
] as const)
const GET_DEVICE_STATUS_OUTPUT_SCHEMA: JsonObject = {
  type: 'object',
  properties: {
    platform: { type: 'string', minLength: 1, maxLength: 64 },
    availableCapabilities: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 160 },
      maxItems: 128
    },
    online: { type: 'boolean' },
    batteryLevel: { type: 'number', minimum: 0, maximum: 1 },
    charging: { type: 'boolean' }
  },
  required: [],
  additionalProperties: false
}

export async function registerTauriNativeCapabilityPack(
  options: RegisterTauriNativeCapabilityPackOptions
): Promise<TauriNativeCapabilityPackResult> {
  const manifest = await readManifestForDiscovery(options.transport)
  if (!manifest) return { registered: [] }
  const registered: AuroraNativeToolId[] = []

  if (manifestAllowsDeviceStatus(manifest)) {
    options.registry.register({
      descriptor: descriptorFor(AURORA_NATIVE_TOOL_IDS.getDeviceStatus, {
        capabilityId: DEVICE_STATUS_CAPABILITY_ID,
        outputSchema: GET_DEVICE_STATUS_OUTPUT_SCHEMA
      }),
      handler: async () => buildDeviceStatus(options.transport)
    })
    registered.push(AURORA_NATIVE_TOOL_IDS.getDeviceStatus)
  }

  for (const action of NATIVE_ACTIONS) {
    if (!nativeActionReady(manifest, action)) continue
    options.registry.register({
      descriptor: descriptorFor(action.toolId, {
        capabilityId: platformCapabilityId(manifest, action.capabilityName),
        osPermissions: action.osPermissions
      }),
      handler: async (input) => invokeNativeAction(options.transport, manifest.platform, action, input.arguments)
    })
    registered.push(action.toolId)
  }

  const foregroundStatus = manifest.platform === 'android'
    ? await readAndroidForegroundStatus(options.transport)
    : null
  if (foregroundStatus && androidForegroundVoiceReady(manifest, foregroundStatus)) {
    options.registry.register({
      descriptor: descriptorFor(AURORA_NATIVE_TOOL_IDS.startForegroundVoiceCapture, {
        capabilityId: ANDROID_FOREGROUND_VOICE_CAPABILITY_ID,
        osPermissions: ['microphone', 'notifications', 'foreground-service']
      }),
      handler: async () => startAndroidForegroundVoice(options.transport)
    })
    registered.push(AURORA_NATIVE_TOOL_IDS.startForegroundVoiceCapture)
  }

  return { registered }
}

async function readManifestForDiscovery(
  transport: TauriNativeCapabilityTransport
): Promise<NativeCapabilityManifest | null> {
  try {
    return await transport.getNativeCapabilityManifest()
  } catch {
    return null
  }
}

async function buildDeviceStatus(transport: TauriNativeCapabilityTransport): Promise<JsonObject> {
  const manifest = await readManifest(transport)
  if (!manifestAllowsDeviceStatus(manifest)) throw new LocalToolHandlerError('permission_unavailable')
  const sidecar = await readSidecarStatus(transport)
  const output: JsonObject = {
    platform: boundedString(manifest.platform, 64),
    availableCapabilities: await availableToolCapabilities(transport, manifest)
  }
  if (sidecar) output.online = sidecar.running
  else output.online = true
  return output
}

async function startAndroidForegroundVoice(transport: TauriNativeCapabilityTransport): Promise<JsonObject> {
  const [manifest, status] = await Promise.all([
    readManifest(transport),
    readAndroidForegroundStatus(transport)
  ])
  if (!status) throw new LocalToolHandlerError('capability_unavailable')
  if (!androidForegroundVoiceReady(manifest, status)) throw new LocalToolHandlerError(nativeStateReason(status.state))

  let result: AndroidVoiceForegroundServiceRequestResult
  try {
    result = await transport.startAndroidVoiceForegroundService()
  } catch {
    throw new LocalToolHandlerError('capability_unavailable')
  }
  if (!result.started && !result.status.running) throw new LocalToolHandlerError(nativeStateReason(result.status.state))
  return { started: Boolean(result.started || result.status.running) }
}

async function readManifest(transport: TauriNativeCapabilityTransport): Promise<NativeCapabilityManifest> {
  try {
    return await transport.getNativeCapabilityManifest()
  } catch {
    throw new LocalToolHandlerError('capability_unavailable')
  }
}

async function readSidecarStatus(transport: TauriNativeCapabilityTransport): Promise<TauriSidecarStatus | null> {
  try {
    return await transport.getSidecarStatus()
  } catch {
    return null
  }
}

async function readAndroidForegroundStatus(
  transport: TauriNativeCapabilityTransport
): Promise<AndroidVoiceForegroundServiceStatus | null> {
  try {
    return await transport.getAndroidVoiceForegroundServiceStatus()
  } catch {
    return null
  }
}

function manifestAllowsDeviceStatus(manifest: NativeCapabilityManifest): boolean {
  return manifest.permissions['aurora.nativeCapabilityManifest'] === true &&
    manifest.capabilities['native.permissionsManifest'] === true &&
    stateAvailable(manifest.permissionStates?.['aurora.nativeCapabilityManifest']) &&
    stateAvailable(manifest.capabilityStates?.['native.permissionsManifest'])
}

function androidForegroundVoiceReady(
  manifest: NativeCapabilityManifest,
  status: AndroidVoiceForegroundServiceStatus
): boolean {
  if (manifest.platform !== 'android' || status.platform !== 'android') return false
  if (!status.startable || !status.microphoneGranted || !status.notificationsGranted) return false
  if (!status.foregroundServiceReady || !status.manifestReady || status.state !== 'available') return false
  return manifest.permissions['aurora.android.microphone'] === true &&
    manifest.permissions['aurora.android.notifications'] === true &&
    manifest.permissions['aurora.android.foregroundServiceMicrophone'] === true &&
    manifest.permissions['aurora.android.voiceForegroundService'] === true &&
    manifest.permissions['aurora.android.voiceForegroundStart'] === true &&
    manifest.capabilities['android.microphoneCapture'] === true &&
    manifest.capabilities['android.foregroundService'] === true &&
    manifest.capabilities['android.voiceForegroundService'] === true &&
    manifest.capabilities['android.voiceForegroundService.start'] === true &&
    stateAvailable(manifest.permissionStates?.['aurora.android.microphone']) &&
    stateAvailable(manifest.permissionStates?.['aurora.android.notifications']) &&
    stateAvailable(manifest.permissionStates?.['aurora.android.foregroundServiceMicrophone']) &&
    stateAvailable(manifest.permissionStates?.['aurora.android.voiceForegroundService']) &&
    stateAvailable(manifest.permissionStates?.['aurora.android.voiceForegroundStart']) &&
    stateAvailable(manifest.capabilityStates?.['android.microphoneCapture']) &&
    stateAvailable(manifest.capabilityStates?.['android.foregroundService']) &&
    stateAvailable(manifest.capabilityStates?.['android.voiceForegroundService']) &&
    stateAvailable(manifest.capabilityStates?.['android.voiceForegroundService.start'])
}

function nativeActionReady(
  manifest: NativeCapabilityManifest,
  action: typeof NATIVE_ACTIONS[number]
): boolean {
  const platform = nativeActionPlatform(manifest.platform)
  if (!platform) return false
  const permissionId = `aurora.${platform}.${action.permissionName}`
  const capabilityId = `${platform}.${action.capabilityName}`
  return manifest.permissions[permissionId] === true &&
    manifest.capabilities[capabilityId] === true &&
    stateAvailable(manifest.permissionStates?.[permissionId]) &&
    stateAvailable(manifest.capabilityStates?.[capabilityId])
}

function nativeActionPlatform(platform: string): 'android' | 'ios' | null {
  if (platform === 'android' || platform === 'ios') return platform
  return null
}

function platformCapabilityId(
  manifest: NativeCapabilityManifest,
  capabilityName: string
): string {
  const platform = nativeActionPlatform(manifest.platform)
  if (!platform) throw new LocalToolHandlerError('unsupported_platform')
  return `${platform}.${capabilityName}`
}

async function invokeNativeAction(
  transport: TauriNativeCapabilityTransport,
  expectedPlatform: string,
  action: typeof NATIVE_ACTIONS[number],
  args: JsonObject
): Promise<JsonObject> {
  const manifest = await readManifest(transport)
  if (manifest.platform !== expectedPlatform || !nativeActionReady(manifest, action)) {
    throw new LocalToolHandlerError(nativeActionStateReason(manifest, action))
  }
  try {
    if (action.toolId === AURORA_NATIVE_TOOL_IDS.shareText) {
      const text = requiredString(args.text)
      const title = optionalString(args.title)
      const result = await transport.shareNativeText({ text, ...(title ? { title } : {}) })
      if (!result.shared) throw new LocalToolHandlerError('capability_unavailable')
      return { shared: true }
    }
    if (action.toolId === AURORA_NATIVE_TOOL_IDS.openDeepLink) {
      const result = await transport.openNativeDeepLink({ url: requiredString(args.url) })
      if (!result.opened) throw new LocalToolHandlerError('capability_unavailable')
      return { opened: true }
    }
    const title = requiredString(args.title)
    const body = optionalString(args.body)
    const result = await transport.showNativeNotification({ title, ...(body ? { body } : {}) })
    if (!result.shown) throw new LocalToolHandlerError('capability_unavailable')
    return { shown: true }
  } catch (error) {
    if (error instanceof LocalToolHandlerError) throw error
    throw new LocalToolHandlerError(nativeActionInvokeError(error))
  }
}

function nativeActionStateReason(
  manifest: NativeCapabilityManifest,
  action: typeof NATIVE_ACTIONS[number]
): string {
  const platform = nativeActionPlatform(manifest.platform)
  if (!platform) return 'unsupported_platform'
  const permissionState = manifest.permissionStates?.[`aurora.${platform}.${action.permissionName}`]
  const capabilityState = manifest.capabilityStates?.[`${platform}.${action.capabilityName}`]
  if (permissionState === 'needs_native_permission' || capabilityState === 'needs_native_permission') {
    return 'permission_unavailable'
  }
  if (permissionState === 'unsupported_platform' || capabilityState === 'unsupported_platform') {
    return 'unsupported_platform'
  }
  return 'capability_unavailable'
}

function nativeActionInvokeError(error: unknown): string {
  if (error instanceof AuroraError) {
    if (error.code === 'permission' || error.code === 'native_permission_missing' || error.code === 'privacy_blocked') {
      return 'permission_denied'
    }
    if (error.code === 'unsupported_feature') return 'unsupported_platform'
  }
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  if (message.includes('permission') || message.includes('user_cancelled')) return 'permission_denied'
  if (message.includes('unsupported')) return 'unsupported_platform'
  return 'capability_unavailable'
}

function requiredString(value: JsonValue | undefined): string {
  if (typeof value !== 'string' || value.length === 0) throw new LocalToolHandlerError('capability_unavailable')
  return value
}

function optionalString(value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined
  return requiredString(value)
}

function stateAvailable(state: AndroidNativeState | undefined): boolean {
  return state === 'available'
}

function nativeStateReason(state: AndroidNativeState | string): string {
  if (state === 'needs_native_permission') return 'permission_unavailable'
  if (state === 'unsupported_platform') return 'unsupported_platform'
  return 'capability_unavailable'
}

async function availableToolCapabilities(
  transport: TauriNativeCapabilityTransport,
  manifest: NativeCapabilityManifest
): Promise<string[]> {
  const capabilities: AuroraNativeToolId[] = manifestAllowsDeviceStatus(manifest)
    ? [AURORA_NATIVE_TOOL_IDS.getDeviceStatus]
    : []
  if (manifest.platform === 'android') {
    const foregroundStatus = await readAndroidForegroundStatus(transport)
    if (foregroundStatus && androidForegroundVoiceReady(manifest, foregroundStatus)) {
      capabilities.push(AURORA_NATIVE_TOOL_IDS.startForegroundVoiceCapture)
    }
  }
  for (const action of NATIVE_ACTIONS) {
    if (nativeActionReady(manifest, action)) capabilities.push(action.toolId)
  }
  return capabilities.sort().slice(0, 128)
}

function descriptorFor(
  id: AuroraNativeToolId,
  options: {
    readonly capabilityId: string
    readonly osPermissions?: readonly string[]
    readonly outputSchema?: JsonObject
  }
): LocalToolDescriptorV1 {
  const base = NATIVE_TOOL_DESCRIPTORS.find((descriptor) => descriptor.toolContractId === id)
  if (!base) throw new LocalToolHandlerError('capability_unavailable')
  return {
    ...base,
    outputSchema: options.outputSchema ?? base.outputSchema,
    nativeRequirements: {
      capabilityIds: [options.capabilityId],
      osPermissions: [...(options.osPermissions ?? base.nativeRequirements.osPermissions)]
    }
  }
}

function boundedString(value: string, maxLength: number): JsonValue {
  return value.slice(0, maxLength)
}
