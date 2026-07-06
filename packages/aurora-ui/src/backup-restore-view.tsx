'use client'

import { useEffect, useMemo, useState } from 'react'
import { ArchiveRestore, Download, FileCheck2, RotateCcw } from 'lucide-react'
import type {
  AuroraClient,
  AuroraError,
  AuroraResponse,
  BackupComponentName,
  BackupCreateResponse,
  BackupListResponse,
  BackupManifestSummary,
  BackupRestoreResponse,
  BackupRollbackResponse,
  BackupVerifyResponse
} from '@aurora/client'
import type { RouteAvailability } from './shell-data'
import { EvidenceBadge, PrivacyBadge, StatusBadge, presentableSignal } from './status-badges'
import { PageHeader } from './state-surface'
import {
  AdminConfirmDialog,
  BadgeCluster,
  Button,
  Card,
  Checkbox,
  DataTable,
  DetailSheet,
  MetaGrid,
  StatStrip,
  type DataColumn
} from './primitives'

export interface BackupRestoreViewProps {
  client: AuroraClient
  route: RouteAvailability
  initialList?: BackupListResponse | null
  initialError?: string | null
}

type BackupLoadState = 'loading' | 'ready' | 'empty' | 'denied' | 'degraded' | 'unavailable' | 'error'
type BackupOperationKind = 'create' | 'verify' | 'restore-dry-run' | 'rollback-dry-run'

interface BackupOperationState {
  kind: BackupOperationKind
  status: 'pending' | 'ok' | 'failed'
  message: string
  auditReceipt: string | null
}

const defaultComponents: BackupComponentName[] = ['config', 'db', 'rag', 'models']

const operationCopy: Record<BackupOperationKind, { title: string; description: string; confirm: string; destructive: boolean }> = {
  create: {
    title: 'Create backup',
    description: 'Aurora drafts and confirms an AdminAction, then submits Backup.Create with your reason, affected components, and an audit receipt.',
    confirm: 'Create backup',
    destructive: false
  },
  verify: {
    title: 'Verify manifest',
    description: 'Aurora drafts and confirms an AdminAction before verifying the selected manifest integrity. No data is modified.',
    confirm: 'Verify manifest',
    destructive: false
  },
  'restore-dry-run': {
    title: 'Preview restore impact',
    description: 'This runs a restore dry-run only. Aurora previews the impact plan and creates a rollback point; it never applies a destructive restore.',
    confirm: 'Run restore dry-run',
    destructive: false
  },
  'rollback-dry-run': {
    title: 'Preview rollback impact',
    description: 'This runs a rollback dry-run only. Aurora previews the rollback impact plan and does not roll back any data.',
    confirm: 'Run rollback dry-run',
    destructive: false
  }
}

export function BackupRestoreView({ client, route, initialList = null, initialError = null }: BackupRestoreViewProps) {
  const [list, setList] = useState<BackupListResponse | null>(initialList)
  const [loadState, setLoadState] = useState<BackupLoadState>(() => initialLoadState(route, initialList, initialError))
  const [loadError, setLoadError] = useState<string | null>(initialError)
  const [selectedBackupId, setSelectedBackupId] = useState(initialList?.backups[0]?.backup_id ?? '')
  const [sheetOpen, setSheetOpen] = useState(false)
  const [dialogKind, setDialogKind] = useState<BackupOperationKind | null>(null)
  const [reason, setReason] = useState('Routine operator backup review')
  const [includePersonalData, setIncludePersonalData] = useState(false)
  const [reauthConfirmed, setReauthConfirmed] = useState(false)
  const [operation, setOperation] = useState<BackupOperationState | null>(null)
  const [lastVerify, setLastVerify] = useState<BackupVerifyResponse | null>(null)
  const [lastRestore, setLastRestore] = useState<BackupRestoreResponse | null>(null)
  const [lastRollback, setLastRollback] = useState<BackupRollbackResponse | null>(null)

  useEffect(() => {
    let active = true
    if (route.disabled) return
    setLoadState((current) => current === 'ready' || current === 'empty' ? current : 'loading')
    client.backups.list({ limit: 50, include_failed: true }).then((result) => {
      if (!active) return
      if (!result.ok) {
        setLoadState(loadStateFromError(result.error))
        setLoadError(backupErrorMessage(result.error))
        return
      }
      setList(result.data)
      setLoadState(result.data.backups.length === 0 ? 'empty' : route.state === 'degraded' ? 'degraded' : 'ready')
      setSelectedBackupId((current) => current || result.data.backups[0]?.backup_id || '')
      setLoadError(null)
    })
    return () => {
      active = false
    }
  }, [client, route.disabled, route.state])

  const backups = list?.backups ?? []
  const selectedBackup = useMemo(
    () => backups.find((backup) => backup.backup_id === selectedBackupId) ?? backups[0] ?? null,
    [backups, selectedBackupId]
  )
  const operationPending = operation?.status === 'pending'
  const mutationRouteReady = !route.disabled && route.routeable
  const disabledReason = backupDisabledReason(route, loadError)
  const rollbackBackupId = lastRestore?.rollback_backup_id ?? null

  const encryptedCount = backups.filter((backup) => backup.encrypted).length
  const secretsProtected = list?.secrets_redacted !== false

  const dialogValid = reason.trim().length > 0 && reauthConfirmed && !operationPending

  function openDialog(kind: BackupOperationKind) {
    setReauthConfirmed(false)
    setDialogKind(kind)
  }

  function selectBackup(backupId: string) {
    setSelectedBackupId(backupId)
    setSheetOpen(true)
  }

  async function runOperation(kind: BackupOperationKind, call: () => Promise<AuroraResponse<BackupCreateResponse | BackupVerifyResponse | BackupRestoreResponse | BackupRollbackResponse>>) {
    setOperation({ kind, status: 'pending', message: adminActionPendingMessage(kind), auditReceipt: null })
    const result = await call()
    if (!result.ok) {
      setOperation({ kind, status: 'failed', message: backupErrorMessage(result.error), auditReceipt: result.audit.correlationId })
      return
    }
    applyOperationResult(kind, result.data)
  }

  function applyOperationResult(
    kind: BackupOperationKind,
    data: BackupCreateResponse | BackupVerifyResponse | BackupRestoreResponse | BackupRollbackResponse
  ) {
    if (kind === 'create') {
      const created = data as BackupCreateResponse
      if (created.backup) {
        setList((current) => ({
          backups: [created.backup!, ...(current?.backups ?? [])],
          total: (current?.total ?? 0) + 1,
          secrets_redacted: created.backup!.secrets_redacted
        }))
        setSelectedBackupId(created.backup.backup_id)
      }
      setOperation({ kind, status: created.status === 'ok' ? 'ok' : 'failed', message: created.message ?? `Backup create returned ${created.status}.`, auditReceipt: created.audit_receipt })
      return
    }
    if (kind === 'verify') {
      const verified = data as BackupVerifyResponse
      setLastVerify(verified)
      setOperation({ kind, status: verified.verified ? 'ok' : 'failed', message: verified.message ?? (verified.verified ? 'Backup manifest verified.' : `Backup verify returned ${verified.status}.`), auditReceipt: verified.manifest_digest ?? null })
      return
    }
    if (kind === 'restore-dry-run') {
      const restore = data as BackupRestoreResponse
      setLastRestore(restore)
      setOperation({ kind, status: restore.status === 'ok' ? 'ok' : 'failed', message: restore.message ?? `Restore dry-run returned ${restore.status}.`, auditReceipt: restore.audit_receipt })
      return
    }
    const rollback = data as BackupRollbackResponse
    setLastRollback(rollback)
    setOperation({ kind, status: rollback.status === 'ok' ? 'ok' : 'failed', message: rollback.message ?? `Rollback dry-run returned ${rollback.status}.`, auditReceipt: rollback.audit_receipt })
  }

  function confirmDialog() {
    const kind = dialogKind
    if (!kind || !dialogValid) return
    const trimmedReason = reason.trim()
    if (kind === 'create') {
      void runOperation('create', () => client.backups.create({
        reason: trimmedReason,
        components: defaultComponents,
        include_personal_data: includePersonalData,
        storage: localStorageTarget()
      }, { reauthConfirmed }))
    } else if (kind === 'verify' && selectedBackup) {
      void runOperation('verify', () => client.backups.verify({ backup_id: selectedBackup.backup_id, storage: selectedBackup.storage }, trimmedReason, { reauthConfirmed }))
    } else if (kind === 'restore-dry-run' && selectedBackup) {
      void runOperation('restore-dry-run', () => client.backups.restore({
        backup_id: selectedBackup.backup_id,
        storage: selectedBackup.storage,
        components: selectedBackup.components.map((component) => component.component),
        dry_run: true,
        create_rollback: true,
        reason: trimmedReason
      }, { reauthConfirmed }))
    } else if (kind === 'rollback-dry-run' && rollbackBackupId) {
      void runOperation('rollback-dry-run', () => client.backups.rollback({ rollback_backup_id: rollbackBackupId, dry_run: true, reason: trimmedReason }, { reauthConfirmed }))
    }
    setDialogKind(null)
  }

  const columns: Array<DataColumn<BackupManifestSummary>> = [
    {
      key: 'backup',
      header: 'Backup',
      render: (backup) => (
        <span className="aui-cell-stack">
          <strong>{backup.backup_id}</strong>
          <small>{backup.created_at}</small>
        </span>
      )
    },
    { key: 'status', header: 'Status', render: (backup) => backup.status },
    {
      key: 'components',
      header: 'Components',
      hideAt: 'lg',
      render: (backup) => backup.components.map((component) => `${component.component}:${component.status}`).join(', ')
    },
    {
      key: 'storage',
      header: 'Storage',
      hideAt: 'md',
      render: (backup) => `${backup.storage.kind} / ${backup.encrypted ? 'encrypted' : 'not encrypted'} / ${backup.storage.encryption}`
    },
    {
      key: 'integrity',
      header: 'Manifest integrity',
      hideAt: 'lg',
      render: (backup) => (
        <span className="aui-cell-stack">
          <code className="aui-mono">{backup.manifest_digest}</code>
          <small>Schema {backup.schema_version}; {backup.secrets_redacted ? 'secrets protected' : 'redaction pending'}; {backup.audit_receipt ?? 'no audit receipt'}</small>
        </span>
      )
    }
  ]

  const dialogConfig = dialogKind ? operationCopy[dialogKind] : null
  const dialogAffected = dialogKind === 'create'
    ? defaultComponents.map(String)
    : dialogKind === 'rollback-dry-run'
      ? [rollbackBackupId ?? 'rollback point']
      : selectedBackup
        ? [selectedBackup.backup_id]
        : []

  return (
    <div className="aui-stack-lg">
      <PageHeader
        eyebrow="Admin"
        title="Backups & Restore"
        description="Create redacted backup manifests, verify integrity, download manifest summaries, and preview restore impact before destructive actions."
        badges={
          <BadgeCluster label="Backup service status">
            <StatusBadge state={route.state} />
            <PrivacyBadge privacy="admin-critical" />
            <EvidenceBadge label={route.providerLabel} />
            <EvidenceBadge label={client.transport.kind} />
            <EvidenceBadge label={secretsProtected ? 'secrets protected' : 'redaction pending'} />
          </BadgeCluster>
        }
        actions={
          <Button
            variant="primary"
            icon={<ArchiveRestore size={16} aria-hidden />}
            disabled={!mutationRouteReady}
            disabledReason={`Create is disabled: ${disabledReason}`}
            onClick={() => openDialog('create')}
          >
            Create via AdminAction
          </Button>
        }
      />

      {!mutationRouteReady ? <p className="aui-inline-alert" role="alert">Create is disabled: {disabledReason}</p> : null}

      <StatStrip
        items={[
          { label: 'Snapshots', value: list?.total ?? backups.length },
          { label: 'Encrypted', value: `${encryptedCount}/${backups.length}` },
          { label: 'Secrets', value: secretsProtected ? 'Protected' : 'Pending', tone: secretsProtected ? 'success' : 'warning' },
          { label: 'Service', value: presentableSignal(loadState) }
        ]}
      />

      <div className="aui-two-col">
        <Card title="Availability" icon={<FileCheck2 size={18} aria-hidden />}>
          <MetaGrid
            columns={1}
            items={[
              { label: 'State', value: loadState },
              { label: 'Route', value: presentableSignal(route.explanation) },
              { label: 'AdminAction', value: 'required for create, verify, restore dry-run and rollback dry-run' },
              { label: 'Mutation gate', value: mutationRouteReady ? 'enabled through Aurora AdminAction draft/confirm/audit' : disabledReason },
              { label: 'Blockers', value: presentableSignal(route.blockers.join(', ') || loadError || 'none') }
            ]}
          />
          {route.disabled ? <p className="aui-inline-alert" role="alert">Backup operations are disabled until backend Backup.List capability state and Backup.* AdminAction contracts are available.</p> : null}
          {loadError ? <p className="aui-inline-alert" role="alert">{loadError}</p> : null}
          {route.repairActions.length > 0 ? (
            <ul className="aui-repair-list" aria-label="Backup repair actions">
              {route.repairActions.map((action) => (
                <li key={action.id}>
                  <strong>{action.label}</strong>
                  <span>{action.disabled ? 'disabled' : 'available'}</span>
                  <small>{action.reason}</small>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>

        <Card title="Restore safety" icon={<RotateCcw size={18} aria-hidden />}>
          <p className="aui-card-note">These controls never call Backup.* directly; Aurora creates and confirms an AdminAction before submitting.</p>
          <div className="aui-action-row">
            <Button
              disabled={!mutationRouteReady || !selectedBackup}
              disabledReason={!mutationRouteReady ? disabledReason : 'Select a manifest first.'}
              onClick={() => openDialog('verify')}
            >
              Verify via AdminAction
            </Button>
            <Button
              disabled={!mutationRouteReady || !selectedBackup}
              disabledReason={!mutationRouteReady ? disabledReason : 'Select a manifest first.'}
              onClick={() => openDialog('restore-dry-run')}
            >
              Preview restore impact
            </Button>
            <Button
              disabled={!mutationRouteReady || !rollbackBackupId}
              disabledReason={!mutationRouteReady ? disabledReason : 'Run a restore dry-run first to create a rollback point.'}
              onClick={() => openDialog('rollback-dry-run')}
            >
              Preview rollback dry-run
            </Button>
          </div>
          <p className="aui-card-note" role="alert">Destructive restore is intentionally unavailable here; only dry-run impact preview is enabled until the backend exposes a confirmed destructive restore contract.</p>
          <Button disabled disabledReason="Backend has not returned a destructive restore contract.">Full restore disabled until backend returns destructive restore support</Button>
          <h3 className="aui-subhead">Rollback visibility</h3>
          <p className="aui-card-note">Rollback is warning-only until a restore dry-run returns a rollback backup id; this view previews rollback impact and does not roll back data.</p>
        </Card>
      </div>

      <Card title="Manifests" icon={<Download size={18} aria-hidden />} flush>
        <DataTable
          columns={columns}
          rows={backups}
          getRowKey={(backup) => backup.backup_id}
          onRowClick={(backup) => selectBackup(backup.backup_id)}
          empty={
            <div className="aui-empty-inline">
              {loadState === 'loading'
                ? <p aria-live="polite">Loading backup manifests from Aurora...</p>
                : <p>No backup manifests were returned by the Backup service.</p>}
            </div>
          }
        />
      </Card>

      {operation || lastVerify || lastRestore || lastRollback ? (
        <Card title="Operation results" icon={<FileCheck2 size={18} aria-hidden />}>
          {operation ? (
            <div className={`aui-op-result aui-op-result-${operation.status}`} role={operation.status === 'failed' ? 'alert' : 'status'}>
              <strong>{operation.kind}</strong>
              <p>{operation.message}</p>
              {operation.auditReceipt ? <code className="aui-mono">{operation.auditReceipt}</code> : null}
            </div>
          ) : null}
          {lastVerify ? <BackupComponents components={lastVerify.components} title="Last verification components" /> : null}
          {lastRestore ? <ImpactPlan plan={lastRestore.impact_plan} title="Restore impact plan" /> : null}
          {lastRollback ? <ImpactPlan plan={lastRollback.impact_plan} title="Rollback impact plan" /> : null}
        </Card>
      ) : null}

      <DetailSheet
        open={sheetOpen && Boolean(selectedBackup)}
        onClose={() => setSheetOpen(false)}
        title={selectedBackup?.backup_id ?? 'Backup manifest'}
        description={selectedBackup ? `Created ${selectedBackup.created_at}` : undefined}
        badge={selectedBackup ? <StatusBadge state={route.state} /> : undefined}
        actions={selectedBackup ? <ManifestDownload backup={selectedBackup} /> : undefined}
      >
        {selectedBackup ? (
          <>
            <MetaGrid
              items={[
                { label: 'Status', value: selectedBackup.status },
                { label: 'Schema', value: selectedBackup.schema_version },
                { label: 'Storage', value: `${selectedBackup.storage.kind} / ${selectedBackup.storage.encryption}` },
                { label: 'Encryption', value: selectedBackup.encrypted ? 'encrypted' : 'not encrypted' },
                { label: 'Secrets', value: selectedBackup.secrets_redacted ? 'secrets protected' : 'redaction pending' },
                { label: 'Audit receipt', value: selectedBackup.audit_receipt ?? 'no audit receipt', mono: true }
              ]}
            />
            <div>
              <p className="aui-meta-label">Manifest digest</p>
              <code className="aui-mono aui-code-block">{selectedBackup.manifest_digest}</code>
            </div>
            <BackupComponents
              components={selectedBackup.components.map((component) => ({
                component: component.component,
                status: component.status,
                message: null,
                redacted: selectedBackup.secrets_redacted
              }))}
              title="Components"
            />
          </>
        ) : null}
      </DetailSheet>

      {dialogConfig ? (
        <AdminConfirmDialog
          open={dialogKind !== null}
          title={dialogConfig.title}
          description={dialogConfig.description}
          methodId={dialogMethodId(dialogKind)}
          severity={dialogConfig.destructive ? 'destructive' : 'standard'}
          affected={dialogAffected}
          requireReason
          reasonValue={reason}
          onReasonChange={setReason}
          confirmLabel={dialogConfig.confirm}
          onConfirm={confirmDialog}
          onCancel={() => setDialogKind(null)}
          busy={operationPending}
          extraValid={reauthConfirmed}
          extraInvalidReason="Confirm AdminAction reauthentication before backup mutations."
        >
          {dialogKind === 'create' ? (
            <Checkbox
              checked={includePersonalData}
              onChange={setIncludePersonalData}
              label="Include personal RAG metadata when backend policy allows it"
            />
          ) : null}
          <Checkbox
            checked={reauthConfirmed}
            onChange={setReauthConfirmed}
            label="I confirm recent AdminAction reauthentication before backup mutations."
          />
        </AdminConfirmDialog>
      ) : null}
    </div>
  )
}

function ManifestDownload({ backup }: { backup: BackupManifestSummary }) {
  const href = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(backup, null, 2))}`
  return <a className="aui-btn aui-btn-outline" href={href} download={`${backup.backup_id}.json`}><span>Download manifest</span></a>
}

interface BackupComponentRow {
  component: string
  status: string
  message?: string | null
  redacted?: boolean
}

function BackupComponents({ components, title }: { components: BackupComponentRow[]; title: string }) {
  return (
    <section>
      <h3 className="aui-subhead">{title}</h3>
      <ul className="aui-repair-list">
        {components.map((component) => (
          <li key={component.component}><strong>{component.component}</strong><span>{component.status}</span><small>{component.message ?? (component.redacted ? 'redacted' : 'not redacted')}</small></li>
        ))}
      </ul>
    </section>
  )
}

function ImpactPlan({ plan, title }: { plan: import('@aurora/client').BackupImpactPlan; title: string }) {
  return (
    <section>
      <h3 className="aui-subhead">{title}</h3>
      <MetaGrid
        items={[
          { label: 'Admin critical', value: plan.admin_critical ? 'yes' : 'no' },
          { label: 'Quiesce', value: plan.requires_quiesce ? 'required' : 'skipped' },
          { label: 'Restart', value: plan.requires_restart ? 'required' : 'skipped' }
        ]}
      />
      <ul className="aui-repair-list">
        {plan.affected_services.map((service) => (
          <li key={`${service.service}-${service.action}`}><strong>{service.service}</strong><span>{service.action}</span><small>{service.reason}</small></li>
        ))}
        {plan.warnings.map((warning) => (
          <li key={warning}><strong>warning</strong><span>review</span><small>{warning}</small></li>
        ))}
      </ul>
    </section>
  )
}

function dialogMethodId(kind: BackupOperationKind | null): string {
  if (kind === 'create') return 'Backup.Create'
  if (kind === 'verify') return 'Backup.Verify'
  if (kind === 'restore-dry-run') return 'Backup.Restore (dry-run)'
  if (kind === 'rollback-dry-run') return 'Backup.Rollback (dry-run)'
  return 'Backup'
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
  if (!route.routeable) return 'Backup route is not routeable from current capability status.'
  if (route.disabled) return 'Backup backend contract is not advertised by the current SDK/capability graph.'
  return 'Backup AdminAction mutation contract is not ready.'
}

export function backupErrorMessage(error: AuroraError): string {
  if (error.code === 'auth' || error.code === 'permission') return 'Backup request denied by authentication or permissions.'
  if (error.code === 'privacy_blocked') return 'Backup request is blocked by privacy policy until required approval exists.'
  if (error.code === 'unavailable_service' || error.code === 'unsupported_feature') return 'Backup service is unavailable in this backend or deployment mode.'
  if (error.code === 'timeout' || error.code === 'transport_loss') return 'Backup request could not reach Aurora reliably; retry after service health recovers.'
  return error.message || 'Backup request failed.'
}

function adminActionPendingMessage(kind: BackupOperationKind): string {
  if (kind === 'create') return 'Creating AdminAction draft and confirmation for backup create.'
  if (kind === 'verify') return 'Creating AdminAction draft and confirmation for backup verification.'
  if (kind === 'restore-dry-run') return 'Creating AdminAction draft and confirmation for restore impact preview.'
  return 'Creating AdminAction draft and confirmation for rollback impact preview.'
}

function localStorageTarget() {
  return { kind: 'local' as const, uri: null, encryption: 'none' as const, key_ref: null, credential_ref: null, metadata: {} }
}
