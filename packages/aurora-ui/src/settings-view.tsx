'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AuroraClient, ConfigFieldMetadata } from '@aurora/client'
import type { AuroraShellSnapshot, RouteAvailability } from './shell-data'
import { SettingsPermissionsView } from './settings-permissions-view'
import { VoiceSettingsView } from './voice-settings-view'
import { getAuroraSurfaceProfile, type AuroraSurfaceProfile } from './platform-surface'
import type { AuroraRuntimeProfileV2 } from './runtime-profile'
import { ConfigEditorView, parseFieldValue, stringifyValue } from './config-editor-view'
import { DataPolicyResource } from './data-policy-view'
import { PageTabs, type PageTabItem } from './shared-components'
import { safeErrorCopy } from './product-copy'
import { Card } from './primitives'
import { ToneBadge } from './status-badges'
import { Badge } from '#components/ui/badge'
import { Input } from '#components/ui/input'

export type SettingsViewTab = 'general' | 'voice' | 'configuration' | 'advanced'

export interface SettingsViewProps {
  client: AuroraClient
  snapshot: AuroraShellSnapshot
  configRoute: RouteAvailability
  dataRoute: RouteAvailability
  initialTab?: SettingsViewTab
  runtimeProfile?: AuroraRuntimeProfileV2 | null | undefined
  surfaceProfile?: AuroraSurfaceProfile | null | undefined
}

export function SettingsView({
  client,
  snapshot,
  configRoute,
  dataRoute,
  initialTab = 'general',
  runtimeProfile = null,
  surfaceProfile = null
}: SettingsViewProps) {
  const [tab, setTab] = useState<SettingsViewTab>(initialTab)
  const voiceSurfaceProfile = useMemo(() => surfaceProfile ?? getAuroraSurfaceProfile({
    transportKind: snapshot.transportKind,
    nativePlatform: snapshot.nativePlatform,
    userAgent: typeof navigator === 'undefined' ? null : navigator.userAgent
  }), [surfaceProfile, snapshot.nativePlatform, snapshot.transportKind])

  const items: PageTabItem[] = [
    {
      value: 'general',
      label: 'General',
      content: <SettingsPermissionsView snapshot={snapshot} surface="settings" currentPath="/settings" hideTabs />
    },
    {
      value: 'voice',
      label: 'Voice',
      content: <VoiceSettingsView client={client} runtimeProfile={runtimeProfile} surfaceProfile={voiceSurfaceProfile} />
    },
    {
      value: 'configuration',
      label: 'Configuration',
      content: <ConfigEditorView client={client} route={configRoute} />
    },
    {
      value: 'advanced',
      label: 'Advanced',
      content: <AdvancedSettingsTab client={client} configRoute={configRoute} dataRoute={dataRoute} />
    }
  ]

  return (
    <section className="flex flex-col gap-4" aria-label="Settings">
      <PageTabs items={items} value={tab} onValueChange={(value) => setTab(value as SettingsViewTab)} />
    </section>
  )
}

interface AdvancedSettingsTabProps {
  client: AuroraClient
  configRoute: RouteAvailability
  dataRoute: RouteAvailability
}

type AdvancedFieldState = 'idle' | 'saving' | 'error'
interface AdvancedSettingsSection {
  id: string
  label: string
  fields: ConfigFieldMetadata[]
}

function AdvancedSettingsTab({ client, configRoute, dataRoute }: AdvancedSettingsTabProps) {
  const [fields, setFields] = useState<ConfigFieldMetadata[]>([])
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error' | 'unavailable'>('loading')
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [fieldState, setFieldState] = useState<Record<string, AdvancedFieldState>>({})
  const [message, setMessage] = useState<string | null>(null)

  const refresh = useCallback(() => {
    if (configRoute.disabled) {
      setLoadState('unavailable')
      setFields([])
      return
    }
    setLoadState('loading')
    client.config.getSchemaMetadata({ include_values: true }).then(
      (result) => {
        if (result.ok) {
          setFields(result.data.fields)
          setLoadState('ready')
        } else {
          setLoadState('error')
          setMessage(productSettingsErrorCopy(result.error))
        }
      },
      (error: unknown) => {
        setLoadState('error')
        setMessage(productSettingsErrorCopy(error))
      }
    )
  }, [client, configRoute])

  useEffect(() => {
    refresh()
  }, [refresh])

  const sections = useMemo(() => groupAdvancedFields(fields), [fields])

  async function commitField(field: ConfigFieldMetadata, raw: string) {
    if (field.secret) return
    const value = parseFieldValue(raw, field.type)
    if (stringifyValue(field.current_value) === stringifyValue(value)) return
    setFieldState((current) => ({ ...current, [field.key_path]: 'saving' }))
    try {
      const result = await client.config.applyChange({
        change: { key_path: field.key_path, value },
        reason: 'Advanced settings update from Aurora UI',
        reauthConfirmed: true
      })
      if (!result.data.success) throw new Error(result.data.error ?? 'settings_update_failed')
      setFieldState((current) => ({ ...current, [field.key_path]: 'idle' }))
      setEdits((current) => {
        const next = { ...current }
        delete next[field.key_path]
        return next
      })
      refresh()
    } catch (error) {
      setFieldState((current) => ({ ...current, [field.key_path]: 'error' }))
      setMessage(productSettingsErrorCopy(error, 'Your change was not saved. Try again.'))
    }
  }

  return (
    <div className="flex flex-col gap-4 py-4">
      <p className="text-sm text-muted-foreground">
        Additional Aurora settings that do not have a dedicated page yet.
      </p>

      {loadState === 'error' ? (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {message ?? 'Advanced settings could not be loaded.'}
        </p>
      ) : null}
      {loadState === 'unavailable' ? (
        <p className="text-sm text-muted-foreground">Advanced settings are unavailable. {safeSettingsText(configRoute.explanation, 'Review access and try again.')}</p>
      ) : null}
      {loadState === 'loading' ? <p className="text-sm text-muted-foreground">Loading Aurora settings.</p> : null}
      {message && loadState === 'ready' ? (
        <p role="status" className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">{message}</p>
      ) : null}

      {sections.map((section) => (
        <Card key={section.id} title={section.label} actions={<Badge variant="secondary">{section.fields.length}</Badge>}>
          <div className="flex flex-col gap-4">
            {section.fields.map((field) => (
              <AdvancedFieldRow
                key={field.key_path}
                field={field}
                value={edits[field.key_path] ?? stringifyValue(field.current_value)}
                saving={fieldState[field.key_path] === 'saving'}
                onChange={(value) => setEdits((current) => ({ ...current, [field.key_path]: value }))}
                onCommit={(value) => commitField(field, value)}
              />
            ))}
          </div>
        </Card>
      ))}
      {sections.length === 0 && loadState === 'ready' ? (
        <p className="text-sm text-muted-foreground">No additional settings are available.</p>
      ) : null}

      <DataPolicyResource client={client} route={dataRoute} />
    </div>
  )
}

function AdvancedFieldRow({
  field,
  value,
  saving,
  onChange,
  onCommit
}: {
  field: ConfigFieldMetadata
  value: string
  saving: boolean
  onChange: (value: string) => void
  onCommit: (value: string) => void
}) {
  return (
    <div className="grid grid-cols-1 items-center gap-2.5 border-b border-border/60 pb-4 last:border-0 last:pb-0 sm:grid-cols-[1fr_minmax(0,300px)]">
      <div className="flex flex-col gap-1">
        <div className="text-[12.5px] font-medium">{advancedFieldTitle(field)}</div>
        <p className="text-[11.5px] text-muted-foreground">{advancedFieldDescription(field)}</p>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="secondary" className="text-[9.5px] uppercase">{sourceLayerLabel(field.source_layer)}</Badge>
          {field.restart_required ? <ToneBadge tone="warning" className="text-[9.5px] uppercase">restart</ToneBadge> : null}
        </div>
      </div>
      <Input
        value={field.secret ? '[REDACTED]' : value}
        disabled={field.secret || saving}
        className="text-[12.5px]"
        onChange={(event) => onChange(event.target.value)}
        onBlur={(event) => onCommit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            onCommit((event.target as HTMLInputElement).value)
          }
        }}
      />
    </div>
  )
}

function isExcludedFromAdvanced(keyPath: string): boolean {
  return (
    keyPath === 'services.gateway' ||
    keyPath.startsWith('services.gateway.') ||
    keyPath === 'services.orchestrator.llm' ||
    keyPath.startsWith('services.orchestrator.llm.') ||
    keyPath === 'services.tooling.mcp' ||
    keyPath.startsWith('services.tooling.mcp.') ||
    keyPath === 'services.tooling.plugins' ||
    keyPath.startsWith('services.tooling.plugins.')
  )
}

function advancedGroupId(keyPath: string): string {
  const parts = keyPath.split('.')
  if (parts[0] === 'services' && parts.length > 1) return parts[1] ?? keyPath
  return parts[0] ?? keyPath
}

function groupAdvancedFields(fields: ConfigFieldMetadata[]): AdvancedSettingsSection[] {
  const groups = new Map<string, ConfigFieldMetadata[]>()
  for (const field of fields) {
    if (isExcludedFromAdvanced(field.key_path)) continue
    const section = advancedGroupId(field.key_path)
    const current = groups.get(section) ?? []
    current.push(field)
    groups.set(section, current)
  }
  let unnamed = 0
  return Array.from(groups.entries()).map(([id, sectionFields]) => {
    const label = advancedGroupLabel(id)
    if (label) return { id, label, fields: sectionFields }
    unnamed += 1
    return { id, label: `More settings ${unnamed}`, fields: sectionFields }
  })
}

function advancedFieldTitle(field: ConfigFieldMetadata): string {
  const title = safeSettingsText(field.title, '')
  return title || 'Setting'
}

function advancedFieldDescription(field: ConfigFieldMetadata): string {
  return safeSettingsText(field.description, 'Update how Aurora behaves on this device.')
}

function advancedGroupLabel(groupId: string): string | null {
  const labels: Record<string, string> = {
    audio: 'Audio',
    db: 'Memory',
    memory: 'Memory',
    scheduler: 'Automation',
    stt: 'Voice input',
    stt_coordinator: 'Voice input',
    stt_transcription: 'Voice input',
    stt_wakeword: 'Wake word',
    tts: 'Spoken replies',
    ui: 'Appearance',
    backup: 'Backup',
    auth: 'Account access'
  }
  return labels[groupId] ?? null
}

function safeSettingsText(value: unknown, replacement: string): string {
  if (typeof value !== 'string') return replacement
  const trimmed = value.trim()
  if (!trimmed || containsInternalSettingsText(trimmed)) return replacement
  return trimmed
}

function sourceLayerLabel(value: unknown): string {
  if (value === 'user') return 'saved'
  if (value === 'env') return 'device'
  if (value === 'default') return 'default'
  return 'Aurora'
}

function containsInternalSettingsText(value: string): boolean {
  const compact = value.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const compactForbidden = [
    'proof',
    'evidence',
    'fixture',
    'fixtures',
    'assertion',
    'assertions',
    'implementation',
    'implemented',
    'implementing',
    'tested',
    'debug',
    'debugging',
    'fallback',
    'provider',
    'consumer',
    'hybrid',
    'manifest',
    'contract',
    'contracts',
    'protocol',
    'transport',
    'runtime',
    'schema',
    'migration',
    'migrations',
    'sqlite',
    'indexeddb',
    'opfs',
    'sidecar',
    'thin',
    'adminaction',
    'method',
    'keypath',
    'keypaths',
    'permission',
    'raw'
  ]
  return compactForbidden.some((term) => compact.includes(term)) ||
    /\b(?:services|gateway|auth|config|orchestrator|tts|stt|db|tooling|scheduler)\s*[._-]\s*[a-z0-9_.-]+\b/iu.test(value) ||
    /\b[A-Z][A-Za-z0-9]+\s*[._-]\s*[A-Z][A-Za-z0-9]+\b/u.test(value)
}

function productSettingsErrorCopy(problem: unknown, backup = 'Aurora settings could not be loaded. Try again.'): string {
  const copy = safeErrorCopy(problem)
  if (!copy.title) return backup
  if (!copy.action || copy.title.toLowerCase().includes(copy.action.toLowerCase())) return copy.title
  return `${copy.title}. ${copy.action}.`
}
