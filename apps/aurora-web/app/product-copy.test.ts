import { renderToStaticMarkup } from 'react-dom/server'
import { AuroraError } from '@aurora/client'
import { describe, expect, it, vi } from 'vitest'
import {
  PRODUCT_ROUTE_COPY,
  productActionErrorText,
  productBundleItemAvailable,
  productQueueStatusState,
  productQueueStatusText,
  projectProductRouteCopy,
} from './product-copy'
import {
  allAuroraRouteNavItems,
  auroraFeatureDefinitions,
  auroraFeatureProductCopyById,
  projectAuroraNavFromDefinitions,
  type AuroraFeatureDefinition,
} from '@aurora/ui/nav'
import { AuroraRoutePage } from './page-content'


function dummyCopyFeatureDefinition(): AuroraFeatureDefinition {
  return {
    id: 'dummy-copy-route',
    nav: {
      section: 'configure',
      label: 'Dummy copy route',
      href: '/dummy-copy-route',
      icon: auroraFeatureDefinitions[0].nav.icon,
      mobileLabel: 'Dummy',
      adminGated: false,
    },
    capabilityFeatureId: 'method:Dummy.Copy',
    routePolicy: {
      capabilityModule: 'Dummy',
      capabilityMethod: 'Copy',
      methodType: 'use',
      privacyClass: 'personal',
      fallbackState: 'unsupported',
      expectedTask: 'service contract',
    },
    productCopy: {
      title: 'Dummy feature title',
      description: 'Dummy feature description.',
    },
    component: {
      exportName: 'DummyCopyRoute',
      load: async () => ({ DummyCopyRoute: () => null }),
    },
  }
}

vi.mock('./shell-state', () => ({
  getShellSnapshot: vi.fn(async () => ({
    routes: [],
    evidenceSource: 'test snapshot',
  })),
}))

describe('web product copy helpers', () => {
  it('derives route copy for every manifest route', () => {
    expect(Object.keys(PRODUCT_ROUTE_COPY)).toEqual(allAuroraRouteNavItems.map((item) => item.id))
    for (const item of allAuroraRouteNavItems) {
      expect(PRODUCT_ROUTE_COPY[item.id]).toEqual(auroraFeatureProductCopyById.get(item.id as never))
    }
    expect(PRODUCT_ROUTE_COPY.assistant?.title).toBe('Assistant')
    expect(PRODUCT_ROUTE_COPY['spoken-replies']?.description).toBe('This feature is available through Aurora.')
    expect(Object.values(PRODUCT_ROUTE_COPY).map((copy) => copy.description).join(' ')).not.toContain('service contract')
  })

  it('adds and removes product copy from injected manifest entries without a manual copy table', () => {
    const dummy = dummyCopyFeatureDefinition()
    const withDummyProjection = projectAuroraNavFromDefinitions([...auroraFeatureDefinitions, dummy])
    const withoutDummyProjection = projectAuroraNavFromDefinitions(auroraFeatureDefinitions)
    const withDummyCopy = projectProductRouteCopy(
      withDummyProjection.routeNavItems,
      withDummyProjection.productCopyById,
    )
    const withoutDummyCopy = projectProductRouteCopy(
      withoutDummyProjection.routeNavItems,
      withoutDummyProjection.productCopyById,
    )

    expect(withDummyCopy['dummy-copy-route']).toEqual({
      title: 'Dummy feature title',
      description: 'Dummy feature description.',
    })
    expect(Object.keys(withDummyCopy)).toContain('dummy-copy-route')
    expect(withoutDummyCopy['dummy-copy-route']).toBeUndefined()
    expect(Object.keys(withoutDummyCopy)).not.toContain('dummy-copy-route')
  })

  it('renders fallback route pages from manifest-derived product copy', async () => {
    const meshMarkup = renderToStaticMarkup(await AuroraRoutePage({ routeId: 'mesh' }))
    const memoryMarkup = renderToStaticMarkup(await AuroraRoutePage({ routeId: 'memory' }))

    expect(meshMarkup).toContain(PRODUCT_ROUTE_COPY.mesh.title)
    expect(meshMarkup).toContain(PRODUCT_ROUTE_COPY.mesh.description)
    expect(memoryMarkup).toContain(PRODUCT_ROUTE_COPY.memory.title.replace('&', '&amp;'))
    expect(memoryMarkup).toContain(PRODUCT_ROUTE_COPY.memory.description)
    expect(meshMarkup).not.toContain('Trusted device actions appear')
    expect(memoryMarkup).not.toContain('Memory is not available from this connection yet')
  })

  it('classifies exact queue status codes without substring availability matches', () => {
    expect(productQueueStatusText('healthy')).toBe('Available')
    expect(productQueueStatusText('HEALTHY')).toBe('Available')
    expect(productQueueStatusText('degraded')).toBe('Needs attention')
    expect(productQueueStatusText('unavailable')).toBe('Unavailable')
    expect(productQueueStatusText('UN-AVAILABLE')).toBe('Unavailable')
    expect(productQueueStatusText('un.available')).toBe('Unavailable')
    expect(productQueueStatusText('not_available')).toBe('Unavailable')
    expect(productQueueStatusState('un_available')).toBe('unsupported')
  })

  it('classifies bundle item statuses with closed codes and fails unknown values closed', () => {
    expect(productBundleItemAvailable('ok')).toBe(true)
    expect(productBundleItemAvailable('OK')).toBe(true)
    expect(productBundleItemAvailable('available')).toBe(true)
    expect(productBundleItemAvailable('unavailable')).toBe(false)
    expect(productBundleItemAvailable('UN.AVAILABLE')).toBe(false)
    expect(productBundleItemAvailable('metadata_only')).toBe(false)
    expect(productBundleItemAvailable('connected and available')).toBe(false)
  })

  it('preserves only validated non-sensitive references in safe error copy', () => {
    expect(productActionErrorText(new AuroraError({
      code: 'transport_loss',
      message: 'Gateway.GetSupportBundle failed /home/alice token',
      correlationId: 'REQ_123'
    }))).toBe('This action is unavailable right now. Check the affected device, then try again. Reference REQ_123.')

    expect(productActionErrorText(new AuroraError({
      code: 'transport_loss',
      message: 'Gateway.GetSupportBundle failed /home/alice token',
      correlationId: 'room-password:/home/alice'
    }))).toBe('This action is unavailable right now. Check the affected device, then try again.')
  })
})
