'use client'

import { useEffect, useMemo, useState } from 'react'
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
import { presentableSignal, ToneBadge, type BadgeTone } from './status-badges'
import { ConfirmDialog } from './shared-components'
import { Button, Card, DataTable, useToast, type DataColumn } from './primitives'

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
    title: 'Restore backup',
    confirmLabel: 'Restore',
    destructive: true,
    describe: () => 'This is an admin-critical action and will be recorded in the audit log with your reason.'
  }
}

export function BackupRestoreView({ client, route, initialList = null, initialError = null }: BackupRestoreViewProps) {
  const { toast } = useToast()
  const [list, setList] = useState<BackupListResponse | null>(initialList)
  const [loadState, setLoadState] = useState<BackupLoadState>(() => initialLoadState(route, initialList, initialError))
  const [loadError, setLoadError] = useState<string | null>(initialError)
  const [pending, setPending] = useState<PendingOperation | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    if (route.disabled) return
    setLoadState((current) => (current === 'ready' || current === 'empty' ? current : 'loading'))
    client.backups.list({ limit: 50, include_failed: true }).then((result) => {
      if (!active) return
      if (!result.ok) {
        setLoadState(loadStateFromError(result.error))
        setLoadError(backupErrorMessage(result.error))
        return
      }
      setList(result.data)
      setLoadState(result.data.backups.length === 0 ? 'empty' : route.state === 'degraded' ? 'degraded' : 'ready')
      setLoadError(null)
    })
    return () => {
      active = false
    }
  }, [client, route.disabled, route.state])

  const backups = list?.backups ?? []
  const mutationRouteReady = !route.disabled && route.routeable
  const disabledReason = backupDisabledReason(route, loadError)

  async function confirmPending() {
    if (!pending) return
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
            setList((current) => ({
              backups: [created.backup!, ...(current?.backups ?? [])],
              total: (current?.total ?? 0) + 1,
              secrets_redacted: created.backup!.secrets_redacted
            }))
          }
          return created.message ?? 'Backup created.'
        })
      } else if (kind === 'verify' && pending.backup) {
        const backup = pending.backup
        const result = await client.backups.verify(
          { backup_id: backup.backup_id, storage: backup.storage },
          'Backup checked from Aurora admin cockpit.',
          { reauthConfirmed: true }
        )
        applyResult(result, (verified) => verified.message ?? (verified.verified ? 'Backup checked.' : 'Backup needs attention.'))
      } else if (kind === 'restore' && pending.backup) {
        const backup = pending.backup
        const result = await client.backups.restore(
          {
            backup_id: backup.backup_id,
            storage: backup.storage,
            components: backup.components.map((component) => component.component),
            dry_run: true,
            create_rollback: true,
            reason: 'Backup restore dry-run requested from Aurora admin cockpit.'
          },
          { reauthConfirmed: true }
        )
        applyResult(result, (restored) => restored.message ?? 'Restore dry-run complete; no data was overwritten.')
      }
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
      toast({ tone: 'error', title: 'Backup action failed', detail: backupErrorMessage(result.error) })
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
            disabled={!mutationRouteReady}
            disabledReason={disabledReason}
            onClick={() => setPending({ kind: 'verify', backup })}
          >
            Verify
          </Button>
          <Button
            variant="danger"
            disabled={!mutationRouteReady}
            disabledReason={disabledReason}
            onClick={() => setPending({ kind: 'restore', backup })}
          >
            Restore
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
          <p className="mt-1 text-sm text-muted-foreground">Snapshots, verification and restore. Restore and rollback require admin confirmation.</p>
        </div>
        <Button
          variant="primary"
          icon={<Archive size={14} aria-hidden />}
          disabled={!mutationRouteReady}
          disabledReason={disabledReason}
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
            empty={<p className="text-sm text-muted-foreground">No backups were returned by Aurora.</p>}
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
        onCancel={() => setPending(null)}
        onConfirm={() => void confirmPending()}
      />
    </div>
  )
}

function BackupStatusNotice({ loadState, route, loadError }: { loadState: BackupLoadState; route: RouteAvailability; loadError: string | null }) {
  if (loadState === 'loading') {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground" aria-live="polite">
        Loading backups from Aurora...
      </div>
    )
  }
  if (loadState === 'ready') return null
  if (route.disabled) {
    return (
      <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning" role="alert">
        Backup operations are disabled until Aurora reports backup actions are ready.
        {route.blockers.length > 0 ? ` ${presentableSignal(route.blockers.join(', '))}` : null}
      </div>
    )
  }
  if (loadState === 'empty') return null
  if (loadError) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
        {loadError}
      </div>
    )
  }
  return null
}

export function backupErrorMessage(error: AuroraError): string {
  if (error.code === 'auth' || error.code === 'permission') return 'Backup request denied by authentication or permissions.'
  if (error.code === 'privacy_blocked') return 'Backup request is blocked by privacy policy until required approval exists.'
  if (error.code === 'unavailable_service' || error.code === 'unsupported_feature') return 'This Aurora version cannot use backup actions yet.'
  if (error.code === 'timeout' || error.code === 'transport_loss') return 'Backup request could not reach Aurora reliably; retry after service health recovers.'
  return error.message || 'Backup request failed.'
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

function initialLoadState(route: RouteAvailability, initialList: BackupListResponse | null, initialError: string | null): BackupLoadState {
  if (route.disabled) {
    if (route.state === 'denied') return 'denied'
    if (route.state === 'degraded') return 'degraded'
    return 'unavailable'
  }
  if (initialError) return 'error'
  if (!initialList) return 'loading'
  if (initialList.backups.length === 0) return 'empty'
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
  if (route.blockers.length > 0) return presentableSignal(route.blockers.join(', '))
  if (!route.routeable) return 'Backup actions are not ready from the current connection.'
  if (route.disabled) return 'Aurora does not list backup actions as ready.'
  return 'Backup actions need admin confirmation before they can run.'
}

function localStorageTarget() {
  return { kind: 'local' as const, uri: null, encryption: 'none' as const, key_ref: null, credential_ref: null, metadata: {} }
}
