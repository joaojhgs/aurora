import { auroraEmbeddedNavItems, auroraNavSections, type AuroraNavItem } from '@aurora/ui'

export const auroraWebHiddenRouteIds = Object.freeze([] as string[])

const hiddenRouteIds = new Set<string>(auroraWebHiddenRouteIds)

export const auroraWebRouteRegistry = Object.freeze(
  [...auroraNavSections.flatMap((section) => section.items), ...auroraEmbeddedNavItems]
    .filter((item) => !hiddenRouteIds.has(item.id))
    .map((item) => ({ id: item.id, href: item.href, item }))
)

export const auroraWebRouteRegistryRouteIds = Object.freeze(
  auroraWebRouteRegistry.map((route) => route.id)
)

export const auroraWebRouteRegistryHrefs = Object.freeze(
  auroraWebRouteRegistry.map((route) => route.href)
)

export const auroraWebRouteById: ReadonlyMap<string, AuroraNavItem> = new Map(
  auroraWebRouteRegistry.map((route) => [route.id, route.item])
)
