'use client'

import { useEffect, useState } from 'react'
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
import { PageHeader } from './state-surface'
import { Card, DataTable, Button, type DataColumn } from './primitives'
import { ConfirmDialog, PermissionEditorTable, ROLE_TEMPLATES, matchRoleTemplate } from './shared-components'
import { Badge } from '#components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '#components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '#components/ui/dropdown-menu'
import { buttonVariants } from '#components/ui/button'
import { cn } from '#lib/utils'

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
  permissionCatalog: PermissionCatalogEntry[]
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
  permissionCatalog: [],
  audit: [],
  mutationState: 'pending',
  mutationReason: 'Loading principals, permissions, and audit records through Aurora.',
  warnings: [],
  error: null,
  evidenceSource: 'pending Aurora service calls'
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
    const unavailableMessage = 'Aurora permission resources are unavailable.'
    return {
      ...loadingSnapshot,
      loadState: denied ? 'denied' : 'service-unavailable',
      mutationState: denied ? 'denied' : 'unsupported',
      mutationReason: failures.join(' ') || unavailableMessage,
      error: denied ? failures.join(' ') || unavailableMessage : unavailableMessage,
      warnings: failures,
      evidenceSource: 'Aurora request error'
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
    permissionCatalog,
    audit,
    mutationState,
    mutationReason: mutationCapability ? capabilityReason(mutationCapability) : 'Auth.PatchPermissions is not advertised by the capability catalog.',
    warnings: failures,
    error: failures[0] ?? null,
    evidenceSource: client.transport.kind === 'mock' ? 'Local preview' : 'Aurora service response'
  }
}

export function AdminRbacView({ snapshot, onPreviewAdminAction }: AdminRbacViewProps) {
  const [editingRole, setEditingRole] = useState<AdminRbacRoleRow | null>(null)
  const [pendingConfirm, setPendingConfirm] = useState<PendingRbacConfirm | null>(null)

  const requestChangeRole = (principal: AdminRbacPrincipalRow, role: AdminRbacRoleRow) => {
    const grant = role.permissions.filter((permission) => !principal.permissions.includes(permission))
    const revoke = principal.permissions.filter((permission) => !role.permissions.includes(permission))
    const action = buildRbacPermissionPatchAction(principal, { grant, revoke, reason: `Change role to ${role.label}` })
    setPendingConfirm({
      title: `Change role for ${principal.username}`,
      description: `Move ${principal.username} from ${principal.roleLabel} to ${role.label}.`,
      actions: [action]
    })
  }

  const requestRevoke = (principal: AdminRbacPrincipalRow) => {
    const action = buildRbacPermissionPatchAction(principal, {
      revoke: principal.permissions,
      reason: `Revoke ${principal.username}`
    })
    setPendingConfirm({
      title: `Revoke ${principal.username}`,
      description: `Remove every granted permission from ${principal.username}. They keep no standing access until re-granted.`,
      actions: [action]
    })
  }

  const requestSaveRoleEditor = (role: AdminRbacRoleRow, nextPermissions: string[]) => {
    setEditingRole(null)
    const affected = snapshot.principals.filter((principal) => principal.roleLabel === role.label)
    const actions = affected
      .map((principal) => {
        const grant = nextPermissions.filter((permission) => !principal.permissions.includes(permission))
        const revoke = principal.permissions.filter((permission) => !nextPermissions.includes(permission))
        if (grant.length === 0 && revoke.length === 0) return null
        return buildRbacPermissionPatchAction(principal, { grant, revoke, reason: `Update ${role.label} permissions` })
      })
      .filter((action): action is AdminRbacAction => action !== null)
    if (actions.length === 0) return
    setPendingConfirm({
      title: `Update ${role.label} permissions`,
      description: `Apply the new permission set to ${affected.length} principal${affected.length === 1 ? '' : 's'} currently in this role.`,
      actions
    })
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        id="admin-rbac-title"
        eyebrow="Admin"
        title="Access & RBAC"
        description="Roles define permission sets; principals are assigned a role."
      />

      {snapshot.loadState !== 'ready' && snapshot.loadState !== 'empty' ? (
        <p role="alert" className="text-sm text-destructive">
          {snapshot.error ?? 'RBAC status needs attention. Controls remain disabled until Aurora marks them ready.'}
        </p>
      ) : null}

      <RolesGrid roles={snapshot.roles} onEdit={setEditingRole} />

      <PrincipalsTable
        principals={snapshot.principals}
        roles={snapshot.roles}
        onChangeRole={requestChangeRole}
        onRevoke={requestRevoke}
      />

      <RoleEditorDialog
        role={editingRole}
        catalog={snapshot.permissionCatalog}
        onCancel={() => setEditingRole(null)}
        onSave={requestSaveRoleEditor}
      />

      <ConfirmDialog
        open={pendingConfirm !== null}
        title={pendingConfirm?.title ?? ''}
        description={pendingConfirm?.description ?? ''}
        confirmLabel="Confirm"
        destructive
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => {
          if (pendingConfirm) {
            for (const action of pendingConfirm.actions) onPreviewAdminAction?.(action)
          }
          setPendingConfirm(null)
        }}
      />
    </div>
  )
}

interface PendingRbacConfirm {
  title: string
  description: string
  actions: AdminRbacAction[]
}

function RolesGrid({ roles, onEdit }: { roles: AdminRbacRoleRow[]; onEdit: (role: AdminRbacRoleRow) => void }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3.5" role="list" aria-label="Roles">
      {roles.map((role) => (
        <Card key={role.id} title={role.label} description={role.description} actions={<Badge variant="secondary">{role.principalCount}</Badge>}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{role.permissions.length} permissions</span>
            {!role.system ? (
              <Button variant="outline" onClick={() => onEdit(role)}>
                Edit
              </Button>
            ) : null}
          </div>
        </Card>
      ))}
    </div>
  )
}

function PrincipalsTable({
  principals,
  roles,
  onChangeRole,
  onRevoke
}: {
  principals: AdminRbacPrincipalRow[]
  roles: AdminRbacRoleRow[]
  onChangeRole: (principal: AdminRbacPrincipalRow, role: AdminRbacRoleRow) => void
  onRevoke: (principal: AdminRbacPrincipalRow) => void
}) {
  const columns: DataColumn<AdminRbacPrincipalRow>[] = [
    {
      key: 'principal',
      header: 'Principal',
      render: (principal) => (
        <div className="flex flex-col">
          <span className="font-medium">{principal.username}</span>
          <span className="text-xs text-muted-foreground">{principal.id}</span>
        </div>
      )
    },
    {
      key: 'kind',
      header: 'Kind',
      render: (principal) => principal.providerLabel || (principal.isAdmin ? 'Admin' : 'User')
    },
    {
      key: 'role',
      header: 'Role',
      render: (principal) => <Badge variant="secondary">{principal.roleLabel}</Badge>
    },
    {
      key: 'lastActive',
      header: 'Last active',
      hideAt: 'md',
      render: (principal) => principal.createdAt ?? '-'
    },
    {
      key: 'action',
      header: 'Action',
      align: 'end',
      render: (principal) => {
        if (principal.roleLabel === 'Owner') return null
        return (
          <div className="flex items-center justify-end gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>Change role</DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Change role</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {roles.map((role) => (
                  <DropdownMenuCheckboxItem
                    key={role.id}
                    checked={role.label === principal.roleLabel}
                    onCheckedChange={() => {
                      if (role.label !== principal.roleLabel) onChangeRole(principal, role)
                    }}
                  >
                    {role.label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="danger" onClick={() => onRevoke(principal)}>
              Revoke
            </Button>
          </div>
        )
      }
    }
  ]

  return (
    <Card title="Principals" ariaLabel="RBAC principals" flush>
      <DataTable columns={columns} rows={principals} getRowKey={(principal) => principal.id} empty="No principals to grant or manage yet." />
    </Card>
  )
}

function RoleEditorDialog({
  role,
  catalog,
  onCancel,
  onSave
}: {
  role: AdminRbacRoleRow | null
  catalog: PermissionCatalogEntry[]
  onCancel: () => void
  onSave: (role: AdminRbacRoleRow, permissions: string[]) => void
}) {
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [roleTemplate, setRoleTemplate] = useState('custom')

  useEffect(() => {
    if (!role) return
    setChecked(Object.fromEntries(role.permissions.map((permission) => [permission, true])))
    setRoleTemplate(matchRoleTemplate(role.permissions))
  }, [role])

  return (
    <Dialog
      open={role !== null}
      onOpenChange={(open: boolean) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit {role?.label ?? ''} permissions</DialogTitle>
          <DialogDescription>Applies to every principal currently grouped under {role?.label ?? 'this role'}.</DialogDescription>
        </DialogHeader>
        {role ? (
          <PermissionEditorTable
            catalog={catalog}
            checked={checked}
            roleTemplate={roleTemplate}
            onSelectRoleTemplate={(templateId) => {
              setRoleTemplate(templateId)
              const preset = ROLE_TEMPLATES.find((template) => template.id === templateId)
              if (preset?.permissions) {
                setChecked(Object.fromEntries(preset.permissions.map((permission) => [permission, true])))
              }
            }}
            onToggle={(permissionId) => {
              setRoleTemplate('custom')
              setChecked((previous) => ({ ...previous, [permissionId]: !previous[permissionId] }))
            }}
          />
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              if (role) onSave(role, Object.keys(checked).filter((permissionId) => checked[permissionId]))
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
    description: 'Aurora will change permissions only after admin confirmation and audit logging.',
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
      accessReason: mutationCapability ? capabilityReason(mutationCapability) : 'Permission changes are not ready yet.',
      providerLabel: mutationCapability ? providerLabel(mutationCapability) : 'Auth target pending',
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
      description: `${label} is based on current principal permissions. Edit members by changing their permissions.`,
      principalCount: rows.length,
      permissions,
      system: permissions.includes('*'),
      manageState: mutationCapability?.availability ?? 'unsupported',
      manageReason: 'Role editing is not ready here. Change principal permissions instead.'
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
  const reason = capability ? capabilityReason(capability) : 'Permission changes are not ready yet.'
  const cascade = [
    `Principal ${principal.id} permissions change from ${before.length} to ${after.length}.`,
    'New sessions and tokens use the updated permissions.',
    'An audit record is required after submit.'
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
  if (capability.availability === 'offline' || capability.availability === 'stale') return 'This device is offline'
  if (capability.availability === 'denied' || capability.availability === 'privacy-blocked') return 'Permission is needed to use this feature'
  if (capability.availability === 'unsupported') return 'This Aurora version cannot use that feature yet'
  if (capability.routeBlockers.length > 0) return 'This action needs attention before it can run.'
  if (capability.raw.policy.approval_required) return 'Admin approval is required before this action can run.'
  return 'Ready'
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
  if (maybe.code === 'auth' || maybe.code === 'permission') return 'Permission is needed to use this feature'
  if (maybe.code === 'unsupported_feature' || maybe.code === 'unavailable_service') return 'This Aurora version cannot use that feature yet'
  if (maybe.code === 'timeout' || maybe.code === 'transport_loss') return 'Connection lost. Reconnecting...'
  return 'Aurora could not read this item'
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
    'offline',
    'denied',
    'degraded',
    'stale',
    'privacy-blocked',
    'unsupported'
  ].includes(value)
}
