import { AuroraError, type AuroraErrorCode } from './errors.js'
import type { AuroraTransport, AuroraTransportRequest, AuroraTransportResponse } from './transport.js'

export type MockHandler<TPayload = unknown, TData = unknown> = (
  request: AuroraTransportRequest<TPayload>
) => TData | Promise<TData>
export type MockRegistration<TPayload = unknown, TData = unknown> =
  | MockHandler<TPayload, TData>
  | TData

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
    return {
      data: (await handler(request)) as TData,
      status: 200
    }
  }
}
