// Aurora cockpit domain types. Mirrors the SDK contract / capability graph specs.

export type DeploymentMode =
  | 'Server'
  | 'Desktop Local'
  | 'Desktop Thin'
  | 'Mesh'
  | 'Android'
  | 'iOS'
  | 'Offline'
  | 'Hybrid'

export type RouteKind =
  | 'Local'
  | 'Remote'
  | 'Mesh Peer'
  | 'Native Mobile'
  | 'Fallback'
  | 'Unknown'

export type PrivacyClass =
  | 'public'
  | 'personal'
  | 'sensitive'
  | 'secret'
  | 'raw-audio'
  | 'credential'
  | 'admin-critical'

export type IdentityState =
  | 'Anonymous'
  | 'Pairing'
  | 'User'
  | 'Admin'
  | 'Mesh peer'
  | 'Expired'

export type HealthState =
  | 'Healthy'
  | 'Degraded'
  | 'Offline'
  | 'Starting'
  | 'Needs attention'

export type AvailabilityState =
  | 'available'
  | 'degraded'
  | 'read_only'
  | 'remote_only'
  | 'local_only'
  | 'needs_auth'
  | 'needs_pairing'
  | 'needs_permission'
  | 'needs_native_permission'
  | 'missing_service'
  | 'unsupported_platform'
  | 'unknown'
  | 'error'

export type BackendCoverage = 'implemented' | 'partial' | 'internal_only' | 'missing_contract' | 'planned' | 'mock_only'

export interface CapabilityFeature {
  id: string
  label: string
  category:
    | 'assistant'
    | 'admin'
    | 'mesh'
    | 'model'
    | 'native'
    | 'diagnostics'
    | 'config'
    | 'tools'
    | 'memory'
  state: AvailabilityState
  privacyClass: PrivacyClass
  requiredServices: string[]
  requiredMethods?: string[]
  requiredPermissions: string[]
  backendCoverage?: BackendCoverage
  transportNotes?: string[]
  missing?: string[]
  userActions?: string[]
  note?: string
}

export type ContractExposure = 'internal' | 'external' | 'both' | 'gateway_builtin' | 'planned'
export type ContractMethodType = 'use' | 'manage' | 'event' | 'gateway' | 'planned'

export interface ServiceMethod {
  name: string
  busTopic: string
  methodType: ContractMethodType
  exposure: ContractExposure
  permissions: string[]
  routePath?: string
  backendCoverage?: BackendCoverage
  note?: string
}

export interface AuroraService {
  module: string
  status: HealthState
  instanceId: string
  capabilities: string[]
  methods: ServiceMethod[]
  lastHeartbeat: string
  routeAvailability: RouteKind
  description: string
}

export interface Principal {
  id: string
  name: string
  kind: 'user' | 'device' | 'service'
  isAdmin: boolean
  role: string
  permissions: string[]
  created: string
  lastActive: string
}

export interface Permission {
  id: string
  label: string
  scope: 'assistant' | 'memory' | 'tools' | 'admin' | 'mesh' | 'config' | 'scheduler' | 'gateway' | 'audio'
  backendNamespace: string
  description?: string
}

export interface Role {
  id: string
  name: string
  description: string
  system?: boolean
  principalCount: number
  permissions: string[]
}

export interface ApiToken {
  id: string
  prefix: string
  principal: string
  scopes: string[]
  created: string
  expires: string
  status: 'active' | 'expiring' | 'revoked'
}

export interface Device {
  id: string
  name: string
  trust: 'trusted' | 'pending' | 'revoked'
  user: string
  lastSeen: string
  source: RouteKind
  platform: string
}

export interface MeshPeer {
  id: string
  name: string
  fingerprint: string
  status: 'approved' | 'pending' | 'denied'
  permissions: string[]
  latencyMs: number
  lastSeen: string
  routeQuality: 'excellent' | 'good' | 'poor'
}

export interface AuditEvent {
  id: string
  timestamp: string
  actor: string
  action: string
  resource: string
  severity: 'info' | 'warning' | 'critical'
  result: 'success' | 'denied' | 'error'
}

export interface ConfigEntry {
  key: string
  section: string
  value: string
  source: 'config.json' | 'env' | 'default'
  description: string
  secret?: boolean
  restartRequired?: boolean
}

export interface ActivityEvent {
  id: string
  type: 'assistant' | 'service' | 'mesh' | 'config' | 'audit' | 'warning'
  title: string
  detail: string
  time: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  route?: RouteKind
  model?: string
  privacyClass?: PrivacyClass
  toolCall?: ToolCall
  citations?: string[]
}

export interface ToolCall {
  name: string
  target: string
  inputs: Record<string, string>
  risk: 'read-only' | 'mutating' | 'external' | 'admin'
  dataLeavesDevice: boolean
  status: 'pending' | 'approved' | 'denied'
}

export interface Conversation {
  id: string
  title: string
  route: RouteKind
  model: string
  privacyClass: PrivacyClass
  updated: string
  pinned?: boolean
}

export interface ModelProvider {
  id: string
  name: string
  kind: 'local' | 'remote' | 'mesh' | 'mobile'
  status: AvailabilityState
  size?: string
  contextWindow: string
  health: HealthState
}

export interface RouteCandidate {
  kind: RouteKind
  label: string
  model: string
  privacyClass: PrivacyClass
  latencyMs: number
  cost: 'free' | 'low' | 'metered'
  available: boolean
  blockers?: string[]
  auditRequired?: boolean
  payloadPreview?: string
  target?: string
  note?: string
}

export interface SpecCoverageRow {
  id: string
  area: 'assistant' | 'admin' | 'mesh' | 'models' | 'tools' | 'memory' | 'native' | 'sdk'
  label: string
  specStatus: 'covered' | 'partial' | 'needs_refinement'
  backendStatus: BackendCoverage
  mockStatus: 'covered' | 'partial' | 'missing'
  requiredBackendWork: string[]
  requiredMockWork: string[]
  taskNotes: string
}
