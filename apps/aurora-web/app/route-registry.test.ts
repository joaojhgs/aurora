import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auroraEmbeddedNavItems, auroraNavSections } from '@aurora/ui'
import { getProductionRouteOracle } from '@aurora/ui/testing'
import { describe, expect, it } from 'vitest'
import {
  auroraWebHiddenRouteIds,
  auroraWebRouteRegistry,
  auroraWebRouteRegistryHrefs,
  auroraWebRouteRegistryRouteIds,
} from './route-registry'

const appDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(appDir, '../../..')
const navItems = [...auroraNavSections.flatMap((section) => section.items), ...auroraEmbeddedNavItems]

const PLACEHOLDER_COPY_MARKERS = [
  'A full product page still needs to be mounted',
  'full product page still needs to be mounted',
  'This Tauri route is now navigable',
  'rendering the assistant diagnostics on the wrong page',
  'TauriRoutePlaceholder',
  'ata-placeholder-panel',
  'debug-dashboard',
  'route is unregistered',
] as const

const WEB_ROUTE_PRODUCTION_MOUNTS: Record<string, readonly string[]> = {
  assistant: ['AssistantClientPage'],
  memory: ['MemoryClientPage'],
  tools: ['ToolApprovalClientPage'],
  mesh: ['MeshPeersClientPage'],
  admin: ['AdminOverviewClientPage'],
  services: ['AdminServicesClientPage'],
  access: ['AdminAccessClientPage'],
  tokens: ['AdminTokensClientPage'],
  devices: ['AdminDevicesClientPage'],
  config: ['ConfigClientPage'],
  contracts: ['AdminContractsClientPage'],
  plugins: ['PluginsClientPage'],
  pairing: ['PairingQueueClientPage'],
  backups: ['BackupClientPage'],
  scheduler: ['SchedulerClientPage'],
  audit: ['AdminAuditClientPage'],
  models: ['ModelsClientPage'],
  diagnostics: ['Health Checks', 'DiagnosticsExportIsland'],
  onboarding: ['OnboardingClientPage'],
  settings: ['SettingsClientPage'],
  data: ['DataPolicyClientPage'],
  native: ['NativeSettingsClientPage'],
  'spoken-replies': ['SpokenRepliesClientPage'],
}

function pageFileForHref(href: string): string {
  if (href === '/') return join(appDir, 'page.tsx')
  return join(appDir, href.replace(/^\//, ''), 'page.tsx')
}

function productionMountSourceForRoute(route: { id: string; href: string }): string {
  const pageSource = readFileSync(pageFileForHref(route.href), 'utf8')
  if (route.id !== 'diagnostics') return pageSource
  return `${pageSource}\n${readFileSync(join(appDir, 'diagnostics', 'diagnostics-client.tsx'), 'utf8')}`
}

function tauriRouteIdsFromSource(): string[] {
  const source = readFileSync(join(repoRoot, 'apps/aurora-tauri/src/tauri-app.tsx'), 'utf8')
  const tupleIds = (name: string): string[] => {
    const match = source.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\] as const`))
    if (!match) return []
    return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((candidate) => candidate[1])
  }
  const routeIds = [...tupleIds('primaryTauriRouteIds'), ...tupleIds('embeddedTauriRouteIds')]
  if (routeIds.length > 0) return routeIds

  const match = source.match(/const tauriRouteIds = \[([\s\S]*?)\] as const/)
  if (!match) throw new Error('Unable to locate tauri route id tuples in apps/aurora-tauri/src/tauri-app.tsx')
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((candidate) => candidate[1])
}

describe('Aurora web route registry', () => {
  it('stays in parity with the shared nav contract and Tauri route ids', () => {
    const hidden = new Set(auroraWebHiddenRouteIds)
    const expectedRouteIds = navItems.filter((item) => !hidden.has(item.id)).map((item) => item.id)
    const expectedHrefs = navItems.filter((item) => !hidden.has(item.id)).map((item) => item.href)

    expect(auroraWebHiddenRouteIds).toEqual([])
    expect(auroraWebRouteRegistryRouteIds).toEqual(expectedRouteIds)
    expect(auroraWebRouteRegistryHrefs).toEqual(expectedHrefs)
    expect(new Set(tauriRouteIdsFromSource())).toEqual(new Set(navItems.map((item) => item.id)))
    expect(new Set(auroraWebRouteRegistryRouteIds)).toEqual(new Set(tauriRouteIdsFromSource()))
  })

  it('has a Next page file for every visible shared nav route', () => {
    for (const route of auroraWebRouteRegistry) {
      expect(existsSync(pageFileForHref(route.href)), `${route.id} ${route.href}`).toBe(true)
    }
  })


  it('source-crawls all 23 web routes with production mounts and route oracle evidence', () => {
    expect(auroraWebRouteRegistry).toHaveLength(23)
    expect(new Set(Object.keys(WEB_ROUTE_PRODUCTION_MOUNTS))).toEqual(
      new Set(auroraWebRouteRegistryRouteIds),
    )

    for (const route of auroraWebRouteRegistry) {
      const source = productionMountSourceForRoute(route)
      const oracle = getProductionRouteOracle(route.id)

      expect(oracle, `${route.id} should have a production route oracle`).toBeDefined()
      expect(oracle?.renderedLandmarks.length, `${route.id} rendered landmarks`).toBeGreaterThan(0)
      expect(oracle?.routeSpecificControls.length, `${route.id} route-specific controls`).toBeGreaterThan(0)
      for (const expectedMount of WEB_ROUTE_PRODUCTION_MOUNTS[route.id] ?? []) {
        expect(source, `${route.id} ${route.href} production mount ${expectedMount}`).toContain(expectedMount)
      }
      for (const marker of PLACEHOLDER_COPY_MARKERS) {
        expect(source, `${route.id} ${route.href} placeholder marker ${marker}`).not.toContain(marker)
      }
    }
  })

  it('mounts production resources for web routes that previously used placeholder contract pages', () => {
    const productionRoutes = [
      { href: '/admin/services', expected: 'AdminServicesClientPage' },
      { href: '/admin/contracts', expected: 'AdminContractsClientPage' },
      { href: '/admin/tokens', expected: 'AdminTokensClientPage' },
      { href: '/memory/policy', expected: 'DataPolicyClientPage' },
      { href: '/settings/native', expected: 'NativeSettingsClientPage' },
      { href: '/admin/voice', expected: 'SpokenRepliesClientPage' }
    ]
    const forbidden = /will use|will render|follow-up task|downstream UI task wires|placeholder|debug-dashboard|route dump/i

    for (const route of productionRoutes) {
      const source = readFileSync(pageFileForHref(route.href), 'utf8')
      expect(source, route.href).toContain(route.expected)
      expect(source, route.href).not.toMatch(forbidden)
    }

    const fallbackSource = readFileSync(join(appDir, 'page-content.tsx'), 'utf8')
    expect(fallbackSource).not.toMatch(/will use|will render|follow-up task|downstream UI task wires/i)
    expect(fallbackSource).toContain('Actions remain unavailable')
  })

  it('keeps /settings on the This-device page and /settings/native on the device-access surface', () => {
    const clientSource = readFileSync(join(appDir, 'settings', 'settings-client.tsx'), 'utf8')
    expect(clientSource).toContain('SettingsView')
    expect(clientSource).not.toContain('initialTab')
    expect(clientSource).not.toContain("'advanced'")

    const nativePage = readFileSync(join(appDir, 'settings', 'native', 'page.tsx'), 'utf8')
    const nativeClient = readFileSync(join(appDir, 'settings', 'native', 'native-settings-client.tsx'), 'utf8')
    expect(nativePage).toContain('NativeSettingsClientPage')
    expect(nativeClient).toContain('SettingsNativeView')
    expect(nativeClient).not.toContain('SettingsView')
  })
})
