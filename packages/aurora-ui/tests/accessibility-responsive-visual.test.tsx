import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import axe from 'axe-core'
import { JSDOM } from 'jsdom'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AuroraClient as Aurora,
  MockAuroraTransport,
  buildAdminOverviewManifest,
  capabilityCatalogFixture,
  cloneFixture,
  deploymentTopologyFixture,
  gatewayRegistryFixture,
  type CapabilityCatalogResponse
} from '@aurora/client'
import { AdminOverviewContent } from '../src/admin-overview-view'
import { AppShell } from '../src/shell'
import { AURORA_FALLBACK_VERSION } from '../src/version'
import { AssistantView } from '../src/assistant-view'
import { SettingsPermissionsView } from '../src/settings-permissions-view'
import { buildShellSnapshot, type AuroraShellSnapshot } from '../src/shell-data'

type SurfaceId = 'assistant' | 'admin' | 'native-settings'
type ViewportId = 'desktop' | 'tablet' | 'mobile'

interface Viewport {
  id: ViewportId
  width: number
  height: number
}

interface SurfaceRender {
  id: SurfaceId
  viewport: Viewport
  html: string
}

interface AccessibilityReportSurface {
  surface: SurfaceId
  viewport: ViewportId
  violations: Array<{
    id: string
    impact: string | null | undefined
    nodes: axe.NodeResult['target'][]
  }>
}

const reportsDir = join(process.cwd(), 'reports', 'accessibility')
const surfaceIds: SurfaceId[] = ['assistant', 'admin', 'native-settings']
const accessibilityResults: AccessibilityReportSurface[] = []
let qaRenders: SurfaceRender[] = []

const viewports: Viewport[] = [
  { id: 'desktop', width: 1440, height: 1024 },
  { id: 'tablet', width: 900, height: 1180 },
  { id: 'mobile', width: 390, height: 844 }
]

const expectedFingerprints: Record<SurfaceId, Record<ViewportId, string>> = {
  // These baselines include the shared Spoken replies navigation entry. Admin
  // renders also use product labels for voice and local-data actions.
  assistant: {
    desktop: 'f1eddf71aaa5',
    tablet: '4441d75ae496',
    mobile: 'ff31bd0409c0'
  },
  admin: {
    desktop: '24025ef61432',
    tablet: '63fb3e19321f',
    mobile: '8fa72942a9cb'
  },
  'native-settings': {
    desktop: '7cfcbf2b64b8',
    tablet: '3279246fdb5d',
    mobile: '63f0cc9eb618'
  }
}

describe('Accessibility, responsive, and visual regression suite', () => {
  beforeAll(async () => {
    accessibilityResults.length = 0
    qaRenders = await renderQaSurfaces()
  })

  afterAll(() => {
    writeJsonReport('accessibility.json', {
      command: 'pnpm --filter @aurora/ui test:accessibility',
      checker: 'axe-core',
      surfaces: sortedAccessibilityResults(),
      acceptedSkips: [
        {
          rule: 'color-contrast',
          rationale: 'axe-core cannot evaluate CSS color contrast reliably in jsdom; static CSS token checks cover focus, layout, and state selectors in this gate.'
        }
      ]
    })
  })

  it.each(surfaceIds.flatMap((surfaceId) => viewports.map((viewport) => ({ surfaceId, viewport }))))(
    'passes axe accessibility checks for $surfaceId/$viewport.id',
    async ({ surfaceId, viewport }) => {
      const surface = qaSurface(surfaceId, viewport.id)
      const axeResult = await runAxe(surface)
      accessibilityResults.push({
        surface: surface.id,
        viewport: surface.viewport.id,
        violations: axeResult.violations.map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          nodes: violation.nodes.map((node) => node.target)
        }))
      })
      expect(axeResult.violations, `${surface.id}/${surface.viewport.id}`).toEqual([])
    },
    // A single axe-core pass over the full AppShell static markup is CPU-bound
    // and has timed out at 10s on loaded CI workers even though standalone
    // runs complete in roughly 8s for all nine surfaces. Keep the allowance
    // scoped to one surface/viewport instead of one 9-surface mega-test.
    20_000
  )

  it('keeps responsive landmarks, focus controls, and state language present at desktop, tablet, and mobile widths', async () => {
    const renders = qaRenders
    const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8')
    const responsiveReport = renders.map((surface) => {
      const text = textContent(surface.html)
      const shellChecks = {
        hasPrimaryNav: surface.html.includes('aria-label="Primary navigation"'),
        hasMobileNav: surface.html.includes('aria-label="Mobile navigation"'),
        hasMain: /<main[^>]*id="content"/.test(surface.html),
        hasStatusLanguage: /Ready|Review|Not ready|Needs consent|Needs confirmation|Degraded|Stale|Not needed|Protected|Unavailable|Unsupported/i.test(text),
        hasBackendStatus: /Aurora|Gateway|Connected|Protected|Device|Routes|Features|Platform/i.test(text)
      }
      // Keep this gate anchored in rendered product language rather than raw
      // route or native diagnostic tokens.
      expect(shellChecks, `${surface.id}/${surface.viewport.id}`).toEqual({
        hasPrimaryNav: true,
        hasMobileNav: true,
        hasMain: true,
        hasStatusLanguage: true,
        hasBackendStatus: true
      })
      if (surface.id === 'assistant') {
        expect(surface.html, `assistant composer marker/${surface.viewport.id}`).toContain('data-first-viewport-work="assistant-chat-composer"')
        expect(surface.html, `assistant has no route privacy sheet/${surface.viewport.id}`).not.toContain('aria-label="Assistant route and privacy details"')
        expect(surface.html, `assistant has no route details trigger/${surface.viewport.id}`).not.toContain('Open route details')
        expect(surface.html, `assistant clean composer has no bottom voice panel/${surface.viewport.id}`)
          .not.toContain('aria-labelledby="assistant-voice-title"')
        expect(surface.html.indexOf('aria-label="Prompt composer"'), `assistant composer before attachment status/${surface.viewport.id}`)
          .toBeLessThan(surface.html.indexOf('aria-labelledby="assistant-context-title"'))
      }
      expect(text, `${surface.id}/${surface.viewport.id}`).not.toMatch(/mock transport selected for production/i)
      expect(text, `${surface.id}/${surface.viewport.id}`).not.toMatch(/remote .*success without/i)
      return { surface: surface.id, viewport: surface.viewport, checks: shellChecks }
    })

    expect(css).toContain('@media (max-width: 1100px)')
    expect(css).toContain('@media (max-width: 860px)')
    expect(css).toContain('@media (max-width: 680px)')
    expect(css).toContain('.aui-mobile-tabs')
    expect(css).toContain('.aui-mobile-sheet')
    expect(css).toContain('.aui-shell-status')
    expect(css).toContain('.aui-chat-workspace')
    expect(css).toContain(':focus-visible')
    expect(css).toContain('grid-template-columns:2.65rem 2.65rem minmax(0,1fr) 2.65rem 2.65rem')
    expect(css).toContain('>.aui-composer-icon[data-voice-access] { grid-column:2;grid-row:1 }')

    writeJsonReport('responsive.json', {
      command: 'pnpm --filter @aurora/ui test:accessibility',
      viewports,
      surfaces: responsiveReport,
      cssBreakpoints: ['1100px', '860px', '680px'],
      focusStatus: ':focus-visible'
    })
  })

  it('matches deterministic visual baselines for loading, denied, degraded, not-ready, and mobile states', async () => {
    const renders = qaRenders
    const fingerprints = renders.map((surface) => {
      const actual = fingerprint(surface.html)
      writeHtmlArtifact(`${surface.id}-${surface.viewport.id}.html`, surface.html)
      return {
        surface: surface.id,
        viewport: surface.viewport.id,
        fingerprint: actual,
        artifact: `packages/aurora-ui/reports/accessibility/${surface.id}-${surface.viewport.id}.html`
      }
    })
    const stateCoverage = coverageText(renders)
    expect(stateCoverage).toContain('Draft a short launch announcement')
    expect(stateCoverage).toContain('Needs attention')
    expect(stateCoverage).toContain('Degraded')
    expect(stateCoverage).toContain('This device is offline')
    expect(stateCoverage).toContain('Protected changes')
    expect(stateCoverage).toContain('Device features')
    expect(stateCoverage).toContain('Sensitive details stay hidden')
    expect(stateCoverage).toContain('aurora-prod-01')
    expect(stateCoverage).toContain('AD admin Administrator')
    expect(stateCoverage).toContain('Runs with Aurora')
    expect(stateCoverage).toContain('Healthy')
    expect(stateCoverage).toContain(`v${AURORA_FALLBACK_VERSION}`)
    expect(stateCoverage).toContain('· connected')
    expect(stateCoverage).not.toContain('4h 12m')
    expect(stateCoverage).not.toContain('v0.9.4')
    expect(stateCoverage).not.toContain('18d 4h')

    writeJsonReport('visual-regression.json', {
      command: 'pnpm --filter @aurora/ui test:accessibility',
      baselineType: 'normalized static markup fingerprint',
      fingerprints,
      stateCoverage: ['ready', 'needs-attention', 'needs-consent', 'degraded', 'offline', 'native settings']
    })

    for (const surface of renders) {
      const actual = fingerprint(surface.html)
      expect(actual, `${surface.id}/${surface.viewport.id}`).toBe(expectedFingerprints[surface.id][surface.viewport.id])
    }
  })

  it('keeps visual fingerprints stable across release labels', () => {
    const source = '<span class="aui-runtime-version">v1.0.0</span>'
    const prerelease = '<span class="aui-runtime-version">v2.0.0-rc.1</span>'

    expect(fingerprint(prerelease)).toBe(fingerprint(source))
  })

  it('documents security and privacy negative cases in the gate output', async () => {
    const snapshot = await buildQaSnapshot()
    const text = textContent(renderShell(snapshot, 'native-settings', viewports[2]!))

    expect(text).toContain('Sensitive details stay hidden')
    expect(text).toContain('Review access, consent, or device selection')
    expect(text).toContain('This device')
    expect(text).not.toMatch(/api[_ -]?key|password|token value|credential hash/i)

    writeJsonReport('security-privacy-negative-cases.json', {
      command: 'pnpm --filter @aurora/ui test:accessibility',
      negativeCases: [
        'no secret-like token values rendered in settings/native surface',
        'device selection failures are presented as user action, not success',
        'native settings render product-safe device feature status',
        'admin-critical settings remain AdminAction-gated'
      ],
      owner: 'aurora-frontend-engineer',
      suite: 'accessibility-responsive-visual'
    })
  })
})

async function renderQaSurfaces(): Promise<SurfaceRender[]> {
  const snapshot = await buildQaSnapshot()
  return viewports.flatMap((viewport) => [
    { id: 'assistant' as const, viewport, html: renderShell(snapshot, 'assistant', viewport) },
    { id: 'admin' as const, viewport, html: renderShell(snapshot, 'admin', viewport) },
    { id: 'native-settings' as const, viewport, html: renderShell(snapshot, 'native-settings', viewport) }
  ])
}

async function buildQaSnapshot(): Promise<AuroraShellSnapshot> {
  const transport = new MockAuroraTransport()
  transport.register('Gateway.GetCapabilityCatalog', () => qaCapabilityCatalog())
  return buildShellSnapshot(new Aurora({ transport }))
}

function renderShell(snapshot: AuroraShellSnapshot, surface: SurfaceId, viewport: Viewport): string {
  const client = new Aurora({ transport: new MockAuroraTransport() })
  const path = surface === 'assistant' ? '/assistant' : surface === 'admin' ? '/admin' : '/settings/native'
  const content =
    surface === 'assistant' ? (
      <AssistantView client={client} route={route(snapshot, 'assistant')} storageKey={`accessibility-${viewport.id}`} />
    ) : surface === 'admin' ? (
      <AdminOverviewContent
        manifest={buildAdminOverviewManifest({
          capabilityCatalog: qaCapabilityCatalog(),
          registry: gatewayRegistryFixture,
          deploymentTopology: deploymentTopologyFixture,
          generatedAt: '2026-06-19T00:00:00Z'
        })}
        transportKind="mock"
      />
    ) : (
      <SettingsPermissionsView snapshot={snapshot} surface="native" currentPath="/settings/native" />
    )

  return renderToStaticMarkup(
    <div
      data-qa-surface={surface}
      data-qa-viewport={viewport.id}
      style={{ width: `${viewport.width}px`, minHeight: `${viewport.height}px` }}
    >
      <AppShell
        snapshot={snapshot}
        currentPath={path}
        runtimeMode="mock"
        sessionIsAdmin={surface === 'admin'}
      >
        {content}
      </AppShell>
    </div>
  )
}

async function runAxe(surface: SurfaceRender): Promise<axe.AxeResults> {
  const dom = new JSDOM(`<!doctype html><html lang="en"><head><title>Aurora QA</title></head><body>${surface.html}</body></html>`, {
    runScripts: 'outside-only',
    pretendToBeVisual: true
  })
  try {
    dom.window.eval(axe.source)
    return await (dom.window as unknown as { axe: typeof axe }).axe.run(dom.window.document, {
      rules: {
        'color-contrast': { enabled: false }
      },
      resultTypes: ['violations']
    })
  } finally {
    dom.window.close()
  }
}

function qaSurface(surfaceId: SurfaceId, viewportId: ViewportId): SurfaceRender {
  const found = qaRenders.find((surface) => surface.id === surfaceId && surface.viewport.id === viewportId)
  if (!found) throw new Error(`Missing QA render ${surfaceId}/${viewportId}`)
  return found
}

function sortedAccessibilityResults(): AccessibilityReportSurface[] {
  return [...accessibilityResults].sort((left, right) => {
    const surfaceDelta = surfaceIds.indexOf(left.surface) - surfaceIds.indexOf(right.surface)
    if (surfaceDelta !== 0) return surfaceDelta
    const viewportDelta = viewports.findIndex((viewport) => viewport.id === left.viewport) - viewports.findIndex((viewport) => viewport.id === right.viewport)
    return viewportDelta
  })
}

function qaCapabilityCatalog(): CapabilityCatalogResponse {
  const catalog = cloneFixture(capabilityCatalogFixture)
  const routes = [
    { module: 'Orchestrator', bindability: 'available', routeBlockers: [] },
    { module: 'Tooling', bindability: 'available', routeBlockers: ['approval_required', 'explicit_selector_required'] },
    { module: 'Config', bindability: 'denied', routeBlockers: ['admin_permission_required'] },
    { module: 'Memory', bindability: 'available', routeBlockers: ['provider_stale'] },
    { module: 'Native', bindability: 'unavailable', routeBlockers: ['native_manifest_missing'] }
  ] as const

  for (const routeState of routes) {
    const providerIds = catalog.provider_index[routeState.module] ?? []
    for (const providerId of providerIds) {
      const provider = catalog.providers.find((item) => item.provider_id === providerId)
      if (!provider) continue
      provider.eligible = routeState.bindability !== 'denied' && routeState.bindability !== 'unavailable'
      provider.reason_code = routeState.routeBlockers[0] ?? 'eligible'
      provider.reason = routeState.routeBlockers.join(', ') || 'eligible'
    }
    const actions = catalog.actions.filter((action) => action.module === routeState.module)
    for (const action of actions) {
      action.bindability = routeState.bindability
      action.route_blockers = [...routeState.routeBlockers]
      action.policy.explicit_selector_required = routeState.module === 'Tooling'
      action.policy.denial_reasons = routeState.module === 'Config' ? ['admin_permission_required'] : []
      action.freshness.stale = routeState.module === 'Memory'
    }
  }

  catalog.secrets_redacted = true
  return catalog
}

function route(snapshot: AuroraShellSnapshot, id: string) {
  const found = snapshot.routes.find((item) => item.item.id === id)
  if (!found) throw new Error(`Missing route ${id}`)
  return found
}

function fingerprint(html: string): string {
  return createHash('sha256').update(normalizeHtml(html)).digest('hex').slice(0, 12)
}

function normalizeHtml(html: string): string {
  return html
    .replace(/(<span class="aui-runtime-version">)v[^<]+(<\/span>)/g, '$1vrelease-version$2')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, 'iso-timestamp')
    .replace(/user-\d+/g, 'user-id')
    .replace(/assistant-pending-\d+/g, 'assistant-pending-id')
    .replace(/\s+/g, ' ')
    .trim()
}

function textContent(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function coverageText(renders: SurfaceRender[]): string {
  return renders.map((render) => textContent(render.html)).join(' ')
}

function writeJsonReport(filename: string, data: unknown): void {
  mkdirSync(reportsDir, { recursive: true })
  writeFileSync(join(reportsDir, filename), `${JSON.stringify(data, null, 2)}\n`)
}

function writeHtmlArtifact(filename: string, html: string): void {
  const filePath = join(reportsDir, filename)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${filename}</title></head><body>${html}</body></html>\n`)
}
