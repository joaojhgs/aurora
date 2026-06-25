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

  useEffect(() => {
    let cancelled = false
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
    })
    return () => {
      cancelled = true
    }
  }, [client, changes])

  async function refresh() {
    setModel(await buildConfigEditorModel(client, route))
  }

  async function applyChanges(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (changes.length === 0) return
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
      setMessage(`Applied ${changes.length} change(s). Audit receipt: ${receipts.join(', ')}`)
      await refresh()
    } catch (error) {
      setMessage(`Apply failed: ${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  async function rollback(version: ConfigVersionEntry) {
    setBusy(true)
    setMessage(null)
    try {
      const result = await client.config.rollback({
        versionId: version.version_id,
        reason: `Rollback ${version.key_path} from Aurora UI`,
        reauthConfirmed: true
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

      <form className="aui-config-grid" onSubmit={applyChanges}>
        <div className="aui-config-panel">
          <div className="aui-config-panel-header">
            <h2>Schema fields</h2>
            <button type="button" className="aui-action-chip" onClick={() => setEdits({})} disabled={changes.length === 0 || busy}>
              <RotateCcw size={14} aria-hidden /> Discard
            </button>
          </div>
          <div className="aui-config-fields">
            {model.fields.map((field) => {
              const editedValue = edits[field.key_path] ?? stringifyValue(field.current_value)
              const changed = changes.some((change) => change.key_path === field.key_path)
              return (
                <label key={field.key_path} className="aui-config-field">
                  <span>
                    <strong>{field.title ?? field.key_path}</strong>
                    <code>{field.key_path}</code>
                    <small>{field.description || 'No schema description provided.'}</small>
                  </span>
                  <input
                    value={field.secret ? '[REDACTED]' : editedValue}
                    disabled={!canMutate || field.secret || busy}
                    aria-invalid={model.validationErrors.some((error) => error.includes(field.key_path))}
                    data-changed={changed ? 'true' : undefined}
                    onChange={(event) => setEdits((current) => ({ ...current, [field.key_path]: event.target.value }))}
                  />
                  <em>{field.source_layer}; {field.restart_required ? 'restart required' : field.reload_required ? 'reload required' : 'hot update'}</em>
                </label>
              )
            })}
          </div>
        </div>

        <aside className="aui-config-panel">
          <div className="aui-config-panel-header">
            <h2>Review</h2>
            <ShieldCheck size={18} aria-hidden />
          </div>
          <DiffList diff={diff} />
          <ImpactList impact={impact} />
          <label className="aui-config-reason">
            <span>Admin reason</span>
            <textarea value={reason} onChange={(event) => setReason(event.target.value)} disabled={!canMutate || busy} />
          </label>
          <button className="aui-primary-action" type="submit" disabled={!canMutate || changes.length === 0 || busy || reason.trim().length === 0}>
            <Save size={16} aria-hidden /> Apply through AdminAction
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
              <button type="button" className="aui-action-chip" disabled={!canMutate || busy} onClick={() => rollback(version)}>
                Rollback
              </button>
            </article>
          ))}
        </div>
      </section>
    </section>
  )
}

function DiffList({ diff }: { diff: ConfigDiffEntry[] }) {
  return (
    <div className="aui-config-review-block">
      <h3>Diff preview</h3>
      {diff.length === 0 ? <p>No staged changes.</p> : null}
      {diff.map((row) => (
        <div key={row.key_path} className="aui-config-diff-row">
          <code>{row.key_path}</code>
          <span>{displayValue(row.old_value)}</span>
          <span>{displayValue(row.new_value)}</span>
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
