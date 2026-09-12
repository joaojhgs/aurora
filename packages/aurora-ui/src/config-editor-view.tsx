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
import { EvidenceBadge, PrivacyBadge, StatusBadge, ToneBadge, presentableSignal } from './status-badges'
import { EmptyState, PageHeader } from './state-surface'
import { AdminConfirmDialog, Button, Card, Checkbox, DataTable, StatStrip, type DataColumn } from './primitives'
import { cn } from '#lib/utils'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '#components/ui/accordion'
import { Badge } from '#components/ui/badge'
import { Input } from '#components/ui/input'
import { Textarea } from '#components/ui/textarea'
import { safeErrorCopy } from './product-copy'
import { adminRouteCopy, productAdminErrorCopy, productAdminReasonCopy } from './admin-product-copy'

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
      error: adminRouteCopy(route)
    }
  }

  try {
    const [schema, history, validation] = await Promise.all([
      client.config.getSchemaMetadata({ include_values: true }),
      client.config.getVersionHistory({ limit: 8 }),
      client.config.validate({})
    ])
    if (!schema.ok) return errorModel(schema.error, 'configuration details')
    if (!history.ok) return errorModel(history.error, 'version history')
    const validationErrors = validation.ok ? validation.data.errors : [safeErrorCopy(validation.error).title]
    return {
      state: schema.data.fields.length === 0 ? 'empty' : validationErrors.length > 0 ? 'degraded' : 'ready',
      fields: schema.data.fields,
      versions: history.data.versions,
      validationErrors,
      secretsRedacted: schema.data.secrets_redacted && history.data.secrets_redacted,
      evidence: schema.audit.correlationId ?? schema.audit.method ?? ['Config', 'GetSchemaMetadata'].join('.'),
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
  const sections = useMemo(() => groupConfigFields(model.fields), [model.fields])
  const displayLabels = useMemo(
    () => buildConfigDisplayLabels(model.fields, model.versions, diff, impact, changes),
    [model.fields, model.versions, diff, impact, changes]
  )
  const localValidationErrors = useMemo(() => validateConfigChanges(model.fields, changes, displayLabels), [model.fields, changes, displayLabels])
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
      if (!diffResult.ok) setMessage(`Review failed: ${safeErrorCopy(diffResult.error).title}`)
      else if (!impactResult.ok) setMessage(`Refresh review failed: ${safeErrorCopy(impactResult.error).title}`)
    }).catch((error) => {
      if (!cancelled) setMessage(`Review failed: ${productAdminErrorCopy(error, 'Review failed. Try again.')}`)
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
    setRollbackReason(`Roll back ${configDisplayLabel(version.key_path, displayLabels)} from Aurora UI`)
    setDialogKind('rollback')
  }

  async function confirmApply() {
    if (reviewBlocked) return
    setBusy(true)
    setMessage(null)
    try {
      for (const change of changes) {
        const result = await client.config.applyChange({ change, reason, reauthConfirmed: true })
        if (!result.data.success) throw new Error(result.data.error ?? `Configuration update failed for ${change.key_path}`)
      }
      setEdits({})
      closeDialog()
      setMessage(`Applied ${changes.length} change(s).`)
      await refresh()
    } catch (error) {
      setMessage(`Apply failed: ${productAdminErrorCopy(error, 'Settings update failed. Try again.')}`)
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
      if (!result.data.success) throw new Error(result.data.error ?? 'Configuration rollback failed')
      setMessage('Rolled back selected setting.')
      closeDialog()
      await refresh()
    } catch (error) {
      setMessage(`Rollback failed: ${productAdminErrorCopy(error, 'Rollback failed. Try again.')}`)
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
        <span className="flex flex-col gap-0.5">
          <strong>{configDisplayLabel(version.key_path, displayLabels)}</strong>
          <small className="font-mono text-xs text-muted-foreground">{version.version_id}</small>
        </span>
      )
    },
    {
      key: 'when',
      header: 'When and visibility',
      render: (version) => (
        <span className="text-sm text-muted-foreground">{version.timestamp}; {version.secret ? 'secret redacted' : 'value visible'}</span>
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
    <section className="flex flex-col gap-4" aria-labelledby="config-editor-title">
      <PageHeader
        eyebrow="Admin configuration"
        id="config-editor-title"
        title="Configuration"
        description="Review settings, protected values, pending changes, refresh impact, rollback history, and audit references."
        badges={
          <>
            <StatusBadge state={route.state} />
            <PrivacyBadge privacy={route.item.privacyClass} />
            <EvidenceBadge label={model.secretsRedacted ? 'secrets protected' : 'redaction pending'} />
            <EvidenceBadge label={configEvidenceLabel(model.evidence)} />
          </>
        }
      />

      <StatStrip
        ariaLabel="Configuration editor summary"
        items={[
          { label: 'Fields', value: model.fields.length, caption: `${sections.length} section(s)` },
          { label: 'Secrets', value: secretCount, caption: 'protected and disabled' },
          { label: 'Restart', value: restartCount, caption: 'fields require service restart' },
          { label: 'Staged', value: changes.length, caption: 'changes awaiting review', tone: changes.length > 0 ? 'warning' : 'default' }
        ]}
      />

      {model.state === 'loading' ? <p className="text-sm text-muted-foreground">Loading config from Aurora.</p> : null}
      {model.state === 'empty' ? <EmptyState title="No settings" message="Aurora returned no editable settings." /> : null}
      {model.state === 'denied' || model.state === 'unavailable' || model.state === 'error'
        ? <EmptyState title="Configuration editor is unavailable" message={productAdminReasonCopy(model.error ?? route.explanation, 'Configuration editor is unavailable.')} />
        : null}
      {model.validationErrors.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
          <strong>Validation errors</strong>
          <ul className="list-disc pl-4">{model.validationErrors.map((error, index) => <li key={`${index}-${error}`}>{configValidationErrorText(error, displayLabels)}</li>)}</ul>
        </div>
      ) : null}
      {message ? (
        <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm" role="status">
          <span>{message}</span>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card
          title="Configuration sections"
          actions={
            <Button variant="ghost" icon={<RotateCcw size={14} aria-hidden />} onClick={() => setEdits({})} disabled={changes.length === 0 || busy}>
              Discard
            </Button>
          }
        >
          {sections.length === 0 ? <p className="text-sm text-muted-foreground">No settings sections are available.</p> : null}
          <Accordion multiple defaultValue={sections.map((_, index) => `settings-group-${index + 1}`)}>
            {sections.map(([section, fields], index) => (
              <AccordionItem key={section} value={`settings-group-${index + 1}`}>
                <AccordionTrigger>
                  <span className="flex flex-1 flex-col gap-0.5 text-left">
                    <strong className="text-sm font-semibold">{configSectionTitle(section)}</strong>
                    <small className="text-xs font-normal text-muted-foreground">Settings group: {configSectionLabel(section)}</small>
                  </span>
                    <span className="flex flex-wrap items-center gap-1.5" aria-label={`${configSectionLabel(section)} section badges`}>
                    <Badge variant="secondary">{fields.length} fields</Badge>
                    <Badge variant="secondary">{countChanged(fields, changes)} staged</Badge>
                    {fields.some((field) => field.secret) ? <Badge variant="outline">secret redacted</Badge> : null}
                    {fields.some((field) => field.restart_required) ? <ToneBadge tone="warning">restart required</ToneBadge> : null}
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="flex flex-col gap-4">
                    {fields.map((field) => {
                      const editedValue = edits[field.key_path] ?? stringifyValue(field.current_value)
                      const changed = changes.some((change) => change.key_path === field.key_path)
                      const sensitive = isSensitiveConfigField(field)
                      return (
                        <label key={field.key_path} className="grid grid-cols-1 gap-2 border-b border-border/60 pb-3 last:border-0 last:pb-0 sm:grid-cols-[1fr_minmax(0,260px)] sm:items-start">
                          <span className="flex flex-col gap-1">
                            <strong className="text-sm font-medium">{configFieldTitle(field)}</strong>
                            <span className="text-xs text-muted-foreground">{configDisplayLabel(field.key_path, displayLabels)}</span>
                            <small className="text-xs text-muted-foreground">{configFieldDescription(field.description)}</small>
                          </span>
                          <span className="flex flex-col gap-1">
                            <ConfigFieldControl
                              field={field}
                              value={sensitive ? '[REDACTED]' : editedValue}
                              disabled={!canMutate || sensitive || busy}
                              invalid={fieldHasValidationError(field.key_path, model.validationErrors, localValidationErrors, displayLabels)}
                              changed={changed}
                              onChange={(value) => setEdits((current) => ({ ...current, [field.key_path]: value }))}
                            />
                            <em className="text-[11px] not-italic text-muted-foreground">
                              {configSourceLayerLabel(field.source_layer)}; {fieldModeLabel(field)}
                              {sensitive ? '; secret redacted' : ''}
                              {field.affected_services.length > 0 ? `; affects ${field.affected_services.map(configServiceLabel).join(', ')}` : ''}
                            </em>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </Card>

        <Card
          title="Staged review"
          icon={<ShieldCheck size={18} aria-hidden />}
          description="Review pending changes and their refresh impact before applying them. Secret values stay protected."
        >
          <div className="flex flex-col gap-4">
            <DiffList diff={diff} labels={displayLabels} />
            <ImpactList impact={impact} labels={displayLabels} />
            {localValidationErrors.length > 0 ? (
              <div className="flex flex-col gap-1 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
                <strong>Staged validation</strong>
                <ul className="list-disc pl-4">{localValidationErrors.map((error, index) => <li key={`${index}-${error}`}>{error}</li>)}</ul>
              </div>
            ) : null}
            <Button
              variant="primary"
              icon={<Save size={16} aria-hidden />}
              disabled={!canMutate || reviewBlocked || busy}
              onClick={() => setDialogKind('apply')}
            >
              Review and apply
            </Button>
          </div>
        </Card>
      </div>

      <Card title="Rollback history" icon={<History size={18} aria-hidden />}>
        <DataTable
          columns={rollbackColumns}
          rows={model.versions}
          getRowKey={(version) => version.version_id}
          empty="No version history reported."
        />
      </Card>

      {dialogKind ? (
        <AdminConfirmDialog
          open
          title={dialogKind === 'apply' ? 'Apply staged config changes' : 'Roll back configuration value'}
          description={
            dialogKind === 'apply'
              ? `Apply ${changes.length} staged change(s). Refresh impact is shown in the staged review card; secret values stay protected.`
              : `Roll back ${rollbackTarget ? configDisplayLabel(rollbackTarget.key_path, displayLabels) : 'this setting'} to a prior version.`
          }
          methodId="Config.Set"
          actionLabel={dialogKind === 'apply' ? 'Apply settings changes' : 'Roll back setting'}
          affected={dialogKind === 'apply' ? changes.map((change) => configDisplayLabel(change.key_path, displayLabels)) : rollbackTarget ? [configDisplayLabel(rollbackTarget.key_path, displayLabels)] : []}
          requireReason
          reasonValue={dialogKind === 'apply' ? reason : rollbackReason}
          onReasonChange={dialogKind === 'apply' ? setReason : setRollbackReason}
          confirmLabel={dialogKind === 'apply' ? 'Confirm apply' : 'Confirm rollback'}
          onConfirm={dialogKind === 'apply' ? confirmApply : confirmRollback}
          onCancel={closeDialog}
          busy={busy}
          extraValid={reauthConfirmed}
          extraInvalidReason="Confirm your recent admin unlock before changing settings."
        >
          <Checkbox
            checked={reauthConfirmed}
            onChange={setReauthConfirmed}
            label="Recent admin unlock confirmed for settings"
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
  const changedRing = 'data-changed:border-primary data-changed:ring-1 data-changed:ring-primary/40'
  if (isSensitiveConfigField(field)) {
    return <Input className={changedRing} type="password" value="[REDACTED]" {...common} />
  }
  if (field.choices && field.choices.length > 0 && !field.secret) {
    return (
      <select className={cn(SELECT_CLASSNAME, changedRing)} value={value} onChange={(event) => onChange(event.target.value)} {...common}>
        {field.choices.map((choice) => {
          const option = stringifyValue(choice)
          return <option key={option} value={option}>{option}</option>
        })}
      </select>
    )
  }
  if (field.type === 'boolean' && !field.secret) {
    return (
      <select className={cn(SELECT_CLASSNAME, changedRing)} value={value || 'false'} onChange={(event) => onChange(event.target.value)} {...common}>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    )
  }
  if ((field.type === 'array' || field.type === 'object') && !field.secret) {
    return <Textarea className={cn('font-mono text-xs', changedRing)} rows={4} value={value} onChange={(event) => onChange(event.target.value)} {...common} />
  }
  return (
    <Input
      className={changedRing}
      type={field.type === 'integer' || field.type === 'number' ? 'number' : field.secret ? 'password' : 'text'}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      {...numericBounds(field)}
      {...common}
    />
  )
}

const SELECT_CLASSNAME =
  'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20'

function DiffList({ diff, labels }: { diff: ConfigDiffEntry[]; labels: ConfigDisplayLabels }) {
  return (
    <div className="flex flex-col gap-2" aria-label="Pending changes">
      <h3 id="config-diff-preview-title" className="text-sm font-semibold">Pending changes</h3>
      {diff.length === 0 ? <p className="text-sm text-muted-foreground">No staged changes.</p> : null}
      {diff.map((row) => (
        <div key={row.key_path} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs">
          <span className="font-medium">{configDisplayLabel(row.key_path, labels)}</span>
          <span className="text-muted-foreground line-through">{displayDiffValue(row)}</span>
          <span className="font-medium">{displayDiffValue(row, 'new')}</span>
        </div>
      ))}
    </div>
  )
}

function ImpactList({ impact, labels }: { impact: ConfigReloadImpactEntry[]; labels: ConfigDisplayLabels }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">Refresh impact</h3>
      {impact.length === 0 ? <p className="text-sm text-muted-foreground">No refresh impact reported.</p> : null}
      {impact.map((entry) => (
        <p key={entry.key_path} className="text-xs text-muted-foreground">
          <strong className="text-foreground">{configDisplayLabel(entry.key_path, labels)}</strong>: {entry.restart_required ? 'restart' : entry.reload_required ? 'reload' : 'hot update'}; {entry.affected_services.map(configServiceLabel).join(', ') || 'no service'}.
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

export function stringifyValue(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

export function parseFieldValue(value: string, type: string): JsonValue {
  if (type === 'integer' || type === 'number') {
    if (value.trim().length === 0) return value
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : value
  }
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
  const value = side === 'old' ? row.old_value : row.new_value
  if (row.secret || isSensitiveConfigPath(row.key_path) || isSensitiveConfigValue(value)) return '[REDACTED]'
  return displayValue(value)
}

interface ConfigDisplayLabels {
  fields: Map<string, string>
  unknown: Map<string, string>
}

function buildConfigDisplayLabels(
  fields: ConfigFieldMetadata[],
  versions: ConfigVersionEntry[],
  diff: ConfigDiffEntry[],
  impact: ConfigReloadImpactEntry[],
  changes: ConfigChange[]
): ConfigDisplayLabels {
  const fieldLabels = new Map<string, string>()
  fields.forEach((field) => {
    fieldLabels.set(field.key_path, safeConfigFieldTitle(field))
  })

  const unknownPaths = new Set<string>()
  for (const path of [
    ...versions.map((version) => version.key_path),
    ...diff.map((row) => row.key_path),
    ...impact.map((entry) => entry.key_path),
    ...changes.map((change) => change.key_path),
  ]) {
    if (!fieldLabels.has(path)) unknownPaths.add(path)
  }
  const unknown = new Map<string, string>()
  Array.from(unknownPaths).sort().forEach((path, index) => {
    unknown.set(path, `Setting ${index + 1}`)
  })
  return { fields: fieldLabels, unknown }
}

function configDisplayLabel(keyPath: string, labels: ConfigDisplayLabels): string {
  return labels.fields.get(keyPath) ?? labels.unknown.get(keyPath) ?? 'Setting'
}

function validateConfigChanges(fields: ConfigFieldMetadata[], changes: ConfigChange[], labels: ConfigDisplayLabels): string[] {
  const fieldByKey = new Map(fields.map((field) => [field.key_path, field]))
  return changes.flatMap((change) => {
    const field = fieldByKey.get(change.key_path)
    const label = configDisplayLabel(change.key_path, labels)
    if (!field) return [`${label}: Aurora could not read this item`]
    const errors: string[] = []
    if (field.secret) errors.push(`${label}: secret fields cannot be edited from the UI`)
    if ((field.type === 'integer' || field.type === 'number') && (typeof change.value !== 'number' || !Number.isFinite(change.value))) {
      errors.push(`${label}: must be a valid ${field.type}`)
    }
    if (field.type === 'integer' && typeof change.value === 'number' && !Number.isInteger(change.value)) {
      errors.push(`${label}: must be a valid integer`)
    }
    if (field.type === 'boolean' && typeof change.value !== 'boolean') errors.push(`${label}: must be true or false`)
    if ((field.type === 'array' && !Array.isArray(change.value)) || (field.type === 'object' && !isPlainObject(change.value))) {
      errors.push(`${label}: must be valid JSON ${field.type}`)
    }
    const minimum = numericConstraint(field, 'minimum')
    const maximum = numericConstraint(field, 'maximum')
    if (typeof change.value === 'number' && minimum !== null && change.value < minimum) errors.push(`${label}: must be at least ${minimum}`)
    if (typeof change.value === 'number' && maximum !== null && change.value > maximum) errors.push(`${label}: must be at most ${maximum}`)
    if (field.choices && field.choices.length > 0 && !field.choices.some((choice) => stringifyValue(choice) === stringifyValue(change.value))) {
      errors.push(`${label}: choose one of the listed values`)
    }
    return errors
  })
}

function fieldHasValidationError(keyPath: string, backendErrors: string[], localErrors: string[], labels: ConfigDisplayLabels): boolean {
  const label = configDisplayLabel(keyPath, labels)
  return backendErrors.some((error) => error.includes(keyPath)) || localErrors.some((error) => error.includes(label))
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
  return configSectionLabel(section)
}

function configSectionLabel(section: string): string {
  return `${configAreaLabel(section)} settings`
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

function configEvidenceLabel(value: string): string {
  if (/Config\.|Get|Schema|Metadata/i.test(value)) return 'Current settings'
  return presentableSignal(value)
}

function configFieldTitle(field: ConfigFieldMetadata): string {
  return safeConfigFieldTitle(field)
}

function safeConfigFieldTitle(field: ConfigFieldMetadata): string {
  if (isSensitiveConfigField(field) || isProtectedConfigText(field.title ?? undefined)) return 'Protected setting'
  const title = field.title?.trim()
  if (title) {
    const softened = productAdminReasonCopy(title, '')
    if (softened) return softened
  }
  return productConfigAreaSettingCopy(field.key_path)
}

function productConfigAreaSettingCopy(value: string): string {
  return `${configAreaLabel(value)} setting`
}

function configValidationErrorText(error: string, labels: ConfigDisplayLabels): string {
  let text = error
  const orderedPaths = [...labels.fields.keys(), ...labels.unknown.keys()].sort((a, b) => b.length - a.length)
  for (const path of orderedPaths) {
    text = text.replaceAll(path, configDisplayLabel(path, labels))
  }
  return productAdminReasonCopy(text, 'Setting needs attention.')
}

function configSourceLayerLabel(value: string): string {
  if (/config\.json/iu.test(value)) return 'Saved settings'
  return productAdminReasonCopy(value, 'Saved settings')
}

function configServiceLabel(value: string): string {
  return configAreaLabel(value)
}

function configAreaLabel(value: string): string {
  if (/gateway|connection/iu.test(value)) return 'Connection'
  if (/auth|access/iu.test(value)) return 'Access'
  if (/orchestrator|assistant|llm/iu.test(value)) return 'Assistant'
  if (/scheduler|schedule/iu.test(value)) return 'Scheduler'
  if (/backup/iu.test(value)) return 'Backups'
  if (/tooling|tools?|mcp|plugins?/iu.test(value)) return 'Tools'
  if (/tts|stt|voice|audio/iu.test(value)) return 'Voice'
  return 'General'
}

function isProtectedConfigPath(value: string): boolean {
  return isSensitiveConfigPath(value)
}

function isProtectedConfigText(value: string | undefined): boolean {
  return /(?:room[_ -]?password)/iu.test(value ?? '')
}

function isSensitiveConfigField(field: ConfigFieldMetadata): boolean {
  return field.secret ||
    isSensitiveConfigPath(field.key_path) ||
    isSensitiveConfigPath(field.title ?? '') ||
    isSensitiveConfigPath(field.description ?? '') ||
    isSensitiveConfigValue(field.current_value)
}

function isSensitiveConfigPath(value: string): boolean {
  return /(?:password|passphrase|secret|credential|api[_ -]?key|apikey|access[_ -]?key|private[_ -]?key|room[_ -]?password|auth[_ -]?token|refresh[_ -]?token|token\b)/iu.test(value)
}

function isSensitiveConfigValue(value: JsonValue | undefined): boolean {
  if (typeof value === 'string') return isSensitiveConfigString(value)
  if (Array.isArray(value)) return value.some((item) => isSensitiveConfigValue(item))
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, entry]) => isSensitiveConfigPath(key) || isSensitiveConfigValue(entry as JsonValue))
  }
  return false
}

function isSensitiveConfigString(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  if (/\b(?:sk-[A-Za-z0-9_-]{6,}|(?:AKIA|ghp_|github_pat_|xox[baprs]-|eyJ)[A-Za-z0-9._-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/u.test(trimmed)) return true
  if (/\b(?:api[_ -]?key|token|secret|credential|password|room[_ -]?password)\b\s*[:=]\s*\S+/iu.test(trimmed)) return true
  if (trimmed.length < 24 || /\s/u.test(trimmed)) return false
  const hasLetter = /[A-Za-z]/u.test(trimmed)
  const hasDigit = /\d/u.test(trimmed)
  const hasSymbol = /[^A-Za-z0-9]/u.test(trimmed)
  return hasLetter && hasDigit && hasSymbol
}

function configFieldDescription(value: string | undefined): string {
  const trimmed = value?.trim()
  if (!trimmed) return 'No description provided.'
  return productAdminReasonCopy(trimmed, 'No description provided.')
}

function errorMessage(error: unknown): string {
  return safeErrorCopy(error).title
}
