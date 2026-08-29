import { describe, expect, it } from 'vitest'
import {
  createLightweightAssistantOrchestrator,
  isLightweightLocalAssistantAvailable,
} from '@aurora/ui/local-assistant'

describe('@aurora/ui local-assistant package export', () => {
  it('is importable from a workspace consumer package', () => {
    expect(createLightweightAssistantOrchestrator).toBeTypeOf('function')
    expect(isLightweightLocalAssistantAvailable({})).toBe(false)
  })
})
