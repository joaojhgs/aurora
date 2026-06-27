import { AuroraError, classifyHttpError, readDetailCode, type AuroraErrorCode } from './errors.js'
import {
  createEventSubscription,
  eventFromUnknown,
  type AuroraEventSubscription,
  type AuroraStreamRequest
} from './events.js'
import type { AuroraTransport, AuroraTransportRequest, AuroraTransportResponse } from './transport.js'
import type {
  AndroidAssistantRoleRequestResult,
  AndroidAssistantRoleStatus,
  AndroidEntrypointPayload,
  AndroidFallbackEntrypoint,
  AndroidLocalLightInferenceStatus,
  AndroidNativePermissionRequestResult,
  AndroidVoiceForegroundServiceRequestResult,
  AndroidVoiceForegroundServiceStatus,
  AuditReceipt,
  AuroraEvent,
  AuroraTransportEnvelope,
  IOSEntrypointPayload,
  IOSInvocationStatus,
  JsonObject,
  NativeCapabilityManifest
} from './types.js'

export type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

export interface TauriCommandNames {
  request: string
  sidecarSession: string
  sidecarStart: string
  sidecarStop: string
  sidecarStatus: string
  nativeCapabilityManifest: string
  androidAssistantRoleStatus: string
  androidAssistantRoleRequest: string
  androidFallbackEntrypoints: string
  androidLocalLightInferenceStatus: string
  androidPermissionRequest: string
  androidVoiceForegroundServiceStatus: string
  androidVoiceForegroundServiceStart: string
  androidVoiceForegroundServiceStop: string
  androidEntrypointPayload: string
  iosEntrypointPayload: string
  nativePermissionStatus: string
  trayStatus: string
  notificationStatus: string
  notificationSend: string
  iosVoiceStatus: string
  iosBackgroundStatus: string
  dialogStatus: string
  audioBridgeStatus: string
  androidBaselineStatus: string
  iosNativePluginManifest: string
  iosInvocationStatus: string
  iosLocalLightInferenceStatus: string
  iosInvokeAction: string
  logTail: string
  secureStorageGet: string
  secureStorageSet: string
  secureStorageDelete: string
  iosSecureStorageStatus: string
  iosBiometricStatus: string
  iosAdminUnlock: string
  biometricAdminUnlockStatus: string
  biometricAdminUnlock: string
  localFileRead: string
  localFileWrite: string
  localFilePick: string
  secureFileHandleOpen: string
  eventSubscribe: string
}

export interface TauriLocalTransportOptions {
  invoke?: TauriInvoke
  commands?: Partial<TauriCommandNames>
  requestArgName?: string
  defaultTimeoutMs?: number
}

export interface TauriSidecarStatus {
  running: boolean
  mode?: 'threads' | 'processes' | 'sidecar' | string
  pid?: number | null
  gatewayUrl?: string | null
  version?: string | null
  lastError?: string | null
  details?: JsonObject
}

export interface TauriLogTailRequest {
  lines?: number
}

export interface TauriLogTailResult {
  available: boolean
  source: string
  lines: string[]
  truncated: boolean
  reason?: string | null
  maxLines?: number
}

export interface TauriSidecarSession {
  token: string
}

export interface TauriNativePermissionStatus {
  platform: string
  permissions: Record<string, boolean>
  capabilities: Record<string, boolean>
  deniedByDefault: string[]
  privacyClasses: string[]
  evidenceSource: string
  secretsRedacted: boolean
}

export interface TauriNativeFeatureStatus {
  available: boolean
  permission: string
  capability: string
  source: string
  reason?: string | null
  details?: JsonObject
}

export interface TauriAndroidAssistantRoleStatus {
  roleAvailable?: boolean | null
  packageQualified?: boolean | null
  roleHeld?: boolean | null
  requestable?: boolean | null
  denied?: boolean | null
  oemUnavailable?: boolean | null
  probeImplemented: boolean
  reason: string
}

export interface TauriAndroidBaselineStatus {
  platform: string
  state: 'available' | 'needs_native_permission' | 'unsupported_platform' | 'degraded' | 'fallback' | string
  feature: string
  available: boolean
  assistantRole: TauriAndroidAssistantRoleStatus
  fallbackEntrypoints: Record<string, boolean>
  evidenceSource: string
  secretsRedacted: boolean
}

export type IosAuroraActionId =
  | 'app-intent.open-assistant'
  | 'shortcut.open-assistant'
  | 'share.import-context'
  | 'deeplink.open'

export interface TauriIosInvocationStatus {
  available: boolean
  surface: string
  supportedActions: IosAuroraActionId[]
  siriReplacement: false
  requiresBackendEvidence: boolean
  secretsRedacted: boolean
}

export interface TauriIosInvokeActionRequest {
  action: IosAuroraActionId
  correlationId?: string
}

export interface TauriIosInvokeActionResult {
  accepted: boolean
  action: string
  handoff?: string
  reason?: string
  correlationId?: string
  secretsRedacted: boolean
}

export interface TauriNotificationRequest {
  title: string
  body: string
}

export interface SecureStorageGetResult {
  key: string
  value: string | null
}

export interface SecureStorageWriteResult {
  key: string
  ok: boolean
}

export interface IosAdminUnlockRequest {
  reason: string
  action?: string
  correlationId?: string
  allowDeviceCredential?: boolean
}

export interface BiometricAdminUnlockStatus {
  platform: 'android' | 'ios' | string
  available: boolean
  requestable: boolean
  deviceSecure: boolean
  biometricReady: boolean
  lastDenied: boolean
  state: 'available' | 'needs_native_permission' | 'unsupported_platform' | 'degraded' | 'fallback' | string
  reason: string
  privacyClass: 'admin-critical' | string
  evidenceSource: string
  secretsRedacted: boolean
}

export interface BiometricAdminUnlockResult {
  started: boolean
  requestCode?: number
  status: BiometricAdminUnlockStatus
  reason: string
  secretsRedacted: boolean
}

export interface LocalFileReadOptions {
  encoding?: 'utf-8' | 'base64' | 'bytes'
}

export interface LocalFileReadResult {
  path: string
  data: string | number[]
  encoding: 'utf-8' | 'base64' | 'bytes'
}

export interface LocalFileWriteOptions {
  encoding?: 'utf-8' | 'base64' | 'bytes'
  createDirs?: boolean
}

export interface LocalFileWriteResult {
  path: string
  bytesWritten?: number
  ok: boolean
}

export interface LocalFilePickOptions {
  multiple?: boolean
  directory?: boolean
  filters?: Array<{ name: string; extensions: string[] }>
}

export interface LocalFilePickResult {
  paths: string[]
  cancelled: boolean
}

export interface SecureFileHandleOpenOptions extends LocalFilePickOptions {
  mode?: 'read' | 'write' | 'readwrite'
}

const DEFAULT_COMMANDS: TauriCommandNames = {
  request: 'aurora_command',
  sidecarSession: 'aurora_sidecar_session',
  sidecarStart: 'aurora_sidecar_start',
  sidecarStop: 'aurora_sidecar_stop',
  sidecarStatus: 'aurora_sidecar_status',
  nativeCapabilityManifest: 'aurora_native_capability_manifest',
  androidAssistantRoleStatus: 'assistantRoleStatus',
  androidAssistantRoleRequest: 'requestAssistantRole',
  androidFallbackEntrypoints: 'fallbackEntrypoints',
  androidLocalLightInferenceStatus: 'localLightInferenceStatus',
  androidPermissionRequest: 'requestAndroidPermission',
  androidVoiceForegroundServiceStatus: 'voiceForegroundServiceStatus',
  androidVoiceForegroundServiceStart: 'startVoiceForegroundService',
  androidVoiceForegroundServiceStop: 'stopVoiceForegroundService',
  androidEntrypointPayload: 'entrypointPayload',
  iosEntrypointPayload: 'aurora_ios_entrypoint_payload',
  nativePermissionStatus: 'aurora_native_permission_status',
  trayStatus: 'aurora_tray_status',
  notificationStatus: 'aurora_notification_status',
  notificationSend: 'aurora_notification_send',
  iosVoiceStatus: 'aurora_ios_voice_status',
  iosBackgroundStatus: 'aurora_ios_background_status',
  dialogStatus: 'aurora_dialog_status',
  audioBridgeStatus: 'aurora_audio_bridge_status',
  androidBaselineStatus: 'aurora_android_baseline_status',
  iosNativePluginManifest: 'aurora_ios_native_plugin_manifest',
  iosInvocationStatus: 'aurora_ios_invocation_status',
  iosLocalLightInferenceStatus: 'aurora_ios_local_light_inference_status',
  iosInvokeAction: 'aurora_ios_invoke_action',
  logTail: 'aurora_log_tail',
  secureStorageGet: 'aurora_secure_storage_get',
  secureStorageSet: 'aurora_secure_storage_set',
  secureStorageDelete: 'aurora_secure_storage_delete',
  iosSecureStorageStatus: 'aurora_ios_secure_storage_status',
  iosBiometricStatus: 'aurora_ios_biometric_status',
  iosAdminUnlock: 'aurora_ios_admin_unlock',
  biometricAdminUnlockStatus: 'aurora_biometric_admin_unlock_status',
  biometricAdminUnlock: 'aurora_biometric_admin_unlock',
  localFileRead: 'aurora_local_file_read',
  localFileWrite: 'aurora_local_file_write',
  localFilePick: 'aurora_local_file_pick',
  secureFileHandleOpen: 'aurora_secure_file_handle_open',
  eventSubscribe: 'aurora_subscribe'
}

export class TauriLocalTransport implements AuroraTransport {
  readonly kind = 'tauri-local'
  readonly commands: TauriCommandNames
  private readonly invokeImpl: TauriInvoke
  private readonly requestArgName: string
  private readonly defaultTimeoutMs: number
  private sidecarSession: Promise<TauriSidecarSession | null> | null = null

  constructor(options: TauriLocalTransportOptions = {}) {
    this.invokeImpl = options.invoke ?? resolveTauriInvoke()
    this.commands = { ...DEFAULT_COMMANDS, ...options.commands }
    this.requestArgName = options.requestArgName ?? 'request'
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000
  }

  async request<TData = unknown, TPayload = unknown>(
    request: AuroraTransportRequest<TPayload>
  ): Promise<AuroraTransportResponse<TData>> {
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs
    const sidecarSession = await this.getSidecarSession()
    const args = { [this.requestArgName]: withSidecarSessionHeader(request, sidecarSession) }
    const context: TauriInvokeContext = { timeoutMs, method: request.method }
    if (request.signal !== undefined) context.signal = request.signal
    if (request.busTopic !== undefined) context.busTopic = request.busTopic
    const value = await this.invokeCommand<unknown>(this.commands.request, args, context)
    const envelope = toTransportEnvelope<TData>(value)
    return {
      ...envelope,
      audit: {
        ...envelope.audit,
        method: envelope.audit?.method ?? request.method,
        busTopic: envelope.audit?.busTopic ?? request.busTopic ?? null,
        transport: this.kind
      }
    }
  }

  getSidecarStatus(): Promise<TauriSidecarStatus> {
    return this.invokeCommand<TauriSidecarStatus>(this.commands.sidecarStatus)
  }

  async startSidecar(): Promise<TauriSidecarStatus> {
    const commandToken = await this.requireSidecarSession()
    return this.invokeCommand<TauriSidecarStatus>(this.commands.sidecarStart, { commandToken })
  }

  async stopSidecar(): Promise<TauriSidecarStatus> {
    const commandToken = await this.requireSidecarSession()
    return this.invokeCommand<TauriSidecarStatus>(this.commands.sidecarStop, { commandToken })
  }

  getNativeCapabilityManifest(): Promise<NativeCapabilityManifest> {
    return this.invokeCommand<NativeCapabilityManifest>(this.commands.nativeCapabilityManifest)
  }

  getAndroidAssistantRoleStatus(): Promise<AndroidAssistantRoleStatus> {
    return this.invokeCommand<AndroidAssistantRoleStatus>(this.commands.androidAssistantRoleStatus)
  }

  requestAndroidAssistantRole(): Promise<AndroidAssistantRoleRequestResult> {
    return this.invokeCommand<AndroidAssistantRoleRequestResult>(this.commands.androidAssistantRoleRequest)
  }

  getAndroidFallbackEntrypoints(): Promise<AndroidFallbackEntrypoint[]> {
    return this.invokeCommand<AndroidFallbackEntrypoint[]>(this.commands.androidFallbackEntrypoints)
  }

  getAndroidLocalLightInferenceStatus(): Promise<AndroidLocalLightInferenceStatus> {
    return this.invokeCommand<AndroidLocalLightInferenceStatus>(this.commands.androidLocalLightInferenceStatus)
  }

  requestAndroidPermission(permission: string): Promise<AndroidNativePermissionRequestResult> {
    return this.invokeCommand<AndroidNativePermissionRequestResult>(this.commands.androidPermissionRequest, { permission })
  }

  getAndroidVoiceForegroundServiceStatus(): Promise<AndroidVoiceForegroundServiceStatus> {
    return this.invokeCommand<AndroidVoiceForegroundServiceStatus>(this.commands.androidVoiceForegroundServiceStatus)
  }

  startAndroidVoiceForegroundService(): Promise<AndroidVoiceForegroundServiceRequestResult> {
    return this.invokeCommand<AndroidVoiceForegroundServiceRequestResult>(this.commands.androidVoiceForegroundServiceStart)
  }

  stopAndroidVoiceForegroundService(): Promise<AndroidVoiceForegroundServiceRequestResult> {
    return this.invokeCommand<AndroidVoiceForegroundServiceRequestResult>(this.commands.androidVoiceForegroundServiceStop)
  }

  getAndroidEntrypointPayload(): Promise<{
    payload: AndroidEntrypointPayload
    entrypoints: NonNullable<NativeCapabilityManifest['entrypoints']>
    evidenceSource: string
    secretsRedacted: boolean
  }> {
    return this.invokeCommand(this.commands.androidEntrypointPayload)
  }

  getIOSEntrypointPayload(): Promise<{
    payload: IOSEntrypointPayload
    entrypoints: NonNullable<NativeCapabilityManifest['entrypoints']>
    evidenceSource: string
    secretsRedacted: boolean
  }> {
    return this.invokeCommand(this.commands.iosEntrypointPayload)
  }

  getNativePermissionStatus(): Promise<TauriNativePermissionStatus> {
    return this.invokeCommand<TauriNativePermissionStatus>(this.commands.nativePermissionStatus)
  }

  getTrayStatus(): Promise<TauriNativeFeatureStatus> {
    return this.invokeCommand<TauriNativeFeatureStatus>(this.commands.trayStatus)
  }

  getNotificationStatus(): Promise<TauriNativeFeatureStatus> {
    return this.invokeCommand<TauriNativeFeatureStatus>(this.commands.notificationStatus)
  }

  sendNotification(request: TauriNotificationRequest): Promise<TauriNativeFeatureStatus> {
    return this.invokeCommand<TauriNativeFeatureStatus>(this.commands.notificationSend, { request })
  }

  getIosVoiceStatus(): Promise<TauriNativeFeatureStatus> {
    return this.invokeCommand<TauriNativeFeatureStatus>(this.commands.iosVoiceStatus)
  }

  getIosBackgroundStatus(): Promise<TauriNativeFeatureStatus> {
    return this.invokeCommand<TauriNativeFeatureStatus>(this.commands.iosBackgroundStatus)
  }

  getDialogStatus(): Promise<TauriNativeFeatureStatus> {
    return this.invokeCommand<TauriNativeFeatureStatus>(this.commands.dialogStatus)
  }

  getAudioBridgeStatus(): Promise<TauriNativeFeatureStatus> {
    return this.invokeCommand<TauriNativeFeatureStatus>(this.commands.audioBridgeStatus)
  }

  getAndroidBaselineStatus(): Promise<TauriAndroidBaselineStatus> {
    return this.invokeCommand<TauriAndroidBaselineStatus>(this.commands.androidBaselineStatus)
  }

  getIosNativePluginManifest(): Promise<NativeCapabilityManifest> {
    return this.invokeCommand<NativeCapabilityManifest>(this.commands.iosNativePluginManifest)
  }

  getIosInvocationStatus(): Promise<TauriIosInvocationStatus> {
    return this.invokeCommand<TauriIosInvocationStatus>(this.commands.iosInvocationStatus)
  }

  getIosLocalLightInferenceStatus(): Promise<AndroidLocalLightInferenceStatus> {
    return this.invokeCommand<AndroidLocalLightInferenceStatus>(this.commands.iosLocalLightInferenceStatus)
  }

  invokeIosAuroraAction(request: TauriIosInvokeActionRequest): Promise<TauriIosInvokeActionResult> {
    return this.invokeCommand<TauriIosInvokeActionResult>(this.commands.iosInvokeAction, { request })
  }

  getLogTail(request: TauriLogTailRequest = {}): Promise<TauriLogTailResult> {
    return this.invokeCommand<TauriLogTailResult>(this.commands.logTail, { request })
  }

  secureStorageGet(key: string): Promise<SecureStorageGetResult> {
    return this.invokeCommand<SecureStorageGetResult>(this.commands.secureStorageGet, { key })
  }

  secureStorageSet(key: string, value: string): Promise<SecureStorageWriteResult> {
    return this.invokeCommand<SecureStorageWriteResult>(this.commands.secureStorageSet, { key, value })
  }

  secureStorageDelete(key: string): Promise<SecureStorageWriteResult> {
    return this.invokeCommand<SecureStorageWriteResult>(this.commands.secureStorageDelete, { key })
  }

  getIosSecureStorageStatus(): Promise<TauriNativeFeatureStatus> {
    return this.invokeCommand<TauriNativeFeatureStatus>(this.commands.iosSecureStorageStatus)
  }

  getIosBiometricStatus(): Promise<TauriNativeFeatureStatus> {
    return this.invokeCommand<TauriNativeFeatureStatus>(this.commands.iosBiometricStatus)
  }

  iosAdminUnlock(request: IosAdminUnlockRequest): Promise<TauriNativeFeatureStatus> {
    return this.invokeCommand<TauriNativeFeatureStatus>(this.commands.iosAdminUnlock, { request })
  }

  getBiometricAdminUnlockStatus(): Promise<BiometricAdminUnlockStatus> {
    return this.invokeCommand<BiometricAdminUnlockStatus>(this.commands.biometricAdminUnlockStatus)
  }

  requestBiometricAdminUnlock(): Promise<BiometricAdminUnlockResult> {
    return this.invokeCommand<BiometricAdminUnlockResult>(this.commands.biometricAdminUnlock)
  }

  readLocalFile(path: string, options: LocalFileReadOptions = {}): Promise<LocalFileReadResult> {
    return this.invokeCommand<LocalFileReadResult>(this.commands.localFileRead, { path, options })
  }

  writeLocalFile(
    path: string,
    data: string | number[],
    options: LocalFileWriteOptions = {}
  ): Promise<LocalFileWriteResult> {
    return this.invokeCommand<LocalFileWriteResult>(this.commands.localFileWrite, { path, data, options })
  }

  pickLocalFile(options: LocalFilePickOptions = {}): Promise<LocalFilePickResult> {
    return this.invokeCommand<LocalFilePickResult>(this.commands.localFilePick, { options })
  }

  openSecureFileHandle(options: SecureFileHandleOpenOptions = {}): Promise<LocalFilePickResult> {
    return this.invokeCommand<LocalFilePickResult>(this.commands.secureFileHandleOpen, { options })
  }

  async subscribe<TEventPayload = unknown, TPayload = unknown>(
    request: AuroraStreamRequest<TPayload>
  ): Promise<AuroraEventSubscription<TEventPayload>> {
    const context: TauriInvokeContext = { method: this.commands.eventSubscribe }
    if (request.topics[0] !== undefined) context.busTopic = request.topics[0]
    const response = await this.invokeCommand<unknown>(
      this.commands.eventSubscribe,
      { [this.requestArgName]: request },
      context
    )
    return createEventSubscription(normalizeTauriEvents<TEventPayload>(response, request))
  }

  async invokeNative<TResponse = unknown>(
    command: string,
    args?: Record<string, unknown>
  ): Promise<TResponse> {
    return this.invokeCommand<TResponse>(command, args)
  }

  private async invokeCommand<TResponse>(
    command: string,
    args?: Record<string, unknown>,
    context: TauriInvokeContext = {}
  ): Promise<TResponse> {
    try {
      const timeoutOptions: TauriTimeoutOptions = { command }
      if (context.timeoutMs !== undefined) timeoutOptions.timeoutMs = context.timeoutMs
      if (context.signal !== undefined) timeoutOptions.signal = context.signal
      return await withTimeout(this.invokeImpl(command, args).then((value) => value as TResponse), timeoutOptions)
    } catch (error) {
      throw normalizeTauriError(error, {
        method: context.method ?? command,
        busTopic: context.busTopic
      })
    }
  }

  private async requireSidecarSession(): Promise<TauriSidecarSession> {
    const session = await this.getSidecarSession()
    if (!session) {
      throw new AuroraError({
        code: 'native_permission_missing',
        message: 'Tauri sidecar session command is unavailable.'
      })
    }
    return session
  }

  private async getSidecarSession(): Promise<TauriSidecarSession | null> {
    this.sidecarSession ??= withTimeout(
      this.invokeImpl(this.commands.sidecarSession).then((value) => value as TauriSidecarSession),
      { command: this.commands.sidecarSession, timeoutMs: 250 }
    ).catch(() => null)
    return this.sidecarSession
  }
}

function withSidecarSessionHeader<TPayload>(
  request: AuroraTransportRequest<TPayload>,
  session: TauriSidecarSession | null
): AuroraTransportRequest<TPayload> {
  if (!session?.token) return request
  return {
    ...request,
    headers: {
      ...request.headers,
      'x-aurora-sidecar-token': session.token
    }
  }
}

async function* normalizeTauriEvents<TPayload>(
  response: unknown,
  request: AuroraStreamRequest
): AsyncIterable<AuroraEvent<TPayload>> {
  if (isAsyncIterable<AuroraEvent<TPayload> | Record<string, unknown>>(response)) {
    for await (const raw of response) {
      yield eventFromUnknown<TPayload>(raw, { kind: request.stream, transport: 'tauri-local', audit: request.audit })
    }
    return
  }
  if (isIterable<AuroraEvent<TPayload> | Record<string, unknown>>(response)) {
    for (const raw of response) {
      yield eventFromUnknown<TPayload>(raw, { kind: request.stream, transport: 'tauri-local', audit: request.audit })
    }
    return
  }
  throw new AuroraError({
    code: 'unsupported_feature',
    message: 'Tauri event subscribe command must return an iterable event stream.'
  })
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value
}

function isIterable<T>(value: unknown): value is Iterable<T> {
  return typeof value === 'object' && value !== null && Symbol.iterator in value
}

interface TauriInvokeContext {
  timeoutMs?: number
  signal?: AbortSignal
  method?: string
  busTopic?: string
}

function resolveTauriInvoke(): TauriInvoke {
  const tauri = (globalThis as { __TAURI__?: { core?: { invoke?: TauriInvoke }; invoke?: TauriInvoke } }).__TAURI__
  const invoke = tauri?.core?.invoke ?? tauri?.invoke
  if (!invoke) {
    throw new AuroraError({
      code: 'unsupported_feature',
      message: 'Tauri invoke is unavailable; pass an invoke implementation to TauriLocalTransport.'
    })
  }
  return invoke
}

function toTransportEnvelope<TData>(value: unknown): AuroraTransportEnvelope<TData> {
  if (isTransportEnvelope<TData>(value)) return value
  return { data: value as TData }
}

function isTransportEnvelope<TData>(value: unknown): value is AuroraTransportEnvelope<TData> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'data' in value &&
    ('status' in value || 'headers' in value || 'audit' in value)
  )
}

interface TauriTimeoutOptions {
  timeoutMs?: number
  signal?: AbortSignal
  command: string
}

async function withTimeout<TResponse>(promise: Promise<TResponse>, options: TauriTimeoutOptions): Promise<TResponse> {
  const racers: Array<Promise<TResponse>> = [promise]
  let timeout: ReturnType<typeof setTimeout> | undefined

  if (options.timeoutMs !== undefined) {
    racers.push(
      new Promise<TResponse>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new AuroraError({
              code: 'timeout',
              message: `Tauri command ${options.command} timed out after ${options.timeoutMs}ms`
            })
          )
        }, options.timeoutMs)
      })
    )
  }

  if (options.signal) {
    racers.push(
      new Promise<TResponse>((_, reject) => {
        if (options.signal?.aborted) {
          reject(new AuroraError({ code: 'timeout', message: `Tauri command ${options.command} was aborted` }))
          return
        }
        options.signal?.addEventListener(
          'abort',
          () => {
            reject(new AuroraError({ code: 'timeout', message: `Tauri command ${options.command} was aborted` }))
          },
          { once: true }
        )
      })
    )
  }

  try {
    return await Promise.race(racers)
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function normalizeTauriError(
  error: unknown,
  context: { method: string; busTopic?: string | undefined }
): AuroraError {
  if (error instanceof AuroraError) return enrichAuroraError(error, context)
  if (isAbortError(error)) {
    return new AuroraError({
      code: 'timeout',
      message: 'Tauri command timed out',
      method: context.method,
      busTopic: context.busTopic,
      cause: error
    })
  }
  if (error instanceof TypeError) {
    return new AuroraError({
      code: 'transport_loss',
      message: error.message,
      method: context.method,
      busTopic: context.busTopic,
      cause: error
    })
  }

  const detail = readErrorDetail(error)
  const status = readStatus(error)
  const code = classifyTauriError(status, detail)
  return new AuroraError({
    code,
    message: readErrorMessage(error, detail) ?? `Tauri command failed: ${context.method}`,
    status,
    method: context.method,
    busTopic: context.busTopic,
    correlationId: readCorrelationId(error, detail),
    detail,
    cause: error
  })
}

function enrichAuroraError(
  error: AuroraError,
  context: { method: string; busTopic?: string | undefined }
): AuroraError {
  return new AuroraError({
    code: error.code,
    message: error.message,
    status: error.status,
    method: error.method ?? context.method,
    busTopic: error.busTopic ?? context.busTopic,
    correlationId: error.correlationId,
    detail: error.detail,
    cause: error
  })
}

function classifyTauriError(status: number | undefined, detail: unknown): AuroraErrorCode {
  if (status !== undefined) return classifyHttpError(status, detail)
  const detailCode = readDetailCode(detail)?.toLowerCase()
  const text = readErrorMessage(detail, detail)?.toLowerCase() ?? ''
  if (detailCode?.includes('native_permission') || text.includes('native permission')) {
    return 'native_permission_missing'
  }
  if (detailCode?.includes('auth') || text.includes('authentication')) return 'auth'
  if (detailCode?.includes('permission') || text.includes('permission denied')) return 'permission'
  if (detailCode?.includes('validation') || text.includes('validation')) return 'validation'
  if (detailCode?.includes('timeout') || text.includes('timed out')) return 'timeout'
  if (detailCode?.includes('unavailable') || text.includes('unavailable')) return 'unavailable_service'
  if (detailCode?.includes('unsupported') || text.includes('unsupported')) return 'unsupported_feature'
  if (detailCode?.includes('privacy') || text.includes('privacy')) return 'privacy_blocked'
  return 'unknown'
}

function readErrorDetail(error: unknown): unknown {
  if (typeof error === 'object' && error !== null && 'detail' in error) return (error as { detail?: unknown }).detail
  return error
}

function readStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const status = (error as { status?: unknown; status_code?: unknown }).status ?? (error as { status_code?: unknown }).status_code
  return typeof status === 'number' ? status : undefined
}

function readCorrelationId(error: unknown, detail: unknown): string | undefined {
  return readString(error, 'correlationId', 'correlation_id') ?? readString(detail, 'correlationId', 'correlation_id') ?? undefined
}

function readErrorMessage(error: unknown, detail: unknown): string | null {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (typeof detail === 'string') return detail
  return (
    readString(detail, 'message', 'error', 'reason') ??
    readString(error, 'message', 'error', 'reason') ??
    null
  )
}

function readString(value: unknown, ...keys: string[]): string | null {
  if (typeof value !== 'object' || value === null) return null
  for (const key of keys) {
    const found = (value as Record<string, unknown>)[key]
    if (typeof found === 'string') return found
  }
  return null
}

function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') ||
    (typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      (error as { name?: unknown }).name === 'AbortError')
  )
}
