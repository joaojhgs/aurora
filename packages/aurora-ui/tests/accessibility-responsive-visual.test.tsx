import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import axe from 'axe-core'
import { JSDOM } from 'jsdom'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AuroraClient,
  MockAuroraTransport,
  buildAdminOverviewManifest,
  capabilityCatalogFixture,
  cloneFixture,
  deploymentTopologyFixture,
  gatewayRegistryFixture,
  type CapabilityCatalogResponse
} from '@aurora/client'
import {
  AdminOverviewContent,
  AppShell,
  AssistantView,
  SettingsPermissionsView,
  buildShellSnapshot,
  type AuroraShellSnapshot
} from '../src/index'

type SurfaceId = 'assistant' | 'admin' | 'mobile-settings'
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

const reportsDir = join(process.cwd(), 'reports', 'accessibility')
const viewports: Viewport[] = [
  { id: 'desktop', width: 1440, height: 1024 },
  { id: 'tablet', width: 900, height: 1180 },
  { id: 'mobile', width: 390, height: 844 }
]

const expectedFingerprints: Record<SurfaceId, Record<ViewportId, string>> = {
  assistant: {
    desktop: 'd54ebaad3756',
    tablet: 'ccae17883a01',
    mobile: 'd026fac719c8'
  },
  admin: {
    desktop: 'c2cd9f61a020',
    tablet: '2c84c35781ac',
    mobile: '047630b7a59a'
  },
  'mobile-settings': {
    desktop: '451ab9ebcf87',
    tablet: '25c04aa56752',
    mobile: '9032cab56dad'
  }
}

describe('Accessibility, responsive, and visual regression suite', () => {
  it('passes axe accessibility checks for assistant, admin, and mobile settings surfaces', async () => {
    const renders = await renderQaSurfaces()
    const results = []

    for (const surface of renders) {
      const axeResult = await runAxe(surface)
      results.push({
        surface: surface.id,
        viewport: surface.viewport.id,
        violations: axeResult.violations.map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          nodes: violation.nodes.map((node) => node.target)
        }))
      })
      expect(axeResult.violations, `${surface.id}/${surface.viewport.id}`).toEqual([])
    }

    writeJsonReport('accessibility.json', {
      command: 'pnpm --filter @aurora/ui test:accessibility',
      checker: 'axe-core',
      surfaces: results,
      acceptedSkips: [
        {
          rule: 'color-contrast',
          rationale: 'axe-core cannot evaluate CSS color contrast reliably in jsdom; static CSS token checks cover focus, layout, and state selectors in this gate.'
        }
      ]
    })
  }, 30_000)

  it('keeps responsive landmarks, focus controls, and state language present at desktop, tablet, and mobile widths', async () => {
    const renders = await renderQaSurfaces()
    const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8')
    const responsiveReport = renders.map((surface) => {
      const text = textContent(surface.html)
      const shellChecks = {
        hasPrimaryNav: surface.html.includes('aria-label="Primary navigation"'),
        hasMobileNav: surface.html.includes('aria-label="Mobile navigation"'),
        hasMain: surface.html.includes('<main class="aui-content" id="content">'),
        hasStatusLanguage: /available-local|available-remote|privacy-blocked|degraded|denied|stale|unsupported/.test(text),
        hasBackendEvidence: /SDK|AuroraClient|Gateway|secrets redacted|capability/.test(text)
      }
      expect(shellChecks, `${surface.id}/${surface.viewport.id}`).toEqual({
        hasPrimaryNav: true,
        hasMobileNav: true,
        hasMain: true,
        hasStatusLanguage: true,
        hasBackendEvidence: true
      })
      expect(text, `${surface.id}/${surface.viewport.id}`).not.toMatch(/mock transport selected for production/i)
      expect(text, `${surface.id}/${surface.viewport.id}`).not.toMatch(/remote .*success without/i)
      return { surface: surface.id, viewport: surface.viewport, checks: shellChecks }
    })

    expect(css).toContain('@media (max-width: 1100px)')
    expect(css).toContain('@media (max-width: 860px)')
    expect(css).toContain('@media (max-width: 680px)')
    expect(css).toContain('.aui-mobile-tabs')
    expect(css).toContain(':focus-visible')

    writeJsonReport('responsive.json', {
      command: 'pnpm --filter @aurora/ui test:accessibility',
      viewports,
      surfaces: responsiveReport,
      cssBreakpoints: ['1100px', '860px', '680px'],
      focusEvidence: ':focus-visible'
    })
  })

  it('matches deterministic visual baselines for loading, denied, degraded, unavailable, and mobile states', async () => {
    const renders = await renderQaSurfaces()
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
    expect(stateCoverage).toContain('Start with a prompt')
    expect(stateCoverage).toContain('privacy-blocked')
    expect(stateCoverage).toContain('degraded')
    expect(stateCoverage).toContain('unsupported')
    expect(stateCoverage).toContain('AdminAction')
    expect(stateCoverage).toContain('Native unsupported')
    expect(stateCoverage).toContain('secrets redacted')

    writeJsonReport('visual-regression.json', {
      command: 'pnpm --filter @aurora/ui test:accessibility',
      baselineType: 'normalized static markup fingerprint',
      fingerprints,
      stateCoverage: ['loading', 'privacy-blocked', 'denied', 'degraded', 'unsupported', 'native unavailable']
    })

    for (const surface of renders) {
      const actual = fingerprint(surface.html)
      expect(actual, `${surface.id}/${surface.viewport.id}`).toBe(expectedFingerprints[surface.id][surface.viewport.id])
    }
  })

  it('documents security and privacy negative cases in the gate output', async () => {
    const snapshot = await buildQaSnapshot()
    const text = textContent(renderShell(snapshot, 'mobile-settings', viewports[2]!))

    expect(text).toContain('secrets redacted')
    expect(text).toContain('explicit selector failures remain hard failures')
    expect(text).toContain('AuroraClient capability evidence')
    expect(text).not.toMatch(/api[_ -]?key|password|token value|credential hash/i)

    writeJsonReport('security-privacy-negative-cases.json', {
      command: 'pnpm --filter @aurora/ui test:accessibility',
      negativeCases: [
        'no secret-like token values rendered in settings/mobile surface',
        'fallback is not presented as success for explicit selector failures',
        'native capabilities stay unsupported without SDK native manifest evidence',
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
    { id: 'mobile-settings' as const, viewport, html: renderShell(snapshot, 'mobile-settings', viewport) }
  ])
}

async function buildQaSnapshot(): Promise<AuroraShellSnapshot> {
  const transport = new MockAuroraTransport()
  transport.register('Gateway.GetCapabilityCatalog', () => qaCapabilityCatalog())
  return buildShellSnapshot(new AuroraClient({ transport }))
}

function renderShell(snapshot: AuroraShellSnapshot, surface: SurfaceId, viewport: Viewport): string {
  const client = new AuroraClient({ transport: new MockAuroraTransport() })
  const path = surface === 'assistant' ? '/assistant' : surface === 'admin' ? '/admin' : '/settings'
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
      <SettingsPermissionsView snapshot={snapshot} />
    )

  return renderToStaticMarkup(
    <div
      data-qa-surface={surface}
      data-qa-viewport={viewport.id}
      style={{ width: `${viewport.width}px`, minHeight: `${viewport.height}px` }}
    >
      <AppShell snapshot={snapshot} currentPath={path}>
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
  dom.window.eval(axe.source)
  return (dom.window as unknown as { axe: typeof axe }).axe.run(dom.window.document, {
    rules: {
      'color-contrast': { enabled: false }
    }
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
