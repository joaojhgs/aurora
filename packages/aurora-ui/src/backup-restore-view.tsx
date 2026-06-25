'use client'

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { ArchiveRestore, Download, FileCheck2, RotateCcw, ShieldAlert } from 'lucide-react'
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
import { EvidenceBadge, PrivacyBadge, StatusBadge } from './status-badges'

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

export function BackupRestoreView({ client, route, initialList = null, initialError = null }: BackupRestoreViewProps) {
  const [list, setList] = useState<BackupListResponse | null>(initialList)
  const [loadState, setLoadState] = useState<BackupLoadState>(() => initialLoadState(route, initialList, initialError))
  const [loadError, setLoadError] = useState<string | null>(initialError)
  const [selectedBackupId, setSelectedBackupId] = useState(initialList?.backups[0]?.backup_id ?? '')
  const [reason, setReason] = useState('Routine operator backup review')
  const [includePersonalData, setIncludePersonalData] = useState(false)
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

  const selectedBackup = useMemo(
    () => list?.backups.find((backup) => backup.backup_id === selectedBackupId) ?? list?.backups[0] ?? null,
    [list, selectedBackupId]
  )
  const canMutate = !route.disabled && reason.trim().length > 0 && operation?.status !== 'pending'
  const canUseSelected = canMutate && Boolean(selectedBackup)
  const rollbackBackupId = lastRestore?.rollback_backup_id ?? null

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

  function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canMutate) return
    void runOperation('create', () => client.backups.create({
      reason: reason.trim(),
      components: defaultComponents,
      include_personal_data: includePersonalData,
      storage: localStorageTarget()
    }))
  }

  function submitVerify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedBackup || !canUseSelected) return
    void runOperation('verify', () => client.backups.verify({ backup_id: selectedBackup.backup_id, storage: selectedBackup.storage }, reason.trim()))
  }

  function submitRestoreDryRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedBackup || !canUseSelected) return
    void runOperation('restore-dry-run', () => client.backups.restore({
      backup_id: selectedBackup.backup_id,
      storage: selectedBackup.storage,
      components: selectedBackup.components.map((component) => component.component),
      dry_run: true,
      create_rollback: true,
      reason: reason.trim()
    }))
  }

  function submitRollbackDryRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!rollbackBackupId || !canMutate) return
    void runOperation('rollback-dry-run', () => client.backups.rollback({ rollback_backup_id: rollbackBackupId, dry_run: true, reason: reason.trim() }))
  }

  return (
    <section className="aui-backups" aria-labelledby="backups-title">
      <header className="aui-backups-header">
        <div>
          <p className="aui-kicker">Admin</p>
          <h1 id="backups-title">Backups & Restore</h1>
          <p>Create redacted backup manifests, verify integrity, download manifest summaries, and preview restore impact before destructive actions.</p>
        </div>
        <div className="aui-assistant-badges" aria-label="Backup backend evidence">
          <StatusBadge state={route.state} />
          <PrivacyBadge privacy="admin-critical" />
          <EvidenceBadge label={route.providerLabel} />
          <EvidenceBadge label={client.transport.kind} />
          <EvidenceBadge label={list?.secrets_redacted === false ? 'redaction unknown' : 'secrets redacted'} />
        </div>
      </header>

      <div className="aui-backup-grid">
        <section className="aui-backup-panel aui-backup-control" aria-labelledby="backup-create-title">
          <PanelTitle icon="create" title="Create backup" id="backup-create-title" />
          <p>AdminAction captures reason, confirmation, affected resources, and audit receipt before creating a manifest.</p>
          <form className="aui-backup-form" onSubmit={submitCreate}>
            <label htmlFor="backup-reason">Reason</label>
            <textarea id="backup-reason" value={reason} onChange={(event) => setReason(event.currentTarget.value)} rows={3} disabled={route.disabled} />
            <label className="aui-backup-check">
              <input type="checkbox" checked={includePersonalData} onChange={(event) => setIncludePersonalData(event.currentTarget.checked)} disabled={route.disabled} />
              <span>Include personal RAG metadata when backend policy allows it</span>
            </label>
            <button type="submit" disabled={!canMutate}>Create via AdminAction</button>
          </form>
        </section>

        <section className="aui-backup-panel" aria-labelledby="backup-state-title">
          <PanelTitle icon="state" title="Availability" id="backup-state-title" />
          <dl className="aui-backup-facts">
            <div><dt>State</dt><dd>{loadState}</dd></div>
            <div><dt>Route</dt><dd>{route.explanation}</dd></div>
            <div><dt>AdminAction</dt><dd>{route.requiresAdminAction ? 'required for create, verify, restore and rollback' : 'not required'}</dd></div>
            <div><dt>Blockers</dt><dd>{route.blockers.join(', ') || loadError || 'none'}</dd></div>
          </dl>
          {route.disabled ? <p role="alert">Backup operations are disabled until backend capability evidence is available.</p> : null}
          {loadError ? <p role="alert">{loadError}</p> : null}
        </section>

        <section className="aui-backup-panel aui-backup-wide" aria-labelledby="backup-list-title">
          <PanelTitle icon="list" title="Manifests" id="backup-list-title" />
          <BackupManifestTable backups={list?.backups ?? []} selectedBackupId={selectedBackup?.backup_id ?? ''} onSelect={setSelectedBackupId} />
          {loadState === 'loading' ? <p aria-live="polite">Loading backup manifests from AuroraClient...</p> : null}
          {loadState === 'empty' ? <p>No backup manifests were returned by the Backup service.</p> : null}
        </section>

        <section className="aui-backup-panel" aria-labelledby="backup-ops-title">
          <PanelTitle icon="restore" title="Verify & restore" id="backup-ops-title" />
          <form className="aui-backup-form" onSubmit={submitVerify}><button type="submit" disabled={!canUseSelected}>Verify via AdminAction</button></form>
          <form className="aui-backup-form" onSubmit={submitRestoreDryRun}><button type="submit" disabled={!canUseSelected}>Preview restore impact</button></form>
          <button type="button" disabled>Full restore disabled until backend returns destructive restore support</button>
          <form className="aui-backup-form" onSubmit={submitRollbackDryRun}><button type="submit" disabled={!rollbackBackupId || !canMutate}>Preview rollback</button></form>
          {selectedBackup ? <ManifestDownload backup={selectedBackup} /> : null}
        </section>

        <section className="aui-backup-panel" aria-labelledby="backup-result-title">
          <PanelTitle icon="download" title="Rollback visibility" id="backup-result-title" />
          {operation ? (
            <div className={`aui-backup-result aui-backup-result-${operation.status}`} role={operation.status === 'failed' ? 'alert' : 'status'}>
              <strong>{operation.kind}</strong>
              <p>{operation.message}</p>
              {operation.auditReceipt ? <code>{operation.auditReceipt}</code> : null}
            </div>
          ) : <p>No AdminAction operation has run in this view yet.</p>}
          {lastVerify ? <BackupComponents components={lastVerify.components} title="Last verification components" /> : null}
          {lastRestore ? <ImpactPlan plan={lastRestore.impact_plan} title="Restore impact plan" /> : null}
          {lastRollback ? <ImpactPlan plan={lastRollback.impact_plan} title="Rollback impact plan" /> : null}
        </section>
      </div>
    </section>
  )
}

function PanelTitle({ icon, title, id }: { icon: 'create' | 'state' | 'list' | 'restore' | 'download'; title: string; id: string }) {
  const Icon = icon === 'create' ? ArchiveRestore : icon === 'state' ? ShieldAlert : icon === 'list' ? FileCheck2 : icon === 'restore' ? RotateCcw : Download
  return <div className="aui-backup-panel-title"><Icon size={18} aria-hidden /><h2 id={id}>{title}</h2></div>
}

function BackupManifestTable({ backups, selectedBackupId, onSelect }: { backups: BackupManifestSummary[]; selectedBackupId: string; onSelect: (backupId: string) => void }) {
  if (backups.length === 0) return <p>No manifests available.</p>
  return (
    <div className="aui-backup-table-wrap">
      <table className="aui-backup-table">
        <thead><tr><th scope="col">Select</th><th scope="col">Backup</th><th scope="col">Status</th><th scope="col">Components</th><th scope="col">Storage</th><th scope="col">Digest</th></tr></thead>
        <tbody>
          {backups.map((backup) => (
            <tr key={backup.backup_id}>
              <td><input aria-label={`Select ${backup.backup_id}`} type="radio" name="backup-id" value={backup.backup_id} checked={selectedBackupId === backup.backup_id} onChange={() => onSelect(backup.backup_id)} /></td>
              <td><strong>{backup.backup_id}</strong><small>{backup.created_at}</small></td>
              <td>{backup.status}</td>
              <td>{backup.components.map((component) => `${component.component}:${component.status}`).join(', ')}</td>
              <td>{backup.storage.kind}{backup.encrypted ? ' encrypted' : ''}</td>
              <td><code>{backup.manifest_digest}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ManifestDownload({ backup }: { backup: BackupManifestSummary }) {
  const href = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(backup, null, 2))}`
  return <a className="aui-action-chip" href={href} download={`${backup.backup_id}.json`}>Download manifest</a>
}

function BackupComponents({ components, title }: { components: import('@aurora/client').BackupComponentResult[]; title: string }) {
  return (
    <section>
      <h3>{title}</h3>
      <ul className="aui-backup-list">
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
      <h3>{title}</h3>
      <dl className="aui-backup-facts">
        <div><dt>Admin critical</dt><dd>{plan.admin_critical ? 'yes' : 'no'}</dd></div>
        <div><dt>Quiesce</dt><dd>{plan.requires_quiesce ? 'required' : 'not required'}</dd></div>
        <div><dt>Restart</dt><dd>{plan.requires_restart ? 'required' : 'not required'}</dd></div>
      </dl>
      <ul className="aui-backup-list">
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
