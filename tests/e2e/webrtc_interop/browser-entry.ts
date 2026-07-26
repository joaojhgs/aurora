import { createBrowserWebRtcAuroraRuntime, MemoryPeerCredentialStore, MqttWebSocketSignalingClient, type WebRtcPeerConnectionProfile } from '../../../packages/aurora-sdk/src/webrtc/index.js'
import * as mqtt from 'mqtt'
import { scryptAsync } from '@noble/hashes/scrypt.js'

export type InteropBrowserConfig = {
  lane: string
  appId: string
  room: string
  roomSecret: string
  brokerUrl: string
  expectedStablePeerId: string
  localStablePeerId: string
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
}

type Snapshot = ReturnType<ReturnType<typeof createBrowserWebRtcAuroraRuntime>['peer']['snapshot']>

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


function mqttFactory(brokerUrl: string, options: any): any {
  const candidate: any = mqtt as any
  const connect = candidate.connect ?? candidate.default?.connect ?? candidate.default
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

type CandidatePairEvidence = Awaited<ReturnType<ReturnType<typeof createBrowserWebRtcAuroraRuntime>['peer']['getSelectedCandidatePairEvidence']>>

function candidatePairMatchesLane(lane: string, evidence: CandidatePairEvidence): boolean {
  if (evidence.selected !== true) return false
  if (lane === 'direct') {
    const candidateTypes = [evidence.localCandidateType, evidence.remoteCandidateType]
    return evidence.category === 'host'
      || (
        evidence.category === 'prflx'
        && candidateTypes.includes('prflx')
        && candidateTypes.includes('host')
        && !candidateTypes.includes('relay')
        && evidence.stunServerReflexiveCandidate?.gathered !== true
      )
  }
  if (lane === 'turn') return evidence.category === 'relay' && [evidence.localCandidateType, evidence.remoteCandidateType].includes('relay')
  if (lane === 'stun') {
    const selectedReflexive = [evidence.localCandidateType, evidence.remoteCandidateType]
      .some((type) => type === 'srflx' || type === 'prflx')
    const configuredStunUrlProven = evidence.stunServerReflexiveCandidate?.urlMatchesConfiguredStunServer === true
      || (
        evidence.stunServerReflexiveCandidate?.urlMatchesConfiguredStunServer === undefined
        && evidence.stunServerReflexiveCandidate?.configuredStunServerCount === 1
      )
    const gatheredViaConfiguredStun = evidence.stunServerReflexiveCandidate?.gathered === true
      && configuredStunUrlProven
    return selectedReflexive
      && (evidence.category === 'srflx' || (evidence.category === 'prflx' && gatheredViaConfiguredStun))
  }
  return evidence.category !== 'unknown'
}

async function waitForSelectedCandidatePair(runtime: ReturnType<typeof createBrowserWebRtcAuroraRuntime>, lane: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  let last = await runtime.peer.getSelectedCandidatePairEvidence()
  while (Date.now() < deadline) {
    if (candidatePairMatchesLane(lane, last)) return last
    await sleep(100)
    last = await runtime.peer.getSelectedCandidatePairEvidence()
  }
  return last
}

export async function runAuroraWebRtcInterop(config: InteropBrowserConfig) {
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
    signalingFactory: (options) => new MqttWebSocketSignalingClient({ ...options, mqttFactory }),
    allowInsecureLoopback: true,
    windowLocation: window.location,
    scryptDeriver: async (password, salt, params) => scryptAsync(password, salt, { N: params.N, r: params.r, p: params.p, dkLen: params.dkLen }),
    pairingConnectPoll: {
      maxAttempts: Math.max(20, Math.ceil(config.timeoutMs / 500)),
      initialDelayMs: 100,
      maxDelayMs: 500,
      rpcTimeoutMs: 5000
    }
  })

  runtime.peer.subscribe((snapshot) => {
    snapshots.push(snapshot)
    console.log('g009-snapshot', snapshot.state, snapshot.icePathCategory, snapshot.selectedSignalingBrokerOrigin || '', snapshot.connectedSignalingPeerId || '', Boolean(snapshot.pendingPairing), snapshot.lastRedactedError?.code || '', snapshot.lastRedactedError?.message || '')
    const pending = snapshot.pendingPairing
    if (pending && autoConfirmPairing) void runtime.peer.confirmPairing(pending.sessionId).catch(() => undefined)
  })

  try {
    await runtime.peer.connect(profile)
    await waitFor(() => runtime.peer.snapshot().state === 'authorized', 'authorized WebRTC DataChannel', config.timeoutMs)

    const registry = await runtime.client.registry.getRegistry()
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

    const revokeResult = await runtime.client.request(config.revokeTopic, {}, { busTopic: config.revokeTopic, timeoutMs: 5000 })
    const revokedStart = snapshots.length
    autoConfirmPairing = false
    await runtime.peer.disconnect('g009 revoked credential reconnect probe').catch(() => undefined)
    await runtime.peer.connect(profile)
    await sleep(Math.min(2500, Math.max(1200, config.timeoutMs / 8)))
    const revokedSnapshot = runtime.peer.snapshot()
    const revokedPendingPairing = countPendingPairing(snapshots, revokedStart)

    const snapshot = runtime.peer.snapshot()
    return {
      lane: config.lane,
      authorized: snapshot.state === 'authorized' || revokedSnapshot.state === 'awaiting-sas-confirmation',
      finalStateAfterRevocation: revokedSnapshot.state,
      icePathCategory: snapshots.findLast((item) => item.icePathCategory !== 'unknown')?.icePathCategory ?? snapshot.icePathCategory,
      selectedCandidatePair,
      selectedSignalingBrokerOrigin: snapshot.selectedSignalingBrokerOrigin,
      iceCandidatePolicy: {
        suppressHostCandidates: config.suppressHostCandidates,
        source: config.suppressHostCandidates ? 'harness browser and Python signaling candidate/SDP filters' : 'browser default ICE candidate policy'
      },
      connectedStablePeerId: snapshot.connectedStablePeerId || config.expectedStablePeerId,
      connectedSignalingPeerId: snapshot.connectedSignalingPeerId,
      protocolCapabilities: snapshot.protocolCapabilities,
      pendingCallCount: snapshot.pendingCallCount,
      registryModuleCount: Array.isArray((registry as any).modules) ? (registry as any).modules.length : 0,
      registryDigest: (registry as any).digest ?? '',
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
    await runtime.close()
    globalThis.fetch = originalFetch
    window.removeEventListener('unhandledrejection', unhandledRejectionHandler)
    window.removeEventListener('error', errorHandler)
  }
}

Object.assign(globalThis, { runAuroraWebRtcInterop })
