import { describe, expect, it } from 'vitest'
import {
  allAuroraRouteNavItems,
  auroraEmbeddedNavItems,
  auroraFeatureDefinitions,
  auroraFeatureProductCopyById,
  auroraNavSections,
  projectAuroraNavFromDefinitions,
  visibleAuroraMobileTabs,
  type AuroraFeatureDefinition,
} from '../src/nav'
import { auroraFeatureDefinitions as barrelAuroraFeatureDefinitions } from '../src'
import { projectShellRouteItems } from '../src/shell-data'
import { getAuroraSurfaceProfile } from '../src/platform-surface'

function dummyFeatureDefinition(): AuroraFeatureDefinition {
  return {
    id: 'dummy-route',
    hostHints: { mobileTab: true },
    nav: {
      section: 'configure',
      label: 'Dummy route',
      href: '/dummy-route',
      icon: auroraFeatureDefinitions[0].nav.icon,
      mobileLabel: 'Dummy',
      adminGated: false,
    },
    capabilityFeatureId: 'method:Dummy.Open',
    routePolicy: {
      capabilityModule: 'Dummy',
      capabilityMethod: 'Open',
      methodType: 'use',
      privacyClass: 'personal',
      fallbackState: 'unsupported',
      expectedTask: 'service contract',
    },
    productCopy: {
      title: 'Dummy route',
      description: 'This feature is available through Aurora.',
    },
    component: {
      exportName: 'DummyRoute',
      load: async () => ({ DummyRoute: () => null }),
    },
  }
}

describe('Aurora feature manifest projections', () => {
  it('exports the canonical feature manifest through the package barrel', () => {
    expect(barrelAuroraFeatureDefinitions).toBe(auroraFeatureDefinitions)
  })

  it('derives route, nav, copy, policy, and lazy-loader data from one manifest', () => {
    const manifestIds = auroraFeatureDefinitions.map((definition) => definition.id)
    const navIds = [
      ...auroraNavSections.flatMap((section) => section.items),
      ...auroraEmbeddedNavItems,
    ].map((item) => item.id)

    expect(navIds).toEqual(manifestIds)
    expect(allAuroraRouteNavItems.map((item) => item.id)).toEqual(manifestIds)

    for (const definition of auroraFeatureDefinitions) {
      const routeItem = allAuroraRouteNavItems.find((item) => item.id === definition.id)
      expect(routeItem, definition.id).toBeDefined()
      expect(routeItem?.href).toBe(definition.nav.href)
      expect(routeItem?.capabilityModule).toBe(definition.routePolicy.capabilityModule)
      expect(routeItem?.capabilityMethod).toBe(definition.routePolicy.capabilityMethod)
      expect(definition.capabilityFeatureId).toBe(`method:${definition.routePolicy.capabilityModule}.${definition.routePolicy.capabilityMethod}`)
      expect(auroraFeatureProductCopyById.get(definition.id)?.title).toBe(definition.productCopy.title)
      expect(definition.component.exportName.length, definition.id).toBeGreaterThan(0)
      expect(typeof definition.component.load, definition.id).toBe('function')
    }
  })

  it('adds and removes nav, shell, copy, policy, and lazy-loader data from injected manifest entries', async () => {
    const dummy = dummyFeatureDefinition()
    const withDummy = projectAuroraNavFromDefinitions([...auroraFeatureDefinitions, dummy])
    const withoutDummy = projectAuroraNavFromDefinitions(auroraFeatureDefinitions)
    const withDummyNavItems = withDummy.navSections.flatMap((section) => section.items)
    const withoutDummyNavItems = withoutDummy.navSections.flatMap((section) => section.items)
    const withDummyShellItems = projectShellRouteItems(withDummy.routeNavItems)
    const withoutDummyShellItems = projectShellRouteItems(withoutDummy.routeNavItems)
    const dummyNavItem = withDummy.routeNavItems.find((item) => item.id === 'dummy-route')

    expect(withDummyNavItems.map((item) => item.id)).toContain('dummy-route')
    expect(withDummy.routeNavItems.map((item) => item.id)).toContain('dummy-route')
    expect(withDummyShellItems.map((item) => item.id)).toContain('dummy-route')
    expect(dummyNavItem).toMatchObject({
      id: 'dummy-route',
      href: '/dummy-route',
      label: 'Dummy route',
      capabilityFeatureId: 'method:Dummy.Open',
      capabilityModule: 'Dummy',
      capabilityMethod: 'Open',
      methodType: 'use',
      privacyClass: 'personal',
      fallbackState: 'unsupported',
      expectedTask: 'service contract',
    })
    expect(withDummyShellItems.find((item) => item.id === 'dummy-route')).toEqual(dummyNavItem)
    expect(withDummy.productCopyById.get('dummy-route')).toEqual(dummy.productCopy)
    expect(withDummy.definitionById.get('dummy-route')?.routePolicy).toEqual(dummy.routePolicy)
    const dummyDefinition = withDummy.definitionById.get('dummy-route')
    expect(dummyDefinition?.component.exportName).toBe('DummyRoute')
    expect(dummyDefinition?.component.load).toBeDefined()
    await expect(dummyDefinition!.component.load()).resolves.toHaveProperty('DummyRoute')

    expect(withoutDummyNavItems.map((item) => item.id)).not.toContain('dummy-route')
    expect(withoutDummy.routeNavItems.map((item) => item.id)).not.toContain('dummy-route')
    expect(withoutDummyShellItems.map((item) => item.id)).not.toContain('dummy-route')
    expect(withoutDummy.productCopyById.has('dummy-route')).toBe(false)
    expect(withoutDummy.definitionById.has('dummy-route')).toBe(false)
  })

  it('derives mobile tabs and visibility from added and removed manifest entries', () => {
    const dummy = dummyFeatureDefinition()
    const profile = getAuroraSurfaceProfile({ nativePlatform: 'android', transportKind: 'native-mobile' })
    const added = projectAuroraNavFromDefinitions([...auroraFeatureDefinitions, dummy])
    const removed = projectAuroraNavFromDefinitions(auroraFeatureDefinitions.filter((entry) => entry.id !== 'assistant'))

    expect(added.mobileTabs.map((tab) => tab.id)).toEqual(['assistant', 'mesh', 'settings', 'dummy-route'])
    expect(visibleAuroraMobileTabs(profile, false, added.mobileTabs).map((tab) => tab.id)).toContain('dummy-route')
    expect(removed.mobileTabs.map((tab) => tab.id)).toEqual(['mesh', 'settings'])
    expect(visibleAuroraMobileTabs(profile, false, removed.mobileTabs).map((tab) => tab.id)).not.toContain('assistant')
    expect(projectAuroraNavFromDefinitions([]).mobileTabs).toEqual([])
  })

})
