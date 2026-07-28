import { describe, expect, it } from 'vitest'

import { ToolingExecuteToolInputToolingExecuteToolRequestSchema } from '../src/generated/index.js'
import { AuroraValidationError, parseBoundary } from '../src/validation/index.js'

describe('validation boundary parsing', () => {
  it('returns parsed values for valid payloads', () => {
    expect(
      parseBoundary(
        'Tooling.ExecuteTool.input.ToolingExecuteToolRequest',
        ToolingExecuteToolInputToolingExecuteToolRequestSchema,
        { tool_name: 'echo', arguments: { message: 'hello' } },
        { boundary: 'http-request' }
      )
    ).toEqual({ tool_name: 'echo', arguments: { message: 'hello' } })
  })

  it('throws redacted validation errors without raw values', () => {
    try {
      parseBoundary(
        'Tooling.ExecuteTool.input.ToolingExecuteToolRequest',
        ToolingExecuteToolInputToolingExecuteToolRequestSchema,
        { tool_name: 'secret raw value', arguments: 'not-object' },
        { boundary: 'webrtc-frame' }
      )
      throw new Error('expected parseBoundary to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(AuroraValidationError)
      const validationError = error as AuroraValidationError
      expect(validationError.schemaId).toBe('Tooling.ExecuteTool.input.ToolingExecuteToolRequest')
      expect(validationError.boundary).toBe('webrtc-frame')
      expect(validationError.issues.map((issue) => issue.path)).toContain('$.arguments')
      expect(JSON.stringify(validationError.toJSON())).not.toContain('secret raw value')
      expect(JSON.stringify(validationError.toJSON())).not.toContain('not-object')
    }
  })
})
