import { sha256 } from '@noble/hashes/sha2.js'

import type { MeshPeerManifest } from '../mesh.js'
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
    const normalized = parseService(service, index)
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

export function buildWebRtcManifestAck(manifest: MeshPeerManifest): MeshManifestAckFrame {
  const input = requirePlainRecord(manifest, 'manifest') as unknown as MeshPeerManifest
  validateManifestTree(input, 'manifest')
  const peerId = requireString(input.peerId, 'peerId')
  assertIdentifier(peerId, 'peerId')
  const services = requireManifestServices(input.services ?? [])
  const sortedServices = [...services].sort((left, right) => left.module.localeCompare(right.module))
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

function parseService(value: unknown, index: number): NonNullable<MeshPeerManifest['services']>[number] {
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
  return out
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
