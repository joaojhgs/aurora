import { describe, expect, it } from 'vitest'
import {
  AssistantSurfaceSelector,
  isLightweightLocalAssistantAvailable,
  LightweightLocalAssistant,
} from '@aurora/ui/local-assistant'

describe('@aurora/ui local-assistant package export', () => {
  it('is importable from a workspace consumer package', () => {
    expect(AssistantSurfaceSelector).toBeTypeOf('function')
    expect(LightweightLocalAssistant).toBeTypeOf('function')
    expect(isLightweightLocalAssistantAvailable({})).toBe(false)
  })
})
