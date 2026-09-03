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
    .map((candidate) => {
      if (
        candidate.module !== undefined &&
        candidate.module !== null &&
        !isRuntimeModuleForNodeConfigModule(input.module, candidate.module)
      ) {
        throw new AuroraNodeConfigValidationError(
          'remoteCandidates.module',
          `must match the requested service module runtime alias (${runtimeModulesForNodeConfigModule(input.module).join(', ')})`
        )
      }
      return candidate
    })
    .filter((candidate) => isUsableCandidate(candidate))
    .map(cloneCandidate)
  const candidateIds = candidates.map(routeCandidateId)
  const selectedRemote = candidates[0]
  const remoteAttempts = candidates.map((candidate) => remoteAttempt(candidate))
  const localAttempt = localRoutingAttempt(input.module)

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
  return [candidate.peerId, candidate.providerId ?? '', candidate.serviceInstanceId ?? '', candidate.module ?? ''].join('|')
}

function localRouteId(module: AuroraNodeConfigModule): string {
  return `local:${module}`
}

function localRoutingAttempt(module: AuroraNodeConfigModule): AuroraNodeRoutingAttempt {
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
