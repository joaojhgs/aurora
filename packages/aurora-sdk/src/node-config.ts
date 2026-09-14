import type { MeshAddressSelector, MeshRouteCandidate } from './mesh.js'

export const AURORA_NODE_CONFIG_VERSION = 1 as const
export const AURORA_NODE_CONFIG_STORAGE_KEY = 'aurora.nodeConfig.v1'

export const AURORA_NODE_CONFIG_MODULES = [
  'tooling',
  'tts',
  'stt',
  'orchestrator',
  'memory'
] as const

export type AuroraNodeConfigModule = (typeof AURORA_NODE_CONFIG_MODULES)[number]
export type AuroraNodeRoutingPreference = 'local' | 'network' | 'local_only' | 'network_only'
export type AuroraNodeRoutingFallback = 'local' | 'network' | 'error' | 'none'

/**
 * Maps the user-facing policy domains to the module IDs emitted by capability
 * discovery and accepted by the generated backend contracts. Keeping this
 * adapter centralized prevents policy keys from becoming wire identities.
 */
export const AURORA_NODE_RUNTIME_MODULES_BY_POLICY = {
  tooling: ['Tooling'],
  tts: ['TTS'],
  stt: ['STTCoordinator', 'Transcription'],
  orchestrator: ['Orchestrator'],
  memory: ['DB']
} as const

const AURORA_SPEECH_RUNTIME_MODULES_BY_STAGE: Record<AuroraSpeechStage, readonly string[]> = {
  kws: ['WakeWord'],
  vad: ['VAD'],
  stt: AURORA_NODE_RUNTIME_MODULES_BY_POLICY.stt,
  tts: AURORA_NODE_RUNTIME_MODULES_BY_POLICY.tts
}

export type AuroraNodeRuntimeModule =
  (typeof AURORA_NODE_RUNTIME_MODULES_BY_POLICY)[AuroraNodeConfigModule][number]

export function runtimeModulesForNodeConfigModule(
  module: AuroraNodeConfigModule
): readonly AuroraNodeRuntimeModule[] {
  return AURORA_NODE_RUNTIME_MODULES_BY_POLICY[module]
}

export function isRuntimeModuleForNodeConfigModule(
  module: AuroraNodeConfigModule,
  runtimeModule: unknown
): runtimeModule is AuroraNodeRuntimeModule {
  return typeof runtimeModule === 'string' &&
    (runtimeModulesForNodeConfigModule(module) as readonly string[]).includes(runtimeModule)
}

export interface AuroraNodeServiceRouting {
  prefer: AuroraNodeRoutingPreference
  fallback: AuroraNodeRoutingFallback
}

export interface AuroraNodeServiceExposure {
  enabled: boolean
}

export interface AuroraNodeServiceConfig {
  routing: AuroraNodeServiceRouting
  expose?: AuroraNodeServiceExposure
}

export type AuroraNodeFeatureOverride = AuroraNodeServiceExposure
export type AuroraNodeFeatureOverrides = Partial<Record<string, AuroraNodeFeatureOverride>>

export interface AuroraNodeConfigDocumentV1 {
  version: typeof AURORA_NODE_CONFIG_VERSION
  updatedAtMs: number
  services: Partial<Record<AuroraNodeConfigModule, AuroraNodeServiceConfig>>
  expose: {
    featureOverrides: Partial<Record<AuroraNodeConfigModule, AuroraNodeFeatureOverrides>>
  }
}

export interface AuroraNodeConfigStore {
  readonly evidence?: string
  load(): Promise<AuroraNodeConfigDocumentV1 | null>
  save(document: AuroraNodeConfigDocumentV1): Promise<void>
  clear?(): Promise<void>
}

export interface AuroraNodeConfigTauriTransport {
  nodeConfigGet(): Promise<{ key: string; value: string | null }>
  nodeConfigSet(value: string): Promise<{ key: string; ok: boolean }>
  nodeConfigDelete(): Promise<{ key: string; ok: boolean }>
  nodeConfigV2Get(): Promise<{ key: string; value: string | null }>
  nodeConfigV2Set(value: string): Promise<{ key: string; ok: boolean }>
  nodeConfigV2Delete(): Promise<{ key: string; ok: boolean }>
}

export interface AuroraNodeConfigSecureStorage {
  get(key: string): Promise<{ value: string | null }>
  set(key: string, value: string): Promise<{ ok: boolean }>
  delete(key: string): Promise<{ ok: boolean }>
}

export interface AuroraNodeConfigTauriStoreOptions {
  evidence?: string
}

export interface AuroraNodeLocalCapability {
  available: boolean
  reason?: string | null
}

export interface AuroraNodeRouteCandidate extends MeshRouteCandidate {
  selector?: MeshAddressSelector | null
}

/** Selector shape that can cross the generated speech and memory boundaries. */
export interface AuroraNodeWireSelector {
  peer_id: string
  provider_id?: string | null
  service_instance_id?: string | null
  resource_namespace?: string | null
  tool_id?: string | null
  data_scope?: string | null
  hardware_target?: string | null
  [key: string]: string | null | undefined
}

export type RouteCandidate = AuroraNodeRouteCandidate

export interface AuroraNodeRoutingResolutionRecord {
  module: AuroraNodeConfigModule
  stage?: AuroraSpeechStage
  preference: AuroraNodeRoutingPreference
  fallbackPolicy: AuroraNodeRoutingFallback
  decision: 'local' | 'remote'
  reason: string
  localAvailable: boolean
  remoteCandidateIds: string[]
  selectedCandidateId: string | null
  fallbackCandidateIds: string[]
  resolvedAtMs: number
}

export type AuroraNodeRoutingResolutionEmitter = (record: AuroraNodeRoutingResolutionRecord) => void

export interface ResolveServiceRoutingInput {
  module: AuroraNodeConfigModule
  stage?: AuroraSpeechStage
  config: AuroraNodeConfigDocumentV1
  localCapability: AuroraNodeLocalCapability
  remoteCandidates: readonly AuroraNodeRouteCandidate[]
  emit?: AuroraNodeRoutingResolutionEmitter
  now?: () => number
}

export interface ServiceRoutingResolution {
  attempt: AuroraNodeRoutingAttempt
  source: 'local' | 'remote'
  selector: AuroraNodeWireSelector | null
  fallback: AuroraNodeRoutingAttempt[]
  record: AuroraNodeRoutingResolutionRecord
}

export interface AuroraNodeRoutingAttempt {
  id: string
  source: 'local' | 'remote'
  selector: AuroraNodeWireSelector | null
  candidate: AuroraNodeRouteCandidate | null
}

export class AuroraNodeConfigValidationError extends Error {
  readonly path: string

  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'AuroraNodeConfigValidationError'
    this.path = path
  }
}

export class AuroraServiceRoutingError extends Error {
  readonly record: AuroraNodeRoutingResolutionRecord

  constructor(record: AuroraNodeRoutingResolutionRecord) {
    super(`No ${record.stage ?? record.module} route satisfies ${record.preference}/${record.fallbackPolicy}: ${record.reason}`)
    this.name = 'AuroraServiceRoutingError'
    this.record = record
  }
}

const DEFAULT_ROUTING: Record<AuroraNodeConfigModule, AuroraNodeServiceRouting> = {
  tooling: { prefer: 'local', fallback: 'network' },
  tts: { prefer: 'local', fallback: 'network' },
  stt: { prefer: 'local', fallback: 'network' },
  orchestrator: { prefer: 'local', fallback: 'network' },
  memory: { prefer: 'network_only', fallback: 'error' }
}

const DEFAULT_EXPOSURE: Record<AuroraNodeConfigModule, boolean> = {
  tooling: true,
  tts: false,
  stt: false,
  orchestrator: false,
  memory: false
}

const PREFERENCE_VALUES = new Set<AuroraNodeRoutingPreference>([
  'local',
  'network',
  'local_only',
  'network_only'
])

const FALLBACK_VALUES = new Set<AuroraNodeRoutingFallback>([
  'local',
  'network',
  'error',
  'none'
])

const MODULE_VALUES = new Set<string>(AURORA_NODE_CONFIG_MODULES)
const SAFE_FEATURE_ID = /^[A-Za-z0-9._:-]{1,128}$/u
const MAX_FEATURE_OVERRIDES = 256
const PROTOTYPE_SENSITIVE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export function emptyAuroraNodeConfigDocument(now = Date.now()): AuroraNodeConfigDocumentV1 {
  const services = Object.fromEntries(
    AURORA_NODE_CONFIG_MODULES.map((module) => [
      module,
      {
        routing: { ...DEFAULT_ROUTING[module] },
        expose: { enabled: DEFAULT_EXPOSURE[module] }
      }
    ])
  ) as AuroraNodeConfigDocumentV1['services']

  return {
    version: AURORA_NODE_CONFIG_VERSION,
    updatedAtMs: validateTimestamp(now, 'updatedAtMs'),
    services,
    expose: { featureOverrides: {} }
  }
}

export function isAuroraNodeConfigModule(value: unknown): value is AuroraNodeConfigModule {
  return typeof value === 'string' && MODULE_VALUES.has(value)
}

export function sanitizeAuroraNodeConfigDocument(document: unknown): AuroraNodeConfigDocumentV1 {
  const record = asRecord(document, 'document')
  assertExactKeys(record, ['version', 'updatedAtMs', 'services', 'expose'], 'document')
  if (record.version !== AURORA_NODE_CONFIG_VERSION) {
    throw new AuroraNodeConfigValidationError('document.version', 'must be 1')
  }

  const servicesRecord = asRecord(record.services, 'document.services')
  const services: AuroraNodeConfigDocumentV1['services'] = {}
  for (const [module, value] of Object.entries(servicesRecord)) {
    assertModule(module, `document.services.${module}`)
    services[module] = sanitizeServiceConfig(value, `document.services.${module}`)
  }

  const expose = asRecord(record.expose, 'document.expose')
  assertExactKeys(expose, ['featureOverrides'], 'document.expose')
  const overridesRecord = asRecord(expose.featureOverrides, 'document.expose.featureOverrides')
  const featureOverrides: AuroraNodeConfigDocumentV1['expose']['featureOverrides'] = {}
  let overrideCount = 0
  for (const [module, value] of Object.entries(overridesRecord)) {
    assertModule(module, `document.expose.featureOverrides.${module}`)
    const moduleOverrides = asRecord(value, `document.expose.featureOverrides.${module}`)
    const sanitized: AuroraNodeFeatureOverrides = {}
    for (const [featureId, featureValue] of Object.entries(moduleOverrides)) {
      overrideCount += 1
      if (overrideCount > MAX_FEATURE_OVERRIDES) {
        throw new AuroraNodeConfigValidationError('document.expose.featureOverrides', 'too many feature overrides')
      }
      if (!SAFE_FEATURE_ID.test(featureId) || PROTOTYPE_SENSITIVE_KEYS.has(featureId)) {
        throw new AuroraNodeConfigValidationError(
          `document.expose.featureOverrides.${module}.${featureId}`,
          'feature ID must contain only safe identifier characters'
        )
      }
      sanitized[featureId] = sanitizeExposure(featureValue, `document.expose.featureOverrides.${module}.${featureId}`)
    }
    featureOverrides[module] = sanitized
  }

  return {
    version: AURORA_NODE_CONFIG_VERSION,
    updatedAtMs: validateTimestamp(record.updatedAtMs, 'document.updatedAtMs'),
    services,
    expose: { featureOverrides }
  }
}

export function migrateAuroraNodeConfigDocument(
  value: unknown,
  now = Date.now()
): AuroraNodeConfigDocumentV1 {
  if (value === null || value === undefined) return emptyAuroraNodeConfigDocument(now)
  const record = asRecord(value, 'document')
  if (record.version === AURORA_NODE_CONFIG_VERSION) return sanitizeAuroraNodeConfigDocument(record)
  if (record.version !== undefined && record.version !== 0) {
    throw new AuroraNodeConfigValidationError('document.version', 'unsupported version')
  }

  const defaults = emptyAuroraNodeConfigDocument(now)
  const legacyServices = record.services
  if (legacyServices !== undefined) {
    const servicesRecord = asRecord(legacyServices, 'document.services')
    const services: Record<string, unknown> = {}
    for (const [module, valueForModule] of Object.entries(servicesRecord)) {
      if (!isAuroraNodeConfigModule(module)) continue
      const legacy = asRecord(valueForModule, `document.services.${module}`)
      const routing = legacy.routing === undefined ? legacy : asRecord(legacy.routing, `document.services.${module}.routing`)
      services[module] = {
        routing: {
          prefer: routing.prefer ?? defaults.services[module]?.routing.prefer,
          fallback: routing.fallback ?? defaults.services[module]?.routing.fallback
        },
        ...(legacy.expose === undefined ? {} : { expose: legacy.expose })
      }
    }
    const candidate = {
      ...defaults,
      updatedAtMs: typeof record.updatedAtMs === 'number' ? record.updatedAtMs : now,
      services: { ...defaults.services, ...services },
      expose: record.expose ?? defaults.expose
    }
    return sanitizeAuroraNodeConfigDocument(candidate)
  }
  return defaults
}

export function serializeAuroraNodeConfigDocument(document: AuroraNodeConfigDocumentV1): string {
  return JSON.stringify(sanitizeAuroraNodeConfigDocument(document))
}

// ---------------------------------------------------------------------------
// Native speech policy v2
// ---------------------------------------------------------------------------

/** The v1 API remains readable for older clients; v2 is the canonical native policy. */
export const AURORA_NODE_CONFIG_V2_VERSION = 2 as const
export const AURORA_NODE_CONFIG_V2_STORAGE_KEY = 'aurora.nodeConfig.v2'
export const AURORA_SPEECH_STAGE_KEYS = ['stt', 'tts', 'kws', 'vad'] as const
export type AuroraSpeechStage = (typeof AURORA_SPEECH_STAGE_KEYS)[number]
export type AuroraSpeechNetworkKind = 'mesh' | 'gateway'

export interface AuroraSpeechStageTarget {
  peerId: string
  resourceId?: string | null
  modelId?: string | null
}

export interface AuroraSpeechStageConfig {
  routing: AuroraNodeServiceRouting
  networkKind?: AuroraSpeechNetworkKind
  target?: AuroraSpeechStageTarget | null
  experimentalRemote?: boolean
  modelId?: string | null
  language?: string | null
}

export interface AuroraSpeechConfigV1 {
  version: 1
  stages: Record<AuroraSpeechStage, AuroraSpeechStageConfig>
  sharing: Record<AuroraSpeechStage, boolean>
  limits: {
    maxAttempts: 1 | 2
    admissionTimeoutMs: number
    finiteDeadlineMs: number
  }
}

export const AURORA_BACKGROUND_TRANSCRIPTION_POLICY_VERSION = 1 as const

/** Persisted user intent only. Runtime capability and effective state are never saved. */
export interface AuroraBackgroundTranscriptionPolicy {
  version: typeof AURORA_BACKGROUND_TRANSCRIPTION_POLICY_VERSION
  enabled: boolean
  ambient: boolean
  notification: boolean
  retentionDays: number
  language: string | null
}

export interface AuroraBackgroundTranscriptionCapability {
  supported: boolean
  ambient: boolean
  notification: boolean
  reason: string | null
}

export type AuroraBackgroundTranscriptionEffectiveReason =
  | 'enabled'
  | 'disabled_by_preference'
  | 'unsupported'
  | 'no_capture_mode'

export interface AuroraBackgroundTranscriptionEffectiveState {
  enabled: boolean
  ambient: boolean
  notification: boolean
  reason: AuroraBackgroundTranscriptionEffectiveReason
  capabilityReason: string | null
}

export interface AuroraNodeConfigDocumentV2 {
  version: typeof AURORA_NODE_CONFIG_V2_VERSION
  revision: number
  updatedAtMs: number
  services: AuroraNodeConfigDocumentV1['services']
  expose: AuroraNodeConfigDocumentV1['expose']
  speech: AuroraSpeechConfigV1
  backgroundTranscription: AuroraBackgroundTranscriptionPolicy
  /** Read-only provenance used for an explicit rollback/recovery operation. */
  legacyV1Snapshot?: AuroraNodeConfigDocumentV1 | null
}

export interface AuroraNodeConfigSaveAck {
  savedRevision: number
  effectiveRevision: number
  pendingNextGeneration: boolean
  pendingRevision: number | null
}

export class AuroraNodeConfigRevisionConflictError extends Error {
  readonly currentRevision: number
  readonly expectedRevision: number

  constructor(expectedRevision: number, currentRevision: number) {
    super(`Node config revision conflict: expected ${expectedRevision}, current ${currentRevision}`)
    this.name = 'AuroraNodeConfigRevisionConflictError'
    this.expectedRevision = expectedRevision
    this.currentRevision = currentRevision
  }
}

const V2_STAGE_VALUES = new Set<string>(AURORA_SPEECH_STAGE_KEYS)
const NETWORK_KIND_VALUES = new Set<AuroraSpeechNetworkKind>(['mesh', 'gateway'])
const SPEECH_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u

const DEFAULT_BACKGROUND_TRANSCRIPTION: AuroraBackgroundTranscriptionPolicy = {
  version: AURORA_BACKGROUND_TRANSCRIPTION_POLICY_VERSION,
  enabled: false,
  ambient: false,
  notification: false,
  retentionDays: 30,
  language: null
}

function defaultSpeechStage(stage: AuroraSpeechStage, services: AuroraNodeConfigDocumentV1['services']): AuroraSpeechStageConfig {
  if (stage === 'kws' || stage === 'vad') {
    return { routing: { prefer: 'local_only', fallback: 'error' }, experimentalRemote: false }
  }
  const inherited = services[stage]?.routing ?? DEFAULT_ROUTING[stage]
  return { routing: { ...inherited }, experimentalRemote: false }
}

export function emptyAuroraNodeConfigDocumentV2(now = Date.now()): AuroraNodeConfigDocumentV2 {
  const legacy = emptyAuroraNodeConfigDocument(now)
  const stages = Object.fromEntries(
    AURORA_SPEECH_STAGE_KEYS.map((stage) => [stage, defaultSpeechStage(stage, legacy.services)])
  ) as Record<AuroraSpeechStage, AuroraSpeechStageConfig>
  return {
    version: AURORA_NODE_CONFIG_V2_VERSION,
    revision: 1,
    updatedAtMs: validateTimestamp(now, 'updatedAtMs'),
    services: legacy.services,
    expose: legacy.expose,
    speech: {
      version: 1,
      stages,
      sharing: { stt: false, tts: false, kws: false, vad: false },
      limits: { maxAttempts: 2, admissionTimeoutMs: 5_000, finiteDeadlineMs: 60_000 }
    },
    backgroundTranscription: { ...DEFAULT_BACKGROUND_TRANSCRIPTION },
    legacyV1Snapshot: null
  }
}

export function sanitizeAuroraNodeConfigDocumentV2(document: unknown): AuroraNodeConfigDocumentV2 {
  const record = asRecord(document, 'document')
  assertExactKeys(record, ['version', 'revision', 'updatedAtMs', 'services', 'expose', 'speech', 'backgroundTranscription', 'legacyV1Snapshot'], 'document')
  if (record.version !== AURORA_NODE_CONFIG_V2_VERSION) {
    throw new AuroraNodeConfigValidationError('document.version', 'must be 2')
  }
  if (typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision) || record.revision < 1) {
    throw new AuroraNodeConfigValidationError('document.revision', 'must be a positive safe integer')
  }
  const legacy = sanitizeAuroraNodeConfigDocument({
    version: AURORA_NODE_CONFIG_VERSION,
    updatedAtMs: record.updatedAtMs,
    services: record.services,
    expose: record.expose
  })
  const speech = asRecord(record.speech, 'document.speech')
  assertExactKeys(speech, ['version', 'stages', 'sharing', 'limits'], 'document.speech')
  if (speech.version !== 1) throw new AuroraNodeConfigValidationError('document.speech.version', 'must be 1')
  const stagesRecord = asRecord(speech.stages, 'document.speech.stages')
  const stages = {} as Record<AuroraSpeechStage, AuroraSpeechStageConfig>
  for (const stage of AURORA_SPEECH_STAGE_KEYS) {
    const stageValue = stagesRecord[stage]
    if (stageValue === undefined) throw new AuroraNodeConfigValidationError(`document.speech.stages.${stage}`, 'is required')
    stages[stage] = sanitizeSpeechStageConfig(stageValue, stage, `document.speech.stages.${stage}`)
  }
  for (const key of Object.keys(stagesRecord)) {
    if (!V2_STAGE_VALUES.has(key)) throw new AuroraNodeConfigValidationError(`document.speech.stages.${key}`, 'unsupported stage')
  }
  const sharingRecord = asRecord(speech.sharing, 'document.speech.sharing')
  assertExactKeys(sharingRecord, [...AURORA_SPEECH_STAGE_KEYS], 'document.speech.sharing')
  const sharing = {} as Record<AuroraSpeechStage, boolean>
  for (const stage of AURORA_SPEECH_STAGE_KEYS) {
    if (typeof sharingRecord[stage] !== 'boolean') throw new AuroraNodeConfigValidationError(`document.speech.sharing.${stage}`, 'must be boolean')
    sharing[stage] = sharingRecord[stage] as boolean
  }
  const limitsRecord = asRecord(speech.limits, 'document.speech.limits')
  assertExactKeys(limitsRecord, ['maxAttempts', 'admissionTimeoutMs', 'finiteDeadlineMs'], 'document.speech.limits')
  const maxAttempts = limitsRecord.maxAttempts
  const admissionTimeoutMs = limitsRecord.admissionTimeoutMs
  const finiteDeadlineMs = limitsRecord.finiteDeadlineMs
  if (maxAttempts !== 1 && maxAttempts !== 2) throw new AuroraNodeConfigValidationError('document.speech.limits.maxAttempts', 'must be 1 or 2')
  if (!isBoundedSafeInteger(admissionTimeoutMs, 1, 60_000)) throw new AuroraNodeConfigValidationError('document.speech.limits.admissionTimeoutMs', 'must be between 1 and 60000')
  if (!isBoundedSafeInteger(finiteDeadlineMs, 1, 60_000)) throw new AuroraNodeConfigValidationError('document.speech.limits.finiteDeadlineMs', 'must be between 1 and 60000')
  const legacyV1Snapshot = record.legacyV1Snapshot === undefined || record.legacyV1Snapshot === null
    ? null
    : sanitizeAuroraNodeConfigDocument(record.legacyV1Snapshot)
  const backgroundTranscription = sanitizeBackgroundTranscriptionPolicy(record.backgroundTranscription)
  return {
    version: 2,
    revision: record.revision,
    updatedAtMs: legacy.updatedAtMs,
    services: legacy.services,
    expose: legacy.expose,
    speech: { version: 1, stages, sharing, limits: { maxAttempts, admissionTimeoutMs, finiteDeadlineMs } },
    backgroundTranscription,
    legacyV1Snapshot
  }
}

export function migrateAuroraNodeConfigDocumentV2(value: unknown, now = Date.now()): AuroraNodeConfigDocumentV2 {
  if (value === null || value === undefined) return emptyAuroraNodeConfigDocumentV2(now)
  if (isRecord(value) && value.version === AURORA_NODE_CONFIG_V2_VERSION) {
    const migrated = value.backgroundTranscription === undefined
      ? { ...value, backgroundTranscription: { ...DEFAULT_BACKGROUND_TRANSCRIPTION } }
      : value
    return sanitizeAuroraNodeConfigDocumentV2(migrated)
  }
  const legacy = migrateAuroraNodeConfigDocument(value, now)
  const migrated = emptyAuroraNodeConfigDocumentV2(legacy.updatedAtMs)
  migrated.services = legacy.services
  migrated.expose = legacy.expose
  migrated.legacyV1Snapshot = legacy
  migrated.speech.stages.stt.routing = { ...legacy.services.stt?.routing ?? migrated.speech.stages.stt.routing }
  migrated.speech.stages.tts.routing = { ...legacy.services.tts?.routing ?? migrated.speech.stages.tts.routing }
  return migrated
}

export function resolveBackgroundTranscriptionEffectiveState(
  policy: AuroraBackgroundTranscriptionPolicy,
  capability: AuroraBackgroundTranscriptionCapability
): AuroraBackgroundTranscriptionEffectiveState {
  const requested = sanitizeBackgroundTranscriptionPolicy(policy)
  if (!requested.enabled) return { enabled: false, ambient: false, notification: false, reason: 'disabled_by_preference', capabilityReason: capability.reason }
  if (!capability.supported) return { enabled: false, ambient: false, notification: false, reason: 'unsupported', capabilityReason: capability.reason }
  const ambient = requested.ambient && capability.ambient
  const notification = requested.notification && capability.notification
  if (!ambient && !notification) return { enabled: false, ambient: false, notification: false, reason: 'no_capture_mode', capabilityReason: capability.reason }
  return { enabled: true, ambient, notification, reason: 'enabled', capabilityReason: capability.reason }
}

export function serializeAuroraNodeConfigDocumentV2(document: AuroraNodeConfigDocumentV2): string {
  return JSON.stringify(sanitizeAuroraNodeConfigDocumentV2(document))
}

export function parseAuroraNodeConfigDocumentV2(value: unknown, now = Date.now()): AuroraNodeConfigDocumentV2 | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
    return migrateAuroraNodeConfigDocumentV2(parsed, now)
  } catch {
    return null
  }
}

export function updateAuroraNodeConfigDocumentV2(
  current: AuroraNodeConfigDocumentV2,
  draft: unknown,
  expectedRevision: number,
  now = Date.now()
): { document: AuroraNodeConfigDocumentV2; acknowledgement: AuroraNodeConfigSaveAck } {
  const currentDocument = sanitizeAuroraNodeConfigDocumentV2(current)
  if (currentDocument.revision !== expectedRevision) throw new AuroraNodeConfigRevisionConflictError(expectedRevision, currentDocument.revision)
  const candidate = sanitizeAuroraNodeConfigDocumentV2(draft)
  const document: AuroraNodeConfigDocumentV2 = {
    ...candidate,
    revision: currentDocument.revision + 1,
    updatedAtMs: validateTimestamp(now, 'updatedAtMs')
  }
  return {
    document,
    acknowledgement: {
      savedRevision: document.revision,
      effectiveRevision: currentDocument.revision,
      pendingNextGeneration: true,
      pendingRevision: document.revision
    }
  }
}

export interface ResolveSpeechStageRoutingInput extends Omit<ResolveServiceRoutingInput, 'module' | 'config'> {
  stage: AuroraSpeechStage
  config: AuroraNodeConfigDocumentV2
  exactSelector?: AuroraSpeechStageTarget | null
}

export interface SpeechStageRoutingResolution extends ServiceRoutingResolution {
  stage: AuroraSpeechStage
}

/** Resolve the stage policy while preserving sticky exact selectors and local-only KWS/VAD. */
export function resolveSpeechStageRouting(input: ResolveSpeechStageRoutingInput): SpeechStageRoutingResolution {
  const config = sanitizeAuroraNodeConfigDocumentV2(input.config)
  const stage = config.speech.stages[input.stage]
  const exact = input.exactSelector ?? null
  let candidates = input.remoteCandidates
  if (exact !== null) {
    candidates = candidates.filter((candidate) => candidate.peerId === exact.peerId &&
      (exact.resourceId === undefined || exact.resourceId === null || candidate.serviceInstanceId === exact.resourceId) &&
      (exact.modelId === undefined || exact.modelId === null || candidate.providerId === exact.modelId))
  } else if (stage.target !== undefined && stage.target !== null) {
    candidates = candidates.filter((candidate) => candidate.peerId === stage.target?.peerId &&
      (stage.target?.resourceId === undefined || stage.target.resourceId === null || candidate.serviceInstanceId === stage.target.resourceId) &&
      (stage.target?.modelId === undefined || stage.target.modelId === null || candidate.providerId === stage.target.modelId))
  }
  if ((input.stage === 'kws' || input.stage === 'vad') && !stage.experimentalRemote) {
    candidates = []
  }
  const serviceModule: AuroraNodeConfigModule = input.stage === 'stt' ? 'stt' : 'tts'
  const resolution = resolveServiceRoutingForRuntimeModules({
    ...input,
    module: serviceModule,
    config: {
      version: 1,
      updatedAtMs: config.updatedAtMs,
      services: { [serviceModule]: { routing: stage.routing } },
      expose: config.expose
    },
    remoteCandidates: candidates,
    localCapability: exact === null ? input.localCapability : { available: false, reason: 'exact selector requires the selected peer' }
  }, AURORA_SPEECH_RUNTIME_MODULES_BY_STAGE[input.stage])
  if (exact !== null && resolution.source !== 'remote') {
    throw new AuroraServiceRoutingError({ ...resolution.record, reason: 'exact selector cannot use a local fallback' })
  }
  return { ...resolution, stage: input.stage }
}

function sanitizeBackgroundTranscriptionPolicy(value: unknown): AuroraBackgroundTranscriptionPolicy {
  const record = asRecord(value, 'document.backgroundTranscription')
  assertExactKeys(record, ['version', 'enabled', 'ambient', 'notification', 'retentionDays', 'language'], 'document.backgroundTranscription')
  if (record.version !== AURORA_BACKGROUND_TRANSCRIPTION_POLICY_VERSION) throw new AuroraNodeConfigValidationError('document.backgroundTranscription.version', 'must be 1')
  for (const key of ['enabled', 'ambient', 'notification'] as const) {
    if (typeof record[key] !== 'boolean') throw new AuroraNodeConfigValidationError(`document.backgroundTranscription.${key}`, 'must be boolean')
  }
  if (!isBoundedSafeInteger(record.retentionDays, 1, 3650)) throw new AuroraNodeConfigValidationError('document.backgroundTranscription.retentionDays', 'must be between 1 and 3650')
  if (record.language !== null && record.language !== undefined && (typeof record.language !== 'string' || record.language.length > 64)) {
    throw new AuroraNodeConfigValidationError('document.backgroundTranscription.language', 'must be a string or null')
  }
  return {
    version: 1,
    enabled: record.enabled as boolean,
    ambient: record.ambient as boolean,
    notification: record.notification as boolean,
    retentionDays: record.retentionDays as number,
    language: (record.language ?? null) as string | null
  }
}

function sanitizeSpeechStageConfig(value: unknown, stage: AuroraSpeechStage, path: string): AuroraSpeechStageConfig {
  const record = asRecord(value, path)
  assertExactKeys(record, ['routing', 'networkKind', 'target', 'experimentalRemote', 'modelId', 'language'], path)
  const routingRecord = asRecord(record.routing, `${path}.routing`)
  assertExactKeys(routingRecord, ['prefer', 'fallback'], `${path}.routing`)
  if (!isRoutingPreference(routingRecord.prefer) || !isRoutingFallback(routingRecord.fallback)) {
    throw new AuroraNodeConfigValidationError(`${path}.routing`, 'unsupported routing policy')
  }
  if (record.networkKind !== undefined && (!isString(record.networkKind) || !NETWORK_KIND_VALUES.has(record.networkKind as AuroraSpeechNetworkKind))) {
    throw new AuroraNodeConfigValidationError(`${path}.networkKind`, 'must be mesh or gateway')
  }
  if (record.experimentalRemote !== undefined && typeof record.experimentalRemote !== 'boolean') {
    throw new AuroraNodeConfigValidationError(`${path}.experimentalRemote`, 'must be boolean')
  }
  const experimentalRemote = record.experimentalRemote === true
  if ((stage === 'kws' || stage === 'vad') && !experimentalRemote && (routingRecord.prefer === 'network' || routingRecord.prefer === 'network_only')) {
    throw new AuroraNodeConfigValidationError(`${path}.routing.prefer`, 'continuous KWS/VAD remote routing requires experimentalRemote')
  }
  let target: AuroraSpeechStageTarget | null | undefined
  if (record.target !== undefined && record.target !== null) {
    const targetRecord = asRecord(record.target, `${path}.target`)
    assertExactKeys(targetRecord, ['peerId', 'resourceId', 'modelId'], `${path}.target`)
    if (!isBoundedId(targetRecord.peerId)) throw new AuroraNodeConfigValidationError(`${path}.target.peerId`, 'must be a bounded identifier')
    for (const key of ['resourceId', 'modelId'] as const) {
      if (targetRecord[key] !== undefined && targetRecord[key] !== null && !isBoundedId(targetRecord[key])) {
        throw new AuroraNodeConfigValidationError(`${path}.target.${key}`, 'must be a bounded identifier')
      }
    }
    target = {
      peerId: targetRecord.peerId,
      ...(targetRecord.resourceId === undefined ? {} : { resourceId: targetRecord.resourceId as string | null }),
      ...(targetRecord.modelId === undefined ? {} : { modelId: targetRecord.modelId as string | null })
    }
  } else if (record.target === null) target = null
  for (const key of ['modelId', 'language'] as const) {
    if (record[key] !== undefined && record[key] !== null && typeof record[key] !== 'string') {
      throw new AuroraNodeConfigValidationError(`${path}.${key}`, 'must be a string or null')
    }
  }
  return {
    routing: { prefer: routingRecord.prefer as AuroraNodeRoutingPreference, fallback: routingRecord.fallback as AuroraNodeRoutingFallback },
    ...(record.networkKind === undefined ? {} : { networkKind: record.networkKind as AuroraSpeechNetworkKind }),
    ...(record.target === undefined ? {} : { target: target ?? null }),
    experimentalRemote,
    ...(record.modelId === undefined ? {} : { modelId: record.modelId as string | null }),
    ...(record.language === undefined ? {} : { language: record.language as string | null })
  }
}

function isString(value: unknown): value is string { return typeof value === 'string' }
function isBoundedId(value: unknown): value is string { return typeof value === 'string' && SPEECH_ID.test(value) }
function isBoundedSafeInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}

export function parseAuroraNodeConfigDocument(value: unknown): AuroraNodeConfigDocumentV1 | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
    return migrateAuroraNodeConfigDocument(parsed)
  } catch {
    return null
  }
}

export function parseAuroraNodeConfigDocumentWire(
  value: unknown,
  now = Date.now()
): { document: AuroraNodeConfigDocumentV1; migratedFromVersion: 0 | 1 } | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
    const version = isRecord(parsed) && parsed.version === AURORA_NODE_CONFIG_VERSION ? 1 : 0
    return { document: migrateAuroraNodeConfigDocument(parsed, now), migratedFromVersion: version }
  } catch {
    return null
  }
}

export function isAuroraNodeServiceExposed(
  document: AuroraNodeConfigDocumentV1,
  module: AuroraNodeConfigModule
): boolean {
  const explicit = document.services[module]?.expose?.enabled
  return explicit ?? DEFAULT_EXPOSURE[module]
}

export function resolveServiceRouting(input: ResolveServiceRoutingInput): ServiceRoutingResolution {
  return resolveServiceRoutingForRuntimeModules(input, runtimeModulesForNodeConfigModule(input.module))
}

function resolveServiceRoutingForRuntimeModules(
  input: ResolveServiceRoutingInput,
  allowedRuntimeModules: readonly string[]
): ServiceRoutingResolution {
  const config = sanitizeAuroraNodeConfigDocument(input.config)
  const localAvailable = input.localCapability.available === true
  const service = config.services[input.module]
  const routing = service?.routing ?? DEFAULT_ROUTING[input.module]
  const candidates = input.remoteCandidates
    .filter((candidate) => candidate.eligible !== false)
    .map((candidate) => {
      if (
        candidate.module !== undefined &&
        candidate.module !== null &&
        !allowedRuntimeModules.includes(candidate.module)
      ) {
        throw new AuroraNodeConfigValidationError(
          'remoteCandidates.module',
          `must match the requested service module runtime alias (${allowedRuntimeModules.join(', ')})`
        )
      }
      return candidate
    })
    .filter((candidate) => isUsableCandidate(candidate))
    .map(cloneCandidate)
  const candidateIds = candidates.map(routeCandidateId)
  const selectedRemote = candidates[0]
  const remoteAttempts = candidates.map((candidate) => remoteAttempt(candidate))
  const localAttempt = localRoutingAttempt(input.stage ?? input.module)

  const chooseLocal = (reason: string, fallback: AuroraNodeRoutingAttempt[] = []): ServiceRoutingResolution => {
    const record = createResolutionRecord({
      input,
      routing,
      localAvailable,
      remoteCandidateIds: candidateIds,
      decision: 'local',
      reason,
      selectedCandidateId: null,
      fallbackCandidateIds: fallback.map(routingAttemptId)
    })
    emitResolution(input.emit, record)
    return { attempt: localAttempt, source: 'local', selector: null, fallback, record }
  }

  const chooseRemote = (
    reason: string,
    fallback: AuroraNodeRoutingAttempt[] = remoteAttempts.slice(1)
  ): ServiceRoutingResolution => {
    if (selectedRemote === undefined) return failNoRoute(input, routing, localAvailable, candidateIds, [], reason)
    const record = createResolutionRecord({
      input,
      routing,
      localAvailable,
      remoteCandidateIds: candidateIds,
      decision: 'remote',
      reason,
      selectedCandidateId: routeCandidateId(selectedRemote),
      fallbackCandidateIds: fallback.map(routingAttemptId)
    })
    emitResolution(input.emit, record)
    return {
      attempt: remoteAttempt(selectedRemote),
      source: 'remote',
      selector: selectorForCandidate(selectedRemote),
      fallback,
      record
    }
  }

  if (routing.prefer === 'local_only') {
    if (localAvailable) return chooseLocal('local_only policy selected the available local capability')
    return failNoRoute(input, routing, false, candidateIds, [], input.localCapability.reason ?? 'local capability unavailable')
  }
  if (routing.prefer === 'network_only') {
    if (selectedRemote !== undefined) {
      const fallback = routing.fallback === 'network' ? remoteAttempts.slice(1) : []
      return chooseRemote('network_only policy selected the first eligible remote candidate', fallback)
    }
    return failNoRoute(input, routing, localAvailable, candidateIds, [], 'no eligible remote candidate')
  }
  if (routing.prefer === 'local' && localAvailable) {
    return chooseLocal(
      'local preference selected the available local capability',
      routing.fallback === 'network' ? remoteAttempts : []
    )
  }
  if (routing.prefer === 'network' && selectedRemote !== undefined) {
    return chooseRemote(
      'network preference selected the first eligible remote candidate',
      routing.fallback === 'local' && localAvailable ? [localAttempt] :
        routing.fallback === 'network' ? remoteAttempts.slice(1) : []
    )
  }
  if (routing.fallback === 'local' && localAvailable) {
    return chooseLocal('preferred route unavailable; local fallback selected')
  }
  if (routing.fallback === 'network' && selectedRemote !== undefined) {
    return chooseRemote('preferred route unavailable; network fallback selected', remoteAttempts.slice(1))
  }
  return failNoRoute(
    input,
    routing,
    localAvailable,
    candidateIds,
    [],
    input.localCapability.reason ?? 'no eligible route satisfies the configured policy'
  )
}

export function createAuroraNodeConfigTauriStore(
  storage: AuroraNodeConfigTauriTransport,
  options: AuroraNodeConfigTauriStoreOptions = {}
): AuroraNodeConfigStore {
  const evidence = options.evidence ?? 'Tauri narrow nonsecret node-config storage'
  return {
    evidence,
    load: async () => {
      const result = await storage.nodeConfigGet()
      assertNodeConfigStorageKey(result.key)
      if (typeof result.value !== 'string' || result.value.length === 0) return null
      const parsed = parseAuroraNodeConfigDocument(result.value)
      if (parsed) return parsed
      try {
        const deleted = await storage.nodeConfigDelete()
        assertNodeConfigStorageKey(deleted.key)
      } catch {
        // Invalid policy remains fail-closed even when cleanup is unavailable.
      }
      return null
    },
    save: async (document) => {
      const result = await storage.nodeConfigSet(serializeAuroraNodeConfigDocument(document))
      assertNodeConfigStorageKey(result.key)
      if (!result.ok) throw new Error('Node config save failed')
    },
    clear: async () => {
      const result = await storage.nodeConfigDelete()
      assertNodeConfigStorageKey(result.key)
      if (!result.ok) throw new Error('Node config clear failed')
    }
  }
}

export interface AuroraNodeConfigV2Store {
  readonly evidence?: string
  load(): Promise<AuroraNodeConfigDocumentV2 | null>
  save(document: AuroraNodeConfigDocumentV2): Promise<AuroraNodeConfigSaveAck>
  saveCas(draft: unknown, expectedRevision: number): Promise<{
    document: AuroraNodeConfigDocumentV2
    acknowledgement: AuroraNodeConfigSaveAck
  }>
  clear?(): Promise<void>
}

/**
 * Native node-policy storage adapter.  The Rust command remains the durable
 * authority; this adapter supplies a serialized, revision-checked boundary
 * for Tauri callers and never stores credentials or model paths.
 */
export function createAuroraNodeConfigV2TauriStore(
  storage: AuroraNodeConfigTauriTransport,
  options: AuroraNodeConfigTauriStoreOptions = {}
): AuroraNodeConfigV2Store {
  const evidence = options.evidence ?? 'Tauri native-owned v2 speech policy storage'
  let writeChain: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = writeChain.then(operation, operation)
    writeChain = next.then(() => undefined, () => undefined)
    return next
  }
  const load = async (): Promise<AuroraNodeConfigDocumentV2 | null> => {
    const result = await storage.nodeConfigV2Get()
    assertNodeConfigV2StorageKey(result.key)
    if (typeof result.value === 'string' && result.value.length > 0) {
      const parsed = parseAuroraNodeConfigDocumentV2(result.value)
      if (parsed !== null) return parsed
      const deletedLegacy = await storage.nodeConfigDelete()
      assertNodeConfigStorageKey(deletedLegacy.key)
      if (!deletedLegacy.ok) throw new Error('Invalid node config legacy cleanup failed')
      const deleted = await storage.nodeConfigV2Delete()
      assertNodeConfigV2StorageKey(deleted.key)
      if (!deleted.ok) throw new Error('Invalid node config v2 cleanup failed')
      return null
    }
    // A v1 document is read-only provenance.  Persist its v2 projection under
    // the new key so subsequent reads use one canonical authority.
    const legacyResult = await storage.nodeConfigGet()
    assertNodeConfigStorageKey(legacyResult.key)
    if (typeof legacyResult.value !== 'string' || legacyResult.value.length === 0) return null
    const migrated = parseAuroraNodeConfigDocumentV2(legacyResult.value)
    if (migrated === null) return null
    const persisted = await storage.nodeConfigV2Set(serializeAuroraNodeConfigDocumentV2(migrated))
    assertNodeConfigV2StorageKey(persisted.key)
    if (!persisted.ok) throw new Error('Node config v2 migration save failed')
    const deletedLegacy = await storage.nodeConfigDelete()
    assertNodeConfigStorageKey(deletedLegacy.key)
    if (!deletedLegacy.ok) throw new Error('Node config v1 migration cleanup failed')
    return migrated
  }
  return {
    evidence,
    load,
    save: async (document) => enqueue(async () => {
      // Direct overwrite is intentionally limited to first initialization.
      // User-facing edits must use saveCas so stale UI documents cannot
      // silently replace a newer durable policy.
      const current = await load()
      if (current !== null) throw new Error('Node config v2 save requires saveCas')
      const normalized = sanitizeAuroraNodeConfigDocumentV2(document)
      if (normalized.revision !== 1) {
        throw new Error('Node config v2 initialization must start at revision 1')
      }
      const result = await storage.nodeConfigV2Set(serializeAuroraNodeConfigDocumentV2(normalized))
      assertNodeConfigV2StorageKey(result.key)
      if (!result.ok) throw new Error('Node config v2 save failed')
      return {
        savedRevision: normalized.revision,
        effectiveRevision: 0,
        pendingNextGeneration: true,
        pendingRevision: normalized.revision
      }
    }),
    saveCas: (draft, expectedRevision) => enqueue(async () => {
      const current = await load()
      if (current === null) throw new Error('Node config v2 is not initialized')
      const updated = updateAuroraNodeConfigDocumentV2(current, draft, expectedRevision)
      const result = await storage.nodeConfigV2Set(serializeAuroraNodeConfigDocumentV2(updated.document))
      assertNodeConfigV2StorageKey(result.key)
      if (!result.ok) throw new Error('Node config v2 save failed')
      return updated
    }),
    clear: async () => enqueue(async () => {
      const deletedLegacy = await storage.nodeConfigDelete()
      assertNodeConfigStorageKey(deletedLegacy.key)
      if (!deletedLegacy.ok) throw new Error('Node config v1 clear failed')
      const result = await storage.nodeConfigV2Delete()
      assertNodeConfigV2StorageKey(result.key)
      if (!result.ok) throw new Error('Node config v2 clear failed')
    })
  }
}

function sanitizeServiceConfig(value: unknown, path: string): AuroraNodeServiceConfig {
  const record = asRecord(value, path)
  assertExactKeys(record, ['routing', 'expose'], path)
  const routing = asRecord(record.routing, `${path}.routing`)
  assertExactKeys(routing, ['prefer', 'fallback'], `${path}.routing`)
  if (!isRoutingPreference(routing.prefer)) {
    throw new AuroraNodeConfigValidationError(`${path}.routing.prefer`, 'unsupported preference')
  }
  if (!isRoutingFallback(routing.fallback)) {
    throw new AuroraNodeConfigValidationError(`${path}.routing.fallback`, 'unsupported fallback')
  }
  return {
    routing: { prefer: routing.prefer, fallback: routing.fallback },
    ...(record.expose === undefined ? {} : { expose: sanitizeExposure(record.expose, `${path}.expose`) })
  }
}

function sanitizeExposure(value: unknown, path: string): AuroraNodeServiceExposure {
  const record = asRecord(value, path)
  assertExactKeys(record, ['enabled'], path)
  if (typeof record.enabled !== 'boolean') {
    throw new AuroraNodeConfigValidationError(`${path}.enabled`, 'must be boolean')
  }
  return { enabled: record.enabled }
}

function failNoRoute(
  input: ResolveServiceRoutingInput,
  routing: AuroraNodeServiceRouting,
  localAvailable: boolean,
  remoteCandidateIds: string[],
  fallbackCandidateIds: string[],
  reason: string
): never {
  const record = createResolutionRecord({
    input,
    routing,
    localAvailable,
    remoteCandidateIds,
    decision: routing.prefer === 'network' || routing.prefer === 'network_only' ? 'remote' : 'local',
    reason,
    selectedCandidateId: null,
    fallbackCandidateIds
  })
  emitResolution(input.emit, record)
  throw new AuroraServiceRoutingError(record)
}

function createResolutionRecord(input: {
  input: ResolveServiceRoutingInput
  routing: AuroraNodeServiceRouting
  localAvailable: boolean
  remoteCandidateIds: string[]
  decision: 'local' | 'remote'
  reason: string
  selectedCandidateId: string | null
  fallbackCandidateIds: string[]
}): AuroraNodeRoutingResolutionRecord {
  return {
    module: input.input.module,
    ...(input.input.stage === undefined ? {} : { stage: input.input.stage }),
    preference: input.routing.prefer,
    fallbackPolicy: input.routing.fallback,
    decision: input.decision,
    reason: input.reason,
    localAvailable: input.localAvailable,
    remoteCandidateIds: [...input.remoteCandidateIds],
    selectedCandidateId: input.selectedCandidateId,
    fallbackCandidateIds: [...input.fallbackCandidateIds],
    resolvedAtMs: validateTimestamp(input.input.now?.() ?? Date.now(), 'resolvedAtMs')
  }
}

function emitResolution(
  emitter: AuroraNodeRoutingResolutionEmitter | undefined,
  record: AuroraNodeRoutingResolutionRecord
): void {
  try {
    emitter?.(record)
  } catch {
    // Routing must not become unavailable because an observability sink failed.
  }
}

function selectorForCandidate(candidate: AuroraNodeRouteCandidate): AuroraNodeWireSelector {
  return canonicalizeSelector(candidate)
}

function cloneCandidate(candidate: AuroraNodeRouteCandidate): AuroraNodeRouteCandidate {
  const selector = canonicalizeSelector(candidate)
  return {
    ...candidate,
    selector
  }
}

function isUsableCandidate(candidate: AuroraNodeRouteCandidate): boolean {
  return isIdentityValue(candidate.peerId) &&
    (candidate.providerId === undefined || candidate.providerId === null || isIdentityValue(candidate.providerId)) &&
    (candidate.serviceInstanceId === undefined || candidate.serviceInstanceId === null || isIdentityValue(candidate.serviceInstanceId)) &&
    (candidate.module === undefined || candidate.module === null || isIdentityValue(candidate.module))
}

function routeCandidateId(candidate: AuroraNodeRouteCandidate): string {
  return JSON.stringify([
    candidate.peerId,
    candidate.providerId ?? null,
    candidate.serviceInstanceId ?? null,
    candidate.module ?? null
  ])
}

function localRouteId(module: AuroraNodeConfigModule | AuroraSpeechStage): string {
  return `local:${module}`
}

function localRoutingAttempt(module: AuroraNodeConfigModule | AuroraSpeechStage): AuroraNodeRoutingAttempt {
  return { id: localRouteId(module), source: 'local', selector: null, candidate: null }
}

function remoteAttempt(candidate: AuroraNodeRouteCandidate): AuroraNodeRoutingAttempt {
  return { id: routeCandidateId(candidate), source: 'remote', selector: selectorForCandidate(candidate), candidate: cloneCandidate(candidate) }
}

function routingAttemptId(attempt: AuroraNodeRoutingAttempt): string {
  return attempt.id
}

const SELECTOR_FIELDS = [
  ['resource_namespace', 'resourceNamespace'],
  ['tool_id', 'toolId'],
  ['data_scope', 'dataScope'],
  ['hardware_target', 'hardwareTarget']
] as const

function canonicalizeSelector(candidate: AuroraNodeRouteCandidate): AuroraNodeWireSelector {
  const selectorValue = candidate.selector
  const selector = selectorValue === undefined || selectorValue === null
    ? {}
    : asRecord(selectorValue, 'remoteCandidates.selector')
  const allowedKeys = new Set<string>([
    'peer_id',
    'peerId',
    'provider_id',
    'providerId',
    'service_instance_id',
    'serviceInstanceId',
    'module',
    ...SELECTOR_FIELDS.flatMap(([wireKey, camelKey]) => [wireKey, camelKey])
  ])
  for (const key of Object.keys(selector)) {
    if (PROTOTYPE_SENSITIVE_KEYS.has(key)) {
      throw new AuroraNodeConfigValidationError(`remoteCandidates.selector.${key}`, 'prototype-sensitive selector field is not allowed')
    }
    if (!allowedKeys.has(key)) {
      throw new AuroraNodeConfigValidationError(`remoteCandidates.selector.${key}`, 'unsupported selector field')
    }
  }

  const canonical: AuroraNodeWireSelector = { peer_id: candidate.peerId }
  addCanonicalSelectorIdentity(canonical, selector, 'peer_id', 'peerId', candidate.peerId, true)
  addCanonicalSelectorIdentity(canonical, selector, 'provider_id', 'providerId', candidate.providerId ?? undefined, false)
  addCanonicalSelectorIdentity(canonical, selector, 'service_instance_id', 'serviceInstanceId', candidate.serviceInstanceId ?? undefined, false)
  addCanonicalSelectorIdentity(canonical, selector, 'module', undefined, candidate.module ?? undefined, false)
  for (const [wireKey, camelKey] of SELECTOR_FIELDS) {
    const value = readSelectorValue(selector, wireKey, camelKey)
    if (value !== undefined) canonical[wireKey] = value
  }
  return canonical
}

function addCanonicalSelectorIdentity(
  canonical: AuroraNodeWireSelector,
  selector: Record<string, unknown>,
  wireKey: keyof AuroraNodeWireSelector | 'module',
  camelKey: string | undefined,
  candidateValue: string | undefined,
  required: boolean
): void {
  const supplied = readSelectorIdentity(selector, String(wireKey), camelKey)
  if (candidateValue === undefined) {
    if (supplied !== undefined) {
      throw new AuroraNodeConfigValidationError(`remoteCandidates.selector.${wireKey}`, 'selector identity is not present on the candidate')
    }
    if (required) throw new AuroraNodeConfigValidationError(`remoteCandidates.selector.${wireKey}`, 'candidate identity is required')
    return
  }
  if (!isIdentityValue(candidateValue)) {
    throw new AuroraNodeConfigValidationError(`remoteCandidates.${wireKey}`, 'must be a non-empty string')
  }
  if (supplied !== undefined && supplied !== candidateValue) {
    throw new AuroraNodeConfigValidationError(`remoteCandidates.selector.${wireKey}`, 'does not match candidate identity')
  }
  if (wireKey !== 'module') canonical[wireKey] = candidateValue
}

function readSelectorIdentity(
  selector: Record<string, unknown>,
  wireKey: string,
  camelKey: string | undefined
): string | undefined {
  const keys = [wireKey, camelKey].filter((key): key is string => key !== undefined)
  const suppliedValues = keys
    .filter((key) => Object.prototype.hasOwnProperty.call(selector, key))
    .map((key) => selector[key])
  for (const value of suppliedValues) {
    if (!isIdentityValue(value)) {
      throw new AuroraNodeConfigValidationError(`remoteCandidates.selector.${wireKey}`, 'must be a non-empty string')
    }
  }
  if (suppliedValues.length > 1 && suppliedValues[0] !== suppliedValues[1]) {
    throw new AuroraNodeConfigValidationError(`remoteCandidates.selector.${wireKey}`, 'snake_case and camelCase values must match')
  }
  return suppliedValues[0] as string | undefined
}

function readSelectorValue(
  selector: Record<string, unknown>,
  wireKey: string,
  camelKey: string
): string | null | undefined {
  const keys = [wireKey, camelKey].filter((key, index, values) => values.indexOf(key) === index)
  const suppliedValues = keys
    .filter((key) => Object.prototype.hasOwnProperty.call(selector, key))
    .map((key) => selector[key])
  for (const value of suppliedValues) {
    if (value !== null && !isIdentityValue(value)) {
      throw new AuroraNodeConfigValidationError(`remoteCandidates.selector.${wireKey}`, 'must be a non-empty string or null')
    }
  }
  if (suppliedValues.length > 1 && suppliedValues[0] !== suppliedValues[1]) {
    throw new AuroraNodeConfigValidationError(`remoteCandidates.selector.${wireKey}`, 'snake_case and camelCase values must match')
  }
  return suppliedValues[0] as string | null | undefined
}

function assertNodeConfigStorageKey(key: string): void {
  if (key !== AURORA_NODE_CONFIG_STORAGE_KEY) {
    throw new Error(`Node config storage returned unexpected key: ${key}`)
  }
}

function assertNodeConfigV2StorageKey(key: string): void {
  if (key !== AURORA_NODE_CONFIG_V2_STORAGE_KEY) {
    throw new Error(`Node config v2 storage returned unexpected key: ${key}`)
  }
}

function isIdentityValue(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    /\S/u.test(value)
}

function isRoutingPreference(value: unknown): value is AuroraNodeRoutingPreference {
  return typeof value === 'string' && PREFERENCE_VALUES.has(value as AuroraNodeRoutingPreference)
}

function isRoutingFallback(value: unknown): value is AuroraNodeRoutingFallback {
  return typeof value === 'string' && FALLBACK_VALUES.has(value as AuroraNodeRoutingFallback)
}

function assertModule(value: string, path: string): asserts value is AuroraNodeConfigModule {
  if (!isAuroraNodeConfigModule(value)) {
    throw new AuroraNodeConfigValidationError(path, 'unsupported module; wakeword and VAD are local-only')
  }
}

function validateTimestamp(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new AuroraNodeConfigValidationError(path, 'must be a non-negative safe integer')
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new AuroraNodeConfigValidationError(path, 'must be an object')
  return value
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      throw new AuroraNodeConfigValidationError(`${path}.${key}`, 'unknown field')
    }
  }
}
