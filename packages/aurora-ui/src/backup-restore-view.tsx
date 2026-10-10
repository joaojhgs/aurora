'use client'

import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Archive } from 'lucide-react'
import type {
  AuroraClient,
  AuroraError,
  AuroraResponse,
  BackupComponentName,
  BackupComponentResult,
  BackupCreateResponse,
  BackupListResponse,
  BackupManifestSummary,
  BackupRestoreResponse,
  BackupVerifyResponse
} from '@aurora/client'
import type { RouteAvailability } from './shell-data'
import { ToneBadge, type BadgeTone } from './status-badges'
import { EmptyState, RouteStateNotice } from './state-surface'
import { ConfirmDialog } from './shared-components'
import { Button, Card, DataTable, useToast, type DataColumn } from './primitives'
import { AuroraQueryProvider, useAuroraQueryScope } from './query'
import { useAuroraQueryKeys, useBackups } from './query-hooks'
import { adminErrorTitle, adminRouteCopy, productAdminErrorCopy, productAdminReasonCopy } from './admin-product-copy'

export interface BackupRestoreViewProps {
  client: AuroraClient
  route: RouteAvailability
  initialList?: BackupListResponse | null
  initialError?: string | null
}

type BackupLoadState = 'loading' | 'ready' | 'empty' | 'denied' | 'degraded' | 'unavailable' | 'error'
type BackupOperationKind = 'create' | 'verify' | 'restore'

interface PendingOperation {
  kind: BackupOperationKind
  backup: BackupManifestSummary | null
}

const defaultComponents: BackupComponentName[] = ['config', 'db', 'rag', 'models']

const operationCopy: Record<BackupOperationKind, { title: string; confirmLabel: string; destructive: boolean; describe: (backup: BackupManifestSummary | null) => string }> = {
  create: {
    title: 'Create backup',
    confirmLabel: 'Create backup',
    destructive: false,
    describe: () => 'Aurora will create a new snapshot of this node and record the action in the audit log.'
  },
  verify: {
    title: 'Check backup',
    confirmLabel: 'Verify',
    destructive: false,
    describe: (backup) => `Aurora will check ${backup?.backup_id ?? 'this backup'} and record the action in the audit log.`
  },
  restore: {
    title: 'Preview restore',
    confirmLabel: 'Preview restore',
    destructive: false,
    describe: () => 'Aurora will check what would change. No saved data will be overwritten.'
  }
}

export function BackupRestoreView(props: BackupRestoreViewProps) {
  const hasQueryScope = useAuroraQueryScope()
  if (hasQueryScope) return <BackupRestoreViewQuery {...props} />
  return (
    <AuroraQueryProvider client={props.client}>
      <BackupRestoreViewQuery {...props} />
    </AuroraQueryProvider>
  )
}

function BackupRestoreViewQuery({ client, route, initialList = null, initialError = null }: BackupRestoreViewProps) {
  const { toast } = useToast()
  const [pending, setPending] = useState<PendingOperation | null>(null)
  const [busy, setBusy] = useState(false)
  const queryClient = useQueryClient()
  const queryKeys = useAuroraQueryKeys()
  const backupQueryRequest = useMemo(() => ({ limit: 50, include_failed: true }), [])
  const backupQueryKey = useMemo(() => queryKeys.backups(backupQueryRequest), [backupQueryRequest, queryKeys])
  const backupQuery = useBackups<BackupListResponse, typeof backupQueryRequest>(
    backupQueryRequest,
    async (queryClient, request, signal) => {
      const result = await queryClient.backups.list(request, { signal })
      if (!result.ok) throw result.error
      return result.data
    },
    {
      enabled: !route.disabled,
      ...(initialList ? { initialData: initialList } : {}),
    }
  )

  const list = backupQuery.data ?? null
  const loadError = backupQuery.error
    ? productAdminErrorCopy(backupQuery.error, 'Backup list could not be loaded.')
    : route.disabled ? initialError : null
  const loadState = backupQuery.error
    ? loadStateFromError(backupQuery.error)
    : resolveBackupLoadState(route, list, loadError, backupQuery.isPending)
  const backups = list?.backups ?? []
  const mutationRouteReady = !route.disabled && route.routeable
  const disabledReason = backupDisabledReason(route, loadError)
  const actionDisabledReason = busy
    ? 'Backup action is still running.'
    : pending
      ? 'Finish the current backup choice first.'
      : disabledReason
  const actionDisabled = !mutationRouteReady || busy || pending !== null

  async function confirmPending() {
    if (!pending || busy) return
    const kind = pending.kind
    setBusy(true)
    try {
      if (kind === 'create') {
        const result = await client.backups.create(
          { reason: 'Backup created from Aurora admin cockpit.', components: defaultComponents, include_personal_data: false, storage: localStorageTarget() },
          { reauthConfirmed: true }
        )
        applyResult(result, (created) => {
          if (created.backup) {
            queryClient.setQueryData<BackupListResponse>(backupQueryKey, (current) => ({
              backups: [created.backup!, ...(current?.backups ?? [])],
              total: (current?.total ?? 0) + 1,
              secrets_redacted: created.backup!.secrets_redacted
            }))
          }
          void queryClient.invalidateQueries({ queryKey: backupQueryKey })
          return created.message ?? 'Backup created.'
        })
      } else if (kind === 'verify' && pending.backup) {
        const backup = pending.backup
        const result = await client.backups.verify(
          { backup_id: backup.backup_id, storage: backup.storage },
          'Backup checked from Aurora admin cockpit.',
          { reauthConfirmed: true }
        )
        applyResult(result, (verified) => {
          void queryClient.invalidateQueries({ queryKey: backupQueryKey })
          return verified.message ?? (verified.verified ? 'Backup checked.' : 'Backup needs attention.')
        })
      } else if (kind === 'restore' && pending.backup) {
        const backup = pending.backup
        const result = await client.backups.restore(
          {
            backup_id: backup.backup_id,
            storage: backup.storage,
            components: backup.components.map((component) => component.component),
            dry_run: true,
            create_rollback: true,
            reason: 'Backup restore preview requested from Aurora admin screen.'
          },
          { reauthConfirmed: true }
        )
        applyResult(result, (restored) => {
          void queryClient.invalidateQueries({ queryKey: backupQueryKey })
          return restored.message ?? 'Restore preview complete. No data was overwritten.'
        })
      }
    } catch (error) {
      toast({
        tone: 'error',
        title: 'Backup action failed',
        detail: productAdminErrorCopy(error, 'Backup action failed. Try again.')
      })
    } finally {
      setBusy(false)
      setPending(null)
    }
  }

  function applyResult<T extends BackupCreateResponse | BackupVerifyResponse | BackupRestoreResponse>(
    result: AuroraResponse<T>,
    onOk: (data: T) => string
  ) {
    if (!result.ok) {
      toast({ tone: 'error', title: 'Backup action failed', detail: productAdminErrorCopy(result.error, 'Backup action failed. Try again.') })
      return
    }
    toast({ tone: 'success', title: onOk(result.data) })
  }

  const columns: Array<DataColumn<BackupManifestSummary>> = [
    {
      key: 'backup',
      header: 'Snapshot',
      mono: true,
      render: (backup) => backup.backup_id
    },
    { key: 'created', header: 'Created', hideAt: 'md', render: (backup) => formatBackupTimestamp(backup.created_at) },
    { key: 'scope', header: 'Scope', hideAt: 'lg', render: (backup) => scopeLabel(backup.components) },
    { key: 'size', header: 'Size', hideAt: 'lg', render: (backup) => sizeLabel(backup.components) },
    { key: 'status', header: 'Status', render: (backup) => <ToneBadge tone={statusTone(backup.status)}>{backup.status}</ToneBadge> },
    {
      key: 'actions',
      header: 'Actions',
      align: 'end',
      render: (backup) => (
        <div className="flex items-center justify-end gap-1.5" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
          <Button
            variant="outline"
            disabled={actionDisabled}
            disabledReason={productAdminReasonCopy(actionDisabledReason)}
            onClick={() => setPending({ kind: 'verify', backup })}
          >
            Verify
          </Button>
          <Button
            variant="danger"
            disabled={actionDisabled}
            disabledReason={productAdminReasonCopy(actionDisabledReason)}
            onClick={() => setPending({ kind: 'restore', backup })}
          >
            Preview restore
          </Button>
        </div>
      )
    }
  ]

  const dialogCopy = pending ? operationCopy[pending.kind] : null

  return (
    <div className="flex h-full flex-col" aria-labelledby="admin-backups-title">
      <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-5">
        <div>
          <h1 id="admin-backups-title" className="text-xl font-semibold tracking-tight">Backups & Restore</h1>
          <p className="mt-1 text-sm text-muted-foreground">Create and verify snapshots, or preview a restore before making changes.</p>
        </div>
        <Button
          variant="primary"
          icon={<Archive size={14} aria-hidden />}
          disabled={actionDisabled}
          disabledReason={productAdminReasonCopy(actionDisabledReason)}
          onClick={() => setPending({ kind: 'create', backup: null })}
        >
          Create backup now
        </Button>
      </div>

      <div className="flex flex-col gap-4 px-6 py-5">
        <BackupStatusNotice loadState={loadState} route={route} loadError={loadError} />

        <Card title="Backups" flush>
          <DataTable
            columns={columns}
            rows={backups}
            getRowKey={(backup) => backup.backup_id}
            empty={<EmptyState title="No backups" message="No backups were returned by Aurora." />}
          />
        </Card>
      </div>

      <ConfirmDialog
        open={pending !== null}
        title={dialogCopy?.title ?? ''}
        description={dialogCopy ? dialogCopy.describe(pending?.backup ?? null) : ''}
        confirmLabel={dialogCopy?.confirmLabel ?? 'Confirm'}
        destructive={Boolean(dialogCopy?.destructive)}
        busy={busy}
        onCancel={() => {
          if (!busy) setPending(null)
        }}
        onConfirm={() => void confirmPending()}
      />
    </div>
  )
}

function BackupStatusNotice({ loadState, route, loadError }: { loadState: BackupLoadState; route: RouteAvailability; loadError: string | null }) {
  if (loadState === 'loading') {
    return <RouteStateNotice title="Loading backups" state="loading" message="Loading backups from Aurora." />
  }
  if (loadState === 'ready') return null
  if (route.disabled) {
    return (
      <RouteStateNotice
        title="Backup actions unavailable"
        state="permission"
        message={`Backup operations are disabled until Aurora reports backup actions are ready.${route.blockers.length > 0 ? ` ${adminRouteCopy(route)}` : ''}`}
      />
    )
  }
  if (loadState === 'empty') return null
  if (loadError) {
    return (
      <RouteStateNotice
        title="Backup status needs attention"
        state={loadState === 'denied' ? 'permission' : loadState === 'degraded' ? 'offline' : 'error'}
        message={loadError}
      />
    )
  }
  return null
}

export function backupErrorMessage(error: AuroraError): string {
  return adminErrorTitle(error, 'Backup request failed.')
}

function statusTone(status: BackupManifestSummary['status']): BadgeTone {
  if (status === 'ok') return 'success'
  if (status === 'unsupported') return 'neutral'
  return 'danger'
}

function scopeLabel(components: BackupComponentResult[]): string {
  const included = components.filter((component) => component.status === 'included')
  if (included.length === defaultComponents.length) return 'Full node'
  if (included.length === 0) return 'None'
  return included.map((component) => titleCase(component.component)).join(' + ')
}

function sizeLabel(components: BackupComponentResult[]): string {
  const totalBytes = components.reduce((sum, component) => sum + (component.bytes ?? 0), 0)
  if (totalBytes <= 0) return 'not reported'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = totalBytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value >= 10 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`
}

function formatBackupTimestamp(createdAt: string): string {
  return createdAt.replace('T', ' ').replace('Z', '')
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function resolveBackupLoadState(
  route: RouteAvailability,
  list: BackupListResponse | null,
  loadError: string | null,
  loading: boolean
): BackupLoadState {
  if (route.disabled) {
    if (route.state === 'denied') return 'denied'
    if (route.state === 'degraded') return 'degraded'
    return 'unavailable'
  }
  if (loadError) return 'error'
  if (loading && !list) return 'loading'
  if (!list || list.backups.length === 0) return 'empty'
  return route.state === 'degraded' ? 'degraded' : 'ready'
}

function loadStateFromError(error: AuroraError): BackupLoadState {
  if (error.code === 'auth' || error.code === 'permission' || error.code === 'privacy_blocked') return 'denied'
  if (error.code === 'unavailable_service' || error.code === 'unsupported_feature') return 'unavailable'
  if (error.code === 'transport_loss' || error.code === 'timeout') return 'degraded'
  return 'error'
}

function backupDisabledReason(route: RouteAvailability, loadError: string | null): string {
  if (loadError) return loadError
  if (route.blockers.length > 0) return adminRouteCopy(route)
  if (!route.routeable) return 'Backup actions are not ready from the current connection.'
  if (route.disabled) return 'Aurora does not list backup actions as ready.'
  return 'Backup actions need admin confirmation before they can run.'
}

function localStorageTarget() {
  return { kind: 'local' as const, uri: null, encryption: 'none' as const, key_ref: null, credential_ref: null, metadata: {} }
}
