import type { JsonObject, JsonValue } from '../types.js'
import type { LocalToolDescriptorV1 } from './descriptor-v1.js'
import { LocalToolHandlerError } from './tooling-provider.js'
import { LocalToolRegistry, type LocalToolHandler } from './tool-registry.js'

export const AURORA_NATIVE_TOOL_IDS = Object.freeze({
  shareText: 'aurora.local.native.share_text.v1',
  openDeepLink: 'aurora.local.native.open_deep_link.v1',
  showNotification: 'aurora.local.native.show_notification.v1',
  pickDocument: 'aurora.local.native.pick_document.v1',
  readGrantedDocument: 'aurora.local.native.read_granted_document.v1',
  writeGrantedDocument: 'aurora.local.native.write_granted_document.v1',
  getClipboardText: 'aurora.local.native.get_clipboard_text.v1',
  setClipboardText: 'aurora.local.native.set_clipboard_text.v1',
  getDeviceStatus: 'aurora.local.native.get_device_status.v1',
  startForegroundVoiceCapture: 'aurora.local.native.start_foreground_voice_capture.v1'
})

export type AuroraNativeToolId = typeof AURORA_NATIVE_TOOL_IDS[keyof typeof AURORA_NATIVE_TOOL_IDS]

export type LocalNativeCapabilityState =
  | 'available'
  | 'needs_native_permission'
  | 'degraded'
  | 'disabled'
  | 'unavailable'
  | 'unsupported_platform'

export type LocalNativeHandler = (args: JsonObject, context: Parameters<LocalToolHandler>[0]) => Promise<JsonValue | undefined> | JsonValue | undefined

export interface LocalNativeCapabilityEvidence {
  readonly capabilityId: string
  readonly state: LocalNativeCapabilityState
  readonly requiredOsPermissions?: readonly string[] | undefined
}

export type LocalNativeCapabilitySnapshot = Partial<Record<AuroraNativeToolId, LocalNativeCapabilityEvidence>>
export type LocalNativeCapabilityHandlers = Partial<Record<AuroraNativeToolId, LocalNativeHandler>>

export interface RegisterNativeCapabilityToolsOptions {
  readonly registry: LocalToolRegistry
  readonly capabilities: LocalNativeCapabilitySnapshot
  readonly handlers: LocalNativeCapabilityHandlers
  readonly includeDegraded?: boolean | undefined
}

const ADVERTISED_STATES = new Set<LocalNativeCapabilityState>(['available', 'needs_native_permission', 'degraded'])

export function registerNativeCapabilityTools(options: RegisterNativeCapabilityToolsOptions): AuroraNativeToolId[] {
  const includeDegraded = options.includeDegraded ?? true
  const registered: AuroraNativeToolId[] = []
  for (const descriptor of NATIVE_TOOL_DESCRIPTORS) {
    const capability = options.capabilities[descriptor.toolContractId as AuroraNativeToolId]
    const handler = options.handlers[descriptor.toolContractId as AuroraNativeToolId]
    if (!capability || !handler) continue
    if (!ADVERTISED_STATES.has(capability.state)) continue
    if (!includeDegraded && capability.state === 'degraded') continue
    const nativeRequirements = {
      capabilityIds: [capability.capabilityId],
      osPermissions: [...(capability.requiredOsPermissions ?? descriptor.nativeRequirements.osPermissions)]
    }
    options.registry.register({
      descriptor: {
        ...descriptor,
        nativeRequirements
      },
      handler: async (input) => {
        if (capability.state === 'needs_native_permission') {
          throw new LocalToolHandlerError('permission_denied')
        }
        return handler(input.arguments, input)
      }
    })
    registered.push(descriptor.toolContractId as AuroraNativeToolId)
  }
  return registered
}

export function nativeCapabilityError(reasonCode: string): LocalToolHandlerError {
  return new LocalToolHandlerError(reasonCode)
}

const stringSchema = { type: 'string', minLength: 1, maxLength: 16_384 } as const
const textSchema = { type: 'string', minLength: 1, maxLength: 100_000 } as const
const booleanSchema = { type: 'boolean' } as const
const documentIdSchema = { type: 'string', minLength: 1, maxLength: 256 } as const

const okOutput = (key: string): JsonObject => ({
  type: 'object',
  properties: { [key]: booleanSchema },
  required: [key],
  additionalProperties: false
})

export const NATIVE_TOOL_DESCRIPTORS: readonly LocalToolDescriptorV1[] = Object.freeze([
  descriptor({
    id: AURORA_NATIVE_TOOL_IDS.shareText,
    localName: 'native.share_text',
    displayName: 'Share text',
    description: 'Share selected text through the current platform share sheet.',
    argsSchema: objectSchema({ text: textSchema, title: stringSchema }, ['text']),
    outputSchema: okOutput('shared'),
    requiredPermissions: ['Native.ShareText'],
    safetyClass: 'sensitive',
    mutating: true,
    dataEgress: true,
    confirmationPolicy: 'sensitive'
  }),
  descriptor({
    id: AURORA_NATIVE_TOOL_IDS.openDeepLink,
    localName: 'native.open_deep_link',
    displayName: 'Open link',
    description: 'Open an Aurora-approved link with the platform handler.',
    argsSchema: objectSchema({ url: stringSchema }, ['url']),
    outputSchema: okOutput('opened'),
    requiredPermissions: ['Native.OpenDeepLink'],
    safetyClass: 'sensitive',
    mutating: true,
    dataEgress: true,
    confirmationPolicy: 'sensitive'
  }),
  descriptor({
    id: AURORA_NATIVE_TOOL_IDS.showNotification,
    localName: 'native.show_notification',
    displayName: 'Show notification',
    description: 'Show a local notification on this device.',
    argsSchema: objectSchema({ title: stringSchema, body: { type: 'string', maxLength: 16_384 } }, ['title']),
    outputSchema: okOutput('shown'),
    requiredPermissions: ['Native.ShowNotification'],
    safetyClass: 'sensitive',
    mutating: true,
    dataEgress: false,
    confirmationPolicy: 'sensitive'
  }),
  descriptor({
    id: AURORA_NATIVE_TOOL_IDS.pickDocument,
    localName: 'native.pick_document',
    displayName: 'Pick document',
    description: 'Ask the local user to choose a document and return an opaque grant ID.',
    argsSchema: objectSchema({
      accept: { type: 'array', items: stringSchema, maxItems: 32 },
      multiple: booleanSchema
    }, []),
    outputSchema: objectSchema({
      documents: {
        type: 'array',
        items: objectSchema({
          documentId: documentIdSchema,
          name: { type: 'string', maxLength: 512 },
          mimeType: { type: 'string', maxLength: 256 }
        }, ['documentId'])
      }
    }, ['documents']),
    requiredPermissions: ['Native.PickDocument'],
    resourceScopes: ['native.document.grant'],
    safetyClass: 'sensitive',
    mutating: false,
    dataEgress: false,
    confirmationPolicy: 'sensitive'
  }),
  descriptor({
    id: AURORA_NATIVE_TOOL_IDS.readGrantedDocument,
    localName: 'native.read_granted_document',
    displayName: 'Read document',
    description: 'Read a previously granted local document by opaque grant ID.',
    argsSchema: objectSchema({ documentId: documentIdSchema }, ['documentId']),
    outputSchema: objectSchema({
      content: { type: 'string', maxLength: 1_000_000 },
      mimeType: { type: 'string', maxLength: 256 }
    }, ['content']),
    requiredPermissions: ['Native.ReadGrantedDocument'],
    resourceScopes: ['native.document.grant'],
    safetyClass: 'sensitive',
    mutating: false,
    dataEgress: true,
    confirmationPolicy: 'sensitive'
  }),
  descriptor({
    id: AURORA_NATIVE_TOOL_IDS.writeGrantedDocument,
    localName: 'native.write_granted_document',
    displayName: 'Write document',
    description: 'Write to a previously granted local document by opaque grant ID.',
    argsSchema: objectSchema({ documentId: documentIdSchema, content: { type: 'string', maxLength: 1_000_000 } }, ['documentId', 'content']),
    outputSchema: okOutput('written'),
    requiredPermissions: ['Native.WriteGrantedDocument'],
    resourceScopes: ['native.document.grant'],
    safetyClass: 'dangerous',
    mutating: true,
    dataEgress: false,
    confirmationPolicy: 'always'
  }),
  descriptor({
    id: AURORA_NATIVE_TOOL_IDS.getClipboardText,
    localName: 'native.get_clipboard_text',
    displayName: 'Read clipboard',
    description: 'Read text from this device clipboard when the platform allows it.',
    argsSchema: objectSchema({}, []),
    outputSchema: objectSchema({ text: { type: 'string', maxLength: 1_000_000 } }, ['text']),
    requiredPermissions: ['Native.GetClipboardText'],
    safetyClass: 'sensitive',
    mutating: false,
    dataEgress: true,
    confirmationPolicy: 'sensitive'
  }),
  descriptor({
    id: AURORA_NATIVE_TOOL_IDS.setClipboardText,
    localName: 'native.set_clipboard_text',
    displayName: 'Write clipboard',
    description: 'Write text to this device clipboard when the platform allows it.',
    argsSchema: objectSchema({ text: { type: 'string', maxLength: 1_000_000 } }, ['text']),
    outputSchema: okOutput('written'),
    requiredPermissions: ['Native.SetClipboardText'],
    safetyClass: 'sensitive',
    mutating: true,
    dataEgress: false,
    confirmationPolicy: 'sensitive'
  }),
  descriptor({
    id: AURORA_NATIVE_TOOL_IDS.getDeviceStatus,
    localName: 'native.get_device_status',
    displayName: 'Get device status',
    description: 'Return bounded local device availability information.',
    argsSchema: objectSchema({}, []),
    outputSchema: objectSchema({
      online: booleanSchema,
      batteryLevel: { type: 'number', minimum: 0, maximum: 1 },
      charging: booleanSchema
    }, []),
    requiredPermissions: ['Native.GetDeviceStatus'],
    safetyClass: 'standard',
    mutating: false,
    dataEgress: false,
    confirmationPolicy: 'never'
  }),
  descriptor({
    id: AURORA_NATIVE_TOOL_IDS.startForegroundVoiceCapture,
    localName: 'native.start_foreground_voice_capture',
    displayName: 'Start microphone',
    description: 'Start focused local voice capture when the platform grants foreground microphone access.',
    argsSchema: objectSchema({}, []),
    outputSchema: okOutput('started'),
    requiredPermissions: ['Native.StartForegroundVoiceCapture'],
    nativeRequirements: { capabilityIds: [], osPermissions: ['microphone'] },
    safetyClass: 'sensitive',
    mutating: true,
    dataEgress: true,
    confirmationPolicy: 'sensitive'
  })
])

function descriptor(input: {
  readonly id: AuroraNativeToolId
  readonly localName: string
  readonly displayName: string
  readonly description: string
  readonly argsSchema: JsonObject
  readonly outputSchema: JsonObject
  readonly requiredPermissions: readonly string[]
  readonly resourceScopes?: readonly string[] | undefined
  readonly nativeRequirements?: { readonly capabilityIds: readonly string[], readonly osPermissions: readonly string[] } | undefined
  readonly safetyClass: LocalToolDescriptorV1['safetyClass']
  readonly mutating: boolean
  readonly dataEgress: boolean
  readonly confirmationPolicy: LocalToolDescriptorV1['confirmationPolicy']
}): LocalToolDescriptorV1 {
  return {
    version: 1,
    toolContractId: input.id,
    localName: input.localName,
    displayName: input.displayName,
    description: input.description,
    argsSchema: input.argsSchema,
    outputSchema: input.outputSchema,
    argumentVisibility: Object.fromEntries(Object.keys(input.argsSchema.properties as Record<string, unknown> | undefined ?? {}).map((key) => [key, key.toLowerCase().includes('content') || key.toLowerCase().includes('text') ? 'private' : 'public'])),
    requiredPermissions: [...input.requiredPermissions],
    resourceScopes: [...(input.resourceScopes ?? [])],
    safetyClass: input.safetyClass,
    privacyClass: 'local-device',
    mutating: input.mutating,
    dataEgress: input.dataEgress,
    nativeRequirements: {
      capabilityIds: [...(input.nativeRequirements?.capabilityIds ?? [input.id])],
      osPermissions: [...(input.nativeRequirements?.osPermissions ?? [])]
    },
    confirmationPolicy: input.confirmationPolicy,
    handlerId: input.id
  }
}

function objectSchema(properties: Record<string, JsonObject>, required: readonly string[]): JsonObject {
  return {
    type: 'object',
    properties,
    required: [...required],
    additionalProperties: false
  }
}
