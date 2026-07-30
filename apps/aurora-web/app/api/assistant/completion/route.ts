import { NextResponse, type NextRequest } from 'next/server'
import {
  createOpenAICompatibleToolProvider,
  type LightweightProviderMessage,
} from '@aurora/client/lightweight-orchestrator'
import type { ToolingProjectionToolInfo } from '@aurora/client'
import {
  assistantCompletionPublicConfig,
  assistantCompletionServerConfig,
} from '../../../assistant-completion-config'

export const runtime = 'nodejs'

export function GET() {
  const config = assistantCompletionPublicConfig()
  if (!config.enabled) {
    return NextResponse.json({ enabled: false }, { status: 404 })
  }
  return NextResponse.json(config)
}

export async function POST(request: NextRequest) {
  const config = assistantCompletionServerConfig()
  if (!config) {
    return NextResponse.json({ ok: false, error: 'assistant_unavailable' }, { status: 404 })
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'assistant_unavailable' }, { status: 400 })
  }
  const providerRequest = normalizeProviderRequest(body, request.signal)
  if (!providerRequest) {
    return NextResponse.json({ ok: false, error: 'assistant_unavailable' }, { status: 400 })
  }
  const provider = createOpenAICompatibleToolProvider(config)
  const response = await provider.complete(providerRequest)
  return NextResponse.json(response)
}

function normalizeProviderRequest(body: unknown, signal: AbortSignal) {
  if (!body || typeof body !== 'object') return null
  const value = body as {
    messages?: unknown
    tools?: unknown
    maxToolCalls?: unknown
  }
  if (!Array.isArray(value.messages) || !Array.isArray(value.tools)) return null
  const maxToolCalls = typeof value.maxToolCalls === 'number' && Number.isFinite(value.maxToolCalls)
    ? Math.max(0, Math.floor(value.maxToolCalls))
    : 0
  return {
    messages: value.messages.filter(isProviderMessage),
    tools: value.tools.filter(isProjectionTool),
    maxToolCalls,
    signal,
  }
}

function isProviderMessage(value: unknown): value is LightweightProviderMessage {
  if (!value || typeof value !== 'object') return false
  const candidate = value as {
    role?: unknown
    content?: unknown
    toolCallId?: unknown
    name?: unknown
  }
  return (
    (candidate.role === 'system'
      || candidate.role === 'user'
      || candidate.role === 'assistant'
      || candidate.role === 'tool')
    && typeof candidate.content === 'string'
    && (candidate.toolCallId === undefined || candidate.toolCallId === null || typeof candidate.toolCallId === 'string')
    && (candidate.name === undefined || candidate.name === null || typeof candidate.name === 'string')
  )
}

function isProjectionTool(value: unknown): value is ToolingProjectionToolInfo {
  if (!value || typeof value !== 'object') return false
  const candidate = value as {
    global_tool_id?: unknown
    execution_location?: unknown
    exportable?: unknown
    provider_available?: unknown
    args_schema?: unknown
  }
  return (
    typeof candidate.global_tool_id === 'string'
    && (candidate.execution_location === 'local' || candidate.execution_location === 'remote')
    && typeof candidate.exportable === 'boolean'
    && (candidate.provider_available === undefined
      || candidate.provider_available === null
      || typeof candidate.provider_available === 'boolean')
    && candidate.args_schema !== null
    && typeof candidate.args_schema === 'object'
    && !Array.isArray(candidate.args_schema)
  )
}
