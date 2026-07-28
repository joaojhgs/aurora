import { describe, expect, it } from 'vitest'
import {
  PRODUCT_COPY,
  assertProductCopySafe,
  productStatusCopy,
  safeErrorCopy,
  type ProductCopyResult,
} from '../src/product-copy'
import { findForbiddenProductionCopyTerms } from '../src/product-copy-forbidden-terms'

describe('production product copy', () => {
  it('keeps centralized visible copy free of blocked implementation wording', () => {
    for (const value of visibleStrings(PRODUCT_COPY)) {
      expect(findForbiddenProductionCopyTerms(value), value).toEqual([])
      expect(() => assertProductCopySafe(value)).not.toThrow()
    }
  })

  it('maps internal statuses to user-safe outcomes and actions', () => {
    expect(productStatusCopy('connected', { deviceName: 'Studio node' })).toEqual({
      title: 'Connected to Studio node',
    })
    expect(productStatusCopy('approval-pending').title).toBe('Waiting for approval on both devices')
    expect(productStatusCopy('temporary-session').title).toBe('Temporary session - changes may be lost when you close Aurora')
    expect(productStatusCopy('local-data-update-failed', { supportId: 'AUR-2042' })).toEqual({
      title: 'Your existing local data was not changed. Try again.',
      action: 'Try again',
      supportId: 'AUR-2042',
    })
    expect(productStatusCopy('unsupported-feature').title).toBe('This Aurora version cannot use that feature yet')
  })

  it('redacts ordinary errors into action-oriented copy', () => {
    const copy = safeErrorCopy({ code: 'permission_denied', message: 'raw internal detail' }, 'AUR-9000')

    expect(copy).toEqual({
      title: 'Permission is needed to use this feature',
      action: 'Review access',
    } satisfies ProductCopyResult)
    expect(JSON.stringify(copy)).not.toContain('raw internal detail')
  })

  it('rejects blocked wording when a new visible string regresses', () => {
    const cases: Array<[string, string]> = [
      ['Web thin debug panel', 'thin'],
      ['Web thin debug panel', 'debug'],
      ['Use the room_password value', 'room-password'],
      ['Use the room-password value', 'room-password'],
      ['Use the room/password value', 'room-password'],
      ['Fall-back status', 'fallback'],
      ['Fall_back status', 'fallback'],
      ['Services/Gateway/API/Port setting', 'key-path'],
      ['services-orchestrator-llm-provider setting', 'key-path'],
      ['services_orchestrator_llm_provider setting', 'key-path'],
      ['services.orchestrator.llm.provider setting', 'key-path'],
      ['SDK details', 'sdk'],
      ['WebView bridge', 'webview'],
      ['Daemon status', 'daemon'],
      ['Orchestrator state', 'orchestrator'],
      ['Raw response', 'raw'],
      ['HTTP endpoint', 'http'],
      ['WSS signaling', 'webrtc-wss'],
      ['WebRTC status', 'webrtc-wss'],
      ['remote_console access', 'remote-console'],
      ['mesh/node status', 'mesh-node'],
      ['runtime_tier label', 'runtime-tier'],
    ]

    for (const [copy, id] of cases) {
      expect(findForbiddenProductionCopyTerms(copy), copy).toEqual(
        expect.arrayContaining([expect.objectContaining({ id })]),
      )
    }
  })

  it('does not block ordinary words that only contain internal fragments', () => {
    for (const copy of ['The room is ready', 'Fallbacks are handled elsewhere', 'This is a rawhide color name', 'The gateway is available']) {
      expect(findForbiddenProductionCopyTerms(copy), copy).toEqual([])
    }
  })
})

function visibleStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(visibleStrings)
  return Object.values(value).flatMap(visibleStrings)
}
