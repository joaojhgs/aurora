'use client'

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { History, RotateCcw, Save, Settings, ShieldCheck } from 'lucide-react'
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
import { EvidenceBadge, PrivacyBadge, StatusBadge } from './status-badges'

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
      error: route.blockers.join(', ') || route.explanation
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

export function ConfigEditorView({ client, route, initialModel }: ConfigEditorViewProps) {
  const [model, setModel] = useState<ConfigEditorModel>(initialModel ?? loadingModel(route))
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [diff, setDiff] = useState<ConfigDiffEntry[]>([])
  const [impact, setImpact] = useState<ConfigReloadImpactEntry[]>([])
  const [reason, setReason] = useState('Admin config update from Aurora UI')
  const [reviewArmed, setReviewArmed] = useState(false)
  const [reauthConfirmed, setReauthConfirmed] = useState(false)
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
    let cancelled = false
    setReviewArmed(false)
    if (changes.length === 0) {
      setDiff([])
      setImpact([])
      return
    }
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

  useEffect(() => {
    setReviewArmed(false)
  }, [reason])

  async function refresh() {
    setModel(await buildConfigEditorModel(client, route))
  }

  async function applyChanges(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (reviewBlocked) return
    if (!reviewArmed) {
      setReviewArmed(true)
      setMessage('Review staged diff and reload/restart impact, then confirm AdminAction apply.')
      return
    }
    if (!reauthConfirmed) {
      setMessage('Apply requires explicit in-session admin unlock before AdminAction submit.')
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const receipts: string[] = []
      for (const change of changes) {
        const result = await client.config.applyChange({ change, reason, reauthConfirmed })
        receipts.push(result.confirmation.audit_receipt)
        if (!result.data.success) throw new Error(result.data.error ?? `Config.Set failed for ${change.key_path}`)
      }
      setEdits({})
      setReviewArmed(false)
      setMessage(`Applied ${changes.length} change(s). Audit receipt: ${receipts.join(', ')}`)
      await refresh()
    } catch (error) {
      setMessage(`Apply failed: ${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  async function rollback(version: ConfigVersionEntry) {
    if (!reauthConfirmed) {
      setMessage('Rollback requires explicit in-session admin unlock before AdminAction submit.')
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const result = await client.config.rollback({
        versionId: version.version_id,
        reason: `Rollback ${version.key_path} from Aurora UI`,
        reauthConfirmed
      })
      if (!result.data.success) throw new Error(result.data.error ?? 'Config rollback failed')
      setMessage(`Rolled back ${version.key_path}. Audit receipt: ${result.confirmation.audit_receipt}`)
      await refresh()
    } catch (error) {
      setMessage(`Rollback failed: ${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const canMutate = !route.disabled && model.state !== 'denied' && model.state !== 'unavailable'

  return (
    <section className="aui-config" aria-labelledby="config-editor-title">
      <header className="aui-config-header">
        <div>
          <p className="aui-kicker">Admin configuration</p>
          <h1 id="config-editor-title"><Settings size={24} aria-hidden /> Configuration</h1>
          <p>Schema-backed values, redacted secrets, validation, diff preview, reload impact, rollback, and audit receipts.</p>
        </div>
        <div className="aui-assistant-badges" aria-label="Config route evidence">
          <StatusBadge state={route.state} />
          <PrivacyBadge privacy={route.item.privacyClass} />
          <EvidenceBadge label={model.secretsRedacted ? 'secrets redacted' : 'redaction unknown'} />
          <EvidenceBadge label={model.evidence} />
        </div>
      </header>

      {model.state === 'loading' ? <ConfigNotice title="Loading config" text="Waiting for AuroraClient config responses." /> : null}
      {model.state === 'empty' ? <ConfigNotice title="No config fields" text="Config schema metadata returned no editable fields." /> : null}
      {model.state === 'denied' || model.state === 'unavailable' || model.state === 'error'
        ? <ConfigNotice title="Config editor unavailable" text={model.error ?? route.explanation} />
        : null}
      {model.validationErrors.length > 0 ? (
        <div className="aui-config-alert" role="alert">
          <strong>Validation errors</strong>
          <ul>{model.validationErrors.map((error) => <li key={error}>{error}</li>)}</ul>
        </div>
      ) : null}
      {message ? <div className="aui-config-alert" role="status">{message}</div> : null}

      <div className="aui-config-summary" aria-label="Configuration editor summary">
        <ConfigMetric label="Schema fields" value={String(model.fields.length)} detail={`${sections.length} accordion sections`} />
        <ConfigMetric label="Secrets" value={String(secretCount)} detail="redacted and disabled" />
        <ConfigMetric label="Restart" value={String(restartCount)} detail="fields require service restart" />
        <ConfigMetric label="Staged" value={String(changes.length)} detail="changes awaiting review" />
      </div>

      <form className="aui-config-grid" onSubmit={applyChanges}>
        <div className="aui-config-panel">
          <div className="aui-config-panel-header">
            <h2>Schema-backed config accordion</h2>
            <button type="button" className="aui-action-chip" onClick={() => {
              setEdits({})
              setReviewArmed(false)
            }} disabled={changes.length === 0 || busy}>
              <RotateCcw size={14} aria-hidden /> Discard
            </button>
          </div>
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
        </div>

        <aside className="aui-config-panel">
          <div className="aui-config-panel-header">
            <h2>Staged review</h2>
            <ShieldCheck size={18} aria-hidden />
          </div>
          <p className="aui-config-review-note">
            Preview Config.PreviewDiff and Config.PreviewReloadImpact before Config.Set is submitted through AdminAction. Secret values stay redacted.
          </p>
          <DiffList diff={diff} />
          <ImpactList impact={impact} />
          {localValidationErrors.length > 0 ? (
            <div className="aui-config-alert" role="alert">
              <strong>Staged validation</strong>
              <ul>{localValidationErrors.map((error) => <li key={error}>{error}</li>)}</ul>
            </div>
          ) : null}
          <label className="aui-config-reason">
            <span>Admin reason</span>
            <textarea value={reason} onChange={(event) => setReason(event.target.value)} disabled={!canMutate || busy} />
          </label>
          <label className="aui-inline-field">
            <input
              type="checkbox"
              checked={reauthConfirmed}
              disabled={!canMutate || busy}
              onChange={(event) => setReauthConfirmed(event.currentTarget.checked)}
            />
            <span>In-session admin unlock confirmed for config AdminAction</span>
          </label>
          <button className="aui-primary-action" type="submit" disabled={!canMutate || reviewBlocked || !reauthConfirmed || busy}>
            <Save size={16} aria-hidden /> {reviewArmed ? 'Confirm Apply through AdminAction' : 'Review Apply through AdminAction'}
          </button>
        </aside>
      </form>

      <section className="aui-config-panel">
        <div className="aui-config-panel-header">
          <h2>Rollback history</h2>
          <History size={18} aria-hidden />
        </div>
        <div className="aui-config-history">
          {model.versions.length === 0 ? <p>No version history reported.</p> : null}
          {model.versions.map((version) => (
            <article key={version.version_id}>
              <div>
                <strong>{version.key_path}</strong>
                <code>{version.version_id}</code>
                <span>{version.timestamp}; {version.secret ? 'secret redacted' : 'value visible'}</span>
              </div>
              <button type="button" className="aui-action-chip" disabled={!canMutate || !reauthConfirmed || busy} onClick={() => rollback(version)}>
                Rollback
              </button>
            </article>
          ))}
        </div>
      </section>
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

function ConfigMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
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

function ConfigNotice({ title, text }: { title: string; text: string }) {
  return <div className="aui-config-alert" role="status"><strong>{title}</strong><span>{text}</span></div>
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
