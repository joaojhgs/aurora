import type {
  AndroidNativeState,
  AndroidVoiceForegroundServiceRequestResult,
  AndroidVoiceForegroundServiceStatus,
  JsonObject,
  JsonValue,
  NativeCapabilityManifest,
  TauriSidecarStatus
} from '@aurora/client'
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
