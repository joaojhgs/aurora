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
