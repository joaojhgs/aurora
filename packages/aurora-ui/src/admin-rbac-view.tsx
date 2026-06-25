'use client'

import { useEffect, useMemo, useState } from 'react'
import { Activity, KeyRound, Lock, RotateCcw, ShieldCheck, UserCog } from 'lucide-react'
import {
  AUTH_METHODS,
  AuroraError,
  checkAccess,
  permissionDescription,
  permissionLabel,
  summarizeCapabilities,
  type AuditLogEntry,
  type AuroraClient,
  type AvailabilityState,
  type CapabilitySummary,
  type ContractMethodType,
  type JsonObject,
  type PermissionCatalogEntry,
  type PermissionPatchRequest,
  type PrincipalResponse
} from '@aurora/client'
import { EvidenceBadge, PrivacyBadge, StatusBadge } from './status-badges'

export type AdminRbacLoadState =
  | 'loading'
  | 'ready'
  | 'empty'
  | 'degraded'
  | 'denied'
  | 'service-unavailable'
  | 'error'

export interface AdminRbacAction {
  title: string
  description: string
  methodId: string
  payload: JsonObject
  affectedResources: string[]
  severity: 'medium' | 'high' | 'critical'
  diff: AdminRbacDiffRow[]
  auditReason: string
  requiresAdminAction: true
}

export interface AdminRbacDiffRow {
  key: string
  before: string
  after: string
}

export interface AdminRbacPrincipalRow {
  id: string
  username: string
  roleLabel: string
  isAdmin: boolean
  permissions: string[]
  effectivePermissions: string[]
  createdAt: string | null
  accessState: AvailabilityState
  accessReason: string
  providerLabel: string
  patchPreview: AdminRbacPatchPreview
}

export interface AdminRbacRoleRow {
  id: string
  label: string
  description: string
  principalCount: number
  permissions: string[]
  system: boolean
  manageState: AvailabilityState
  manageReason: string
}

export interface AdminRbacPermissionRow {
  id: string
  label: string
  description: string
  service: string | null
  kind: string
  requiredByCount: number
  coveredPrincipals: number
}

export interface AdminRbacPatchPreview {
  methodId: typeof AUTH_METHODS.patchPermissions
  state: AvailabilityState
  available: boolean
  requiresAdminAction: boolean
  reason: string
  grant: string[]
  revoke: string[]
  before: string[]
  after: string[]
  cascade: string[]
  action: AdminRbacAction | null
}

export interface AdminRbacAuditRow {
  id: string
  event: string
  principalId: string
  action: string
  correlationId: string
  details: string
  createdAt: string
}

export interface AdminRbacSnapshot {
  loadState: AdminRbacLoadState
  generatedAt: string | null
  secretsRedacted: boolean
  principals: AdminRbacPrincipalRow[]
  roles: AdminRbacRoleRow[]
  permissions: AdminRbacPermissionRow[]
  audit: AdminRbacAuditRow[]
  mutationState: AvailabilityState
  mutationReason: string
  warnings: string[]
  error: string | null
  evidenceSource: string
}

export interface AdminRbacResourceProps {
  client: AuroraClient
  onPreviewAdminAction?: ((action: AdminRbacAction) => void) | undefined
}

export interface AdminRbacViewProps {
  snapshot: AdminRbacSnapshot
  onPreviewAdminAction?: ((action: AdminRbacAction) => void) | undefined
}

const loadingSnapshot: AdminRbacSnapshot = {
  loadState: 'loading',
  generatedAt: null,
  secretsRedacted: true,
  principals: [],
  roles: [],
  permissions: [],
  audit: [],
  mutationState: 'pending',
  mutationReason: 'Loading RBAC principals, permission catalog, capability catalog, and audit log through AuroraClient.',
  warnings: [],
  error: null,
  evidenceSource: 'pending AuroraClient SDK calls'
}

export function AdminRbacResource({ client, onPreviewAdminAction }: AdminRbacResourceProps) {
  const [snapshot, setSnapshot] = useState<AdminRbacSnapshot>(loadingSnapshot)

  useEffect(() => {
    let cancelled = false
    setSnapshot(loadingSnapshot)
    void buildAdminRbacSnapshot(client).then((next) => {
      if (!cancelled) setSnapshot(next)
    })
    return () => {
      cancelled = true
    }
  }, [client])

  return <AdminRbacView snapshot={snapshot} onPreviewAdminAction={onPreviewAdminAction} />
}

export async function buildAdminRbacSnapshot(client: AuroraClient): Promise<AdminRbacSnapshot> {
  const [principalsResult, permissionsResult, catalogResult, auditResult] = await Promise.allSettled([
    client.authApi.listPrincipals(),
    client.permissions.listCatalog(),
    client.capabilities.listCatalog({ include_unavailable: true, include_internal: true, include_schemas: true }),
    client.authApi.auditLog({ limit: 25, event: null })
  ])

  const principalResponse = resultDataOrNull(principalsResult)
  const permissionCatalog = valueOrNull(permissionsResult) ?? []
  const capabilityCatalog = valueOrNull(catalogResult)
  const auditResponse = resultDataOrNull(auditResult)
  const summaries = capabilityCatalog ? summarizeCapabilities(capabilityCatalog) : []
  const failures = [
    failureMessage('principals', principalsResult),
    failureMessage('permissions', permissionsResult),
    failureMessage('capability catalog', catalogResult),
    failureMessage('audit log', auditResult)
  ].filter((message): message is string => Boolean(message))
  const denied = [principalsResult, permissionsResult, catalogResult, auditResult].some(isDeniedFailure)

  if (!principalResponse && permissionCatalog.length === 0 && !capabilityCatalog && !auditResponse) {
    const unavailableMessage = 'Auth RBAC SDK resources are unavailable.'
    return {
      ...loadingSnapshot,
      loadState: denied ? 'denied' : 'service-unavailable',
      mutationState: denied ? 'denied' : 'unsupported',
      mutationReason: failures.join(' ') || unavailableMessage,
      error: denied ? failures.join(' ') || unavailableMessage : unavailableMessage,
      warnings: failures,
      evidenceSource: 'AuroraClient SDK error'
    }
  }

  const mutationCapability = capabilityFor(AUTH_METHODS.patchPermissions, summaries)
  const principals = buildPrincipalRows(principalResponse?.principals ?? [], permissionCatalog, mutationCapability)
  const roles = buildRoleRows(principals, mutationCapability)
  const permissions = buildPermissionRows(permissionCatalog, principals)
  const audit = (auditResponse?.events ?? []).map(auditRow)
  const mutationState = mutationCapability?.availability ?? (denied ? 'denied' : 'unsupported')
  const loadState: AdminRbacLoadState = denied
    ? 'denied'
    : failures.length > 0
      ? 'degraded'
      : principals.length === 0
        ? 'empty'
        : 'ready'

  return {
    loadState,
    generatedAt: capabilityCatalog?.generated_at ?? null,
    secretsRedacted: capabilityCatalog?.secrets_redacted ?? true,
    principals,
    roles,
    permissions,
    audit,
    mutationState,
    mutationReason: mutationCapability ? capabilityReason(mutationCapability) : 'Auth.PatchPermissions is not advertised by the capability catalog.',
    warnings: failures,
    error: failures[0] ?? null,
    evidenceSource: client.transport.kind === 'mock' ? 'SDK mock transport fixture' : 'AuroraClient backend response'
  }
}

export function AdminRbacView({ snapshot, onPreviewAdminAction }: AdminRbacViewProps) {
  const totals = useMemo(() => rbacTotals(snapshot), [snapshot])

  return (
    <section className="aui-admin-rbac" aria-labelledby="admin-rbac-title">
      <header className="aui-admin-header">
        <div>
          <p className="aui-kicker">Admin</p>
          <h1 id="admin-rbac-title">Access and RBAC</h1>
          <p>
            Principals, role summaries, effective permission previews, and audit evidence are loaded through AuroraClient.
          </p>
        </div>
        <div className="aui-admin-badges" aria-label="RBAC backend evidence">
          {isAvailabilityState(snapshot.loadState) ? <StatusBadge state={snapshot.loadState} /> : <span className={`aui-badge aui-badge-${snapshot.loadState}`}>{snapshot.loadState}</span>}
          <EvidenceBadge label={snapshot.evidenceSource} />
          <EvidenceBadge label={snapshot.secretsRedacted ? 'secrets redacted' : 'redaction unknown'} />
          <PrivacyBadge privacy="admin-critical" />
        </div>
      </header>

      <RbacStatusPanel snapshot={snapshot} />

      <div className="aui-admin-metrics" aria-label="RBAC coverage summary">
        <Metric label="Principals" value={String(snapshot.principals.length)} detail={`${totals.admins} admin/system`} />
        <Metric label="Roles" value={String(snapshot.roles.length)} detail="derived from backend permissions" />
        <Metric label="Permissions" value={String(snapshot.permissions.length)} detail={`${totals.managePermissions} manage/admin`} />
        <Metric label="Audit" value={String(snapshot.audit.length)} detail="redacted Auth events" />
      </div>

      <div className="aui-rbac-layout">
        <PrincipalsPanel principals={snapshot.principals} onPreviewAdminAction={onPreviewAdminAction} />
        <RolesPanel roles={snapshot.roles} />
        <PermissionsPanel permissions={snapshot.permissions} />
        <AuditPanel audit={snapshot.audit} />
      </div>
    </section>
  )
}

export function buildRbacPermissionPatchAction(
  principal: Pick<AdminRbacPrincipalRow, 'id' | 'username' | 'permissions'>,
  input: { grant?: string[]; revoke?: string[]; reason?: string } = {}
): AdminRbacAction {
  const grant = sortedUnique(input.grant ?? [])
  const revoke = sortedUnique(input.revoke ?? [])
  const before = sortedUnique(principal.permissions)
  const after = sortedUnique([...before.filter((permission) => !revoke.includes(permission)), ...grant])
  const payload: PermissionPatchRequest = {
    user_id: principal.id,
    grant,
    revoke
  }
  return {
    title: `Patch permissions for ${principal.username}`,
    description: 'Aurora will submit the permission patch only after AdminAction draft, confirmation, and audit receipt.',
    methodId: AUTH_METHODS.patchPermissions,
    payload: payload as unknown as JsonObject,
    affectedResources: [`principal:${principal.id}`, ...grant.map((permission) => `grant:${permission}`), ...revoke.map((permission) => `revoke:${permission}`)],
    severity: revoke.includes('*') || grant.includes('*') ? 'critical' : 'high',
    auditReason: input.reason ?? 'RBAC permission patch preview',
    requiresAdminAction: true,
    diff: [
      { key: 'principal.permissions', before: before.join(', ') || 'none', after: after.join(', ') || 'none' },
      { key: 'grant', before: 'none', after: grant.join(', ') || 'none' },
      { key: 'revoke', before: 'none', after: revoke.join(', ') || 'none' }
    ]
  }
}

function RbacStatusPanel({ snapshot }: { snapshot: AdminRbacSnapshot }) {
  if (snapshot.loadState === 'loading') {
    return (
      <div className="aui-admin-notice" aria-live="polite">
        <Activity size={18} aria-hidden />
        <span>Loading RBAC principals, permissions, capabilities, and audit events through AuroraClient.</span>
      </div>
    )
  }
  if (snapshot.loadState === 'ready') return null
  if (snapshot.loadState === 'empty') {
    return (
      <div className="aui-admin-notice" role="status">
        <UserCog size={18} aria-hidden />
        <span>No principals were returned by Auth.ListPrincipals.</span>
      </div>
    )
  }
  return (
    <div className="aui-admin-notice aui-admin-notice-warning" role="alert">
      <Lock size={18} aria-hidden />
      <span>{snapshot.error ?? 'RBAC evidence is degraded. Unsupported or denied controls remain disabled.'}</span>
    </div>
  )
}

function PrincipalsPanel({
  principals,
  onPreviewAdminAction
}: {
  principals: AdminRbacPrincipalRow[]
  onPreviewAdminAction?: ((action: AdminRbacAction) => void) | undefined
}) {
  return (
    <section className="aui-admin-panel aui-rbac-principals" aria-labelledby="rbac-principals-title">
      <div className="aui-panel-heading">
        <div>
          <p className="aui-kicker">Principals</p>
          <h2 id="rbac-principals-title">Identity access</h2>
        </div>
      </div>
      {principals.length === 0 ? (
        <p className="aui-muted">No principals are available from Auth.ListPrincipals.</p>
      ) : (
        <div className="aui-table-scroll">
          <table className="aui-table">
            <thead>
              <tr>
                <th>Identity</th>
                <th>Role</th>
                <th>Effective access</th>
                <th>Route</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {principals.map((principal) => (
                <tr key={principal.id}>
                  <td>
                    <details className="aui-service-details">
                      <summary>
                        <strong>{principal.username}</strong>
                        <small>{principal.id}</small>
                      </summary>
                      <div className="aui-service-drawer">
                        <dl>
                          <div><dt>Created</dt><dd>{principal.createdAt ?? 'not reported'}</dd></div>
                          <div><dt>Provider</dt><dd>{principal.providerLabel}</dd></div>
                          <div><dt>Patch preview</dt><dd>{principal.patchPreview.reason}</dd></div>
                        </dl>
                        <PermissionChips permissions={principal.permissions} emptyLabel="No stored permissions" />
                      </div>
                    </details>
                  </td>
                  <td>
                    <div className="aui-state-line">
                      {principal.isAdmin ? <ShieldCheck size={16} aria-hidden /> : <UserCog size={16} aria-hidden />}
                      <span>{principal.roleLabel}</span>
                    </div>
                  </td>
                  <td>
                    <PermissionChips permissions={principal.effectivePermissions.slice(0, 4)} emptyLabel="none" />
                    {principal.effectivePermissions.length > 4 ? <small className="aui-muted">+{principal.effectivePermissions.length - 4} more</small> : null}
                  </td>
                  <td>
                    <div className="aui-state-line">
                      <StatusBadge state={principal.accessState} />
                      <span>{principal.accessReason}</span>
                    </div>
                  </td>
                  <td>
                    <button
                      className="aui-action-chip"
                      type="button"
                      disabled={!principal.patchPreview.available || !principal.patchPreview.action}
                      title={principal.patchPreview.reason}
                      onClick={() => {
                        if (principal.patchPreview.action) onPreviewAdminAction?.(principal.patchPreview.action)
                      }}
                    >
                      <KeyRound size={15} aria-hidden />
                      Preview patch
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function RolesPanel({ roles }: { roles: AdminRbacRoleRow[] }) {
  return (
    <section className="aui-admin-panel" aria-labelledby="rbac-roles-title">
      <div className="aui-panel-heading">
        <div>
          <p className="aui-kicker">Roles</p>
          <h2 id="rbac-roles-title">Role summaries</h2>
        </div>
      </div>
      <div className="aui-rbac-card-list">
        {roles.map((role) => (
          <article className="aui-rbac-role" key={role.id}>
            <header>
              <strong>{role.label}</strong>
              <StatusBadge state={role.manageState} />
            </header>
            <p>{role.description}</p>
            <PermissionChips permissions={role.permissions.slice(0, 5)} emptyLabel="No permissions" />
            <small>{role.principalCount} principals. {role.manageReason}</small>
          </article>
        ))}
      </div>
    </section>
  )
}

function PermissionsPanel({ permissions }: { permissions: AdminRbacPermissionRow[] }) {
  return (
    <section className="aui-admin-panel" aria-labelledby="rbac-permissions-title">
      <div className="aui-panel-heading">
        <div>
          <p className="aui-kicker">Catalog</p>
          <h2 id="rbac-permissions-title">Permissions</h2>
        </div>
      </div>
      <div className="aui-rbac-permission-grid">
        {permissions.slice(0, 18).map((permission) => (
          <article className="aui-rbac-permission" key={permission.id}>
            <strong>{permission.label}</strong>
            <code>{permission.id}</code>
            <p>{permission.description}</p>
            <small>{permission.kind} / used by {permission.requiredByCount} contracts / held by {permission.coveredPrincipals} principals</small>
          </article>
        ))}
      </div>
    </section>
  )
}

function AuditPanel({ audit }: { audit: AdminRbacAuditRow[] }) {
  return (
    <section className="aui-admin-panel" aria-labelledby="rbac-audit-title">
      <div className="aui-panel-heading">
        <div>
          <p className="aui-kicker">Audit</p>
          <h2 id="rbac-audit-title">Recent access changes</h2>
        </div>
      </div>
      {audit.length === 0 ? (
        <p className="aui-muted">No Auth audit entries were returned.</p>
      ) : (
        <ol className="aui-rbac-audit">
          {audit.map((entry) => (
            <li key={entry.id}>
              <span>{entry.createdAt}</span>
              <strong>{entry.action || entry.event}</strong>
              <code>{entry.correlationId}</code>
              <small>{entry.principalId}: {entry.details}</small>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article className="aui-admin-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  )
}

function PermissionChips({ permissions, emptyLabel }: { permissions: string[]; emptyLabel: string }) {
  return (
    <div className="aui-chip-list">
      {permissions.map((permission) => (
        <code className="aui-chip" key={permission}>{permission}</code>
      ))}
      {permissions.length === 0 ? <span className="aui-muted">{emptyLabel}</span> : null}
    </div>
  )
}

function buildPrincipalRows(
  principals: PrincipalResponse[],
  permissionCatalog: PermissionCatalogEntry[],
  mutationCapability: CapabilitySummary | undefined
): AdminRbacPrincipalRow[] {
  return principals.map((principal) => {
    const effectivePermissions = principal.is_admin ? ['*'] : sortedUnique(principal.permissions)
    const sampleGrant = sampleGrantPermission(principal.permissions, permissionCatalog)
    const sampleRevoke = principal.permissions.includes('*') ? [] : principal.permissions.slice(0, 1)
    const preview = permissionPatchPreview(principal, sampleGrant ? [sampleGrant] : [], sampleRevoke, mutationCapability)
    return {
      id: principal.id,
      username: principal.username,
      roleLabel: roleLabel(principal),
      isAdmin: principal.is_admin,
      permissions: sortedUnique(principal.permissions),
      effectivePermissions,
      createdAt: principal.created_at ?? null,
      accessState: mutationCapability?.availability ?? 'unsupported',
      accessReason: mutationCapability ? capabilityReason(mutationCapability) : 'Capability catalog does not advertise Auth RBAC mutation.',
      providerLabel: mutationCapability ? providerLabel(mutationCapability) : 'Auth provider pending',
      patchPreview: preview
    }
  })
}

function buildRoleRows(
  principals: AdminRbacPrincipalRow[],
  mutationCapability: CapabilitySummary | undefined
): AdminRbacRoleRow[] {
  const roleMap = new Map<string, AdminRbacPrincipalRow[]>()
  for (const principal of principals) {
    const key = principal.roleLabel
    roleMap.set(key, [...(roleMap.get(key) ?? []), principal])
  }
  return [...roleMap.entries()].map(([label, rows]) => {
    const permissions = sortedUnique(rows.flatMap((row) => row.permissions))
    return {
      id: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      label,
      description: `${label} is derived from current principal permissions because no standalone role CRUD contract is exposed.`,
      principalCount: rows.length,
      permissions,
      system: permissions.includes('*'),
      manageState: mutationCapability?.availability ?? 'unsupported',
      manageReason: 'Role CRUD is not a backend contract in this checkout; use principal permission AdminAction patches instead.'
    }
  })
}

function buildPermissionRows(
  permissions: PermissionCatalogEntry[],
  principals: AdminRbacPrincipalRow[]
): AdminRbacPermissionRow[] {
  return permissions.map((permission) => ({
    id: permission.id,
    label: permission.label || permissionLabel(permission.id),
    description: permission.description || permissionDescription(permission.id, permission.methodType),
    service: permission.service,
    kind: permission.kind,
    requiredByCount: permission.requiredBy.length,
    coveredPrincipals: principals.filter((principal) =>
      checkAccess(principal.effectivePermissions, [permission.id], permission.methodType as ContractMethodType | null).allowed
    ).length
  }))
}

function permissionPatchPreview(
  principal: PrincipalResponse,
  grant: string[],
  revoke: string[],
  capability: CapabilitySummary | undefined
): AdminRbacPatchPreview {
  const before = sortedUnique(principal.permissions)
  const after = sortedUnique([...before.filter((permission) => !revoke.includes(permission)), ...grant])
  const requiresAdminAction = true
  const available = Boolean(capability && ['available-local', 'available-remote', 'degraded'].includes(capability.availability))
  const reason = capability ? capabilityReason(capability) : 'Auth.PatchPermissions is not advertised by the capability catalog.'
  const cascade = [
    `Principal ${principal.id} permissions change from ${before.length} to ${after.length}.`,
    'New sessions/tokens use backend effective-permission resolution.',
    'Audit receipt is required after AdminAction submit.'
  ]
  return {
    methodId: AUTH_METHODS.patchPermissions,
    state: capability?.availability ?? 'unsupported',
    available,
    requiresAdminAction,
    reason,
    grant,
    revoke,
    before,
    after,
    cascade,
    action: available ? buildRbacPermissionPatchAction({ id: principal.id, username: principal.username, permissions: before }, { grant, revoke }) : null
  }
}

function auditRow(entry: AuditLogEntry): AdminRbacAuditRow {
  return {
    id: stringValue(entry.id) || stringValue(entry.correlation_id) || `${stringValue(entry.event)}-${stringValue(entry.created_at)}`,
    event: stringValue(entry.event) || 'audit event',
    principalId: stringValue(entry.principal_id) || 'unknown principal',
    action: stringValue(entry.action) || stringValue(entry.event) || 'unknown action',
    correlationId: stringValue(entry.correlation_id) || 'not reported',
    details: redactDetails(stringValue(entry.details) || 'redacted details unavailable'),
    createdAt: stringValue(entry.created_at) || 'time not reported'
  }
}

function capabilityFor(methodId: string, summaries: CapabilitySummary[]): CapabilitySummary | undefined {
  return summaries.find((summary) => summary.busTopic === methodId)
}

function sampleGrantPermission(current: string[], catalog: PermissionCatalogEntry[]): string | null {
  const candidate = catalog.find((permission) =>
    permission.id !== '*' &&
    !current.includes(permission.id) &&
    (permission.id.endsWith('.use') || permission.id.endsWith('.manage'))
  )
  return candidate?.id ?? null
}

function roleLabel(principal: PrincipalResponse): string {
  if (principal.permissions.includes('*')) return 'Owner'
  if (principal.is_admin || principal.permissions.some((permission) => permission.endsWith('.manage'))) return 'Admin'
  if (principal.permissions.some((permission) => permission.includes('Scheduler') || permission.includes('Tooling'))) return 'Automation'
  return 'Member'
}

function capabilityReason(capability: CapabilitySummary): string {
  if (capability.routeBlockers.length > 0) return capability.routeBlockers.join(', ')
  if (capability.raw.policy.approval_required) return `${capability.busTopic} requires AdminAction approval.`
  return `${capability.busTopic} is ${capability.availability}.`
}

function providerLabel(capability: CapabilitySummary): string {
  const location = capability.peerId && capability.peerId !== 'local-peer' ? `remote:${capability.peerId}` : capability.providerId
  return `${location} / ${capability.serviceInstanceId}`
}

function rbacTotals(snapshot: AdminRbacSnapshot) {
  return {
    admins: snapshot.principals.filter((principal) => principal.isAdmin || principal.permissions.includes('*')).length,
    managePermissions: snapshot.permissions.filter((permission) => permission.id.endsWith('.manage') || permission.id === '*').length
  }
}

function resultDataOrNull<T>(settled: PromiseSettledResult<{ ok: true; data: T } | { ok: false }>): T | null {
  return settled.status === 'fulfilled' && settled.value.ok ? settled.value.data : null
}

function valueOrNull<T>(settled: PromiseSettledResult<T>): T | null {
  return settled.status === 'fulfilled' ? settled.value : null
}

function failureMessage(label: string, settled: PromiseSettledResult<unknown>): string | null {
  if (settled.status === 'rejected') return `${label}: ${errorMessage(settled.reason)}`
  const value = settled.value as { ok?: boolean; error?: unknown }
  if (value && value.ok === false) return `${label}: ${errorMessage(value.error)}`
  return null
}

function isDeniedFailure(settled: PromiseSettledResult<unknown>): boolean {
  if (settled.status === 'rejected') {
    const reason = settled.reason as Partial<AuroraError>
    return reason.code === 'auth' || reason.code === 'permission'
  }
  const value = settled.value as { ok?: boolean; error?: Partial<AuroraError> }
  return value?.ok === false && (value.error?.code === 'auth' || value.error?.code === 'permission')
}

function errorMessage(error: unknown): string {
  const maybe = error as Partial<AuroraError>
  return maybe.message ?? (error instanceof Error ? error.message : 'Unknown SDK error')
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function redactDetails(details: string): string {
  return details.replace(/token["=:][^,"}]+/gi, 'token:redacted').replace(/password["=:][^,"}]+/gi, 'password:redacted')
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

function isAvailabilityState(value: string): value is AvailabilityState {
  return [
    'available-local',
    'available-remote',
    'pending',
    'denied',
    'degraded',
    'stale',
    'privacy-blocked',
    'unsupported'
  ].includes(value)
}
