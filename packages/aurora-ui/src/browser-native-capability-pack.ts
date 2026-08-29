import type { JsonObject, JsonValue, NativeCapabilityManifest } from '@aurora/client'
import {
  AURORA_NATIVE_TOOL_IDS,
  LocalToolRegistry,
  NATIVE_TOOL_DESCRIPTORS,
  nativeCapabilityError,
  registerNativeCapabilityTools,
  type AuroraNativeToolId,
  type LocalNativeCapabilityHandlers,
  type LocalNativeCapabilitySnapshot,
  type LocalNativeCapabilityState,
} from '@aurora/client/local-tools'

export type BrowserNativeCapabilityErrorCode =
  | 'capability_unavailable'
  | 'local_confirmation_required'
  | 'permission_denied'
  | 'permission_unavailable'
  | 'unsupported_platform'
  | 'user_activation_required'

export interface BrowserNativeCapabilityPack {
  readonly registry: LocalToolRegistry
  readonly manifest: NativeCapabilityManifest
  readonly snapshot: LocalNativeCapabilitySnapshot
  readonly registeredToolIds: readonly AuroraNativeToolId[]
}

export interface BrowserNativeCapabilityPackOptions {
  readonly stablePeerId: string
  readonly providerLabel?: string | null
  readonly registry?: LocalToolRegistry | undefined
  readonly navigator?: BrowserNavigatorPort | null
  readonly window?: BrowserWindowPort | null
  readonly notification?: BrowserNotificationPort | null
  readonly filePicker?: BrowserFilePickerPort | null
  readonly crypto?: BrowserCryptoPort | null
  readonly now?: () => string
  readonly randomId?: () => string
  readonly permissionStates?: BrowserNativePermissionStates
  readonly approvedDeepLinks?: readonly string[]
  readonly allowCurrentOriginDeepLinks?: boolean
}

export type BrowserNativePermissionName = 'clipboard-read' | 'clipboard-write' | 'document-write'
export type BrowserNativePermissionStates = Partial<Record<BrowserNativePermissionName, PermissionState>>

export interface BrowserNavigatorPort {
  readonly clipboard?: BrowserClipboardPort
  readonly share?: (data: ShareData) => Promise<void>
  readonly canShare?: (data: ShareData) => boolean
  readonly onLine?: boolean
  readonly userAgent?: string
  readonly getBattery?: () => Promise<BrowserBatteryStatus>
}

export interface BrowserClipboardPort {
  readText(): Promise<string>
  writeText(text: string): Promise<void>
}

export interface BrowserWindowPort {
  readonly location?: Pick<Location, 'origin' | 'href'>
  open(url: string, target?: string, features?: string): unknown
}

export interface BrowserNotificationPort {
  readonly permission: NotificationPermission
  show(title: string, options?: NotificationOptions): unknown
}

export interface BrowserFilePickerPort {
  showOpenFilePicker?(options?: BrowserOpenFilePickerOptions): Promise<readonly BrowserFileHandle[]>
}

export interface BrowserOpenFilePickerOptions {
  readonly multiple?: boolean
  readonly types?: readonly BrowserFilePickerAcceptType[]
}

export interface BrowserFilePickerAcceptType {
  readonly description?: string
  readonly accept: Record<string, readonly string[]>
}

export interface BrowserFileHandle {
  readonly kind?: string
  readonly name?: string
  getFile(): Promise<BrowserFile>
  createWritable?: () => Promise<BrowserWritableFileStream>
}

export interface BrowserFile {
  readonly name?: string
  readonly type?: string
  text(): Promise<string>
}

export interface BrowserWritableFileStream {
  write(content: string): Promise<void>
  close(): Promise<void>
}

export interface BrowserBatteryStatus {
  readonly level?: number
  readonly charging?: boolean
}

export interface BrowserCryptoPort {
  randomUUID?: () => string
  getRandomValues?: <T extends ArrayBufferView>(array: T) => T
}

interface DocumentGrant {
  readonly handle: BrowserFileHandle
  readonly name: string | null
  readonly mimeType: string | null
}

const ERROR_CODES = new Set<BrowserNativeCapabilityErrorCode>([
  'capability_unavailable',
  'local_confirmation_required',
  'permission_denied',
  'permission_unavailable',
  'unsupported_platform',
  'user_activation_required',
])

const DOCUMENT_ID_RE = /^doc_[A-Za-z0-9_-]{16,96}$/u
const DEFAULT_APPROVED_PROTOCOLS = new Set(['https:', 'mailto:', 'tel:', 'aurora:', 'aurora-local:'])

interface ApprovedDeepLinkRule {
  readonly protocol: string
  readonly origin: string | null
  readonly route: string
  readonly subtree: boolean
}

export function createBrowserNativeCapabilityPack(options: BrowserNativeCapabilityPackOptions): BrowserNativeCapabilityPack {
  const registry = options.registry ?? new LocalToolRegistry({
    stablePeerId: options.stablePeerId,
    providerLabel: options.providerLabel ?? 'Browser device',
    source: 'core',
    sourceId: 'browser-native-capability-pack',
  })
  const randomId = options.randomId ?? (() => secureRandomId(options.crypto ?? undefined))
  const documents = new Map<string, DocumentGrant>()
  const snapshot = buildBrowserNativeCapabilitySnapshot(options)
  const handlers = buildBrowserNativeCapabilityHandlers(options, documents, randomId)
  const registeredToolIds = registerNativeCapabilityTools({ registry, capabilities: snapshot, handlers })
  const manifest = buildBrowserNativeCapabilityManifest(snapshot, options.now?.() ?? new Date().toISOString())

  return {
    registry,
    manifest,
    snapshot: filterSnapshot(snapshot, registeredToolIds),
    registeredToolIds,
  }
}

export function buildBrowserNativeCapabilitySnapshot(options: BrowserNativeCapabilityPackOptions): LocalNativeCapabilitySnapshot {
  const capabilities: LocalNativeCapabilitySnapshot = {}
  const nav = options.navigator ?? null
  const filePicker = options.filePicker ?? null
  const notification = options.notification ?? null
  const win = options.window ?? null

  if (nav?.share && canShareText(nav)) {
    capabilities[AURORA_NATIVE_TOOL_IDS.shareText] = capability(AURORA_NATIVE_TOOL_IDS.shareText, 'available')
  }
  if (win?.open && hasApprovedDeepLinkScope(options)) {
    capabilities[AURORA_NATIVE_TOOL_IDS.openDeepLink] = capability(AURORA_NATIVE_TOOL_IDS.openDeepLink, 'available')
  }
  if (notification?.permission === 'granted') {
    capabilities[AURORA_NATIVE_TOOL_IDS.showNotification] = capability(AURORA_NATIVE_TOOL_IDS.showNotification, 'available', ['notifications'])
  }
  if (filePicker?.showOpenFilePicker) {
    capabilities[AURORA_NATIVE_TOOL_IDS.pickDocument] = capability(AURORA_NATIVE_TOOL_IDS.pickDocument, 'available')
    capabilities[AURORA_NATIVE_TOOL_IDS.readGrantedDocument] = capability(AURORA_NATIVE_TOOL_IDS.readGrantedDocument, 'available')
    if (hasGrantedPermission(options, 'document-write')) {
      capabilities[AURORA_NATIVE_TOOL_IDS.writeGrantedDocument] = capability(AURORA_NATIVE_TOOL_IDS.writeGrantedDocument, 'available', ['document-write'])
    }
  }
  if (nav?.clipboard?.readText && hasGrantedPermission(options, 'clipboard-read')) {
    capabilities[AURORA_NATIVE_TOOL_IDS.getClipboardText] = capability(AURORA_NATIVE_TOOL_IDS.getClipboardText, 'available', ['clipboard-read'])
  }
  if (nav?.clipboard?.writeText && hasGrantedPermission(options, 'clipboard-write')) {
    capabilities[AURORA_NATIVE_TOOL_IDS.setClipboardText] = capability(AURORA_NATIVE_TOOL_IDS.setClipboardText, 'available', ['clipboard-write'])
  }
  if (nav) {
    capabilities[AURORA_NATIVE_TOOL_IDS.getDeviceStatus] = capability(AURORA_NATIVE_TOOL_IDS.getDeviceStatus, 'available')
  }

  return capabilities
}

export function mapBrowserNativeCapabilityError(error: unknown): BrowserNativeCapabilityErrorCode {
  if (isDomExceptionName(error, 'NotAllowedError')) return 'permission_denied'
  if (isDomExceptionName(error, 'SecurityError')) return 'permission_denied'
  if (isDomExceptionName(error, 'AbortError')) return 'local_confirmation_required'
  const message = error instanceof Error ? error.message.toLowerCase() : String(error ?? '').toLowerCase()
  if (message.includes('activation') || message.includes('gesture')) return 'user_activation_required'
  if (message.includes('permission') || message.includes('denied')) return 'permission_denied'
  if (message.includes('cancel')) return 'local_confirmation_required'
  return 'capability_unavailable'
}

function buildBrowserNativeCapabilityHandlers(
  options: BrowserNativeCapabilityPackOptions,
  documents: Map<string, DocumentGrant>,
  randomId: () => string,
): LocalNativeCapabilityHandlers {
  return {
    [AURORA_NATIVE_TOOL_IDS.shareText]: async (args) => {
      const nav = requirePort(options.navigator, 'capability_unavailable')
      if (!nav.share) throw nativeCapabilityError('capability_unavailable')
      try {
        const title = optionalString(args.title)
        await nav.share({ text: requireString(args.text), ...(title ? { title } : {}) })
        return { shared: true }
      } catch (error) {
        throw redactedNativeError(error)
      }
    },
    [AURORA_NATIVE_TOOL_IDS.openDeepLink]: (args) => {
      const win = requirePort(options.window, 'capability_unavailable')
      const url = requireString(args.url)
      if (!isApprovedDeepLink(url, options)) throw nativeCapabilityError('permission_denied')
      let opened: unknown
      try {
        opened = win.open(url, '_blank', 'noopener,noreferrer')
      } catch (error) {
        throw redactedNativeError(error)
      }
      if (opened === null) throw nativeCapabilityError('user_activation_required')
      return { opened: true }
    },
    [AURORA_NATIVE_TOOL_IDS.showNotification]: (args) => {
      const notification = requirePort(options.notification, 'permission_unavailable')
      if (notification.permission !== 'granted') throw nativeCapabilityError('permission_denied')
      try {
        const body = optionalString(args.body)
        notification.show(requireString(args.title), body ? { body } : undefined)
        return { shown: true }
      } catch (error) {
        throw redactedNativeError(error)
      }
    },
    [AURORA_NATIVE_TOOL_IDS.pickDocument]: async (args) => {
      const filePicker = requirePort(options.filePicker, 'unsupported_platform')
      if (!filePicker.showOpenFilePicker) throw nativeCapabilityError('unsupported_platform')
      try {
        const types = acceptPickerTypes(args.accept)
        const handles = await filePicker.showOpenFilePicker({ multiple: args.multiple === true, ...(types ? { types } : {}) })
        const picked = handles.slice(0, args.multiple === true ? 25 : 1).map((handle) => {
          const documentId = newDocumentId(randomId)
          const grant = sanitizeGrant(handle)
          documents.set(documentId, { ...grant, handle })
          return { documentId, ...(grant.name ? { name: grant.name } : {}), ...(grant.mimeType ? { mimeType: grant.mimeType } : {}) }
        })
        return { documents: picked }
      } catch (error) {
        throw redactedNativeError(error)
      }
    },
    [AURORA_NATIVE_TOOL_IDS.readGrantedDocument]: async (args) => {
      const grant = requireDocumentGrant(documents, args.documentId)
      try {
        const file = await grant.handle.getFile()
        return { content: await file.text(), ...(safeMimeType(file.type ?? grant.mimeType) ? { mimeType: safeMimeType(file.type ?? grant.mimeType) } : {}) }
      } catch (error) {
        throw redactedNativeError(error)
      }
    },
    [AURORA_NATIVE_TOOL_IDS.writeGrantedDocument]: async (args) => {
      const grant = requireDocumentGrant(documents, args.documentId)
      if (!grant.handle.createWritable) throw nativeCapabilityError('permission_unavailable')
      try {
        const stream = await grant.handle.createWritable()
        await stream.write(requireString(args.content))
        await stream.close()
        return { written: true }
      } catch (error) {
        throw redactedNativeError(error)
      }
    },
    [AURORA_NATIVE_TOOL_IDS.getClipboardText]: async () => {
      const clipboard = requirePort(options.navigator?.clipboard, 'permission_unavailable')
      try {
        return { text: await clipboard.readText() }
      } catch (error) {
        throw redactedNativeError(error)
      }
    },
    [AURORA_NATIVE_TOOL_IDS.setClipboardText]: async (args) => {
      const clipboard = requirePort(options.navigator?.clipboard, 'permission_unavailable')
      try {
        await clipboard.writeText(requireString(args.text))
        return { written: true }
      } catch (error) {
        throw redactedNativeError(error)
      }
    },
    [AURORA_NATIVE_TOOL_IDS.getDeviceStatus]: async () => {
      const nav = requirePort(options.navigator, 'capability_unavailable')
      const status: JsonObject = { online: nav.onLine !== false }
      try {
        const battery = await nav.getBattery?.()
        if (typeof battery?.level === 'number') status.batteryLevel = clamp(battery.level, 0, 1)
        if (typeof battery?.charging === 'boolean') status.charging = battery.charging
      } catch {
        // Battery is optional; device status remains useful without it.
      }
      return status
    },
  }
}

function buildBrowserNativeCapabilityManifest(
  snapshot: LocalNativeCapabilitySnapshot,
  generatedAt: string,
): NativeCapabilityManifest {
  const permissions: Record<string, boolean> = {}
  const permissionStates: Record<string, 'available'> = {}
  const capabilities: Record<string, boolean> = {}
  const capabilityStates: Record<string, 'available'> = {}

  for (const [toolId, evidence] of Object.entries(snapshot)) {
    if (!evidence || evidence.state !== 'available') continue
    capabilities[evidence.capabilityId] = true
    capabilityStates[evidence.capabilityId] = 'available'
    for (const permission of evidence.requiredOsPermissions ?? []) {
      permissions[`browser.${permission}`] = true
      permissionStates[`browser.${permission}`] = 'available'
    }
    for (const descriptorPermission of descriptorRequiredPermissions(toolId as AuroraNativeToolId)) {
      permissions[descriptorPermission] = true
      permissionStates[descriptorPermission] = 'available'
    }
  }

  return {
    platform: 'browser',
    permissions,
    capabilities,
    permissionStates,
    capabilityStates,
    evidenceSource: 'browser-native-capability-pack',
    secretsRedacted: true,
    policyNotes: [`generated_at:${generatedAt}`],
  }
}

function filterSnapshot(snapshot: LocalNativeCapabilitySnapshot, registeredToolIds: readonly AuroraNativeToolId[]): LocalNativeCapabilitySnapshot {
  return Object.fromEntries(registeredToolIds.map((toolId) => [toolId, snapshot[toolId]])) as LocalNativeCapabilitySnapshot
}

function capability(
  toolId: AuroraNativeToolId,
  state: LocalNativeCapabilityState,
  requiredOsPermissions: readonly string[] = [],
) {
  return { capabilityId: toolId, state, requiredOsPermissions }
}

function descriptorRequiredPermissions(toolId: AuroraNativeToolId): string[] {
  return [...(NATIVE_TOOL_DESCRIPTORS.find((descriptor) => descriptor.toolContractId === toolId)?.requiredPermissions ?? [])]
}

function canShareText(nav: BrowserNavigatorPort): boolean {
  try {
    return nav.canShare ? nav.canShare({ text: 'Aurora' }) : true
  } catch {
    return false
  }
}

function hasApprovedDeepLinkScope(options: BrowserNativeCapabilityPackOptions): boolean {
  return approvedDeepLinkRules(options).length > 0 || (options.allowCurrentOriginDeepLinks !== false && currentHttpsOrigin(options) !== null)
}

function isApprovedDeepLink(value: string, options: BrowserNativeCapabilityPackOptions): boolean {
  let url: URL
  try {
    url = new URL(value, options.window?.location?.href)
  } catch {
    return false
  }
  if (!DEFAULT_APPROVED_PROTOCOLS.has(url.protocol)) return false
  if (approvedDeepLinkRules(options).some((rule) => deepLinkMatchesRule(url, rule))) return true
  const currentOrigin = currentHttpsOrigin(options)
  return options.allowCurrentOriginDeepLinks !== false && url.protocol === 'https:' && currentOrigin !== null && url.origin === currentOrigin
}

function approvedDeepLinkRules(options: BrowserNativeCapabilityPackOptions): ApprovedDeepLinkRule[] {
  return (options.approvedDeepLinks ?? [])
    .map((value) => approvedDeepLinkRule(value))
    .filter((rule): rule is ApprovedDeepLinkRule => Boolean(rule))
}

function approvedDeepLinkRule(value: string): ApprovedDeepLinkRule | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (!DEFAULT_APPROVED_PROTOCOLS.has(url.protocol)) return null
  if (url.username || url.password) return null
  if (url.protocol === 'https:') {
    return {
      protocol: url.protocol,
      origin: url.origin,
      route: normalizePath(url.pathname),
      subtree: url.pathname.endsWith('/') && url.pathname !== '/',
    }
  }
  return {
    protocol: url.protocol,
    origin: null,
    route: customSchemeRoute(url),
    subtree: false,
  }
}

function deepLinkMatchesRule(url: URL, rule: ApprovedDeepLinkRule): boolean {
  if (url.protocol !== rule.protocol) return false
  if (rule.protocol === 'https:') {
    if (url.origin !== rule.origin) return false
    const path = normalizePath(url.pathname)
    return rule.subtree ? path.startsWith(rule.route) : path === rule.route
  }
  return customSchemeRoute(url) === rule.route
}

function normalizePath(value: string): string {
  return value || '/'
}

function customSchemeRoute(url: URL): string {
  if (url.protocol === 'mailto:' || url.protocol === 'tel:') return url.pathname
  return `${url.hostname}${normalizePath(url.pathname)}`
}

function currentHttpsOrigin(options: BrowserNativeCapabilityPackOptions): string | null {
  const origin = options.window?.location?.origin
  return origin?.startsWith('https://') ? origin : null
}

function hasGrantedPermission(options: BrowserNativeCapabilityPackOptions, permission: BrowserNativePermissionName): boolean {
  return options.permissionStates?.[permission] === 'granted'
}

function requireDocumentGrant(documents: Map<string, DocumentGrant>, value: JsonValue | undefined): DocumentGrant {
  const documentId = requireString(value)
  if (!DOCUMENT_ID_RE.test(documentId)) throw nativeCapabilityError('permission_denied')
  const grant = documents.get(documentId)
  if (!grant) throw nativeCapabilityError('permission_denied')
  return grant
}

function sanitizeGrant(handle: BrowserFileHandle): Omit<DocumentGrant, 'handle'> {
  const name = safeDocumentName(handle.name)
  return { name, mimeType: null }
}

function acceptPickerTypes(value: JsonValue | undefined): readonly BrowserFilePickerAcceptType[] | undefined {
  if (!Array.isArray(value)) return undefined
  const extensions = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^\.[a-z0-9]{1,16}$/u.test(item))
    .slice(0, 32)
  if (extensions.length === 0) return undefined
  return [{ description: 'Documents', accept: { 'application/octet-stream': extensions } }]
}

function redactedNativeError(error: unknown): Error {
  return nativeCapabilityError(mapBrowserNativeCapabilityError(error))
}

function requirePort<T>(value: T | null | undefined, reasonCode: BrowserNativeCapabilityErrorCode): T {
  if (!value) throw nativeCapabilityError(reasonCode)
  return value
}

function requireString(value: JsonValue | undefined): string {
  if (typeof value !== 'string' || value.length === 0) throw nativeCapabilityError('capability_unavailable')
  return value
}

function optionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function safeDocumentName(value: string | undefined): string | null {
  if (!value) return null
  const name = value.split(/[\\/]/u).pop()?.slice(0, 512).trim()
  return name && name !== '.' && name !== '..' ? name : null
}

function safeMimeType(value: string | null | undefined): string | undefined {
  return value && /^[a-z0-9][a-z0-9.+-]{0,126}\/[a-z0-9][a-z0-9.+-]{0,126}$/iu.test(value) ? value.slice(0, 256) : undefined
}

function isDomExceptionName(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name
}

function newDocumentId(randomId: () => string): string {
  const id = randomId().replace(/[^A-Za-z0-9_-]/gu, '')
  if (id.length < 16) throw nativeCapabilityError('capability_unavailable')
  return `doc_${id.padEnd(16, '0').slice(0, 96)}`
}

function secureRandomId(cryptoRef: BrowserCryptoPort | undefined = globalThis.crypto): string {
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID()
  if (cryptoRef?.getRandomValues) {
    const bytes = cryptoRef.getRandomValues(new Uint8Array(24))
    return base64Url(bytes)
  }
  throw nativeCapabilityError('capability_unavailable')
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function assertBrowserNativeCapabilityErrorCode(value: string): asserts value is BrowserNativeCapabilityErrorCode {
  if (!ERROR_CODES.has(value as BrowserNativeCapabilityErrorCode)) {
    throw new TypeError('Unsupported browser native capability error code')
  }
}
