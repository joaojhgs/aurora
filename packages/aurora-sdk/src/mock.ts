import { AuroraError, type AuroraErrorCode } from './errors.js'
import type { AuroraTransportEnvelope } from './types.js'
import type { AuroraTransport, AuroraTransportRequest, AuroraTransportResponse } from './transport.js'

export type MockHandler<TPayload = unknown, TData = unknown> = (
  request: AuroraTransportRequest<TPayload>
) => TData | AuroraTransportEnvelope<TData> | Promise<TData | AuroraTransportEnvelope<TData>>
export type MockRegistration<TPayload = unknown, TData = unknown> =
  | MockHandler<TPayload, TData>
  | TData
  | AuroraTransportEnvelope<TData>

export class MockAuroraTransport implements AuroraTransport {
  readonly kind = 'mock'
  private readonly handlers = new Map<string, MockHandler>()

  register<TPayload = unknown, TData = unknown>(
    method: string,
    registration: MockRegistration<TPayload, TData>
  ): this {
    const handler: MockHandler<TPayload, TData> =
      typeof registration === 'function'
        ? (registration as MockHandler<TPayload, TData>)
        : () => registration
    this.handlers.set(method, handler as MockHandler)
    return this
  }

  fail(method: string, code: AuroraErrorCode, message: string): this {
    return this.register(method, () => {
      throw new AuroraError({ code, message, method })
    })
  }

  async request<TData = unknown, TPayload = unknown>(
    request: AuroraTransportRequest<TPayload>
  ): Promise<AuroraTransportResponse<TData>> {
    const handler = this.handlers.get(request.method) ?? (request.busTopic ? this.handlers.get(request.busTopic) : undefined)
    if (!handler) {
      throw new AuroraError({
        code: 'unsupported_feature',
        message: `No mock handler registered for ${request.method}`,
        method: request.method,
        busTopic: request.busTopic
      })
    }
    const value = await handler(request)
    if (isTransportEnvelope<TData>(value)) return value
    return {
      data: value as TData,
      status: 200,
      audit: {
        method: request.method,
        busTopic: request.busTopic ?? null,
        transport: this.kind
      }
    }
  }
}

function isTransportEnvelope<TData>(value: unknown): value is AuroraTransportEnvelope<TData> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'data' in value &&
    ('status' in value || 'headers' in value || 'audit' in value)
  )
}
