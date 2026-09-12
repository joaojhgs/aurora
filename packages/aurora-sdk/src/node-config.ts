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

export interface AuroraNodeConfigSecureStorage {
  get(key: string): Promise<{ value: string | null }>
  set(key: string, value: string): Promise<{ ok: boolean }>
  delete(key: string): Promise<{ ok: boolean }>
}

export interface AuroraNodeConfigTauriStoreOptions {
  key?: string
  evidence?: string
}

export interface AuroraNodeLocalCapability {
  available: boolean
  reason?: string | null
}

export interface AuroraNodeRouteCandidate extends MeshRouteCandidate {
  selector?: MeshAddressSelector | null
}

export type RouteCandidate = AuroraNodeRouteCandidate

export interface AuroraNodeRoutingResolutionRecord {
  module: AuroraNodeConfigModule
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
  config: AuroraNodeConfigDocumentV1
  localCapability: AuroraNodeLocalCapability
  remoteCandidates: readonly AuroraNodeRouteCandidate[]
  emit?: AuroraNodeRoutingResolutionEmitter
  now?: () => number
}

export interface ServiceRoutingResolution {
  source: 'local' | 'remote'
  selector: MeshAddressSelector | null
  fallback: AuroraNodeRouteCandidate[]
  record: AuroraNodeRoutingResolutionRecord
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
    super(`No ${record.module} route satisfies ${record.preference}/${record.fallbackPolicy}: ${record.reason}`)
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
      if (!SAFE_FEATURE_ID.test(featureId)) {
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

export interface AuroraNodeConfigDocumentV2 {
  version: typeof AURORA_NODE_CONFIG_V2_VERSION
  revision: number
  updatedAtMs: number
  services: AuroraNodeConfigDocumentV1['services']
  expose: AuroraNodeConfigDocumentV1['expose']
  speech: AuroraSpeechConfigV1
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
    legacyV1Snapshot: null
  }
}

export function sanitizeAuroraNodeConfigDocumentV2(document: unknown): AuroraNodeConfigDocumentV2 {
  const record = asRecord(document, 'document')
  assertExactKeys(record, ['version', 'revision', 'updatedAtMs', 'services', 'expose', 'speech', 'legacyV1Snapshot'], 'document')
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
  return {
    version: 2,
    revision: record.revision,
    updatedAtMs: legacy.updatedAtMs,
    services: legacy.services,
    expose: legacy.expose,
    speech: { version: 1, stages, sharing, limits: { maxAttempts, admissionTimeoutMs, finiteDeadlineMs } },
    legacyV1Snapshot
  }
}

export function migrateAuroraNodeConfigDocumentV2(value: unknown, now = Date.now()): AuroraNodeConfigDocumentV2 {
  if (value === null || value === undefined) return emptyAuroraNodeConfigDocumentV2(now)
  if (isRecord(value) && value.version === AURORA_NODE_CONFIG_V2_VERSION) return sanitizeAuroraNodeConfigDocumentV2(value)
  const legacy = migrateAuroraNodeConfigDocument(value, now)
  const migrated = emptyAuroraNodeConfigDocumentV2(legacy.updatedAtMs)
  migrated.services = legacy.services
  migrated.expose = legacy.expose
  migrated.legacyV1Snapshot = legacy
  migrated.speech.stages.stt.routing = { ...legacy.services.stt?.routing ?? migrated.speech.stages.stt.routing }
  migrated.speech.stages.tts.routing = { ...legacy.services.tts?.routing ?? migrated.speech.stages.tts.routing }
  return migrated
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
  const resolution = resolveServiceRouting({
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
  })
  if (exact !== null && resolution.source !== 'remote') {
    throw new AuroraServiceRoutingError({ ...resolution.record, reason: 'exact selector cannot use a local fallback' })
  }
  return { ...resolution, stage: input.stage }
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
  const config = sanitizeAuroraNodeConfigDocument(input.config)
  const localAvailable = input.localCapability.available === true
  const service = config.services[input.module]
  const routing = service?.routing ?? DEFAULT_ROUTING[input.module]
  const candidates = input.remoteCandidates
    .filter((candidate) => candidate.eligible !== false)
    .filter((candidate) => isUsableCandidate(candidate))
    .map(cloneCandidate)
  const candidateIds = candidates.map(routeCandidateId)
  const selectedRemote = candidates[0]
  const fallback = candidates.slice(1)

  const chooseLocal = (reason: string): ServiceRoutingResolution => {
    const record = createResolutionRecord({
      input,
      routing,
      localAvailable,
      remoteCandidateIds: candidateIds,
      decision: 'local',
      reason,
      selectedCandidateId: null,
      fallbackCandidateIds: candidateIds
    })
    emitResolution(input.emit, record)
    return { source: 'local', selector: null, fallback: candidates, record }
  }

  const chooseRemote = (reason: string): ServiceRoutingResolution => {
    if (selectedRemote === undefined) return failNoRoute(input, routing, localAvailable, candidateIds, [], reason)
    const record = createResolutionRecord({
      input,
      routing,
      localAvailable,
      remoteCandidateIds: candidateIds,
      decision: 'remote',
      reason,
      selectedCandidateId: routeCandidateId(selectedRemote),
      fallbackCandidateIds: fallback.map(routeCandidateId)
    })
    emitResolution(input.emit, record)
    return {
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
    if (selectedRemote !== undefined) return chooseRemote('network_only policy selected the first eligible remote candidate')
    return failNoRoute(input, routing, localAvailable, candidateIds, [], 'no eligible remote candidate')
  }
  if (routing.prefer === 'local' && localAvailable) {
    return chooseLocal('local preference selected the available local capability')
  }
  if (routing.prefer === 'network' && selectedRemote !== undefined) {
    return chooseRemote('network preference selected the first eligible remote candidate')
  }
  if (routing.fallback === 'local' && localAvailable) {
    return chooseLocal('preferred route unavailable; local fallback selected')
  }
  if (routing.fallback === 'network' && selectedRemote !== undefined) {
    return chooseRemote('preferred route unavailable; network fallback selected')
  }
  return failNoRoute(
    input,
    routing,
    localAvailable,
    candidateIds,
    fallback.map(routeCandidateId),
    input.localCapability.reason ?? 'no eligible route satisfies the configured policy'
  )
}

export function createAuroraNodeConfigTauriStore(
  storage: AuroraNodeConfigSecureStorage,
  options: AuroraNodeConfigTauriStoreOptions = {}
): AuroraNodeConfigStore {
  const key = options.key ?? AURORA_NODE_CONFIG_STORAGE_KEY
  const evidence = options.evidence ?? 'Tauri narrow nonsecret node-config storage'
  return {
    evidence,
    load: async () => {
      const result = await storage.get(key)
      if (typeof result.value !== 'string' || result.value.length === 0) return null
      const parsed = parseAuroraNodeConfigDocument(result.value)
      if (parsed) return parsed
      try {
        await storage.delete(key)
      } catch {
        // Invalid policy remains fail-closed even when cleanup is unavailable.
      }
      return null
    },
    save: async (document) => {
      const result = await storage.set(key, serializeAuroraNodeConfigDocument(document))
      if (!result.ok) throw new Error('Node config save failed')
    },
    clear: async () => {
      const result = await storage.delete(key)
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
  storage: AuroraNodeConfigSecureStorage,
  options: AuroraNodeConfigTauriStoreOptions = {}
): AuroraNodeConfigV2Store {
  const key = options.key ?? AURORA_NODE_CONFIG_V2_STORAGE_KEY
  const evidence = options.evidence ?? 'Tauri native-owned v2 speech policy storage'
  let writeChain: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = writeChain.then(operation, operation)
    writeChain = next.then(() => undefined, () => undefined)
    return next
  }
  const load = async (): Promise<AuroraNodeConfigDocumentV2 | null> => {
    const result = await storage.get(key)
    if (typeof result.value === 'string' && result.value.length > 0) {
      return parseAuroraNodeConfigDocumentV2(result.value)
    }
    // A v1 document is read-only provenance.  Persist its v2 projection under
    // the new key so subsequent reads use one canonical authority.
    const legacyResult = await storage.get(AURORA_NODE_CONFIG_STORAGE_KEY)
    if (typeof legacyResult.value !== 'string' || legacyResult.value.length === 0) return null
    const migrated = parseAuroraNodeConfigDocumentV2(legacyResult.value)
    if (migrated === null) return null
    const persisted = await storage.set(key, serializeAuroraNodeConfigDocumentV2(migrated))
    if (!persisted.ok) throw new Error('Node config v2 migration save failed')
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
      const result = await storage.set(key, serializeAuroraNodeConfigDocumentV2(normalized))
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
      const result = await storage.set(key, serializeAuroraNodeConfigDocumentV2(updated.document))
      if (!result.ok) throw new Error('Node config v2 save failed')
      return updated
    }),
    clear: async () => enqueue(async () => {
      const result = await storage.delete(key)
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

function selectorForCandidate(candidate: AuroraNodeRouteCandidate): MeshAddressSelector {
  if (candidate.selector !== undefined && candidate.selector !== null) return { ...candidate.selector }
  const selector: MeshAddressSelector = { peerId: candidate.peerId }
  if (candidate.providerId) selector.providerId = candidate.providerId
  if (candidate.serviceInstanceId) selector.serviceInstanceId = candidate.serviceInstanceId
  if (candidate.module) selector.module = candidate.module
  return selector
}

function cloneCandidate(candidate: AuroraNodeRouteCandidate): AuroraNodeRouteCandidate {
  return {
    ...candidate,
    ...(candidate.selector === undefined ? {} : { selector: candidate.selector === null ? null : { ...candidate.selector } })
  }
}

function isUsableCandidate(candidate: AuroraNodeRouteCandidate): boolean {
  return typeof candidate.peerId === 'string' && candidate.peerId.length > 0 && candidate.peerId.length <= 256
}

function routeCandidateId(candidate: AuroraNodeRouteCandidate): string {
  return [candidate.peerId, candidate.providerId ?? '', candidate.serviceInstanceId ?? ''].join('|')
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
