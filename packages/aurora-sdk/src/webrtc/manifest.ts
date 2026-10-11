import { sha256 } from '@noble/hashes/sha2.js'

import type {
  MeshPeerManifest,
  MeshSpeechStageCapabilityExportV1,
  MeshSpeechStageCapabilityV1
} from '../mesh.js'
import type { ManifestAck, ManifestServiceCompatibility } from '../types.js'
import { bytesToHex, canonicalJson } from './encoding.js'

const MAX_STRING = 512
const MAX_NODE_NAME = 512
const MAX_SERVICES = 128
const MAX_METHODS = 512
const MAX_CAPABILITIES = 256
const MODULE_RE = /^[A-Za-z][A-Za-z0-9_:-]{0,127}$/u
const TOPIC_RE = /^[A-Za-z][A-Za-z0-9_:-]*(?:\.[A-Za-z][A-Za-z0-9_:-]*)+$/u
const SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,256}$/u
const HEX_64_RE = /^[0-9a-f]{64}$/u
const MAX_RAW_DEPTH = 16
const MAX_RAW_ARRAY_ITEMS = 1024
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const ACTIVE_MANIFEST_PROTOCOL = 'projection-v1'
const LEGACY_MANIFEST_PROTOCOL = 'legacy-unfiltered-v0'
const MAX_GRANTS = 512
// The gateway's RecipientProjectionEvidence model is declared extra="forbid",
// so the wire object carries exactly these fields.
const EVIDENCE_FIELDS: ReadonlySet<string> = new Set([
  'provider_peer_id',
  'recipient_peer_id',
  'registry_revision',
  'registry_digest',
  'policy_revision',
  'policy_digest',
  'auth_grant_revision',
  'auth_grant_state',
  'auth_grant_digest',
  'grants_digest',
  'protocol_tier',
  'projection_digest',
  'evidence_digest',
  'grants'
])
const GRANT_FIELDS: ReadonlySet<string> = new Set(['permission', 'source'])
const SPEECH_CAPABILITY_FIELDS: ReadonlySet<string> = new Set([
  'schema',
  'stage',
  'method_ids',
  'modes',
  'implementation',
  'peer_id',
  'resource_id',
  'capability_revision',
  'supported_formats',
  'sample_rates',
  'channels',
  'supported_languages',
  'model_ids',
  'lifecycle',
  'max_input_bytes',
  'max_chunk_bytes',
  'max_concurrent',
  'max_queue',
  'lease_ms',
  'readiness',
  'required_permissions',
  'audio_consent_required',
  'experimental',
  'exported'
])
const SPEECH_EXPORT_FIELDS: ReadonlySet<string> = new Set([
  'capability',
  'voice_ids',
  'requires_remote_audio_egress'
])
const SPEECH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const LOGICAL_VOICE_ID_RE = /^(?:standard:[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,63}|clone:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u

type MeshManifestAckFrame = ManifestAck & { type: 'manifest_ack' }

export class WebRtcManifestParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebRtcManifestParseError'
  }
}

export function parseWebRtcMeshManifest(
  frame: Readonly<Record<string, unknown>>,
  expectedPeerId: string
): MeshPeerManifest {
  assertIdentifier(expectedPeerId, 'expectedPeerId')
  const manifest = requirePlainRecord(frame, 'manifest')
  validateManifestTree(manifest, 'manifest')
  if (manifest.type !== 'manifest') throw new WebRtcManifestParseError('manifest type must be manifest')
  const peerId = requireString(manifest.peer_id, 'peer_id')
  if (peerId !== expectedPeerId) throw new WebRtcManifestParseError('manifest peer_id does not match authenticated peer')
  const nodeName = requireString(manifest.node_name, 'node_name', MAX_NODE_NAME)
  const version = optionalString(manifest.aurora_version, 'aurora_version')
  const sharedServices = requireArray(manifest.shared_services, 'shared_services', MAX_SERVICES)

  rejectConsumerOnlyProviderClaim(manifest)

  const seenModules = new Set<string>()
  const services = sharedServices.map((service, index) => {
    const normalized = parseService(service, index, peerId)
    if (seenModules.has(normalized.module)) {
      throw new WebRtcManifestParseError('duplicate manifest service module')
    }
    seenModules.add(normalized.module)
    return normalized
  })

  return {
    peerId,
    nodeName,
    version: version ?? null,
    authenticated: true,
    trusted: false,
    services,
    raw: manifest
  }
}

export function buildWebRtcManifestAck(
  manifest: MeshPeerManifest,
  options: { expectedRecipientPeerId?: string } = {}
): MeshManifestAckFrame {
  const input = requirePlainRecord(manifest, 'manifest') as unknown as MeshPeerManifest
  validateManifestTree(input, 'manifest')
  const peerId = requireString(input.peerId, 'peerId')
  assertIdentifier(peerId, 'peerId')
  const services = requireManifestServices(input.services ?? [])
  const sortedServices = [...services].sort((left, right) =>
    left.module < right.module ? -1 : left.module > right.module ? 1 : 0
  )
  assertUnique(sortedServices.map((service) => service.module), 'services')

  const raw = input.raw === undefined ? null : requirePlainRecord(input.raw, 'manifest.raw')
  if (raw === null || raw.active_protocol === undefined || raw.active_protocol === LEGACY_MANIFEST_PROTOCOL) {
    return legacyUnverifiableAck(sortedServices)
  }
  if (raw.active_protocol !== ACTIVE_MANIFEST_PROTOCOL) {
    throw new WebRtcManifestParseError('manifest ACK requires supported projection protocol')
  }
  if (raw.peer_id !== peerId) throw new WebRtcManifestParseError('manifest raw peer_id contradicts peerId')
  if (raw.active_version !== 'v1' || raw.active_tier !== 'projection' || raw.projection_active !== true) {
    throw new WebRtcManifestParseError('manifest ACK requires active projection-v1 evidence')
  }
  const evidence = requirePlainRecord(raw.recipient_projection_evidence, 'recipient_projection_evidence')
  if (evidence.provider_peer_id !== peerId) throw new WebRtcManifestParseError('projection evidence provider mismatch')
  if (evidence.protocol_tier !== ACTIVE_MANIFEST_PROTOCOL) throw new WebRtcManifestParseError('projection evidence protocol mismatch')
  const protocolRevision = requireString(raw.active_version, 'active_version')
  const registryRevision = requireString(evidence.registry_revision, 'registry_revision')
  const exportPolicyRevision = requireString(evidence.policy_revision, 'policy_revision')
  const authGrantRevision = requireNonNegativeInteger(evidence.auth_grant_revision, 'auth_grant_revision')
  // Ordering and per-service digests first, matching the precedence in
  // Python's _classify_projection_manifest, so a non-canonical manifest is
  // reported as such rather than as a digest mismatch.
  verifyProjectionEvidence(raw, evidence, options.expectedRecipientPeerId)
  const projectionDigest = requireDigest(evidence.projection_digest, 'projection_digest')
  const computedDigest = manifestProjectionDigest(raw)
  if (projectionDigest !== computedDigest) {
    throw new WebRtcManifestParseError('projection_digest contradicts manifest services')
  }

  const structured = sortedServices.map((service): ManifestServiceCompatibility => {
    if ((service.methods ?? []).length === 0) {
      return serviceStatus(service.module, 'incompatible', ['method_not_advertised'])
    }
    return serviceStatus(service.module, 'compatible', [])
  })
  return {
    type: 'manifest_ack',
    compatible_services: structured.filter((service) => service.status === 'compatible').map((service) => service.service_id),
    incompatible_services: structured.filter((service) => service.status === 'incompatible').map((service) => service.service_id),
    unused_services: [],
    active_protocol: ACTIVE_MANIFEST_PROTOCOL,
    active_version: protocolRevision,
    active_tier: 'projection',
    protocol_revision: protocolRevision,
    registry_revision: registryRevision,
    export_policy_revision: exportPolicyRevision,
    auth_grant_revision: authGrantRevision,
    projection_digest: projectionDigest,
    services: structured
  }
}

function parseService(
  value: unknown,
  index: number,
  manifestPeerId: string
): NonNullable<MeshPeerManifest['services']>[number] {
  const service = requirePlainRecord(value, `shared_services[${index}]`)
  const module = requireString(service.module, 'service.module')
  if (!MODULE_RE.test(module)) throw new WebRtcManifestParseError('invalid service module')
  rejectConsumerOnlyProviderClaim(service)
  const methodsValue = requireArray(service.methods ?? [], 'service.methods', MAX_METHODS)
  const methods = methodsValue.map((method, methodIndex) => parseMethod(method, methodIndex))
  const capabilities = requireStringArray(service.capabilities ?? [], 'service.capabilities', MAX_CAPABILITIES)
  const providerId = validOptionalId(service.provider_id ?? service.providerId)
  const serviceInstanceId = validOptionalId(service.service_instance_id ?? service.serviceInstanceId)
  const out: NonNullable<MeshPeerManifest['services']>[number] = {
    module,
    methods,
    capabilities
  }
  const version = optionalString(service.version, 'service.version')
  if (version !== undefined) out.version = version
  if (providerId !== null) out.providerId = providerId
  if (serviceInstanceId !== null) out.serviceInstanceId = serviceInstanceId
  if (Object.prototype.hasOwnProperty.call(service, 'speech_stage_capabilities')) {
    out.speechStageCapabilities = parseSpeechStageCapabilities(
      service.speech_stage_capabilities,
      manifestPeerId,
      module,
      methodsValue
    )
  }
  return out
}

function parseSpeechStageCapabilities(
  value: unknown,
  manifestPeerId: string,
  serviceModule: string,
  methods: unknown[]
): MeshSpeechStageCapabilityExportV1[] {
  const wrappers = requireArray(value, 'speech_stage_capabilities', MAX_RAW_ARRAY_ITEMS).map(
    (item, index) => parseSpeechStageExport(item, index, manifestPeerId, serviceModule, methods)
  )
  const canonicalWrappers = wrappers.map((wrapper) => canonicalJson(wrapper))
  assertUnique(canonicalWrappers, 'speech_stage_capabilities')
  for (let index = 1; index < canonicalWrappers.length; index += 1) {
    if (canonicalWrappers[index - 1]! > canonicalWrappers[index]!) {
      throw new WebRtcManifestParseError('speech_stage_capabilities is not canonical')
    }
  }
  return wrappers
}

function parseSpeechStageExport(
  value: unknown,
  index: number,
  manifestPeerId: string,
  serviceModule: string,
  methods: unknown[]
): MeshSpeechStageCapabilityExportV1 {
  const label = `speech_stage_capabilities[${index}]`
  const wrapper = requirePlainRecord(value, label)
  assertExactKeys(wrapper, SPEECH_EXPORT_FIELDS, label)
  const capability = parseSpeechStageCapability(
    wrapper.capability,
    `${label}.capability`,
    manifestPeerId,
    serviceModule,
    methods
  )
  const voiceIds = requireStringArray(wrapper.voice_ids, `${label}.voice_ids`, 256)
  if (voiceIds.some((voiceId) => !LOGICAL_VOICE_ID_RE.test(voiceId))) {
    throw new WebRtcManifestParseError(`${label}.voice_ids contains an invalid logical voice ID`)
  }
  assertUnique(voiceIds, `${label}.voice_ids`)
  if (typeof wrapper.requires_remote_audio_egress !== 'boolean') {
    throw new WebRtcManifestParseError(`${label}.requires_remote_audio_egress must be a boolean`)
  }
  return {
    capability,
    voice_ids: voiceIds,
    requires_remote_audio_egress: wrapper.requires_remote_audio_egress
  }
}

function parseSpeechStageCapability(
  value: unknown,
  label: string,
  manifestPeerId: string,
  serviceModule: string,
  methods: unknown[]
): MeshSpeechStageCapabilityV1 {
  const capability = requirePlainRecord(value, label)
  assertExactKeys(capability, SPEECH_CAPABILITY_FIELDS, label)
  if (capability.schema !== 'speech-stage-capability.v1') {
    throw new WebRtcManifestParseError(`${label}.schema is unsupported`)
  }

  const stages = new Set(['stt', 'tts', 'kws', 'vad'])
  if (typeof capability.stage !== 'string' || !stages.has(capability.stage)) {
    throw new WebRtcManifestParseError(`${label}.stage is invalid`)
  }
  const methodIds = requireStringArray(capability.method_ids, `${label}.method_ids`, 16)
  assertCanonicalUnique(methodIds, `${label}.method_ids`)
  if (methodIds.length === 0 || methodIds.some((methodId) => !TOPIC_RE.test(methodId))) {
    throw new WebRtcManifestParseError(`${label}.method_ids must contain valid methods`)
  }

  const modes = requireStringArray(capability.modes, `${label}.modes`, 2) as Array<'finite' | 'streaming'>
  if (modes.length === 0 || modes.some((mode) => mode !== 'finite' && mode !== 'streaming')) {
    throw new WebRtcManifestParseError(`${label}.modes is invalid`)
  }
  assertUnique(modes, `${label}.modes`)
  if ((capability.stage === 'kws' || capability.stage === 'vad') && modes.includes('streaming') && capability.experimental !== true) {
    throw new WebRtcManifestParseError(`${label} requires experimental streaming mode`)
  }
  const implementations = new Set(['native', 'wasm', 'python'])
  if (typeof capability.implementation !== 'string' || !implementations.has(capability.implementation)) {
    throw new WebRtcManifestParseError(`${label}.implementation is invalid`)
  }

  const peerId = requireString(capability.peer_id, `${label}.peer_id`, 256)
  if (!SPEECH_ID_RE.test(peerId) || peerId !== manifestPeerId) {
    throw new WebRtcManifestParseError(`${label}.peer_id does not match manifest provider`)
  }
  const resourceId = capability.resource_id
  if (typeof resourceId !== 'string' || !SPEECH_ID_RE.test(resourceId)) {
    throw new WebRtcManifestParseError(`${label}.resource_id is invalid`)
  }
  if (resourceId !== `remote:${manifestPeerId}:${serviceModule}`) {
    throw new WebRtcManifestParseError(`${label}.resource_id does not match service`)
  }

  const capabilityRevision = requireBoundedInteger(
    capability.capability_revision,
    `${label}.capability_revision`,
    0,
    Number.MAX_SAFE_INTEGER
  )
  const supportedFormats = requireUniqueSpeechStrings(capability.supported_formats, `${label}.supported_formats`, 16)
  const sampleRates = requireUniqueSpeechIntegers(capability.sample_rates, `${label}.sample_rates`, 16, 1, Number.MAX_SAFE_INTEGER)
  const channels = requireUniqueSpeechIntegers(capability.channels, `${label}.channels`, 8, 1, Number.MAX_SAFE_INTEGER)
  const supportedLanguages = requireUniqueSpeechStrings(capability.supported_languages, `${label}.supported_languages`, 64)
  const modelIds = requireUniqueSpeechStrings(capability.model_ids, `${label}.model_ids`, 64)
  const lifecycle = requireStringArray(capability.lifecycle, `${label}.lifecycle`, 2) as Array<'foreground' | 'active_native_capture'>
  if (lifecycle.length === 0 || lifecycle.some((item) => item !== 'foreground' && item !== 'active_native_capture')) {
    throw new WebRtcManifestParseError(`${label}.lifecycle is invalid`)
  }
  assertUnique(lifecycle, `${label}.lifecycle`)

  const maxInputBytes = requireBoundedInteger(capability.max_input_bytes, `${label}.max_input_bytes`, 1, 4 * 1024 * 1024)
  const maxChunkBytes = requireBoundedInteger(capability.max_chunk_bytes, `${label}.max_chunk_bytes`, 1, 64 * 1024)
  if (maxChunkBytes > maxInputBytes) {
    throw new WebRtcManifestParseError(`${label}.max_chunk_bytes exceeds max_input_bytes`)
  }
  const maxConcurrent = requireBoundedInteger(capability.max_concurrent, `${label}.max_concurrent`, 1, 4)
  const maxQueue = requireBoundedInteger(capability.max_queue, `${label}.max_queue`, 0, 4)
  const leaseMs = requireBoundedInteger(capability.lease_ms, `${label}.lease_ms`, 1, 300_000)

  const readinessValues = new Set(['ready', 'missing_model', 'loading', 'incompatible', 'unavailable'])
  if (typeof capability.readiness !== 'string' || !readinessValues.has(capability.readiness)) {
    throw new WebRtcManifestParseError(`${label}.readiness is invalid`)
  }
  const requiredPermissions = requireUniqueSpeechStrings(capability.required_permissions, `${label}.required_permissions`, 16)
  assertCanonicalUnique(requiredPermissions, `${label}.required_permissions`)
  const audioConsentRequired = requireSpeechBoolean(capability.audio_consent_required, `${label}.audio_consent_required`)
  const experimental = requireSpeechBoolean(capability.experimental, `${label}.experimental`)
  const exported = requireSpeechBoolean(capability.exported, `${label}.exported`)
  if (capability.readiness !== 'ready' || !exported) {
    throw new WebRtcManifestParseError(`${label} is not ready and exported`)
  }

  if (methodIds.some((methodId) => !methodId.startsWith(`${serviceModule}.`))) {
    throw new WebRtcManifestParseError(`${label}.method_ids must belong to ${serviceModule}`)
  }

  const methodPermissions = new Map<string, string[]>()
  for (const [methodIndex, methodValue] of methods.entries()) {
    if (typeof methodValue === 'string') {
      continue
    }
    const method = requirePlainRecord(methodValue, `methods[${methodIndex}]`)
    const topic = method.bus_topic ?? method.busTopic
    if (typeof topic !== 'string') continue
    const permissions = requireStringArray(
      method.required_perms ?? method.requiredPerms ?? [],
      `methods[${methodIndex}].required_perms`,
      MAX_CAPABILITIES
    )
    methodPermissions.set(topic, permissions)
  }
  const permissionUnion = new Set<string>()
  for (const methodId of methodIds) {
    const permissions = methodPermissions.get(methodId)
    if (permissions === undefined || permissions.length === 0 || permissions.some((item) => item.trim() !== item)) {
      throw new WebRtcManifestParseError(`${label} references a method with unknown permissions`)
    }
    for (const permission of permissions) permissionUnion.add(permission)
  }
  const expectedPermissions = [...permissionUnion].sort()
  if (
    expectedPermissions.length === 0
    || expectedPermissions.length !== requiredPermissions.length
    || expectedPermissions.some((permission, permissionIndex) => requiredPermissions[permissionIndex] !== permission)
  ) {
    throw new WebRtcManifestParseError(`${label}.required_permissions do not match its methods`)
  }

  return {
    schema: 'speech-stage-capability.v1',
    stage: capability.stage as MeshSpeechStageCapabilityV1['stage'],
    method_ids: methodIds,
    modes,
    implementation: capability.implementation as MeshSpeechStageCapabilityV1['implementation'],
    peer_id: peerId,
    resource_id: resourceId,
    capability_revision: capabilityRevision,
    supported_formats: supportedFormats,
    sample_rates: sampleRates,
    channels,
    supported_languages: supportedLanguages,
    model_ids: modelIds,
    lifecycle,
    max_input_bytes: maxInputBytes,
    max_chunk_bytes: maxChunkBytes,
    max_concurrent: maxConcurrent,
    max_queue: maxQueue,
    lease_ms: leaseMs,
    readiness: capability.readiness as MeshSpeechStageCapabilityV1['readiness'],
    required_permissions: requiredPermissions,
    audio_consent_required: audioConsentRequired,
    experimental,
    exported
  }
}

function requireUniqueSpeechStrings(value: unknown, label: string, max: number): string[] {
  const values = requireStringArray(value, label, max)
  if (values.some((item) => item.trim() !== item)) {
    throw new WebRtcManifestParseError(`${label} contains surrounding whitespace`)
  }
  assertUnique(values, label)
  return values
}

function requireUniqueSpeechIntegers(
  value: unknown,
  label: string,
  max: number,
  minimum: number,
  maximum: number
): number[] {
  const values = requireArray(value, label, max).map((item) => requireBoundedInteger(item, label, minimum, maximum))
  assertUnique(values.map(String), label)
  return values
}

function requireBoundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new WebRtcManifestParseError(`${label} must be an integer from ${minimum} through ${maximum}`)
  }
  return value
}

function requireSpeechBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new WebRtcManifestParseError(`${label} must be a boolean`)
  return value
}

function parseMethod(value: unknown, index: number): string {
  if (typeof value === 'string') {
    if (!TOPIC_RE.test(value) || value.length > MAX_STRING) throw new WebRtcManifestParseError('invalid method topic')
    return value
  }
  const method = requirePlainRecord(value, `methods[${index}]`)
  const busTopic = method.bus_topic ?? method.busTopic
  if (typeof busTopic === 'string' && busTopic.length <= MAX_STRING && TOPIC_RE.test(busTopic)) {
    return busTopic
  }
  throw new WebRtcManifestParseError('manifest method is missing valid bus_topic')
}

function requireManifestServices(value: unknown): NonNullable<MeshPeerManifest['services']> {
  const services = requireArray(value, 'services', MAX_SERVICES)
  return services.map((item, index) => {
    const service = requirePlainRecord(item, `services[${index}]`)
    const module = requireString(service.module, 'service.module')
    if (!MODULE_RE.test(module)) throw new WebRtcManifestParseError('invalid service module')
    const out: NonNullable<MeshPeerManifest['services']>[number] = {
      module,
      methods: requireStringArray(service.methods ?? [], 'service.methods', MAX_METHODS).map((method) => {
        if (!TOPIC_RE.test(method)) throw new WebRtcManifestParseError('invalid service method topic')
        return method
      }),
      capabilities: requireStringArray(service.capabilities ?? [], 'service.capabilities', MAX_CAPABILITIES)
    }
    const version = optionalString(service.version, 'service.version')
    const providerId = validOptionalId(service.providerId)
    const serviceInstanceId = validOptionalId(service.serviceInstanceId)
    if (version !== undefined) out.version = version
    if (providerId !== null) out.providerId = providerId
    if (serviceInstanceId !== null) out.serviceInstanceId = serviceInstanceId
    return out
  })
}

function legacyUnverifiableAck(services: NonNullable<MeshPeerManifest['services']>): MeshManifestAckFrame {
  const structured = services.map((service) => serviceStatus(service.module, 'incompatible', ['legacy_unverifiable']))
  return {
    type: 'manifest_ack',
    compatible_services: [],
    incompatible_services: structured.map((service) => service.service_id),
    unused_services: [],
    active_protocol: null,
    active_version: null,
    active_tier: null,
    protocol_revision: null,
    registry_revision: null,
    export_policy_revision: null,
    auth_grant_revision: null,
    projection_digest: null,
    services: structured
  }
}

function serviceStatus(
  serviceId: string,
  status: ManifestServiceCompatibility['status'],
  reasonCodes: ManifestServiceCompatibility['reason_codes']
): ManifestServiceCompatibility {
  return {
    service_id: serviceId,
    service_label: '',
    status,
    reason_codes: [...new Set(reasonCodes)].sort() as ManifestServiceCompatibility['reason_codes'],
    reason: ''
  }
}

/**
 * Verify the projection-v1 evidence chain the same way the Python gateway does.
 *
 * The gateway's `_classify_projection_manifest` is the reference.
 * Without these checks a peer Python classifies as
 * `permissions_unknown` — revoked authority, unsigned grants, a manifest whose
 * services are not in canonical order — was accepted here, so the two
 * implementations disagreed about which peers were usable.
 *
 * Digests are recomputed over the raw wire objects, matching how
 * `projection_digest` is already verified. Both shipped providers emit a
 * complete field set, so a provider that omits optional keys is rejected here
 * where Python would accept it; that direction is fail-closed and visible.
 */
function verifyProjectionEvidence(
  rawManifest: Record<string, unknown>,
  evidence: Record<string, unknown>,
  expectedRecipientPeerId?: string
): void {
  if (rawManifest.granted_permissions !== null && rawManifest.granted_permissions !== undefined) {
    throw new WebRtcManifestParseError('projection manifest cannot carry legacy granted_permissions')
  }
  if (rawManifest.projection_supported !== true) {
    throw new WebRtcManifestParseError('projection manifest must advertise projection support')
  }
  assertCanonicalProjectionOrder(rawManifest)
  assertExactKeys(evidence, EVIDENCE_FIELDS, 'recipient_projection_evidence')

  if (evidence.auth_grant_state !== 'active') {
    throw new WebRtcManifestParseError('projection evidence authority is not active')
  }
  const authGrantRevision = requireNonNegativeInteger(evidence.auth_grant_revision, 'auth_grant_revision')
  if (authGrantRevision < 1) {
    throw new WebRtcManifestParseError('projection evidence authority revision is unknown')
  }
  const recipientPeerId = requireString(evidence.recipient_peer_id, 'recipient_peer_id')
  assertIdentifier(recipientPeerId, 'recipient_peer_id')
  if (!expectedRecipientPeerId) {
    throw new WebRtcManifestParseError('projection evidence recipient is unbound')
  }
  if (recipientPeerId !== expectedRecipientPeerId) {
    throw new WebRtcManifestParseError('projection evidence recipient mismatch')
  }

  const grants = requireArray(evidence.grants, 'grants', MAX_GRANTS).map((grant, index) => {
    const record = requirePlainRecord(grant, `grants[${index}]`)
    assertExactKeys(record, GRANT_FIELDS, `grants[${index}]`)
    return {
      permission: requireString(record.permission, 'grants[].permission'),
      source: requireString(record.source, 'grants[].source')
    }
  })
  assertCanonicalGrants(grants)

  if (requireDigest(evidence.grants_digest, 'grants_digest') !== canonicalDigest({ grants })) {
    throw new WebRtcManifestParseError('grants_digest contradicts the grant evidence')
  }

  // Mirrors RecipientEvidence.to_canonical(include_digest=False).
  const expectedAuthorityDigest = canonicalDigest({
    grants,
    peer_id: recipientPeerId,
    readiness: 'ready',
    revision: authGrantRevision,
    state: 'active'
  })
  if (requireDigest(evidence.auth_grant_digest, 'auth_grant_digest') !== expectedAuthorityDigest) {
    throw new WebRtcManifestParseError('auth_grant_digest contradicts the recipient authority')
  }

  const { evidence_digest: declaredEvidenceDigest, ...evidenceWithoutDigest } = evidence
  if (requireDigest(declaredEvidenceDigest, 'evidence_digest') !== canonicalDigest(evidenceWithoutDigest)) {
    throw new WebRtcManifestParseError('evidence_digest contradicts the projection evidence')
  }
}

/** Canonical ordering, uniqueness, and per-service digests, as Python requires. */
function assertCanonicalProjectionOrder(rawManifest: Record<string, unknown>): void {
  const protocols = rawManifest.supported_protocols
  if (protocols !== undefined && protocols !== null) {
    assertCanonicalUnique(requireStringArray(protocols, 'supported_protocols', MAX_CAPABILITIES), 'supported_protocols')
  }
  const services = requireArray(rawManifest.shared_services, 'shared_services', MAX_SERVICES)
  assertCanonicalUnique(
    services.map((service, index) => requireString(requirePlainRecord(service, `shared_services[${index}]`).module, 'service.module')),
    'shared_services'
  )
  for (const [index, service] of services.entries()) {
    const record = requirePlainRecord(service, `shared_services[${index}]`)
    assertCanonicalUnique(requireStringArray(record.capabilities ?? [], 'service.capabilities', MAX_CAPABILITIES), 'capabilities')
    assertCanonicalUnique(
      requireStringArray(record.available_feature_ids ?? [], 'service.available_feature_ids', MAX_CAPABILITIES),
      'available_feature_ids'
    )
    assertCanonicalFeatures(record.callable_features, 'service.callable_features')

    const methods = requireArray(record.methods ?? [], 'service.methods', MAX_METHODS)
    const topics = methods.map((method, methodIndex) => {
      const methodRecord = requirePlainRecord(method, `methods[${methodIndex}]`)
      const topic = requireString(methodRecord.bus_topic, 'method.bus_topic')
      assertCanonicalUnique(requireStringArray(methodRecord.required_perms ?? [], 'method.required_perms', MAX_CAPABILITIES), 'required_perms')
      assertCanonicalUnique(
        requireStringArray(methodRecord.callable_feature_ids ?? [], 'method.callable_feature_ids', MAX_CAPABILITIES),
        'callable_feature_ids'
      )
      assertCanonicalFeatures(methodRecord.callable_features, 'method.callable_features')
      return topic
    })
    assertCanonicalUnique(topics, 'methods')

    const declaredDigest = record.digest
    if (typeof declaredDigest !== 'string' || declaredDigest.length === 0) {
      throw new WebRtcManifestParseError('projection service is missing its digest')
    }
    const { digest: _ignored, ...serviceWithoutDigest } = record
    if (requireDigest(declaredDigest, 'service.digest') !== canonicalDigest(serviceWithoutDigest)) {
      throw new WebRtcManifestParseError('service digest contradicts the advertised service')
    }
  }
}

function assertCanonicalFeatures(value: unknown, label: string): void {
  if (value === undefined || value === null) return
  const features = requireArray(value, label, MAX_CAPABILITIES)
  const ids = features.map((feature, index) => {
    const record = requirePlainRecord(feature, `${label}[${index}]`)
    assertCanonicalUnique(requireStringArray(record.method_ids ?? [], `${label}.method_ids`, MAX_METHODS), `${label}.method_ids`)
    return requireString(record.feature_id, `${label}.feature_id`)
  })
  assertCanonicalUnique(ids, label)
}

/** Python's `_require_canonical_unique`: unique and already in code-point order. */
function assertCanonicalUnique(values: string[], field: string): void {
  assertUnique(values, field)
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! > values[index]!) {
      throw new WebRtcManifestParseError(`${field} is not canonical`)
    }
  }
}

function assertCanonicalGrants(grants: Array<{ permission: string; source: string }>): void {
  assertUnique(grants.map((grant) => grant.permission), 'grants')
  for (let index = 1; index < grants.length; index += 1) {
    const previous = grants[index - 1]!
    const current = grants[index]!
    const ordered = previous.permission < current.permission
      || (previous.permission === current.permission && previous.source <= current.source)
    if (!ordered) throw new WebRtcManifestParseError('grants are not canonical')
  }
}

function assertExactKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new WebRtcManifestParseError(`${label} has unknown field`)
  }
  for (const key of allowed) {
    if (!(key in record)) throw new WebRtcManifestParseError(`${label} is missing ${key}`)
  }
}

function canonicalDigest(value: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJson(value))))
}

function manifestProjectionDigest(rawManifest: Record<string, unknown>): string {
  const rawServices = requireArray(rawManifest.shared_services, 'shared_services', MAX_SERVICES)
  const services = rawServices.map((service, index) => {
    const record = requirePlainRecord(service, `shared_services[${index}]`)
    const { digest: _digest, ...withoutDigest } = record
    return withoutDigest
  })
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJson({
    provider_peer_id: rawManifest.peer_id,
    services
  }))))
}

function validateManifestTree(value: unknown, label: string, depth = 0): void {
  if (depth > MAX_RAW_DEPTH) throw new WebRtcManifestParseError(`${label} exceeds maximum nesting depth`)
  if (Array.isArray(value)) {
    if (value.length > MAX_RAW_ARRAY_ITEMS) throw new WebRtcManifestParseError(`${label} array exceeds maximum size`)
    value.forEach((item, index) => validateManifestTree(item, `${label}[${index}]`, depth + 1))
    return
  }
  if (value === null || typeof value !== 'object') return
  const record = requirePlainRecord(value, label)
  rejectAccessors(record, label)
  for (const key of Object.keys(record)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) throw new WebRtcManifestParseError(`${label} contains unsafe object key`)
    validateManifestTree(record[key], `${label}.${key}`, depth + 1)
  }
}

function rejectConsumerOnlyProviderClaim(record: Record<string, unknown>): void {
  const role = record.role ?? record.peer_role ?? record.peerRole
  if (role === 'consumer') throw new WebRtcManifestParseError('consumer-only peer cannot provide a manifest')
  const capabilities = record.capabilities
  if (Array.isArray(capabilities) && capabilities.includes('consumer_only_v1')) {
    throw new WebRtcManifestParseError('consumer-only peer cannot provide a manifest')
  }
}

function requirePlainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebRtcManifestParseError(`${label} must be an object`)
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    throw new WebRtcManifestParseError(`${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function rejectAccessors(record: Record<string, unknown>, label: string): void {
  for (const key of Object.keys(record)) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new WebRtcManifestParseError(`${label} contains accessor property`)
    }
  }
}

function requireString(value: unknown, field: string, max = MAX_STRING): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new WebRtcManifestParseError(`${field} must be a bounded string`)
  }
  return value
}

function optionalString(value: unknown, field: string, max = MAX_STRING): string | undefined {
  if (value === undefined || value === null) return undefined
  return requireString(value, field, max)
}

function requireDigest(value: unknown, field: string): string {
  const digest = requireString(value, field, 64)
  if (!HEX_64_RE.test(digest)) throw new WebRtcManifestParseError(`${field} must be lowercase sha256 hex`)
  return digest
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || typeof value !== 'number' || value < 0) {
    throw new WebRtcManifestParseError(`${field} must be a non-negative integer`)
  }
  return value
}

function requireArray(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new WebRtcManifestParseError(`${field} must be a bounded array`)
  }
  return value
}

function requireStringArray(value: unknown, field: string, max: number): string[] {
  return requireArray(value, field, max).map((item) => requireString(item, field))
}

function validOptionalId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value)) return null
  return value
}

function assertIdentifier(value: string, field: string): void {
  if (!SAFE_ID_RE.test(value)) throw new WebRtcManifestParseError(`${field} must be a bounded identifier`)
}

function assertUnique(values: string[], field: string): void {
  if (new Set(values).size !== values.length) throw new WebRtcManifestParseError(`${field} must be unique`)
}
