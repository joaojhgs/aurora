// @vitest-environment node

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

type CdpMessage = {
  id?: number
  method?: string
  params?: Record<string, any>
  result?: Record<string, any>
  sessionId?: string
}

type CdpClient = {
  mode: 'browser-flattened' | 'browser-nested' | 'direct-page'
  send(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<CdpMessage>
  close(): void
}

type ConnectAndroidWebviewCdp = (options: {
  port: string | number
  onEvent?: (message: CdpMessage) => void
  commandTimeoutMs?: number
  lookupTimeoutMs?: number
  fetchImpl?: typeof fetch
  WebSocketImpl?: typeof WebSocket
}) => Promise<CdpClient>

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const moduleUrl = pathToFileURL(
  join(packageRoot, 'scripts', 'android-webview-cdp.mjs'),
).href

async function loadConnector(): Promise<ConnectAndroidWebviewCdp> {
  const module = await import(moduleUrl) as {
    connectAndroidWebviewCdp: ConnectAndroidWebviewCdp
  }
  return module.connectAndroidWebviewCdp
}

describe('Android WebView CDP connector', () => {
  it('prefers a flattened browser target session over the direct page socket', async () => {
    const sent: CdpMessage[] = []
    const events: CdpMessage[] = []
    const fake = createFakeWebSocket((_socket, message) => {
      sent.push(message)
      if (message.method === 'Target.getTargets') {
        _socket.respond(message.id!, {
          targetInfos: [{ targetId: 'page-1', type: 'page', url: 'http://tauri.localhost/' }],
        })
      } else if (message.method === 'Target.attachToTarget') {
        _socket.respond(message.id!, { sessionId: 'flat-session' })
      } else {
        _socket.respond(message.id!, {}, message.sessionId)
      }
    })
    const fetchImpl = createDevtoolsFetch({
      version: { webSocketDebuggerUrl: 'ws://device.invalid/devtools/browser/root' },
      targets: [{
        id: 'page-1',
        type: 'page',
        url: 'http://tauri.localhost/',
        webSocketDebuggerUrl: 'ws://device.invalid/devtools/page/page-1',
      }],
    })

    const connect = await loadConnector()
    const client = await connect({
      port: 9222,
      onEvent: (message) => events.push(message),
      fetchImpl,
      WebSocketImpl: fake.WebSocketImpl,
      commandTimeoutMs: 25,
    })
    await client.send('Log.enable')
    fake.sockets[0].emitMessage({
      method: 'Log.entryAdded',
      sessionId: 'flat-session',
      params: { entry: { level: 'error', text: 'example' } },
    })

    expect(client.mode).toBe('browser-flattened')
    expect(fake.sockets[0].url).toBe('ws://127.0.0.1:9222/devtools/browser/root')
    expect(sent).toContainEqual(expect.objectContaining({
      method: 'Target.attachToTarget',
      params: { targetId: 'page-1', flatten: true },
    }))
    expect(sent).toContainEqual(expect.objectContaining({
      method: 'Log.enable',
      sessionId: 'flat-session',
    }))
    expect(events).toContainEqual(expect.objectContaining({ method: 'Log.entryAdded' }))
    client.close()
  })

  it('reconnects with legacy nested routing when flattened commands time out', async () => {
    const sent: Array<{ connection: number; message: CdpMessage }> = []
    const events: CdpMessage[] = []
    const fake = createFakeWebSocket((socket, message) => {
      const connection = fake.sockets.indexOf(socket)
      sent.push({ connection, message })
      if (message.method === 'Target.getTargets') {
        socket.respond(message.id!, {
          targetInfos: [{ targetId: 'page-2', type: 'page', url: 'http://tauri.localhost/' }],
        })
        return
      }
      if (message.method === 'Target.attachToTarget') {
        socket.respond(message.id!, {
          sessionId: connection === 0 ? 'flat-timeout' : 'nested-session',
        })
        return
      }
      if (connection === 0 && message.method === 'Runtime.enable') {
        return
      }
      if (message.method === 'Target.sendMessageToTarget') {
        const inner = JSON.parse(String(message.params?.message)) as CdpMessage
        socket.respond(message.id!, {})
        socket.emitMessage({
          method: 'Target.receivedMessageFromTarget',
          params: {
            sessionId: 'nested-session',
            message: JSON.stringify({
              id: inner.id,
              result: inner.method === 'Runtime.evaluate'
                ? { result: { value: 'nested-ok' } }
                : {},
            }),
          },
        })
      }
    })
    const fetchImpl = createDevtoolsFetch({
      version: { webSocketDebuggerUrl: 'ws://device.invalid/devtools/browser/root' },
      targets: [],
    })

    const connect = await loadConnector()
    const client = await connect({
      port: 9333,
      onEvent: (message) => events.push(message),
      fetchImpl,
      WebSocketImpl: fake.WebSocketImpl,
      commandTimeoutMs: 10,
    })
    const evaluated = await client.send('Runtime.evaluate', { expression: '1' })
    fake.sockets[1].emitMessage({
      method: 'Target.receivedMessageFromTarget',
      params: {
        sessionId: 'nested-session',
        message: JSON.stringify({ method: 'Log.entryAdded', params: { entry: { text: 'nested' } } }),
      },
    })

    expect(client.mode).toBe('browser-nested')
    expect(fake.sockets).toHaveLength(2)
    expect(evaluated.result?.result?.value).toBe('nested-ok')
    expect(sent).toContainEqual(expect.objectContaining({
      connection: 1,
      message: expect.objectContaining({ method: 'Target.sendMessageToTarget' }),
    }))
    expect(events).toContainEqual(expect.objectContaining({ method: 'Log.entryAdded' }))
    client.close()
  })

  it('keeps the direct page socket as an older-WebView fallback', async () => {
    const fake = createFakeWebSocket((socket, message) => {
      socket.respond(message.id!, {
        result: message.method === 'Runtime.evaluate' ? { value: 'direct-ok' } : undefined,
      })
    })
    const fetchImpl = createDevtoolsFetch({
      version: {},
      targets: [{
        id: 'page-3',
        type: 'page',
        url: 'http://tauri.localhost/',
        webSocketDebuggerUrl: 'ws://device.invalid/devtools/page/page-3',
      }],
    })

    const connect = await loadConnector()
    const client = await connect({
      port: 9444,
      fetchImpl,
      WebSocketImpl: fake.WebSocketImpl,
      commandTimeoutMs: 25,
    })
    const evaluated = await client.send('Runtime.evaluate', { expression: '1' })

    expect(client.mode).toBe('direct-page')
    expect(fake.sockets[0].url).toBe('ws://127.0.0.1:9444/devtools/page/page-3')
    expect(evaluated.result?.result?.value).toBe('direct-ok')
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:9444/json/version',
      expect.any(Object),
    )
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:9444/json/list',
      expect.any(Object),
    )
    client.close()
  })
})

function createDevtoolsFetch({ version, targets }: {
  version: Record<string, unknown>
  targets: Array<Record<string, unknown>>
}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    const value = url.endsWith('/json/version') ? version : targets
    return {
      ok: true,
      status: 200,
      async json() {
        return value
      },
    } as Response
  }) as typeof fetch
}

type FakeSocket = {
  url: string
  readyState: number
  respond(id: number, result: Record<string, unknown>, sessionId?: string): void
  emitMessage(message: CdpMessage): void
  emit(type: string, event: unknown): void
}

function createFakeWebSocket(
  onSend: (socket: FakeSocket, message: CdpMessage) => void,
) {
  const sockets: FakeSocket[] = []

  class FakeWebSocket {
    readonly url: string
    readyState = 0
    private listeners = new Map<string, Array<{
      listener: (event: any) => void
      once: boolean
    }>>()

    constructor(url: string) {
      this.url = url
      sockets.push(this)
      queueMicrotask(() => {
        this.readyState = 1
        this.emit('open', {})
      })
    }

    addEventListener(
      type: string,
      listener: (event: any) => void,
      options?: { once?: boolean },
    ) {
      const listeners = this.listeners.get(type) ?? []
      listeners.push({ listener, once: options?.once === true })
      this.listeners.set(type, listeners)
    }

    send(data: string) {
      onSend(this, JSON.parse(data) as CdpMessage)
    }

    close() {
      if (this.readyState === 3) return
      this.readyState = 3
      this.emit('close', {})
    }

    respond(id: number, result: Record<string, unknown>, sessionId?: string) {
      this.emitMessage({ id, result, ...(sessionId ? { sessionId } : {}) })
    }

    emitMessage(message: CdpMessage) {
      this.emit('message', { data: JSON.stringify(message) })
    }

    emit(type: string, event: unknown) {
      const listeners = this.listeners.get(type) ?? []
      for (const entry of [...listeners]) entry.listener(event)
      this.listeners.set(type, listeners.filter((entry) => !entry.once))
    }
  }

  return {
    sockets,
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
  }
}
