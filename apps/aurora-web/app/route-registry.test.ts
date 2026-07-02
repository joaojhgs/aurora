import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auroraNavSections } from '@aurora/ui'
import { describe, expect, it } from 'vitest'
import {
  auroraWebHiddenRouteIds,
  auroraWebRouteRegistry,
  auroraWebRouteRegistryHrefs,
  auroraWebRouteRegistryRouteIds,
} from './route-registry'

const appDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(appDir, '../../..')
const navItems = auroraNavSections.flatMap((section) => section.items)

function pageFileForHref(href: string): string {
  if (href === '/') return join(appDir, 'page.tsx')
  return join(appDir, href.replace(/^\//, ''), 'page.tsx')
}

function tauriRouteIdsFromSource(): string[] {
  const source = readFileSync(join(repoRoot, 'apps/aurora-tauri/src/tauri-app.tsx'), 'utf8')
  const match = source.match(/const tauriRouteIds = \[([\s\S]*?)\] as const/)
  if (!match) throw new Error('Unable to locate tauriRouteIds tuple in apps/aurora-tauri/src/tauri-app.tsx')
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
})
