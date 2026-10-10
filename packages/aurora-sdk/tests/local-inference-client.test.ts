import { describe, expect, it } from 'vitest'
import { LocalInferenceClient, type LocalInferenceInvoke } from '../src/local-inference/client.js'
import type { LocalInferenceCompletionRequest, LocalInferenceToolDeclaration } from '../src/local-inference/types.js'

describe('local inference native client', () => {
  it('creates a ready selected session, completes locally, cancels that session, and closes it', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []
    let resolveStarted!: () => void
    let resolveCompletion!: (value: unknown) => void
    const completionStarted = new Promise<void>((resolve) => { resolveStarted = resolve })
    const invoke: LocalInferenceInvoke = async (command, args) => {
      calls.push({ command, args })
      if (command === 'aurora_local_inference_engines') {
        return envelope([{
          engine: 'cactus', surface: 'android', version: 'native-build', accelerators: ['cpu'], maxConcurrentModels: 1
        }])
      }
      if (command === 'aurora_local_inference_catalog') {
        return envelope([{
          modelId: 'actions-on-device', displayLabel: 'Actions', bytes: 100,
          capabilities: { chat: true, tools: true }
        }])
      }
      if (command === 'aurora_local_inference_download_model') {
        return envelope({ modelId: 'actions-on-device', state: 'ready', bytesOnDisk: 100 })
      }
      if (command === 'aurora_local_inference_model_status') {
        return envelope({ modelId: 'actions-on-device', state: 'ready' })
      }
      if (command === 'aurora_local_inference_session_create') {
        return envelope({ modelId: 'actions-on-device', sessionId: 'conversation-1', contextBytes: null, contextTokens: 4096 })
      }
      if (command === 'aurora_local_inference_complete') {
        resolveStarted()
        return await new Promise<unknown>((resolve) => { resolveCompletion = resolve })
      }
      if (command === 'aurora_local_inference_cancel') {
        resolveCompletion(envelope({ type: 'message', content: 'late completion' }))
        return envelope(null)
      }
      if (command === 'aurora_local_inference_session_destroy') return envelope(null)
      throw new Error('Unexpected local command')
    }
    const client = new LocalInferenceClient(invoke, { cancelTimeoutMs: 500, createRequestId: () => 'request-1' })
    const tools: readonly LocalInferenceToolDeclaration[] = [{
      type: 'function',
      function: { name: 'notes_create_1', description: 'Create a note', parameters: { type: 'object' } }
    }]

    await expect(client.engines()).resolves.toMatchObject([{ engine: 'cactus', surface: 'android' }])
    await expect(client.catalog()).resolves.toEqual([{
      modelId: 'actions-on-device', displayLabel: 'Actions', bytes: 100,
      capabilities: { chat: true, tools: true }
    }])
    await expect(client.downloadModel('actions-on-device')).resolves.toMatchObject({ modelId: 'actions-on-device', state: 'ready' })
    await expect(client.sessionCreate('actions-on-device', 'conversation-1')).resolves.toEqual({
      modelId: 'actions-on-device', sessionId: 'conversation-1', contextBytes: null, contextTokens: 4096
    })

    const request: LocalInferenceCompletionRequest = {
      modelId: 'actions-on-device',
      sessionId: 'conversation-1',
      messages: [{ role: 'user', content: 'Make a note' }],
      tools,
      options: { forceTools: false, maxTokens: 512 }
    }
    const controller = new AbortController()
    const completion = client.complete(request, controller.signal)
    await completionStarted
    controller.abort()
    await expect(completion).rejects.toMatchObject({ reasonCode: 'provider_call_cancelled' })
    await client.close()

    expect(calls.map((call) => call.command)).toEqual([
      'aurora_local_inference_engines',
      'aurora_local_inference_catalog',
      'aurora_local_inference_download_model',
      'aurora_local_inference_model_status',
      'aurora_local_inference_session_create',
      'aurora_local_inference_model_status',
      'aurora_local_inference_complete',
      'aurora_local_inference_cancel',
      'aurora_local_inference_session_destroy'
    ])
    expect(calls.find((call) => call.command === 'aurora_local_inference_session_create')?.args).toEqual({
      modelId: 'actions-on-device', sessionId: 'conversation-1'
    })
    expect(calls.find((call) => call.command === 'aurora_local_inference_complete')?.args).toEqual({
      sessionId: 'conversation-1', requestId: 'request-1', request
    })
    expect(calls.find((call) => call.command === 'aurora_local_inference_cancel')?.args).toEqual({
      sessionId: 'conversation-1', requestId: 'request-1'
    })
  })
})

function envelope(data: unknown): { ok: true; data: unknown } {
  return { ok: true, data }
}
