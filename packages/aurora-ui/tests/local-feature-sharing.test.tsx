import { describe, expect, it } from 'vitest'

import {
  localFeatureIdsForServicePermissions,
  localServicePermissionCatalog,
  localShareableServiceScopes,
  selectedLocalServicePermissions,
  type LocalFeatureSharingSnapshot,
} from '../src/local-feature-sharing'

describe('local service sharing projection', () => {
  it('groups only available features by the service metadata emitted by their host', () => {
    const snapshot = localSharingSnapshot()

    expect(localShareableServiceScopes(snapshot)).toEqual([
      {
        id: 'orchestrator',
        permissionId: 'Orchestrator.use',
        label: 'Assistant',
        description: 'Answer requests on this device.',
        featureIds: ['Local.Orchestrator'],
      },
      {
        id: 'tooling',
        permissionId: 'Tooling.use',
        label: 'Tools',
        description: 'Use tools this device makes available.',
        featureIds: ['Native.GetDeviceStatus'],
      },
    ])
  })

  it('maps service-level choices to the available local sub-features', () => {
    const snapshot = localSharingSnapshot()
    const scopes = localShareableServiceScopes(snapshot)

    expect(selectedLocalServicePermissions(snapshot, scopes)).toEqual([
      'Orchestrator.use',
    ])
    expect(localFeatureIdsForServicePermissions(scopes, ['Tooling.use'])).toEqual([
      'Native.GetDeviceStatus',
    ])
  })

  it('builds the shared permission table without exposing local sub-feature ids', () => {
    const catalog = localServicePermissionCatalog(
      localShareableServiceScopes(localSharingSnapshot()),
    )

    expect(catalog.map((entry) => entry.label)).toEqual(['Assistant', 'Tools'])
    expect(catalog.map((entry) => entry.id)).toEqual([
      'Orchestrator.use',
      'Tooling.use',
    ])
    expect(JSON.stringify(catalog)).not.toContain('Native.GetDeviceStatus')
    expect(JSON.stringify(catalog)).not.toContain('Native.Unavailable')
  })
})

function localSharingSnapshot(): LocalFeatureSharingSnapshot {
  const toolingService = {
    serviceId: 'tooling',
    servicePermissionId: 'Tooling.use',
    serviceLabel: 'Tools',
    serviceDescription: 'Use tools this device makes available.',
  } as const
  return {
    features: [
      {
        ...toolingService,
        id: 'Native.GetDeviceStatus',
        label: 'Device status',
        description: 'Read device status.',
        enabled: false,
        available: true,
        requiresAuroraOpen: true,
        requiresLocalConfirmation: false,
      },
      {
        id: 'Local.Orchestrator',
        label: 'Assistant',
        description: 'Answer requests.',
        enabled: true,
        available: true,
        requiresAuroraOpen: true,
        requiresLocalConfirmation: false,
        serviceId: 'orchestrator',
        servicePermissionId: 'Orchestrator.use',
        serviceLabel: 'Assistant',
        serviceDescription: 'Answer requests on this device.',
      },
      {
        ...toolingService,
        id: 'Native.Unavailable',
        label: 'Unavailable',
        description: 'Unavailable on this device.',
        enabled: false,
        available: false,
        requiresAuroraOpen: true,
        requiresLocalConfirmation: false,
      },
    ],
    approvedDevices: [],
  }
}
