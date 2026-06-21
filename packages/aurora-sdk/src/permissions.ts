import { describeBackendInventory, describeRegistry } from './descriptors.js'
import type {
  BackendInventory,
  ContractExposure,
  ContractMethodType,
  GatewayBuiltinRouteDescriptor,
  GetRegistryResponse,
  MethodDescriptor
} from './types.js'

export const PERMISSION_ALL = '*'

export type PermissionCatalogEntryKind =
  | 'all'
  | 'service_wildcard'
  | 'method_type'
  | 'method'
  | 'gateway_builtin'
  | 'unknown'

export interface PermissionCatalogEntry {
  id: string
  label: string
  description: string
  service: string | null
  action: string | null
  kind: PermissionCatalogEntryKind
  methodType: ContractMethodType | null
  exposure: ContractExposure | null
  busTopic: string | null
  routePath: string | null
  availableOverHttp: boolean
  requiredBy: PermissionRequirementSource[]
}

export interface PermissionRequirementSource {
  module: string | null
  method: string
  busTopic: string | null
  routePath: string | null
  methodType: ContractMethodType | null
  exposure: ContractExposure | null
  availableOverHttp: boolean
  source: 'registry' | 'backend_inventory' | 'gateway_builtin' | 'manual'
}

export interface PermissionCatalogInput {
  methods?: MethodDescriptor[]
  gatewayBuiltins?: GatewayBuiltinRouteDescriptor[]
  source?: PermissionRequirementSource['source']
}

export interface PermissionAccessDecision {
  allowed: boolean
  required: string[]
  satisfied: string[]
  missing: string[]
  grants: Record<string, string | null>
}

export interface EffectivePermissionInput {
  userPermissions: string[]
  userIsAdmin?: boolean
  tokenScopes: string[]
}

export function permissionLabel(permission: string): string {
  if (permission === PERMISSION_ALL) return 'Full access'
  const parsed = parsePermission(permission)
  if (!parsed.service) return permission
  if (parsed.action === '*') return `All ${parsed.service} permissions`
  if (parsed.action === 'use') return `Use ${parsed.service}`
  if (parsed.action === 'manage') return `Manage ${parsed.service}`
  return parsed.action ? `${parsed.service} ${splitWords(parsed.action)}` : parsed.service
}

export function permissionDescription(permission: string, methodType: ContractMethodType | null = null): string {
  if (permission === PERMISSION_ALL) return 'Grants every Aurora permission.'
  const parsed = parsePermission(permission)
  if (!parsed.service) return `Backend permission ${permission}.`
  if (parsed.action === '*') return `Grants every ${parsed.service} permission.`
  if (parsed.action === 'use') return `Grants ${parsed.service} methods whose backend method_type is use.`
  if (parsed.action === 'manage') return `Grants ${parsed.service} methods whose backend method_type is manage.`
  const typeSuffix = methodType ? ` This method is classified as ${methodType}.` : ''
  return `Grants backend permission ${permission}.${typeSuffix}`
}

export function buildPermissionCatalog(input: PermissionCatalogInput): PermissionCatalogEntry[] {
  const entries = new Map<string, PermissionCatalogEntry>()
  ensureEntry(entries, PERMISSION_ALL, null, null)

  for (const method of input.methods ?? []) {
    const source = requirementSourceFromMethod(method, input.source ?? 'registry')
    ensureServiceTemplates(entries, method.module)
    ensureEntry(entries, method.busTopic, method.methodType, source)
    for (const permission of method.requiredPermissions) {
      ensureEntry(entries, permission, method.methodType, source).requiredBy.push(source)
    }
  }

  for (const route of input.gatewayBuiltins ?? []) {
    const source = requirementSourceFromGatewayBuiltin(route)
    for (const permission of route.requiredPermissions) {
      ensureEntry(entries, permission, route.methodType, source).requiredBy.push(source)
    }
  }

  return [...entries.values()]
    .map((entry) => ({
      ...entry,
      requiredBy: uniqueRequirementSources(entry.requiredBy)
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

export function buildPermissionCatalogFromRegistry(
  registry: GetRegistryResponse,
  gatewayBuiltins: GatewayBuiltinRouteDescriptor[] = []
): PermissionCatalogEntry[] {
  return buildPermissionCatalog({
    methods: describeRegistry(registry),
    gatewayBuiltins,
    source: 'registry'
  })
}

export function buildPermissionCatalogFromBackendInventory(inventory: BackendInventory): PermissionCatalogEntry[] {
  const descriptors = describeBackendInventory(inventory)
  return buildPermissionCatalog({
    methods: descriptors.methods,
    gatewayBuiltins: descriptors.gatewayBuiltins,
    source: 'backend_inventory'
  })
}

export function hasPermission(
  required: string,
  grantedPermissions: Iterable<string>,
  methodType: ContractMethodType | null = null
): boolean {
  return permissionGrantFor(required, grantedPermissions, methodType) !== null
}

export function permissionGrantFor(
  required: string,
  grantedPermissions: Iterable<string>,
  methodType: ContractMethodType | null = null
): string | null {
  const granted = new Set(grantedPermissions)
  if (granted.has(PERMISSION_ALL)) return PERMISSION_ALL
  if (granted.has(required)) return required

  const requiredParts = required.split('.')
  if (requiredParts.length > 1) {
    for (const permission of granted) {
      if (!permission.endsWith('.*')) continue
      const prefixParts = permission.slice(0, -2).split('.')
      if (
        prefixParts.length < requiredParts.length &&
        requiredParts.slice(0, prefixParts.length).every((part, index) => part === prefixParts[index])
      ) {
        return permission
      }
    }
  }

  if (methodType && requiredParts.length > 1) {
    const typePermission = `${requiredParts[0]}.${methodType}`
    if (granted.has(typePermission)) return typePermission
  }

  return null
}

export function checkAccess(
  effectivePermissions: Iterable<string>,
  requiredPermissions: string[],
  methodType: ContractMethodType | null = null
): PermissionAccessDecision {
  const grants: Record<string, string | null> = {}
  const satisfied: string[] = []
  const missing: string[] = []

  for (const required of requiredPermissions) {
    const grant = permissionGrantFor(required, effectivePermissions, methodType)
    grants[required] = grant
    if (grant) satisfied.push(required)
    else missing.push(required)
  }

  return {
    allowed: missing.length === 0,
    required: [...requiredPermissions],
    satisfied,
    missing,
    grants
  }
}

export function wildcardIntersection(userPermissions: Iterable<string>, tokenScopes: Iterable<string>): string[] {
  const user = new Set(userPermissions)
  const effective = new Set<string>()

  for (const scope of tokenScopes) {
    if (hasPermission(scope, user)) {
      effective.add(scope)
      continue
    }
    if (!isWildcardPermission(scope)) continue
    for (const permission of user) {
      if (hasPermission(permission, [scope])) effective.add(permission)
    }
  }

  return sortedUnique([...effective])
}

export function resolveEffectivePermissions(input: EffectivePermissionInput): string[] {
  if (input.userIsAdmin) return [PERMISSION_ALL]
  if (input.tokenScopes.includes(PERMISSION_ALL) || input.tokenScopes.includes('all')) {
    return sortedUnique(input.userPermissions)
  }
  return wildcardIntersection(input.userPermissions, input.tokenScopes)
}

export function permissionsForMethod(method: Pick<MethodDescriptor, 'requiredPermissions' | 'methodType'>): string[] {
  return sortedUnique([
    ...method.requiredPermissions,
    ...method.requiredPermissions.flatMap((permission) => {
      const parsed = parsePermission(permission)
      if (!parsed.service) return []
      return [`${parsed.service}.*`, `${parsed.service}.${method.methodType}`]
    }),
    PERMISSION_ALL
  ])
}

function ensureServiceTemplates(entries: Map<string, PermissionCatalogEntry>, service: string): void {
  ensureEntry(entries, `${service}.*`, null, null)
  ensureEntry(entries, `${service}.use`, 'use', null)
  ensureEntry(entries, `${service}.manage`, 'manage', null)
}

function ensureEntry(
  entries: Map<string, PermissionCatalogEntry>,
  permission: string,
  methodType: ContractMethodType | null,
  source: PermissionRequirementSource | null
): PermissionCatalogEntry {
  const existing = entries.get(permission)
  if (existing) return existing

  const parsed = parsePermission(permission)
  const entry: PermissionCatalogEntry = {
    id: permission,
    label: permissionLabel(permission),
    description: permissionDescription(permission, methodType),
    service: parsed.service,
    action: parsed.action,
    kind: permissionKind(permission, source),
    methodType: methodTypeForPermission(permission, methodType),
    exposure: source?.exposure ?? null,
    busTopic: source?.busTopic ?? (parsed.action && !['*', 'use', 'manage'].includes(parsed.action) ? permission : null),
    routePath: source?.routePath ?? null,
    availableOverHttp: source?.availableOverHttp ?? false,
    requiredBy: []
  }
  entries.set(permission, entry)
  return entry
}

function permissionKind(permission: string, source: PermissionRequirementSource | null): PermissionCatalogEntryKind {
  if (permission === PERMISSION_ALL) return 'all'
  const parsed = parsePermission(permission)
  if (parsed.action === '*') return 'service_wildcard'
  if (parsed.action === 'use' || parsed.action === 'manage') return 'method_type'
  if (source?.source === 'gateway_builtin') return 'gateway_builtin'
  return parsed.service ? 'method' : 'unknown'
}

function methodTypeForPermission(permission: string, methodType: ContractMethodType | null): ContractMethodType | null {
  const action = parsePermission(permission).action
  if (action === 'use' || action === 'manage') return action
  return methodType
}

function parsePermission(permission: string): { service: string | null; action: string | null } {
  if (permission === PERMISSION_ALL) return { service: null, action: null }
  const [service, action] = permission.split('.', 2)
  return {
    service: service || null,
    action: action || null
  }
}

function requirementSourceFromMethod(
  method: MethodDescriptor,
  source: PermissionRequirementSource['source']
): PermissionRequirementSource {
  return {
    module: method.module,
    method: method.name,
    busTopic: method.busTopic,
    routePath: method.routePath,
    methodType: method.methodType,
    exposure: method.exposure,
    availableOverHttp: method.availableOverHttp,
    source
  }
}

function requirementSourceFromGatewayBuiltin(route: GatewayBuiltinRouteDescriptor): PermissionRequirementSource {
  return {
    module: 'Gateway',
    method: route.name,
    busTopic: null,
    routePath: route.routePath,
    methodType: route.methodType,
    exposure: route.exposure,
    availableOverHttp: true,
    source: 'gateway_builtin'
  }
}

function uniqueRequirementSources(sources: PermissionRequirementSource[]): PermissionRequirementSource[] {
  const seen = new Set<string>()
  const unique: PermissionRequirementSource[] = []
  for (const source of sources) {
    const key = [
      source.source,
      source.module,
      source.method,
      source.busTopic,
      source.routePath,
      source.methodType,
      source.exposure
    ].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(source)
  }
  return unique.sort((a, b) => `${a.module ?? ''}.${a.method}`.localeCompare(`${b.module ?? ''}.${b.method}`))
}

function isWildcardPermission(permission: string): boolean {
  return permission === PERMISSION_ALL || permission.endsWith('.*')
}

function splitWords(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort()
}
