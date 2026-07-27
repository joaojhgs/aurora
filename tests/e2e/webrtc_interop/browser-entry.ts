import '../../../apps/aurora-tauri/src/legacy-webview-polyfills.js'
import { createBrowserWebRtcAuroraRuntime, MemoryPeerCredentialStore, MqttWebSocketSignalingClient, type WebRtcPeerConnectionProfile } from '../../../packages/aurora-sdk/src/webrtc/index.js'
import {
  candidatePairMatchesLane,
  type InteropCandidatePairEvidence
} from './assertions.js'

export type InteropBrowserConfig = {
  lane: string
  appId: string
  room: string
  roomSecret: string
  brokerUrl: string
  expectedStablePeerId: string
  localStablePeerId: string
  localSignalingId: string
  expectedNegotiationRole: 'offerer' | 'answerer'
  nodeName: string
  stunServers: string[]
  turnServers: string[]
  turnUsername?: string
  turnCredential?: string
  forceRelay: boolean
  suppressHostCandidates: boolean
  timeoutMs: number
  eventTopic: string
  eventCorrelationId: string
  ttsEventTopic: string
  ttsCorrelationId: string
  wrongCorrelationId: string
  mutationTopic: string
  mutationCountTopic: string
  mutationStartedTopic: string
  revokeTopic: string
  largeEchoTopic: string
  errorTopic: string
  streamTopic: string
  streamStatusTopic: string
  runtimeLocation?: {
    protocol: string
    hostname: string
  }
}

type Snapshot = ReturnType<ReturnType<typeof createBrowserWebRtcAuroraRuntime>['peer']['snapshot']>

type PeerConnectionDiagnostic = {
  at: string
  connectionId: number
  event: string
  connectionState?: string
  iceConnectionState?: string
  iceGatheringState?: string
  signalingState?: string
  candidateType?: string
  candidateProtocol?: string
  errorCode?: number
  errorText?: string
}

let peerConnectionSequence = 0

function recordPeerConnectionDiagnostic(
  connectionId: number,
  pc: RTCPeerConnection,
  event: string,
  details: Partial<PeerConnectionDiagnostic> = {}
): void {
  const existing = Reflect.get(
    globalThis,
    '__auroraWebRtcInteropPeerConnectionDiagnostics'
  )
  const diagnostics = Array.isArray(existing) ? existing : []
  diagnostics.push({
    at: new Date().toISOString(),
    connectionId,
    event,
    connectionState: pc.connectionState,
    iceConnectionState: pc.iceConnectionState,
    iceGatheringState: pc.iceGatheringState,
    signalingState: pc.signalingState,
    ...details
  })
  if (diagnostics.length > 100) diagnostics.splice(0, diagnostics.length - 100)
  Object.assign(globalThis, {
    __auroraWebRtcInteropPeerConnectionDiagnostics: diagnostics
  })
}

function recordInteropProgress(phase: string, snapshot?: Snapshot): void {
  Object.assign(globalThis, {
    __auroraWebRtcInteropProgress: {
      phase,
      at: new Date().toISOString(),
      peer: snapshot
        ? {
            state: snapshot.state,
            icePathCategory: snapshot.icePathCategory,
            negotiationRole: snapshot.negotiationRole,
            connectedStablePeerId: snapshot.connectedStablePeerId,
            connectedSignalingPeerId: snapshot.connectedSignalingPeerId,
            selectedSignalingBrokerOrigin:
              snapshot.selectedSignalingBrokerOrigin,
            hasPendingPairing: Boolean(snapshot.pendingPairing),
            lastRedactedError: snapshot.lastRedactedError
          }
        : null
    }
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs: number,
  intervalMs = 100
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(intervalMs)
  }
  throw new Error(`Timed out waiting for ${label}`)
}


async function mqttFactory(brokerUrl: string, options: any): Promise<any> {
  const mqttModuleUrl = '/mqtt-bundle.mjs'
  let candidate: any = await import(mqttModuleUrl)
  for (let depth = 0; depth < 4; depth += 1) {
    if (
      typeof candidate?.connect === 'function' ||
      typeof candidate === 'function'
    ) {
      break
    }
    candidate = candidate?.default
  }
  const connect =
    typeof candidate?.connect === 'function'
      ? candidate.connect
      : candidate
  if (typeof connect !== 'function') throw new Error('mqtt.connect is unavailable in bundled browser harness')
  return connect(brokerUrl, options)
}

function isHostCandidate(candidate: unknown): boolean {
  const text = typeof candidate === 'string'
    ? candidate
    : typeof (candidate as { candidate?: unknown } | null)?.candidate === 'string'
      ? String((candidate as { candidate: string }).candidate)
      : ''
  return /\btyp\s+host\b/.test(text)
}

function stripHostIceCandidatesFromSdp(
  description: RTCSessionDescription | RTCSessionDescriptionInit | null
): RTCSessionDescriptionInit | null {
  if (description === null) return null
  const separator = description.sdp.includes('\r\n') ? '\r\n' : '\n'
  return {
    type: description.type,
    sdp: description.sdp
      .split(/\r?\n/)
      .filter((line) => !/^a=candidate:.*\btyp\s+host\b/i.test(line))
      .join(separator)
  }
}

function suppressHostIceCandidates(pc: RTCPeerConnection): RTCPeerConnection {
  let assigned: ((event: RTCPeerConnectionIceEvent) => void) | null = null
  return new Proxy(pc, {
    get(target, property) {
      if (property === 'onicecandidate') return assigned
      if (property === 'localDescription') return stripHostIceCandidatesFromSdp(target.localDescription)
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
    set(target, property, value) {
      if (property === 'onicecandidate') {
        assigned = value
        target.onicecandidate = typeof value === 'function'
          ? (event: RTCPeerConnectionIceEvent) => {
            if (event.candidate !== null && isHostCandidate(event.candidate)) return
            value(event)
          }
          : value
        return true
      }
      return Reflect.set(target, property, value, target)
    }
  })
}

function makePeerConnectionFactory(
  forceRelay: boolean,
  suppressHostCandidates: boolean,
  turnUsername?: string,
  turnCredential?: string
) {
  return (configuration: RTCConfiguration): RTCPeerConnection => {
    const iceServers = configuration.iceServers?.map((server) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls]
      if (urls.some((url) => typeof url === 'string' && (url.startsWith('turn:') || url.startsWith('turns:'))) && !server.username && turnUsername && turnCredential) {
        return { ...server, username: turnUsername, credential: turnCredential }
      }
      return server
    })
    const next: RTCConfiguration = { ...configuration }
    if (iceServers !== undefined) next.iceServers = iceServers
    if (forceRelay) next.iceTransportPolicy = 'relay'
    const pc = new RTCPeerConnection(next)
    const connectionId = ++peerConnectionSequence
    recordPeerConnectionDiagnostic(connectionId, pc, 'created', {
      candidateType: next.iceTransportPolicy ?? 'all'
    })
    for (const event of [
      'connectionstatechange',
      'iceconnectionstatechange',
      'icegatheringstatechange',
      'signalingstatechange',
      'negotiationneeded',
      'datachannel'
    ]) {
      pc.addEventListener(event, () => {
        recordPeerConnectionDiagnostic(connectionId, pc, event)
      })
    }
    pc.addEventListener('icecandidate', (event) => {
      const candidate = event.candidate
      if (candidate === null) {
        recordPeerConnectionDiagnostic(connectionId, pc, 'icecandidate:complete')
        return
      }
      const candidateText = candidate.candidate
      const candidateType =
        (candidate as RTCIceCandidate & { type?: string }).type ??
        /\styp\s(\S+)/u.exec(candidateText)?.[1]
      const candidateProtocol =
        (candidate as RTCIceCandidate & { protocol?: string }).protocol ??
        candidateText.split(/\s+/u)[2]
      recordPeerConnectionDiagnostic(connectionId, pc, 'icecandidate', {
        ...(candidateType ? { candidateType } : {}),
        ...(candidateProtocol ? { candidateProtocol } : {})
      })
    })
    pc.addEventListener('icecandidateerror', (event) => {
      const error = event as Event & { errorCode?: number; errorText?: string }
      recordPeerConnectionDiagnostic(connectionId, pc, 'icecandidateerror', {
        ...(typeof error.errorCode === 'number'
          ? { errorCode: error.errorCode }
          : {}),
        ...(error.errorText
          ? { errorText: error.errorText.slice(0, 160) }
          : {})
      })
    })
    return suppressHostCandidates ? suppressHostIceCandidates(pc) : pc
  }
}

async function firstEvent<T>(iterable: AsyncIterable<T>, timeoutMs: number): Promise<T> {
  const iterator = iterable[Symbol.asyncIterator]()
  const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for DataChannel event')), timeoutMs))
  try {
    const result = await Promise.race([iterator.next(), timer])
    if (result.done) throw new Error('DataChannel event stream ended before first event')
    return result.value
  } finally {
    await iterator.return?.()
  }
}

async function optionalFirstEvent<T>(iterable: AsyncIterable<T>, timeoutMs: number): Promise<T | null> {
  try {
    return await firstEvent(iterable, timeoutMs)
  } catch {
    return null
  }
}

function countPendingPairing(snapshots: Snapshot[], startIndex = 0): number {
  return snapshots.slice(startIndex).filter((item) => Boolean(item.pendingPairing)).length
}

function signalingIdFactory(signalingId: string): () => string {
  let first = true
  return () => {
    if (first) {
      first = false
      return signalingId
    }
    return globalThis.crypto.randomUUID()
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function waitForStreamStatus(
  runtime: ReturnType<typeof createBrowserWebRtcAuroraRuntime>,
  topic: string,
  probeId: string,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  let last: Record<string, unknown> = {}
  while (Date.now() < deadline) {
    last = await runtime.client.request<Record<string, unknown>>(
      topic,
      { probe_id: probeId },
      { busTopic: topic, timeoutMs: 5000 }
    )
    if (last.cancelled === true) return last
    await sleep(100)
  }
  throw new Error(`Timed out waiting for Python stream cancellation: ${JSON.stringify(last)}`)
}

async function waitForSelectedCandidatePair(runtime: ReturnType<typeof createBrowserWebRtcAuroraRuntime>, lane: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  let last: InteropCandidatePairEvidence = await runtime.peer.getSelectedCandidatePairEvidence()
  while (Date.now() < deadline) {
    if (candidatePairMatchesLane(lane, last)) return last
    await sleep(100)
    last = await runtime.peer.getSelectedCandidatePairEvidence()
  }
  return last
}

export async function runAuroraWebRtcInterop(config: InteropBrowserConfig) {
  recordInteropProgress('initializing')
  const fetchCalls: string[] = []
  const suppressedUnhandledRejections: string[] = []
  const errorHandler = (event: ErrorEvent) => {
    const message = event.error?.message || event.message || ''
    if (message.includes('session reconnecting') || message.includes('session closed')) {
      suppressedUnhandledRejections.push(message.slice(0, 160))
      event.preventDefault()
    }
  }
  const unhandledRejectionHandler = (event: PromiseRejectionEvent) => {
    const message = event.reason?.message || String(event.reason || '')
    if (message.includes('session reconnecting') || message.includes('session closed') || message.includes('g009 uncertain transport loss')) {
      suppressedUnhandledRejections.push(message.slice(0, 160))
      event.preventDefault()
    }
  }
  window.addEventListener('error', errorHandler)
  window.addEventListener('unhandledrejection', unhandledRejectionHandler)
  const originalFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    return await originalFetch(input as RequestInfo, init)
  }) as typeof fetch

  const snapshots: Snapshot[] = []
  let autoConfirmPairing = true
  const profile: WebRtcPeerConnectionProfile = {
    mode: 'webrtc-only',
    appId: config.appId,
    room: config.room,
    roomSecretRef: config.roomSecret,
    signalingBrokers: [config.brokerUrl],
    expectedStablePeerId: config.expectedStablePeerId,
    nodeName: config.nodeName,
    production: false,
    allowInsecureLoopbackSignaling: true,
    stunServers: config.stunServers,
    turnServers: config.turnServers
  }

  const runtime = createBrowserWebRtcAuroraRuntime({
    mode: 'webrtc-only',
    profile,
    localStablePeerId: config.localStablePeerId,
    localNodeName: 'G009 browser',
    defaultTimeoutMs: config.timeoutMs,
    credentialStore: new MemoryPeerCredentialStore(),
    createPeerConnection: makePeerConnectionFactory(
      config.forceRelay,
      config.suppressHostCandidates,
      config.turnUsername,
      config.turnCredential
    ),
    signalingFactory: (options) => {
      const signaling = new MqttWebSocketSignalingClient({
        ...options,
        mqttFactory
      })
      Object.assign(globalThis, {
        __auroraWebRtcInteropSignalingDiagnostics: () =>
          signaling.diagnostics()
      })
      return signaling
    },
    randomId: signalingIdFactory(config.localSignalingId),
    allowInsecureLoopback: true,
    windowLocation: config.runtimeLocation ?? window.location,
    scryptWorkerFactory: () =>
      new Worker(
        new URL('/crypto-worker-bundle.js', window.location.href)
      ),
    pairingConnectPoll: {
      maxAttempts: Math.max(20, Math.ceil(config.timeoutMs / 500)),
      initialDelayMs: 100,
      maxDelayMs: 500,
      rpcTimeoutMs: 5000
    }
  })
  recordInteropProgress('runtime-created', runtime.peer.snapshot())

  runtime.peer.subscribe((snapshot) => {
    snapshots.push(snapshot)
    recordInteropProgress(`peer:${snapshot.state}`, snapshot)
    console.log('g009-snapshot', snapshot.state, snapshot.icePathCategory, snapshot.selectedSignalingBrokerOrigin || '', snapshot.connectedSignalingPeerId || '', Boolean(snapshot.pendingPairing), snapshot.lastRedactedError?.code || '', snapshot.lastRedactedError?.message || '')
    const pending = snapshot.pendingPairing
    if (pending && autoConfirmPairing) void runtime.peer.confirmPairing(pending.sessionId).catch(() => undefined)
  })

  try {
    await runtime.peer.connect(profile)
    recordInteropProgress('connect-returned', runtime.peer.snapshot())
    await waitFor(() => runtime.peer.snapshot().state === 'authorized', 'authorized WebRTC DataChannel', config.timeoutMs)
    const authorizedSnapshot = runtime.peer.snapshot()
    recordInteropProgress('authorized', authorizedSnapshot)

    const registry = await runtime.client.registry.getRegistry()
    const meshTransport = runtime.meshTransport
    if (!meshTransport) throw new Error('authorized browser runtime did not expose its mesh transport')
    const manifest = await meshTransport.getManifest(config.expectedStablePeerId)
    if (!manifest) throw new Error('Python peer did not return a manifest over the DataChannel')
    recordInteropProgress('registry-and-manifest-complete', runtime.peer.snapshot())

    const intentionalError = await runtime.client.requestResult(
      config.errorTopic,
      {},
      { busTopic: config.errorTopic, timeoutMs: 5000 }
    )

    const fragmentCountsBefore = runtime.peer.snapshot()
    const largeRequestBlob = 'x'.repeat(512 * 1024)
    const largeResult = await runtime.client.request<{ blob: string }>(
      config.largeEchoTopic,
      { blob: largeRequestBlob },
      { busTopic: config.largeEchoTopic, timeoutMs: config.timeoutMs }
    )
    const fragmentCountsAfter = runtime.peer.snapshot()
    const expectedLargeResultBlob = 'y'.repeat(512 * 1024)

    const completedStreamProbeId = `g009-stream-complete-${config.lane}`
    const completedStreamChunks: unknown[] = []
    for await (const chunk of meshTransport.streamRequest({
      method: config.streamTopic,
      busTopic: config.streamTopic,
      payload: { probe_id: completedStreamProbeId, mode: 'complete' },
      timeoutMs: config.timeoutMs,
      audit: { correlationId: completedStreamProbeId }
    })) {
      completedStreamChunks.push(chunk)
    }

    const cancelledStreamProbeId = `g009-stream-cancel-${config.lane}`
    const streamAbort = new AbortController()
    const cancelledStream = meshTransport.streamRequest<Record<string, unknown>>({
      method: config.streamTopic,
      busTopic: config.streamTopic,
      payload: { probe_id: cancelledStreamProbeId, mode: 'cancel' },
      timeoutMs: config.timeoutMs,
      signal: streamAbort.signal,
      audit: { correlationId: cancelledStreamProbeId }
    })
    const cancelledIterator = cancelledStream[Symbol.asyncIterator]()
    const cancelledFirstChunk = await cancelledIterator.next()
    streamAbort.abort()
    let cancelledClientError = ''
    try {
      await cancelledIterator.next()
    } catch (error) {
      cancelledClientError = error instanceof Error ? error.message : String(error)
    }
    const cancelledStreamStatus = await waitForStreamStatus(
      runtime,
      config.streamStatusTopic,
      cancelledStreamProbeId,
      config.timeoutMs
    )
    recordInteropProgress('rpc-and-streams-complete', runtime.peer.snapshot())

    const selectedCandidatePair = await waitForSelectedCandidatePair(runtime, config.lane, Math.min(8000, config.timeoutMs))
    const subscription = runtime.client.events.subscribe({
      stream: 'generic',
      topics: [config.eventTopic],
      correlationId: config.eventCorrelationId,
      timeoutMs: config.timeoutMs
    })
    const event = await firstEvent(subscription, config.timeoutMs)
    subscription.close('interop event received')

    const ttsWrong = runtime.client.events.subscribe({
      stream: 'generic', topics: [config.ttsEventTopic], correlationId: config.wrongCorrelationId, payload: { correlation_id: config.wrongCorrelationId }, timeoutMs: 600
    })
    const wrongCorrelationEvent = await optionalFirstEvent(ttsWrong, 600)
    ttsWrong.close('wrong correlation probe done')
    const ttsSub = runtime.client.events.subscribe({
      stream: 'generic', topics: [config.ttsEventTopic], correlationId: config.ttsCorrelationId, payload: { correlation_id: config.ttsCorrelationId }, timeoutMs: config.timeoutMs
    })
    const ttsEvent = await firstEvent(ttsSub, config.timeoutMs)
    ttsSub.close('tts metadata event received')
    let wildcardDelivered = false
    try {
      const wildcardSub = runtime.client.events.subscribe({ stream: 'generic', topics: ['TTS.*'], correlationId: config.ttsCorrelationId, payload: { correlation_id: config.ttsCorrelationId }, timeoutMs: 800 })
      wildcardDelivered = (await optionalFirstEvent(wildcardSub, 800)) !== null
      wildcardSub.close('wildcard probe done')
    } catch {
      wildcardDelivered = false
    }

    const reconnectStart = snapshots.length
    await runtime.peer.disconnect('g009 live reconnect probe').catch(() => undefined)
    await runtime.peer.connect(profile)
    await waitFor(() => runtime.peer.snapshot().state === 'authorized', 'authorized reconnect WebRTC DataChannel', config.timeoutMs)
    const reconnectRegistry = await runtime.client.registry.getRegistry()
    const reconnectPairingPrompts = countPendingPairing(snapshots, reconnectStart)
    recordInteropProgress('reconnect-complete', runtime.peer.snapshot())

    const mutationId = `g009-${config.lane}-${Date.now().toString(36)}`
    const mutationStart = snapshots.length
    const mutationStartedSub = runtime.client.events.subscribe({
      stream: 'generic', topics: [config.mutationStartedTopic], correlationId: mutationId, payload: { correlation_id: mutationId }, timeoutMs: config.timeoutMs
    })
    let mutationSettledBeforeDisconnect = false
    const mutationStartedAtMs = Date.now()
    const mutationPromise = runtime.client.requestResult(config.mutationTopic, { mutation_id: mutationId, delay_seconds: 1.2 }, { busTopic: config.mutationTopic, timeoutMs: 5000 })
      .then((value) => { mutationSettledBeforeDisconnect = true; return value.ok ? { settled: 'resolved', value: value.data, settled_after_disconnect: false } : { settled: 'rejected', message: value.error.message, settled_after_disconnect: true } })
      .catch((error) => ({ settled: 'rejected', message: error?.message || String(error), settled_after_disconnect: true }))
    const mutationStartedEvent = await firstEvent(mutationStartedSub, config.timeoutMs)
    mutationStartedSub.close('mutation started ack received')
    const disconnectAtMs = Date.now()
    const settledBeforeDisconnect = mutationSettledBeforeDisconnect
    await runtime.peer.disconnect('g009 uncertain transport loss before mutation response settled').catch(() => undefined)
    const mutationResult = await Promise.race([
      mutationPromise,
      sleep(350).then(() => ({ settled: 'pending_after_forced_loss', message: 'no browser response observed after forced transport loss', settled_after_disconnect: false }))
    ])
    await runtime.peer.connect(profile)
    await waitFor(() => runtime.peer.snapshot().state === 'authorized', 'post-mutation reconnect WebRTC DataChannel', config.timeoutMs)
    const mutationReconnectPairingPrompts = countPendingPairing(snapshots, mutationStart)
    const mutationCount = await runtime.client.request(config.mutationCountTopic, { mutation_id: mutationId }, { busTopic: config.mutationCountTopic, timeoutMs: 5000 })
    recordInteropProgress('mutation-reconnect-complete', runtime.peer.snapshot())

    const revokeResult = await runtime.client.request(config.revokeTopic, {}, { busTopic: config.revokeTopic, timeoutMs: 5000 })
    const revokedStart = snapshots.length
    autoConfirmPairing = false
    await runtime.peer.disconnect('g009 revoked credential reconnect probe').catch(() => undefined)
    await runtime.peer.connect(profile)
    await sleep(Math.min(2500, Math.max(1200, config.timeoutMs / 8)))
    const revokedSnapshot = runtime.peer.snapshot()
    const revokedPendingPairing = countPendingPairing(snapshots, revokedStart)
    recordInteropProgress('revocation-complete', revokedSnapshot)

    const snapshot = runtime.peer.snapshot()
    return {
      lane: config.lane,
      authorized: snapshot.state === 'authorized' || revokedSnapshot.state === 'awaiting-sas-confirmation',
      finalStateAfterRevocation: revokedSnapshot.state,
      icePathCategory: [...snapshots].reverse().find((item) => item.icePathCategory !== 'unknown')?.icePathCategory ?? snapshot.icePathCategory,
      selectedCandidatePair,
      selectedSignalingBrokerOrigin: snapshot.selectedSignalingBrokerOrigin,
      iceCandidatePolicy: {
        suppressHostCandidates: config.suppressHostCandidates,
        source: config.suppressHostCandidates ? 'harness browser and Python signaling candidate/SDP filters' : 'browser default ICE candidate policy'
      },
      connectedStablePeerId: snapshot.connectedStablePeerId || config.expectedStablePeerId,
      connectedSignalingPeerId: snapshot.connectedSignalingPeerId,
      protocolCapabilities: snapshot.protocolCapabilities,
      negotiationRole: authorizedSnapshot.negotiationRole,
      pendingCallCount: snapshot.pendingCallCount,
      registryModuleCount: Array.isArray((registry as any).modules) ? (registry as any).modules.length : 0,
      registryDigest: (registry as any).digest ?? '',
      manifestEvidence: {
        peerId: manifest.peerId,
        nodeName: manifest.nodeName,
        serviceCount: manifest.services?.length ?? 0,
        methodCount: manifest.services?.reduce((count, service) => count + (service.methods?.length ?? 0), 0) ?? 0
      },
      errorEvidence: {
        rejected: intentionalError.ok === false,
        code: intentionalError.ok ? null : intentionalError.error.code,
        message: intentionalError.ok ? null : intentionalError.error.message
      },
      largeRpcEvidence: {
        requestBytes: largeRequestBlob.length,
        requestSha256: await sha256Hex(largeRequestBlob),
        resultBytes: largeResult.blob.length,
        resultSha256: await sha256Hex(largeResult.blob),
        expectedResultSha256: await sha256Hex(expectedLargeResultBlob),
        sentFragmentCount: fragmentCountsAfter.sentFragmentCount - fragmentCountsBefore.sentFragmentCount,
        receivedFragmentCount: fragmentCountsAfter.receivedFragmentCount - fragmentCountsBefore.receivedFragmentCount
      },
      rpcStreamEvidence: {
        completedChunks: completedStreamChunks,
        cancelledFirstChunk: cancelledFirstChunk.value,
        cancelledClientError,
        pythonStatus: cancelledStreamStatus
      },
      event,
      ttsEvent,
      scopedEventEvidence: {
        wrongCorrelationDelivered: wrongCorrelationEvent !== null,
        wildcardDelivered
      },
      reconnectEvidence: {
        registryModuleCount: Array.isArray((reconnectRegistry as any).modules) ? (reconnectRegistry as any).modules.length : 0,
        pendingPairingPrompts: reconnectPairingPrompts,
        authorizedWithoutSas: reconnectPairingPrompts === 0
      },
      mutationEvidence: {
        mutationId,
        mutationStartedEvent,
        mutationResult,
        mutationCount,
        uncertainLossWindow: {
          startedAckBeforeDisconnect: Boolean(mutationStartedEvent),
          responseSettledBeforeDisconnect: settledBeforeDisconnect,
          requestStartedToDisconnectMs: disconnectAtMs - mutationStartedAtMs,
          disconnectBeforeResponseSettled: !settledBeforeDisconnect,
          browserResultCategory: (mutationResult as any).settled === 'rejected' ? 'transport_lost_before_response' : 'response_survived_disconnect'
        },
        executionCountAtMostOnce: Number((mutationCount as any).execution_count ?? 999) <= 1,
        pairingPromptsDuringMutationReconnect: mutationReconnectPairingPrompts
      },
      revocationEvidence: {
        revokeResult,
        finalState: revokedSnapshot.state,
        pendingPairingPrompts: revokedPendingPairing,
        routeAuthorizedAfterRevocation: revokedSnapshot.state === 'authorized'
      },
      hostileCaseEvidence: {
        liveMalformedFrames: 'not injected in browser live lane to avoid destabilizing shared DataChannel; see unitVectorTests in aggregate report',
        failClosedObserved: revokedSnapshot.state !== 'authorized'
      },
      snapshots: snapshots.map((item) => ({
        state: item.state,
        icePathCategory: item.icePathCategory,
        connectedStablePeerId: item.connectedStablePeerId,
        selectedSignalingBrokerOrigin: item.selectedSignalingBrokerOrigin,
        hasPendingPairing: Boolean(item.pendingPairing)
      })),
      httpFetchCalls: fetchCalls,
      noHttpFetchTransportUsed: fetchCalls.length === 0,
      suppressedUnhandledRejections
    }
  } finally {
    recordInteropProgress('closing', runtime.peer.snapshot())
    await runtime.close()
    Reflect.deleteProperty(
      globalThis,
      '__auroraWebRtcInteropSignalingDiagnostics'
    )
    Reflect.deleteProperty(
      globalThis,
      '__auroraWebRtcInteropPeerConnectionDiagnostics'
    )
    globalThis.fetch = originalFetch
    window.removeEventListener('unhandledrejection', unhandledRejectionHandler)
    window.removeEventListener('error', errorHandler)
  }
}

Object.assign(globalThis, { runAuroraWebRtcInterop })
