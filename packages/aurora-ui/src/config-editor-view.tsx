'use client'

import { useEffect, useMemo, useState } from 'react'
import { History, RotateCcw, Save, ShieldCheck } from 'lucide-react'
import type {
  AuroraClient,
  AuroraError,
  ConfigChange,
  ConfigDiffEntry,
  ConfigFieldMetadata,
  ConfigReloadImpactEntry,
  ConfigVersionEntry,
  JsonValue
} from '@aurora/client'
import type { RouteAvailability } from './shell-data'
import { EvidenceBadge, PrivacyBadge, StatusBadge, presentableSignal } from './status-badges'
import { EmptyState, PageHeader } from './state-surface'
import { AdminConfirmDialog, Button, Card, Checkbox, DataTable, StatStrip, type DataColumn } from './primitives'

export interface ConfigEditorViewProps {
  client: AuroraClient
  route: RouteAvailability
  initialModel?: ConfigEditorModel
}

export interface ConfigEditorModel {
  state: 'loading' | 'ready' | 'empty' | 'denied' | 'degraded' | 'unavailable' | 'error'
  fields: ConfigFieldMetadata[]
  versions: ConfigVersionEntry[]
  validationErrors: string[]
  secretsRedacted: boolean
  evidence: string
  error: string | null
}

export async function buildConfigEditorModel(client: AuroraClient, route?: RouteAvailability): Promise<ConfigEditorModel> {
  if (route?.disabled) {
    return {
      state: route.state === 'denied' ? 'denied' : route.state === 'degraded' ? 'degraded' : 'unavailable',
      fields: [],
      versions: [],
      validationErrors: [],
      secretsRedacted: true,
      evidence: route.providerLabel,
      error: presentableSignal(route.blockers.join(', ') || route.explanation)
    }
  }

  try {
    const [schema, history, validation] = await Promise.all([
      client.config.getSchemaMetadata({ include_values: true }),
      client.config.getVersionHistory({ limit: 8 }),
      client.config.validate({})
    ])
    if (!schema.ok) return errorModel(schema.error, 'schema metadata')
    if (!history.ok) return errorModel(history.error, 'version history')
    const validationErrors = validation.ok ? validation.data.errors : [validation.error.message]
    return {
      state: schema.data.fields.length === 0 ? 'empty' : validationErrors.length > 0 ? 'degraded' : 'ready',
      fields: schema.data.fields,
      versions: history.data.versions,
      validationErrors,
      secretsRedacted: schema.data.secrets_redacted && history.data.secrets_redacted,
      evidence: schema.audit.correlationId ?? schema.audit.method ?? 'Config.GetSchemaMetadata',
      error: null
    }
  } catch (error) {
    return errorModel(error, 'config editor')
  }
}

type ConfigDialogKind = 'apply' | 'rollback'

export function ConfigEditorView({ client, route, initialModel }: ConfigEditorViewProps) {
  const [model, setModel] = useState<ConfigEditorModel>(initialModel ?? loadingModel(route))
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [diff, setDiff] = useState<ConfigDiffEntry[]>([])
  const [impact, setImpact] = useState<ConfigReloadImpactEntry[]>([])
  const [reason, setReason] = useState('Admin config update from Aurora UI')
  const [rollbackReason, setRollbackReason] = useState('')
  const [rollbackTarget, setRollbackTarget] = useState<ConfigVersionEntry | null>(null)
  const [reauthConfirmed, setReauthConfirmed] = useState(false)
  const [dialogKind, setDialogKind] = useState<ConfigDialogKind | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (initialModel && initialModel.state !== 'loading') return
    buildConfigEditorModel(client, route).then((next) => {
      if (!cancelled) setModel(next)
    })
    return () => {
      cancelled = true
    }
  }, [client, route, initialModel])

  const changes = useMemo<ConfigChange[]>(() => {
    return Object.entries(edits).flatMap(([key_path, raw]) => {
      const field = model.fields.find((candidate) => candidate.key_path === key_path)
      if (!field || stringifyValue(field.current_value) === raw) return []
      return [{ key_path, value: parseFieldValue(raw, field.type) }]
    })
  }, [edits, model.fields])
  const localValidationErrors = useMemo(() => validateConfigChanges(model.fields, changes), [model.fields, changes])
  const sections = useMemo(() => groupConfigFields(model.fields), [model.fields])
  const restartCount = model.fields.filter((field) => field.restart_required).length
  const secretCount = model.fields.filter((field) => field.secret).length
  const reviewBlocked = changes.length === 0 || localValidationErrors.length > 0 || reason.trim().length === 0

  useEffect(() => {
    if (changes.length === 0) {
      setDiff([])
      setImpact([])
      return
    }
    let cancelled = false
    Promise.all([
      client.config.previewDiff({ changes }),
      client.config.previewReloadImpact({ changes })
    ]).then(([diffResult, impactResult]) => {
      if (cancelled) return
      setDiff(diffResult.ok ? diffResult.data.diffs : [])
      setImpact(impactResult.ok ? impactResult.data.impacts : [])
      if (!diffResult.ok) setMessage(`Diff preview failed: ${diffResult.error.message}`)
      else if (!impactResult.ok) setMessage(`Reload impact failed: ${impactResult.error.message}`)
    }).catch((error) => {
      if (!cancelled) setMessage(`Diff preview failed: ${errorMessage(error)}`)
    })
    return () => {
      cancelled = true
    }
  }, [client, changes])

  async function refresh() {
    setModel(await buildConfigEditorModel(client, route))
  }

  function closeDialog() {
    setDialogKind(null)
    setReauthConfirmed(false)
  }

  function openRollbackDialog(version: ConfigVersionEntry) {
    setRollbackTarget(version)
    setRollbackReason(`Rollback ${version.key_path} from Aurora UI`)
    setDialogKind('rollback')
  }

  async function confirmApply() {
    if (reviewBlocked) return
    setBusy(true)
    setMessage(null)
    try {
      const receipts: string[] = []
      for (const change of changes) {
        const result = await client.config.applyChange({ change, reason, reauthConfirmed: true })
        receipts.push(result.confirmation.audit_receipt)
        if (!result.data.success) throw new Error(result.data.error ?? `Config.Set failed for ${change.key_path}`)
      }
      setEdits({})
      closeDialog()
      setMessage(`Applied ${changes.length} change(s). Audit receipt: ${receipts.join(', ')}`)
      await refresh()
    } catch (error) {
      setMessage(`Apply failed: ${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  async function confirmRollback() {
    if (!rollbackTarget) return
    setBusy(true)
    setMessage(null)
    try {
      const result = await client.config.rollback({
        versionId: rollbackTarget.version_id,
        reason: rollbackReason,
        reauthConfirmed: true
      })
      if (!result.data.success) throw new Error(result.data.error ?? 'Config rollback failed')
      setMessage(`Rolled back ${rollbackTarget.key_path}. Audit receipt: ${result.confirmation.audit_receipt}`)
      closeDialog()
      await refresh()
    } catch (error) {
      setMessage(`Rollback failed: ${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const canMutate = !route.disabled && model.state !== 'denied' && model.state !== 'unavailable'

  const rollbackColumns: Array<DataColumn<ConfigVersionEntry>> = [
    {
      key: 'field',
      header: 'Field',
      render: (version) => (
        <span className="aui-cell-stack">
          <strong>{version.key_path}</strong>
          <small className="aui-mono">{version.version_id}</small>
        </span>
      )
    },
    {
      key: 'when',
      header: 'When and visibility',
      render: (version) => (
        <span className="aui-cell-text">{version.timestamp}; {version.secret ? 'secret redacted' : 'value visible'}</span>
      )
    },
    {
      key: 'action',
      header: 'Action',
      align: 'end',
      render: (version) => (
        <Button variant="outline" disabled={!canMutate || busy} onClick={() => openRollbackDialog(version)}>
          Rollback
        </Button>
      )
    }
  ]

  return (
    <section className="aui-config" aria-labelledby="config-editor-title">
      <PageHeader
        eyebrow="Admin configuration"
        id="config-editor-title"
        title="Configuration"
        description="Schema-backed values, redacted secrets, validation, diff preview, reload impact, rollback, and audit receipts."
        badges={
          <>
            <StatusBadge state={route.state} />
            <PrivacyBadge privacy={route.item.privacyClass} />
            <EvidenceBadge label={model.secretsRedacted ? 'secrets protected' : 'redaction pending'} />
            <EvidenceBadge label={model.evidence} />
          </>
        }
      />

      <StatStrip
        ariaLabel="Configuration editor summary"
        items={[
          { label: 'Schema fields', value: model.fields.length, caption: `${sections.length} accordion sections` },
          { label: 'Secrets', value: secretCount, caption: 'redacted and disabled' },
          { label: 'Restart', value: restartCount, caption: 'fields require service restart' },
          { label: 'Staged', value: changes.length, caption: 'changes awaiting review', tone: changes.length > 0 ? 'warning' : 'default' }
        ]}
      />

      {model.state === 'loading' ? <p className="aui-message">Loading config from Aurora.</p> : null}
      {model.state === 'empty' ? <EmptyState title="No config fields" message="Config schema metadata returned no editable fields." /> : null}
      {model.state === 'denied' || model.state === 'unavailable' || model.state === 'error'
        ? <EmptyState title="Configuration editor is unavailable" message={presentableSignal(model.error ?? route.explanation)} />
        : null}
      {model.validationErrors.length > 0 ? (
        <div className="aui-inline-alert aui-inline-alert-danger" role="alert">
          <strong>Validation errors</strong>
          <ul>{model.validationErrors.map((error) => <li key={error}>{error}</li>)}</ul>
        </div>
      ) : null}
      {message ? <div className="aui-inline-alert" role="status"><span>{message}</span></div> : null}

      <div className="aui-config-grid">
        <Card
          className="aui-config-panel"
          title="Schema-backed config accordion"
          actions={
            <Button variant="ghost" icon={<RotateCcw size={14} aria-hidden />} onClick={() => setEdits({})} disabled={changes.length === 0 || busy}>
              Discard
            </Button>
          }
        >
          <div className="aui-config-accordion">
            {sections.length === 0 ? <p className="aui-muted">No schema sections are available.</p> : null}
            {sections.map(([section, fields]) => (
              <details key={section} className="aui-config-section" open>
                <summary>
                  <span>
                    <strong>{configSectionTitle(section)}</strong>
                    <small>Config section: {section}</small>
                  </span>
                  <span className="aui-config-section-badges" aria-label={`${section} section badges`}>
                    <em>{fields.length} fields</em>
                    <em>{countChanged(fields, changes)} staged</em>
                    {fields.some((field) => field.secret) ? <em>secret redacted</em> : null}
                    {fields.some((field) => field.restart_required) ? <em>restart required</em> : null}
                  </span>
                </summary>
                <div className="aui-config-fields">
                  {fields.map((field) => {
                    const editedValue = edits[field.key_path] ?? stringifyValue(field.current_value)
                    const changed = changes.some((change) => change.key_path === field.key_path)
                    return (
                      <label key={field.key_path} className="aui-config-field">
                        <span>
                          <strong>{field.title ?? field.key_path}</strong>
                          <code>{field.key_path}</code>
                          <small>{field.description || 'No schema description provided.'}</small>
                        </span>
                        <ConfigFieldControl
                          field={field}
                          value={field.secret ? '[REDACTED]' : editedValue}
                          disabled={!canMutate || field.secret || busy}
                          invalid={fieldHasValidationError(field.key_path, model.validationErrors, localValidationErrors)}
                          changed={changed}
                          onChange={(value) => setEdits((current) => ({ ...current, [field.key_path]: value }))}
                        />
                        <em>
                          {field.source_layer}; {fieldModeLabel(field)}
                          {field.secret ? '; secret redacted' : ''}
                          {field.affected_services.length > 0 ? `; affects ${field.affected_services.join(', ')}` : ''}
                        </em>
                      </label>
                    )
                  })}
                </div>
              </details>
            ))}
          </div>
        </Card>

        <Card
          className="aui-config-panel"
          title="Staged review"
          icon={<ShieldCheck size={18} aria-hidden />}
          description="Preview Config.PreviewDiff and Config.PreviewReloadImpact before Config.Set is submitted through AdminAction. Secret values stay redacted."
        >
          <DiffList diff={diff} />
          <ImpactList impact={impact} />
          {localValidationErrors.length > 0 ? (
            <div className="aui-inline-alert aui-inline-alert-danger" role="alert">
              <strong>Staged validation</strong>
              <ul>{localValidationErrors.map((error) => <li key={error}>{error}</li>)}</ul>
            </div>
          ) : null}
          <Button
            variant="primary"
            icon={<Save size={16} aria-hidden />}
            disabled={!canMutate || reviewBlocked || busy}
            onClick={() => setDialogKind('apply')}
          >
            Review Apply through AdminAction
          </Button>
        </Card>
      </div>

      <Card className="aui-config-panel" title="Rollback history" icon={<History size={18} aria-hidden />}>
        <DataTable
          columns={rollbackColumns}
          rows={model.versions}
          getRowKey={(version) => version.version_id}
          empty={<div className="aui-empty-inline"><p>No version history reported.</p></div>}
        />
      </Card>

      {dialogKind ? (
        <AdminConfirmDialog
          open
          title={dialogKind === 'apply' ? 'Apply staged config changes' : 'Roll back configuration value'}
          description={
            dialogKind === 'apply'
              ? `Apply ${changes.length} staged change(s) through Config.Set. Reload/restart impact is shown in the staged review card; secret values stay redacted.`
              : `Roll back ${rollbackTarget?.key_path ?? 'this field'} to a prior version through Config.Set.`
          }
          methodId="Config.Set"
          affected={dialogKind === 'apply' ? changes.map((change) => change.key_path) : rollbackTarget ? [rollbackTarget.key_path] : []}
          requireReason
          reasonValue={dialogKind === 'apply' ? reason : rollbackReason}
          onReasonChange={dialogKind === 'apply' ? setReason : setRollbackReason}
          confirmLabel={dialogKind === 'apply' ? 'Confirm Apply through AdminAction' : 'Confirm Rollback through AdminAction'}
          onConfirm={dialogKind === 'apply' ? confirmApply : confirmRollback}
          onCancel={closeDialog}
          busy={busy}
          extraValid={reauthConfirmed}
          extraInvalidReason="Confirm in-session admin unlock before config AdminAction."
        >
          <Checkbox
            checked={reauthConfirmed}
            onChange={setReauthConfirmed}
            label="In-session admin unlock confirmed for config AdminAction"
          />
        </AdminConfirmDialog>
      ) : null}
    </section>
  )
}

function ConfigFieldControl({
  field,
  value,
  disabled,
  invalid,
  changed,
  onChange
}: {
  field: ConfigFieldMetadata
  value: string
  disabled: boolean
  invalid: boolean
  changed: boolean
  onChange: (value: string) => void
}) {
  const common = {
    disabled,
    'aria-invalid': invalid,
    'data-changed': changed ? 'true' : undefined
  } as const
  if (field.choices && field.choices.length > 0 && !field.secret) {
    return (
      <select value={value} onChange={(event) => onChange(event.target.value)} {...common}>
        {field.choices.map((choice) => {
          const option = stringifyValue(choice)
          return <option key={option} value={option}>{option}</option>
        })}
      </select>
    )
  }
  if (field.type === 'boolean' && !field.secret) {
    return (
      <select value={value || 'false'} onChange={(event) => onChange(event.target.value)} {...common}>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    )
  }
  if ((field.type === 'array' || field.type === 'object') && !field.secret) {
    return <textarea value={value} onChange={(event) => onChange(event.target.value)} {...common} />
  }
  return (
    <input
      type={field.type === 'integer' || field.type === 'number' ? 'number' : field.secret ? 'password' : 'text'}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      {...numericBounds(field)}
      {...common}
    />
  )
}

function DiffList({ diff }: { diff: ConfigDiffEntry[] }) {
  return (
    <div className="aui-config-review-block" aria-label="Preview diff">
      <h3 id="config-diff-preview-title">Diff preview</h3>
      {diff.length === 0 ? <p>No staged changes.</p> : null}
      {diff.map((row) => (
        <div key={row.key_path} className="aui-config-diff-row">
          <code>{row.key_path}</code>
          <span>{displayDiffValue(row)}</span>
          <span>{displayDiffValue(row, 'new')}</span>
        </div>
      ))}
    </div>
  )
}

function ImpactList({ impact }: { impact: ConfigReloadImpactEntry[] }) {
  return (
    <div className="aui-config-review-block">
      <h3>Reload impact</h3>
      {impact.length === 0 ? <p>No reload impact reported.</p> : null}
      {impact.map((entry) => (
        <p key={entry.key_path}>
          <strong>{entry.key_path}</strong>: {entry.restart_required ? 'restart' : entry.reload_required ? 'reload' : 'hot update'}; {entry.affected_services.join(', ') || 'no service'}.
        </p>
      ))}
    </div>
  )
}

function loadingModel(route: RouteAvailability): ConfigEditorModel {
  return {
    state: 'loading',
    fields: [],
    versions: [],
    validationErrors: [],
    secretsRedacted: true,
    evidence: route.providerLabel,
    error: null
  }
}

function errorModel(error: unknown, source: string): ConfigEditorModel {
  const maybe = error as Partial<AuroraError>
  const code = maybe.code
  return {
    state: code === 'auth' || code === 'permission' ? 'denied' : code === 'unsupported_feature' || code === 'unavailable_service' ? 'unavailable' : 'error',
    fields: [],
    versions: [],
    validationErrors: [],
    secretsRedacted: true,
    evidence: source,
    error: errorMessage(error)
  }
}

function stringifyValue(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

function parseFieldValue(value: string, type: string): JsonValue {
  if (type === 'integer' || type === 'number') return Number(value)
  if (type === 'boolean') return value === 'true'
  if (type === 'array' || type === 'object') {
    try {
      return JSON.parse(value) as JsonValue
    } catch {
      return value
    }
  }
  return value
}

function displayValue(value: JsonValue | undefined): string {
  const text = stringifyValue(value)
  return text.length > 0 ? text : 'empty'
}

function displayDiffValue(row: ConfigDiffEntry, side: 'old' | 'new' = 'old'): string {
  if (row.secret) return '[REDACTED]'
  return displayValue(side === 'old' ? row.old_value : row.new_value)
}

function validateConfigChanges(fields: ConfigFieldMetadata[], changes: ConfigChange[]): string[] {
  const fieldByKey = new Map(fields.map((field) => [field.key_path, field]))
  return changes.flatMap((change) => {
    const field = fieldByKey.get(change.key_path)
    if (!field) return [`${change.key_path}: field is not present in schema metadata`]
    const errors: string[] = []
    if (field.secret) errors.push(`${field.key_path}: secret fields cannot be edited from the UI`)
    if ((field.type === 'integer' || field.type === 'number') && (typeof change.value !== 'number' || Number.isNaN(change.value))) {
      errors.push(`${field.key_path}: must be a valid ${field.type}`)
    }
    if (field.type === 'boolean' && typeof change.value !== 'boolean') errors.push(`${field.key_path}: must be true or false`)
    if ((field.type === 'array' && !Array.isArray(change.value)) || (field.type === 'object' && !isPlainObject(change.value))) {
      errors.push(`${field.key_path}: must be valid JSON ${field.type}`)
    }
    const minimum = numericConstraint(field, 'minimum')
    const maximum = numericConstraint(field, 'maximum')
    if (typeof change.value === 'number' && minimum !== null && change.value < minimum) errors.push(`${field.key_path}: must be at least ${minimum}`)
    if (typeof change.value === 'number' && maximum !== null && change.value > maximum) errors.push(`${field.key_path}: must be at most ${maximum}`)
    if (field.choices && field.choices.length > 0 && !field.choices.some((choice) => stringifyValue(choice) === stringifyValue(change.value))) {
      errors.push(`${field.key_path}: must match a schema choice`)
    }
    return errors
  })
}

function fieldHasValidationError(keyPath: string, backendErrors: string[], localErrors: string[]): boolean {
  return [...backendErrors, ...localErrors].some((error) => error.includes(keyPath))
}

function numericBounds(field: ConfigFieldMetadata): { min?: number; max?: number } {
  const min = numericConstraint(field, 'minimum')
  const max = numericConstraint(field, 'maximum')
  return {
    ...(min === null ? {} : { min }),
    ...(max === null ? {} : { max })
  }
}

function numericConstraint(field: ConfigFieldMetadata, key: 'minimum' | 'maximum'): number | null {
  const value = field.constraints[key]
  return typeof value === 'number' ? value : null
}

function isPlainObject(value: JsonValue): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function groupConfigFields(fields: ConfigFieldMetadata[]): Array<[string, ConfigFieldMetadata[]]> {
  const groups = new Map<string, ConfigFieldMetadata[]>()
  for (const field of fields) {
    const section = configSectionName(field.key_path)
    const current = groups.get(section) ?? []
    current.push(field)
    groups.set(section, current)
  }
  return Array.from(groups.entries())
}

function configSectionName(keyPath: string): string {
  const parts = keyPath.split('.')
  return parts.length >= 2 ? parts.slice(0, 2).join('.') : parts[0] || 'root'
}

function configSectionTitle(section: string): string {
  return section
    .split('.')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' / ')
}

function countChanged(fields: ConfigFieldMetadata[], changes: ConfigChange[]): number {
  const keys = new Set(fields.map((field) => field.key_path))
  return changes.filter((change) => keys.has(change.key_path)).length
}

function fieldModeLabel(field: ConfigFieldMetadata): string {
  if (field.restart_required) return 'restart required'
  if (field.reload_required) return 'reload required'
  return 'hot update'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
