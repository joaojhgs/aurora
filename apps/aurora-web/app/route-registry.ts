import {
  auroraRoutedFeatureDefinitions,
  projectAuroraNavFromDefinitions,
  type AuroraFeatureDefinition,
  type AuroraNavItem,
} from '@aurora/ui/nav'

export interface AuroraWebRouteRegistryEntry {
  id: string
  href: string
  item: AuroraNavItem
  component: AuroraFeatureDefinition['component'] | undefined
}

export interface AuroraWebRouteRegistryProjection {
  hiddenRouteIds: readonly string[]
  routes: readonly AuroraWebRouteRegistryEntry[]
  routeIds: readonly string[]
  hrefs: readonly string[]
  routeById: ReadonlyMap<string, AuroraNavItem>
}

export function projectAuroraWebRouteRegistry(
  definitions: readonly AuroraFeatureDefinition[] = auroraRoutedFeatureDefinitions,
): AuroraWebRouteRegistryProjection {
  const navProjection = projectAuroraNavFromDefinitions(definitions)
  const hiddenRouteIds = definitions
    .filter((definition) => definition.hostHints?.webHidden === true)
    .map((definition) => definition.id)
  const hiddenRouteIdSet = new Set<string>(hiddenRouteIds)
  const routes = navProjection.routeNavItems
    .filter((item) => !hiddenRouteIdSet.has(item.id))
    .map((item) => ({
      id: item.id,
      href: item.href,
      item,
      component: navProjection.definitionById.get(item.id)?.component,
    }))
  return {
    hiddenRouteIds: Object.freeze(hiddenRouteIds),
    routes: Object.freeze(routes),
    routeIds: Object.freeze(routes.map((route) => route.id)),
    hrefs: Object.freeze(routes.map((route) => route.href)),
    routeById: new Map(routes.map((route) => [route.id, route.item])),
  }
}

const auroraWebRouteProjection = projectAuroraWebRouteRegistry()

export const auroraWebHiddenRouteIds = auroraWebRouteProjection.hiddenRouteIds

export const auroraWebRouteRegistry = auroraWebRouteProjection.routes

export const auroraWebRouteRegistryRouteIds = auroraWebRouteProjection.routeIds

export const auroraWebRouteRegistryHrefs = auroraWebRouteProjection.hrefs

export const auroraWebRouteById: ReadonlyMap<string, AuroraNavItem> = auroraWebRouteProjection.routeById
