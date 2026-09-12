const DEFAULT_COMMAND_TIMEOUT_MS = 5_000
const DEFAULT_LOOKUP_TIMEOUT_MS = 5_000

export async function connectAndroidWebviewCdp({
  port,
  onEvent = () => {},
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  lookupTimeoutMs = DEFAULT_LOOKUP_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
}) {
  if (!port) throw new Error('Android WebView DevTools port is required.')
  if (typeof fetchImpl !== 'function') {
    throw new Error('Android WebView CDP requires a fetch implementation.')
  }
  if (typeof WebSocketImpl !== 'function') {
    throw new Error('Android WebView CDP requires a WebSocket implementation.')
  }

  const baseUrl = `http://127.0.0.1:${port}`
  const lookupErrors = []
  const [version, listedTargets] = await Promise.all([
    fetchJson(`${baseUrl}/json/version`, fetchImpl, lookupTimeoutMs).catch((error) => {
      lookupErrors.push(`version lookup: ${errorMessage(error)}`)
      return null
    }),
    fetchJson(`${baseUrl}/json/list`, fetchImpl, lookupTimeoutMs).catch((error) => {
      lookupErrors.push(`target lookup: ${errorMessage(error)}`)
      return []
    }),
  ])
  const targets = Array.isArray(listedTargets) ? listedTargets : []
  const browserUrl = rewriteWebSocketUrl(version?.webSocketDebuggerUrl, port)
  const connectionErrors = []

  if (browserUrl) {
    for (const mode of ['flattened', 'nested']) {
      let client
      try {
        client = await connectBrowserTarget({
          url: browserUrl,
          mode,
          listedTargets: targets,
          onEvent,
          commandTimeoutMs,
          WebSocketImpl,
        })
        await client.send('Runtime.enable', {}, commandTimeoutMs)
        return client
      } catch (error) {
        client?.close()
        connectionErrors.push(`${mode} browser session: ${errorMessage(error)}`)
      }
    }
  }

  const directTarget = pickPageTarget(targets)
  const directUrl = rewriteWebSocketUrl(directTarget?.webSocketDebuggerUrl, port)
  if (directUrl) {
    let raw
    try {
      raw = await connectRawCdp({
        url: directUrl,
        onEvent,
        commandTimeoutMs,
        WebSocketImpl,
      })
      const client = createDirectClient(raw, directTarget, commandTimeoutMs)
      await client.send('Runtime.enable', {}, commandTimeoutMs)
      return client
    } catch (error) {
      raw?.close()
      connectionErrors.push(`direct page session: ${errorMessage(error)}`)
    }
  }

  const details = [...lookupErrors, ...connectionErrors]
  if (!browserUrl && !directUrl) {
    details.push('DevTools exposed neither a browser socket nor a page socket')
  }
  throw new Error(`Android WebView CDP connection failed: ${details.join('; ')}`)
}

async function connectBrowserTarget({
  url,
  mode,
  listedTargets,
  onEvent,
  commandTimeoutMs,
  WebSocketImpl,
}) {
  let routeEvent = () => {}
  const raw = await connectRawCdp({
    url,
    onEvent: (message) => routeEvent(message),
    commandTimeoutMs,
    WebSocketImpl,
  })

  try {
    const targetResponse = await raw.send('Target.getTargets')
    const browserTargets = targetResponse.result?.targetInfos
    const target = pickPageTarget(Array.isArray(browserTargets) ? browserTargets : [])
      ?? pickPageTarget(listedTargets)
    const targetId = target?.targetId ?? target?.id
    if (!targetId) {
      throw new Error('Android WebView browser target did not expose a page target id.')
    }

    const attached = await raw.send('Target.attachToTarget', {
      targetId,
      flatten: mode === 'flattened',
    })
    const sessionId = attached.result?.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('Android WebView browser target did not return a CDP session id.')
    }

    if (mode === 'flattened') {
      routeEvent = (message) => {
        if (message.sessionId && message.sessionId !== sessionId) return
        onEvent(message)
      }
      return createFlattenedClient(raw, target, sessionId, commandTimeoutMs)
    }

    return createNestedClient({
      raw,
      target,
      sessionId,
      onEvent,
      commandTimeoutMs,
      setRouteEvent(handler) {
        routeEvent = handler
      },
    })
  } catch (error) {
    raw.close()
    throw error
  }
}

function createFlattenedClient(raw, target, sessionId, commandTimeoutMs) {
  return {
    mode: 'browser-flattened',
    target,
    send(method, params = {}, timeoutMs = commandTimeoutMs) {
      return raw.send(method, params, { sessionId, timeoutMs })
    },
    close() {
      raw.close()
    },
  }
}

function createNestedClient({
  raw,
  target,
  sessionId,
  onEvent,
  commandTimeoutMs,
  setRouteEvent,
}) {
  const pending = new Map()
  let sequence = 0
  let closed = false

  setRouteEvent((message) => {
    if (
      message.method !== 'Target.receivedMessageFromTarget'
      || message.params?.sessionId !== sessionId
      || typeof message.params?.message !== 'string'
    ) {
      return
    }

    let inner
    try {
      inner = JSON.parse(message.params.message)
    } catch {
      return
    }
    if (inner.id && pending.has(inner.id)) {
      settleNestedPending(pending, inner.id, inner)
      return
    }
    onEvent(inner)
  })

  return {
    mode: 'browser-nested',
    target,
    send(method, params = {}, timeoutMs = commandTimeoutMs) {
      if (closed) {
        return Promise.reject(new Error(`Android WebView CDP connection is not open: ${method}`))
      }
      const id = ++sequence
      const innerMessage = JSON.stringify({ id, method, params })
      const response = new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          rejectPromise(new Error(`Android WebView CDP command timed out: ${method}`))
        }, timeoutMs)
        pending.set(id, {
          method,
          resolve: resolvePromise,
          reject: rejectPromise,
          timer,
        })
      })
      raw.send(
        'Target.sendMessageToTarget',
        { sessionId, message: innerMessage },
        { timeoutMs },
      ).catch((error) => rejectNestedPending(pending, id, error))
      return response
    },
    close() {
      if (closed) return
      closed = true
      rejectAllNestedPending(pending, new Error('Android WebView CDP connection closed'))
      raw.close()
    },
  }
}

function createDirectClient(raw, target, commandTimeoutMs) {
  return {
    mode: 'direct-page',
    target,
    send(method, params = {}, timeoutMs = commandTimeoutMs) {
      return raw.send(method, params, { timeoutMs })
    },
    close() {
      raw.close()
    },
  }
}

async function connectRawCdp({
  url,
  onEvent,
  commandTimeoutMs,
  WebSocketImpl,
}) {
  const socket = new WebSocketImpl(url)
  const pending = new Map()
  let sequence = 0
  let closed = false

  await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error('Android WebView CDP socket open timed out.'))
      socket.close()
    }, commandTimeoutMs)
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      resolvePromise()
    }, { once: true })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      rejectPromise(new Error('Android WebView CDP connection failed.'))
    }, { once: true })
  })

  const rejectPending = (error) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    pending.clear()
  }

  socket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (message.id && pending.has(message.id)) {
      const waiter = pending.get(message.id)
      pending.delete(message.id)
      clearTimeout(waiter.timer)
      if (message.error) {
        waiter.reject(new Error(
          `Android WebView CDP ${waiter.method} failed: ${message.error.message ?? 'unknown error'}`,
        ))
      } else {
        waiter.resolve(message)
      }
      return
    }
    onEvent(message)
  })
  socket.addEventListener('close', () => {
    if (closed) return
    closed = true
    rejectPending(new Error(
      'Android WebView CDP connection closed; the app or renderer may have exited.',
    ))
  })
  socket.addEventListener('error', () => {
    if (closed) return
    closed = true
    rejectPending(new Error('Android WebView CDP connection failed.'))
  })

  return {
    send(method, params = {}, { sessionId, timeoutMs = commandTimeoutMs } = {}) {
      if (closed || socket.readyState !== 1) {
        return Promise.reject(new Error(`Android WebView CDP connection is not open: ${method}`))
      }
      const id = ++sequence
      return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          rejectPromise(new Error(`Android WebView CDP command timed out: ${method}`))
        }, timeoutMs)
        pending.set(id, {
          method,
          resolve: resolvePromise,
          reject: rejectPromise,
          timer,
        })
        try {
          socket.send(JSON.stringify({
            id,
            method,
            params,
            ...(sessionId ? { sessionId } : {}),
          }))
        } catch (error) {
          clearTimeout(timer)
          pending.delete(id)
          rejectPromise(error)
        }
      })
    },
    close() {
      if (closed) return
      closed = true
      rejectPending(new Error('Android WebView CDP connection closed.'))
      socket.close()
    },
  }
}

function settleNestedPending(pending, id, message) {
  const waiter = pending.get(id)
  pending.delete(id)
  clearTimeout(waiter.timer)
  if (message.error) {
    waiter.reject(new Error(
      `Android WebView CDP ${waiter.method} failed: ${message.error.message ?? 'unknown error'}`,
    ))
    return
  }
  waiter.resolve(message)
}

function rejectNestedPending(pending, id, error) {
  const waiter = pending.get(id)
  if (!waiter) return
  pending.delete(id)
  clearTimeout(waiter.timer)
  waiter.reject(error)
}

function rejectAllNestedPending(pending, error) {
  for (const [id] of pending) rejectNestedPending(pending, id, error)
}

function pickPageTarget(targets) {
  return targets.find((target) => (
    target?.type === 'page'
    && (target.targetId || target.id || target.webSocketDebuggerUrl)
  )) ?? targets.find((target) => (
    typeof target?.url === 'string'
    && target.url.includes('tauri.localhost')
    && (target.targetId || target.id || target.webSocketDebuggerUrl)
  ))
}

async function fetchJson(url, fetchImpl, timeoutMs) {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return response.json()
}

function rewriteWebSocketUrl(value, port) {
  if (typeof value !== 'string' || value.length === 0) return null
  const url = new URL(value)
  url.hostname = '127.0.0.1'
  url.port = String(port)
  return url.toString()
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
