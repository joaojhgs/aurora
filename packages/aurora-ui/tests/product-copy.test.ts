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
    expect(findForbiddenProductionCopyTerms('Web thin debug panel')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'thin' }),
        expect.objectContaining({ id: 'debug' }),
      ]),
    )
  })
})

function visibleStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(visibleStrings)
  return Object.values(value).flatMap(visibleStrings)
}
