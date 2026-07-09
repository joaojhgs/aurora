'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Plug, RefreshCw } from 'lucide-react'
import type {
  AuroraClient,
  McpSourceWizardDraft,
  PluginSourceWizardDraft,
  ToolApprovalCardModel,
  ToolCatalogResponse,
  ToolOnboardingValidationResult,
  ToolSourceDetailModel,
  ToolSourceSummaryModel,
  ToolingPageViewModel
} from '@aurora/client'
import { getToolSourceDetailFromView, normalizeToolCatalog, validateMcpSourceDraft, validatePluginSourceDraft } from '@aurora/client'
import type { RouteAvailability } from './shell-data'
import { ToneBadge, presentableSignal, riskTone, stateTone, trustTone } from './status-badges'
import { PageTabs } from './shared-components'
import { Button, Card, DataTable, FormField, Switch, useToast, type DataColumn } from './primitives'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '#components/ui/dialog'
import { Input } from '#components/ui/input'
import { Badge } from '#components/ui/badge'
import { cn } from '#lib/utils'
import {
  buildToolingPolicySummaryFromBackend,
  buildToolingSourcesFromBackend,
  sourceSectionLabel,
  type ToolingPolicySummaryModel,
  type ToolingSourceModel,
  type ToolingSourceType
} from './tooling/source-model'

export type AdminPluginsLoadState = 'loading' | 'ready' | 'empty' | 'denied' | 'degraded' | 'service-unavailable' | 'error'

export interface AvailablePluginTemplate {
  id: string
  name: string
  description: string
}

/**
 * Known installable plugin templates. There is no backend registry of
 * "plugins not yet configured" (confirmed: Tooling only exposes sources that
 * already exist via Tooling.ListToolSources/GetToolCatalog) - this mirrors the
 * prototype's `AVAILABLE_PLUGINS_INITIAL` fixture as a client-side onboarding
 * convenience list, matching precedent set for RBAC's `ROLE_TEMPLATES`.
 */
export const AVAILABLE_PLUGIN_TEMPLATES: AvailablePluginTemplate[] = [
  { id: 'plugin:notion', name: 'notion-plugin', description: 'Read and write Notion pages and databases.' },
  { id: 'plugin:home-assistant', name: 'home-assistant-plugin', description: 'Control smart-home devices via Home Assistant.' }
]

const TOOL_SOURCE_SECTION_ORDER: Array<Exclude<ToolingSourceType, 'blocked' | 'plugin'> | 'blocked'> = ['core', 'mcp', 'mesh', 'unknown', 'blocked']

export interface AdminPluginsSnapshot {
  loadState: AdminPluginsLoadState
  policy: ToolingPolicySummaryModel
  sourceSummaries: ToolSourceSummaryModel[]
  sourceDetails: Record<string, ToolSourceDetailModel | null>
  fallbackTools: ToolApprovalCardModel[]
  warnings: string[]
  error: string | null
  evidenceSource: string
}

export interface AdminPluginsViewProps {
  client: AuroraClient
  route: RouteAvailability
  initialSnapshot?: AdminPluginsSnapshot | undefined
  initialTab?: 'tools' | 'plugins' | undefined
}

const emptyPolicy: ToolingPolicySummaryModel = {
  mode: 'enforce',
  defaultBehavior: 'Loading Tooling policy through Aurora.',
  activeGrantCount: 0,
  pendingApprovalCount: 0,
  blockedCount: 0,
  sourceCount: 0,
  bypassEnabled: false,
  dryRunOnly: false,
  denyAll: false,
  lastChanged: 'not reported',
  actor: 'not reported',
  evidence: 'pending Aurora service calls'
}

const loadingPluginsSnapshot: AdminPluginsSnapshot = {
  loadState: 'loading',
  policy: emptyPolicy,
  sourceSummaries: [],
  sourceDetails: {},
  fallbackTools: [],
  warnings: [],
  error: null,
  evidenceSource: 'pending Aurora service calls'
}

export async function buildAdminPluginsSnapshot(client: AuroraClient, route?: RouteAvailability): Promise<AdminPluginsSnapshot> {
  if (route?.disabled) {
    return {
      ...loadingPluginsSnapshot,
      loadState: route.state === 'denied' ? 'denied' : route.state === 'degraded' ? 'degraded' : 'service-unavailable',
      warnings: route.blockers.map(presentableSignal),
      error: presentableSignal(route.blockers.join(', ') || route.explanation),
      evidenceSource: route.providerLabel
    }
  }

  let catalog: ToolCatalogResponse
  try {
    catalog = await client.tools.listCatalog<ToolCatalogResponse>()
  } catch (error) {
    return {
      ...loadingPluginsSnapshot,
      loadState: isPermissionError(error) ? 'denied' : 'service-unavailable',
      warnings: [errorMessage(error)],
      error: errorMessage(error),
      evidenceSource: 'Aurora request error'
    }
  }

  const view: ToolingPageViewModel = await client.tools.getPageView(catalog)
  const fallbackTools = normalizeToolCatalog(catalog, { transportKind: client.transport.kind })
  const sourceDetails = Object.fromEntries(
    view.sources.map((source) => [source.id, getToolSourceDetailFromView(view, source.id, catalog)] as const)
  )
  const loadState: AdminPluginsLoadState = view.sources.length === 0 && fallbackTools.length === 0 ? 'empty' : 'ready'

  return {
    loadState,
    policy: buildToolingPolicySummaryFromBackend(view.policy),
    sourceSummaries: view.sources,
    sourceDetails,
    fallbackTools,
    warnings: [],
    error: null,
    evidenceSource: client.transport.kind === 'mock' ? 'Local transport' : 'Aurora service response'
  }
}

export function AdminPluginsView({ client, route, initialSnapshot, initialTab }: AdminPluginsViewProps) {
  const [snapshot, setSnapshot] = useState<AdminPluginsSnapshot>(initialSnapshot ?? loadingPluginsSnapshot)
  const [activeTab, setActiveTab] = useState<'tools' | 'plugins'>(initialTab ?? 'tools')
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [mcpWizardOpen, setMcpWizardOpen] = useState(false)
  const [pluginConfigTarget, setPluginConfigTarget] = useState<AvailablePluginTemplate | null>(null)
  const { toast } = useToast()

  const refresh = async () => {
    const next = await buildAdminPluginsSnapshot(client, route)
    setSnapshot(next)
  }

  useEffect(() => {
    let cancelled = false
    if (initialSnapshot && initialSnapshot.loadState !== 'loading') return
    setSnapshot(loadingPluginsSnapshot)
    buildAdminPluginsSnapshot(client, route).then((next) => {
      if (!cancelled) setSnapshot(next)
    })
    return () => {
      cancelled = true
    }
  }, [client, route, initialSnapshot])

  const sources = useMemo(
    () => buildToolingSourcesFromBackend(snapshot.sourceSummaries, snapshot.sourceDetails, snapshot.fallbackTools),
    [snapshot.sourceSummaries, snapshot.sourceDetails, snapshot.fallbackTools]
  )
  const toolSources = useMemo(() => sources.filter((source) => source.type !== 'plugin'), [sources])
  const pluginSources = useMemo(() => sources.filter((source) => source.type === 'plugin'), [sources])
  const selectedSource = toolSources.find((source) => source.id === selectedSourceId) ?? toolSources[0] ?? null
  const availablePlugins = useMemo(
    () => AVAILABLE_PLUGIN_TEMPLATES.filter((template) => !pluginSources.some((source) => source.name === template.name)),
    [pluginSources]
  )

  async function toggleSourceActive(source: ToolingSourceModel) {
    const nextActive = source.effectiveTrust === 'blocked'
    setMutationError(null)
    try {
      await client.tools.upsertSourcePolicy({
        sourceId: source.id,
        providerPeerId: source.peerId,
        providerServiceInstanceId: source.serviceInstanceId,
        trustTier: nextActive ? 'trusted' : 'blocked',
        reason: `${nextActive ? 'Enable' : 'Disable'} ${source.name} from Tools & Plugins`
      })
      await refresh()
      toast({ tone: 'success', title: `${source.name} ${nextActive ? 'enabled' : 'disabled'}` })
    } catch (error) {
      setMutationError(errorMessage(error))
      toast({ tone: 'error', title: `Could not update ${source.name}`, detail: errorMessage(error) })
    }
  }

  async function createMcpSource(draft: McpSourceWizardDraft): Promise<ToolOnboardingValidationResult> {
    const testResult = await client.tools.testMcpSource(draft)
    if (testResult.status === 'invalid') return testResult
    return client.tools.createMcpSource(draft)
  }

  async function createPluginSource(draft: PluginSourceWizardDraft): Promise<ToolOnboardingValidationResult> {
    const testResult = await client.tools.testPluginSource(draft)
    if (testResult.status === 'invalid') return testResult
    return client.tools.createPluginSource(draft)
  }

  return (
    <div className="flex flex-col gap-4" aria-labelledby="tools-plugins-title">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <h1 id="tools-plugins-title" className="text-xl font-semibold tracking-tight">
            Tools &amp; Plugins
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Core tools, MCP servers, plugins and mesh peer tools, grouped by source with policy and approvals.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="font-normal">
            Policy: <strong className="ml-1 font-semibold">{snapshot.policy.mode}</strong>
          </Badge>
          <ToneBadge tone="warning">{snapshot.policy.pendingApprovalCount} pending</ToneBadge>
          <Button variant="primary" icon={<Plug size={14} aria-hidden />} onClick={() => setMcpWizardOpen(true)}>
            Add MCP source
          </Button>
        </div>
      </div>

      <RouteNotice snapshot={snapshot} route={route} mutationError={mutationError} />

      <PageTabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as 'tools' | 'plugins')}
        items={[
          {
            value: 'tools',
            label: 'Tools',
            content: (
              <ToolsTab
                sources={toolSources}
                selectedSource={selectedSource}
                onSelectSource={setSelectedSourceId}
                onToggleActive={toggleSourceActive}
              />
            )
          },
          {
            value: 'plugins',
            label: 'Plugins',
            content: (
              <PluginsTab
                configured={pluginSources}
                available={availablePlugins}
                onToggleActive={toggleSourceActive}
                onConfigure={setPluginConfigTarget}
              />
            )
          }
        ]}
      />

      <AddMcpSourceDialog
        open={mcpWizardOpen}
        onClose={() => setMcpWizardOpen(false)}
        onSubmit={async (draft) => {
          const result = await createMcpSource(draft)
          if (result.errors.length === 0) {
            setMcpWizardOpen(false)
            await refresh()
            toast({ tone: 'success', title: `${draft.name} registered`, detail: 'It starts quarantined until reviewed and approved.' })
          }
          return result
        }}
      />

      <PluginConfigDialog
        template={pluginConfigTarget}
        onClose={() => setPluginConfigTarget(null)}
        onSubmit={async (draft) => {
          const result = await createPluginSource(draft)
          if (result.errors.length === 0) {
            setPluginConfigTarget(null)
            await refresh()
            toast({ tone: 'success', title: `${draft.packageName} configured` })
          }
          return result
        }}
      />
    </div>
  )
}

function RouteNotice({ snapshot, route, mutationError }: { snapshot: AdminPluginsSnapshot; route: RouteAvailability; mutationError: string | null }) {
  if (snapshot.loadState === 'loading') {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
        <RefreshCw size={14} aria-hidden /> Loading Tooling catalog through Aurora.
      </p>
    )
  }
  if (route.disabled || snapshot.error) {
    return (
      <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
        <AlertTriangle size={14} aria-hidden /> {snapshot.error ?? presentableSignal(route.blockers.join(', ') || route.explanation)}
      </p>
    )
  }
  if (mutationError) {
    return (
      <p className="flex items-center gap-2 text-sm text-destructive" role="alert">
        <AlertTriangle size={14} aria-hidden /> {mutationError}
      </p>
    )
  }
  if (snapshot.loadState === 'empty') {
    return <p className="text-sm text-muted-foreground">No Tooling catalog entries were returned.</p>
  }
  return null
}

function ToolsTab({
  sources,
  selectedSource,
  onSelectSource,
  onToggleActive
}: {
  sources: ToolingSourceModel[]
  selectedSource: ToolingSourceModel | null
  onSelectSource: (id: string) => void
  onToggleActive: (source: ToolingSourceModel) => void
}) {
  const columns: DataColumn<ToolApprovalCardModel>[] = [
    {
      key: 'tool',
      header: 'Tool',
      render: (tool) => (
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-xs">{tool.name}</span>
          <span className="text-xs text-muted-foreground">{tool.description}</span>
        </div>
      )
    },
    {
      key: 'risk',
      header: 'Risk',
      render: (tool) => <ToneBadge tone={riskTone(tool.riskClass)}>{tool.riskClass}</ToneBadge>
    },
    {
      key: 'calls',
      header: 'Calls',
      render: () => <span className="text-muted-foreground">not reported</span>
    },
    {
      key: 'state',
      header: 'State',
      align: 'end',
      render: (tool) => {
        const state = toolStateLabel(tool)
        return <ToneBadge tone={stateTone(state)}>{state}</ToneBadge>
      }
    }
  ]

  return (
    <div className="flex min-h-0 flex-1 gap-4 pt-4">
      <div className="w-[280px] shrink-0 overflow-y-auto rounded-xl border border-border bg-muted/10 p-3" aria-label="Tool sources">
        {TOOL_SOURCE_SECTION_ORDER.map((type) => {
          const sectionSources = sources.filter((source) => source.type === type)
          if (sectionSources.length === 0) return null
          return (
            <div key={type} className="mb-3 last:mb-0">
              <p className="mb-1 px-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">{sourceSectionLabel(type)}</p>
              {sectionSources.map((source) => (
                <button
                  key={source.id}
                  type="button"
                  onClick={() => onSelectSource(source.id)}
                  className={cn(
                    'mb-1 w-full rounded-lg px-3 py-2 text-left transition-colors',
                    selectedSource?.id === source.id ? 'bg-muted' : 'hover:bg-muted/60'
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{source.name}</span>
                    <ToneBadge tone={trustTone(source.effectiveTrust)} className="shrink-0">
                      {source.effectiveTrust}
                    </ToneBadge>
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {sourceSectionLabel(source.type)} · {source.toolCount} tools
                  </p>
                </button>
              ))}
            </div>
          )
        })}
        {sources.length === 0 ? <p className="px-1 text-xs text-muted-foreground">No tool sources reported.</p> : null}
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto">
        {selectedSource ? (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="font-mono text-base font-semibold">{selectedSource.name}</h2>
                  <ToneBadge tone={trustTone(selectedSource.effectiveTrust)}>{selectedSource.effectiveTrust}</ToneBadge>
                </div>
                <p className="mt-1 max-w-xl text-sm text-muted-foreground">{sourceDescription(selectedSource)}</p>
              </div>
              {selectedSource.type === 'plugin' ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{selectedSource.effectiveTrust === 'blocked' ? 'Inactive' : 'Active'}</span>
                  <Switch
                    checked={selectedSource.effectiveTrust !== 'blocked'}
                    onChange={() => onToggleActive(selectedSource)}
                    label={`Toggle ${selectedSource.name} active`}
                  />
                </div>
              ) : null}
            </div>

            <div className="mt-4">
              <DataTable columns={columns} rows={selectedSource.tools} getRowKey={(tool) => tool.id} empty="No tools reported for this source." />
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No tool source is selected.</p>
        )}
      </div>
    </div>
  )
}

function PluginsTab({
  configured,
  available,
  onToggleActive,
  onConfigure
}: {
  configured: ToolingSourceModel[]
  available: AvailablePluginTemplate[]
  onToggleActive: (source: ToolingSourceModel) => void
  onConfigure: (template: AvailablePluginTemplate) => void
}) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3.5 pt-4">
      {configured.map((source) => {
        const active = source.effectiveTrust !== 'blocked'
        return (
          <Card key={source.id}>
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-medium">{source.name}</p>
              <ToneBadge tone={active ? 'success' : 'neutral'}>{active ? 'active' : 'inactive'}</ToneBadge>
            </div>
            <p className="mt-1.5 mb-3 text-xs text-muted-foreground">{sourceDescription(source)}</p>
            <Button variant="outline" className="w-full" onClick={() => onToggleActive(source)}>
              {active ? 'Disable' : 'Enable'}
            </Button>
          </Card>
        )
      })}
      {available.map((template) => (
        <Card key={template.id}>
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-medium">{template.name}</p>
          </div>
          <p className="mt-1.5 mb-3 text-xs text-muted-foreground">{template.description}</p>
          <Button variant="primary" className="w-full" onClick={() => onConfigure(template)}>
            Configure
          </Button>
        </Card>
      ))}
      {configured.length === 0 && available.length === 0 ? <p className="text-sm text-muted-foreground">No plugins reported.</p> : null}
    </div>
  )
}

function AddMcpSourceDialog({
  open,
  onClose,
  onSubmit
}: {
  open: boolean
  onClose: () => void
  onSubmit: (draft: McpSourceWizardDraft) => Promise<ToolOnboardingValidationResult>
}) {
  const [name, setName] = useState('')
  const [transport, setTransport] = useState('')
  const [commandOrUrl, setCommandOrUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<string[]>([])

  useEffect(() => {
    if (!open) {
      setName('')
      setTransport('')
      setCommandOrUrl('')
      setErrors([])
    }
  }, [open])

  function draftFromForm(): McpSourceWizardDraft {
    const trimmed = commandOrUrl.trim()
    const looksLikeUrl = /^(https?|wss?):\/\//i.test(trimmed)
    return {
      name: name.trim(),
      transport: transport.trim() || null,
      url: looksLikeUrl ? trimmed : null,
      command: looksLikeUrl ? null : trimmed || null,
      trustTier: 'untrusted',
      reason: 'Registered from Tools & Plugins wizard'
    }
  }

  const draft = draftFromForm()
  const localValidation = validateMcpSourceDraft(draft)
  const canSubmit = localValidation.errors.length === 0 && !busy

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add MCP source</DialogTitle>
          <DialogDescription>Register a new MCP server. It starts quarantined until reviewed and approved.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <FormField label="Name" htmlFor="mcp-source-name">
            <Input id="mcp-source-name" value={name} placeholder="e.g. notion-mcp" onChange={(event) => setName(event.target.value)} />
          </FormField>
          <FormField label="Transport" htmlFor="mcp-source-transport">
            <Input id="mcp-source-transport" value={transport} placeholder="stdio, sse, or streamable-http" onChange={(event) => setTransport(event.target.value)} />
          </FormField>
          <FormField label="Command or URL" htmlFor="mcp-source-command">
            <Input id="mcp-source-command" value={commandOrUrl} placeholder="npx @scope/mcp-server" onChange={(event) => setCommandOrUrl(event.target.value)} />
          </FormField>
          {errors.length > 0 ? <p className="text-sm text-destructive">{errors.join(', ')}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!canSubmit}
            onClick={async () => {
              setBusy(true)
              setErrors([])
              try {
                const result = await onSubmit(draft)
                if (result.errors.length > 0) setErrors(result.errors)
              } finally {
                setBusy(false)
              }
            }}
          >
            Test &amp; add source
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PluginConfigDialog({
  template,
  onClose,
  onSubmit
}: {
  template: AvailablePluginTemplate | null
  onClose: () => void
  onSubmit: (draft: PluginSourceWizardDraft) => Promise<ToolOnboardingValidationResult>
}) {
  const [apiKey, setApiKey] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<string[]>([])

  useEffect(() => {
    setApiKey('')
    setWorkspace('')
    setErrors([])
  }, [template?.id])

  if (!template) return null

  const draft: PluginSourceWizardDraft = {
    packageName: template.name,
    pluginId: template.id,
    trustTier: 'untrusted',
    reason: `Configured ${template.name} from Tools & Plugins`,
    metadata: { api_key: apiKey || null, workspace: workspace || null }
  }
  const localValidation = validatePluginSourceDraft(draft)
  const canSubmit = localValidation.errors.length === 0 && !busy

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configure {template.name}</DialogTitle>
          <DialogDescription>
            {template.description} Configuration is read from Config on save; the plugin then appears as an active source above.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <FormField label="API key / credential" htmlFor="plugin-config-key">
            <Input
              id="plugin-config-key"
              type="password"
              value={apiKey}
              placeholder="Stored via ConfigService, never shown again"
              onChange={(event) => setApiKey(event.target.value)}
            />
          </FormField>
          <FormField label="Scope / workspace (optional)" htmlFor="plugin-config-scope">
            <Input id="plugin-config-scope" value={workspace} placeholder="e.g. default workspace" onChange={(event) => setWorkspace(event.target.value)} />
          </FormField>
          {errors.length > 0 ? <p className="text-sm text-destructive">{errors.join(', ')}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!canSubmit}
            onClick={async () => {
              setBusy(true)
              setErrors([])
              try {
                const result = await onSubmit(draft)
                if (result.errors.length > 0) setErrors(result.errors)
              } finally {
                setBusy(false)
              }
            }}
          >
            Save &amp; activate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function sourceDescription(source: ToolingSourceModel): string {
  if (source.type === 'core') return 'Built-in tools shipped with Aurora services, always present, no install step.'
  if (source.type === 'mcp') return `MCP server (${source.transport ?? 'transport not reported'}) exposing ${source.toolCount} tool(s).`
  if (source.type === 'mesh') return `Tools announced by mesh peer ${source.peerId ?? source.name}'s Tooling catalog (cached, negotiated).`
  if (source.type === 'unknown') return 'Announced tools from an unverified provider. Quarantined until reviewed.'
  if (source.type === 'plugin') return `Plugin source exposing ${source.toolCount} tool(s).`
  return source.catalogEvidence
}

function toolStateLabel(tool: ToolApprovalCardModel): string {
  if (tool.state === 'approved' || tool.state === 'executed') return 'approved'
  if (tool.state === 'denied' || tool.state === 'replay-rejected' || tool.state === 'unavailable' || tool.state === 'failed' || tool.state === 'expired') return 'denied'
  if (tool.approvalRequired) return 'pending'
  return tool.state
}

function isPermissionError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'permission'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
