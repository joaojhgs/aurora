import { describe, expect, it } from 'vitest'

import { describeBrowserStorageHealth } from './storage-health'

describe('describeBrowserStorageHealth', () => {
  it('maps internal storage states to four product outcomes with safe copy', () => {
    const backend = {
      kind: 'indexeddb' as const,
      persistent: true,
      sqlite: false,
      profileId: 'profile-1',
      schemaVersion: 3,
      migrationState: 'idle' as const
    }
    const outcomes = [
      describeBrowserStorageHealth({ backend, ownerAvailable: true, internalState: 'ready_persistent', internalReason: 'indexeddb ok' }),
      describeBrowserStorageHealth({ backend, ownerAvailable: false, internalState: 'owner_blocked', internalReason: 'web_locks owner_exists' }),
      describeBrowserStorageHealth({ backend: { ...backend, persistent: false, kind: 'memory' as const }, ownerAvailable: true, internalState: 'ready_memory', internalReason: 'indexeddb denied' }),
      describeBrowserStorageHealth({ backend, ownerAvailable: true, internalState: 'needs_attention', internalReason: 'migration_integrity' })
    ]

    expect(new Set(outcomes.map((outcome) => outcome.outcome))).toEqual(new Set([
      'saved_on_this_device',
      'ready',
      'temporary_session',
      'needs_attention'
    ]))
    const rendered = outcomes.map((outcome) => `${outcome.product.title} ${outcome.product.detail}`).join('\n').toLowerCase()
    for (const forbidden of ['proof', 'evidence', 'fixture', 'assertion', 'implementation', 'tested', 'debug', 'fallback', 'provider', 'consumer', 'hybrid', 'route', 'manifest', 'contract', 'protocol', 'transport', 'runtime', 'schema', 'migration', 'sqlite', 'indexeddb', 'opfs', 'sidecar', 'thin']) {
      expect(rendered).not.toContain(forbidden)
    }
    expect(outcomes[0]?.internalReason).toBe('indexeddb ok')
  })
})
