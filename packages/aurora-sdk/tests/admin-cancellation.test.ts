import { describe, expect, it } from 'vitest'

import {
  AdminActionClient,
  type AdminActionConfirmResponse,
  type AdminActionControllerClient,
  type AdminActionDraftResponse
} from '../src/index.js'
import type { AuroraResponse, AuroraTransport } from '../src/index.js'

type RequestOptions = NonNullable<Parameters<AdminActionControllerClient['request']>[2]>

interface RecordedRequest {
  method: string
  payload: unknown
  options?: RequestOptions
}

const transport: AuroraTransport = {
  kind: 'mock-admin-cancellation',
  async request() {
    throw new Error('transport is not used by AdminActionClient tests')
  }
}

describe('AdminActionClient cancellation', () => {
  it('passes one abort signal through draft, confirm, and submit', async () => {
    const controller = new AbortController()
    const calls: RecordedRequest[] = []
    const client = new AdminActionClient(controllerClient(async (method, payload, options) => {
      calls.push({ method, payload, ...(options !== undefined ? { options } : {}) })
      if (method === 'Gateway.AdminActionDraft') return adminDraftFixture('Config.Set')
      if (method === 'Gateway.AdminActionConfirm') return adminConfirmFixture('aa-Config-Set')
      if (method === 'Config.Set') return { success: true }
      throw new Error(`unexpected method ${method}`)
    }))

    await expect(client.execute<{ success: boolean }>({
      methodId: 'Config.Set',
      payload: { key: 'ui.enabled', value: true },
      reason: 'Change local setting',
      reauthConfirmed: true,
      signal: controller.signal
    })).resolves.toEqual({
      draft: adminDraftFixture('Config.Set'),
      confirmation: adminConfirmFixture('aa-Config-Set'),
      data: { success: true }
    })

    expect(calls).toHaveLength(3)
    expect(calls.map((call) => call.options?.signal)).toEqual([
      controller.signal,
      controller.signal,
      controller.signal
    ])
    expect(calls.at(-1)).toEqual(expect.objectContaining({
      method: 'Config.Set',
      options: expect.objectContaining({
        path: '/api/Config/Set',
        httpMethod: 'POST',
        signal: controller.signal,
        headers: {
          'X-Aurora-AdminAction-Id': 'aa-Config-Set',
          'X-Aurora-AdminAction-Token': 'token-Config-Set',
          'X-Aurora-AdminAction-Digest': 'digest-Config-Set'
        }
      })
    }))
  })

  it('does not submit when the signal is aborted after confirmation resolves', async () => {
    const controller = new AbortController()
    const abortReason = new Error('operator changed device scope')
    const methods: string[] = []
    const client = new AdminActionClient(controllerClient(async (method) => {
      methods.push(method)
      if (method === 'Gateway.AdminActionDraft') return adminDraftFixture('Config.Set')
      if (method === 'Gateway.AdminActionConfirm') {
        controller.abort(abortReason)
        return adminConfirmFixture('aa-Config-Set')
      }
      if (method === 'Config.Set') throw new Error('submit must not run after cancellation')
      throw new Error(`unexpected method ${method}`)
    }))

    await expect(client.execute({
      methodId: 'Config.Set',
      payload: { key: 'ui.enabled', value: false },
      reason: 'Change local setting',
      reauthConfirmed: true,
      signal: controller.signal
    })).rejects.toBe(abortReason)

    expect(methods).toEqual(['Gateway.AdminActionDraft', 'Gateway.AdminActionConfirm'])
  })
})

function controllerClient(
  handler: (method: string, payload: unknown, options: RequestOptions | undefined) => Promise<unknown>
): AdminActionControllerClient {
  return {
    transport,
    async request<TData = unknown, TPayload = unknown>(
      method: string,
      payload?: TPayload,
      options?: RequestOptions
    ): Promise<TData> {
      return handler(method, payload, options) as Promise<TData>
    },
    async requestResult<TData = unknown>(): Promise<AuroraResponse<TData>> {
      throw new Error('requestResult is not used by AdminActionClient tests')
    }
  }
}

function adminDraftFixture(methodId: string): AdminActionDraftResponse {
  const suffix = methodId.replace('.', '-')
  return {
    action_id: `aa-${suffix}`,
    nonce: `nonce-${suffix}`,
    digest: `digest-${suffix}`,
    method_id: methodId,
    affected_resources: ['config'],
    required_phrase: 'CONFIRM',
    required_reason: true,
    required_reauth: true,
    expires_at: '2026-06-25T12:05:00Z',
    expires_in_seconds: 300,
    confirmation_headers: {
      action_id: 'X-Aurora-AdminAction-Id',
      confirmation_token: 'X-Aurora-AdminAction-Token',
      digest: 'X-Aurora-AdminAction-Digest'
    }
  }
}

function adminConfirmFixture(actionId: string): AdminActionConfirmResponse {
  const suffix = actionId.replace('aa-', '')
  return {
    action_id: actionId,
    confirmation_token: `token-${suffix}`,
    digest: `digest-${suffix}`,
    confirmed: true,
    expires_at: '2026-06-25T12:05:00Z',
    audit_receipt: `audit-${suffix}`,
    confirmation_headers: {
      action_id: 'X-Aurora-AdminAction-Id',
      confirmation_token: 'X-Aurora-AdminAction-Token',
      digest: 'X-Aurora-AdminAction-Digest'
    }
  }
}
