import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  ToolingExecuteToolInputToolingExecuteToolRequestSchema,
  ToolingGetStatsOutputToolingGetStatsResponseSchema
} from '../src/generated/index.js'

const generatedRoot = resolve(process.cwd(), 'src/generated')
const manifest = JSON.parse(readFileSync(resolve(generatedRoot, 'backend-contracts.manifest.json'), 'utf8'))
const contractSchema = JSON.parse(readFileSync(resolve(generatedRoot, 'backend-contracts.schema.json'), 'utf8'))
const providerInventory = JSON.parse(readFileSync(resolve(generatedRoot, 'tooling-local-provider-v1.json'), 'utf8'))
type ProviderMethod = { method_id: string }

describe('generated backend contracts', () => {
  it('parses positive Tooling vectors and strips undeclared fields', () => {
    const execute = ToolingExecuteToolInputToolingExecuteToolRequestSchema.parse({
      tool_name: 'echo',
      arguments: { message: 'hello', unicode: 'snowman \u2603' },
      dry_run: true,
      unexpected: 'stripped'
    })

    expect(execute).toEqual({
      tool_name: 'echo',
      arguments: { message: 'hello', unicode: 'snowman \u2603' },
      dry_run: true
    })

    const stats = ToolingGetStatsOutputToolingGetStatsResponseSchema.parse({
      total_tools: 2,
      mcp_tools_loaded: 1,
      core_tools: 1,
      plugin_tools: 0,
      unexpected: 'stripped'
    })

    expect(stats).toEqual({
      total_tools: 2,
      mcp_tools_loaded: 1,
      core_tools: 1,
      plugin_tools: 0
    })
  })

  it('rejects negative Tooling vectors', () => {
    expect(() =>
      ToolingExecuteToolInputToolingExecuteToolRequestSchema.parse({
        tool_name: 12,
        arguments: {}
      })
    ).toThrow()
  })

  it('keeps manifest and local provider identities stable', () => {
    expect(contractSchema.allowlist).toEqual([
      'Tooling.ExecuteTool',
      'Tooling.GetMCPStatus',
      'Tooling.GetStats',
      'Tooling.GetTools'
    ])
    expect(manifest.generator_format_version).toBe('aurora-sdk-zod-codegen-v1')
    expect(providerInventory.provider_service_instance_id).toBe('local:aurora-sdk-local-provider-v1:Tooling')
    expect(providerInventory.methods.map((method: ProviderMethod) => method.method_id)).toEqual(contractSchema.allowlist)
  })
})
