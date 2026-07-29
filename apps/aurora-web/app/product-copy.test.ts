import { AuroraError } from '@aurora/client'
import { describe, expect, it } from 'vitest'
import {
  productActionErrorText,
  productBundleItemAvailable,
  productQueueStatusState,
  productQueueStatusText
} from './product-copy'

describe('web product copy helpers', () => {
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
