export type InteropCandidatePairEvidence = {
  selected?: boolean
  category?: string
  localCandidateType?: string
  remoteCandidateType?: string
  stunServerReflexiveCandidate?: {
    gathered?: boolean
    urlMatchesConfiguredStunServer?: boolean
    configuredStunServerCount?: number
  }
}

export type InteropBrowserResult = {
  authorized: boolean
  negotiationRole?: 'unknown' | 'offerer' | 'answerer'
  finalStateAfterRevocation: string
  selectedCandidatePair: InteropCandidatePairEvidence
  selectedSignalingBrokerOrigin?: string
  connectedStablePeerId?: string
  pendingCallCount: number
  registryModuleCount: number
  manifestEvidence: {
    peerId: string
    nodeName?: string | null
    serviceCount: number
    methodCount: number
  }
  errorEvidence: {
    rejected: boolean
    code: string | null
    message: string | null
  }
  largeRpcEvidence: {
    requestBytes: number
    requestSha256: string
    resultBytes: number
    resultSha256: string
    expectedResultSha256: string
    sentFragmentCount: number
    receivedFragmentCount: number
  }
  rpcStreamEvidence: {
    completedChunks: unknown[]
    cancelledFirstChunk: unknown
    cancelledClientError: string
    pythonStatus: Record<string, unknown>
  }
  event: unknown
  ttsEvent: unknown
  scopedEventEvidence: {
    wrongCorrelationDelivered: boolean
    wildcardDelivered: boolean
  }
  reconnectEvidence: {
    registryModuleCount: number
    pendingPairingPrompts: number
    authorizedWithoutSas: boolean
  }
  mutationEvidence: {
    executionCountAtMostOnce: boolean
    pairingPromptsDuringMutationReconnect: number
    uncertainLossWindow: {
      startedAckBeforeDisconnect: boolean
      disconnectBeforeResponseSettled: boolean
    }
  }
  revocationEvidence: {
    finalState: string
    pendingPairingPrompts: number
    routeAuthorizedAfterRevocation: boolean
  }
  hostileCaseEvidence: {
    failClosedObserved: boolean
  }
  httpFetchCalls: string[]
  noHttpFetchTransportUsed: boolean
}

export type InteropResultExpectations = {
  lane: string
  expectedStablePeerId: string
  expectedNegotiationRole: 'offerer' | 'answerer'
  expectedErrorMessage?: string
}

export type InteropNetworkRequest = {
  url: string
}

export function redactInteropSeededText(
  value: string,
  seededSecrets: readonly string[],
): string {
  return seededSecrets.reduce(
    (redacted, secret) =>
      secret ? redacted.replaceAll(secret, '[REDACTED]') : redacted,
    value,
  )
}

export function redactInteropArtifactValue<T>(
  value: T,
  seededSecrets: readonly string[],
): T {
  return JSON.parse(
    redactInteropSeededText(
      JSON.stringify(value ?? null),
      seededSecrets,
    ),
  ) as T
}

export function assertNoInteropSeededSecrets(
  value: unknown,
  seededSecrets: readonly string[],
): void {
  const serialized = JSON.stringify(value ?? null)
  const leakedSecretCount = seededSecrets.filter(
    (secret) => Boolean(secret) && serialized.includes(secret),
  ).length
  if (leakedSecretCount > 0) {
    throw new Error(
      `WebRTC interop artifact contains ${leakedSecretCount} seeded secret value(s)`,
    )
  }
}

export function candidatePairMatchesLane(
  lane: string,
  evidence: InteropCandidatePairEvidence,
): boolean {
  if (evidence.selected !== true) return false
  if (lane === 'direct') {
    const candidateTypes = [
      evidence.localCandidateType,
      evidence.remoteCandidateType,
    ]
    return (
      evidence.category === 'host' ||
      (evidence.category === 'prflx' &&
        candidateTypes.includes('prflx') &&
        candidateTypes.includes('host') &&
        !candidateTypes.includes('relay') &&
        evidence.stunServerReflexiveCandidate?.gathered !== true)
    )
  }
  if (lane === 'turn') {
    return (
      evidence.category === 'relay' &&
      [evidence.localCandidateType, evidence.remoteCandidateType].includes(
        'relay',
      )
    )
  }
  if (lane === 'stun') {
    const selectedReflexive = [
      evidence.localCandidateType,
      evidence.remoteCandidateType,
    ].some((type) => type === 'srflx' || type === 'prflx')
    const configuredStunUrlProven =
      evidence.stunServerReflexiveCandidate
        ?.urlMatchesConfiguredStunServer === true ||
      (evidence.stunServerReflexiveCandidate
        ?.urlMatchesConfiguredStunServer === undefined &&
        evidence.stunServerReflexiveCandidate
          ?.configuredStunServerCount === 1)
    const gatheredViaConfiguredStun =
      evidence.stunServerReflexiveCandidate?.gathered === true &&
      configuredStunUrlProven
    return (
      selectedReflexive &&
      (evidence.category === 'srflx' ||
        (evidence.category === 'prflx' && gatheredViaConfiguredStun))
    )
  }
  return evidence.category !== 'unknown'
}

export function collectInteropAssertionFailures(
  result: InteropBrowserResult,
  expectations: InteropResultExpectations,
): string[] {
  const failures: string[] = []
  const check = (condition: boolean, message: string) => {
    if (!condition) failures.push(message)
  }

  check(result.authorized === true, 'peer was not authorized')
  check(
    candidatePairMatchesLane(
      expectations.lane,
      result.selectedCandidatePair,
    ),
    `selected ICE candidate pair did not prove the ${expectations.lane} lane`,
  )
  check(
    result.connectedStablePeerId === expectations.expectedStablePeerId,
    `connected stable peer ID was ${String(result.connectedStablePeerId)}`,
  )
  check(
    result.negotiationRole === expectations.expectedNegotiationRole,
    `negotiation role was ${String(result.negotiationRole)}`,
  )
  check(
    Boolean(result.selectedSignalingBrokerOrigin),
    'selected signaling broker origin was not recorded',
  )
  check(
    result.registryModuleCount > 0,
    'registry did not contain any modules',
  )
  check(result.pendingCallCount === 0, 'RPC calls remained pending')
  check(Boolean(result.event), 'general event was not delivered')
  check(Boolean(result.ttsEvent), 'TTS event was not delivered')
  check(
    result.scopedEventEvidence.wrongCorrelationDelivered === false,
    'wrong-correlation event was delivered',
  )
  check(
    result.scopedEventEvidence.wildcardDelivered === false,
    'wildcard subscription received a scoped event',
  )
  check(
    result.manifestEvidence.peerId === expectations.expectedStablePeerId,
    `manifest peer ID was ${result.manifestEvidence.peerId}`,
  )
  check(
    result.manifestEvidence.serviceCount > 0,
    'manifest did not contain services',
  )
  check(
    result.manifestEvidence.methodCount > 0,
    'manifest did not contain methods',
  )
  check(
    result.errorEvidence.rejected === true,
    'intentional RPC error was not rejected',
  )
  check(
    result.errorEvidence.code === 'unknown',
    `intentional RPC error code was ${String(result.errorEvidence.code)}`,
  )
  check(
    (result.errorEvidence.message ?? '').includes(
      expectations.expectedErrorMessage ??
        'intentional interop RPC failure',
    ),
    'intentional RPC error message was not preserved',
  )
  check(
    result.largeRpcEvidence.requestBytes === 512 * 1024,
    `large RPC request was ${result.largeRpcEvidence.requestBytes} bytes`,
  )
  check(
    result.largeRpcEvidence.resultBytes === 512 * 1024,
    `large RPC response was ${result.largeRpcEvidence.resultBytes} bytes`,
  )
  check(
    result.largeRpcEvidence.resultSha256 ===
      result.largeRpcEvidence.expectedResultSha256,
    'large RPC response digest did not match',
  )
  check(
    result.largeRpcEvidence.sentFragmentCount > 1,
    'large RPC request did not fragment',
  )
  check(
    result.largeRpcEvidence.receivedFragmentCount > 1,
    'large RPC response did not fragment',
  )
  check(
    result.rpcStreamEvidence.completedChunks.length === 2,
    `completed stream returned ${result.rpcStreamEvidence.completedChunks.length} chunks`,
  )
  check(
    Boolean(result.rpcStreamEvidence.cancelledFirstChunk),
    'cancelled stream did not deliver its first chunk',
  )
  check(
    result.rpcStreamEvidence.cancelledClientError.includes('timed out'),
    'cancelled stream did not surface the expected client timeout',
  )
  check(
    result.rpcStreamEvidence.pythonStatus.started === true &&
      result.rpcStreamEvidence.pythonStatus.completed === false &&
      result.rpcStreamEvidence.pythonStatus.cancelled === true &&
      result.rpcStreamEvidence.pythonStatus.chunk_count === 1,
    'Python stream cancellation status did not match the protocol contract',
  )
  check(
    result.reconnectEvidence.registryModuleCount > 0,
    'registry did not recover after reconnect',
  )
  check(
    result.reconnectEvidence.authorizedWithoutSas === true,
    'retained peer credentials did not authorize reconnect',
  )
  check(
    result.reconnectEvidence.pendingPairingPrompts === 0,
    'reconnect unexpectedly prompted for pairing',
  )
  check(
    result.mutationEvidence.uncertainLossWindow
      .startedAckBeforeDisconnect === true,
    'mutation start was not acknowledged before disconnect',
  )
  check(
    result.mutationEvidence.uncertainLossWindow
      .disconnectBeforeResponseSettled === true,
    'mutation response settled before the induced disconnect',
  )
  check(
    result.mutationEvidence.executionCountAtMostOnce === true,
    'mutation executed more than once',
  )
  check(
    result.mutationEvidence.pairingPromptsDuringMutationReconnect === 0,
    'mutation reconnect unexpectedly prompted for pairing',
  )
  check(
    result.revocationEvidence.routeAuthorizedAfterRevocation === false,
    'revoked route remained authorized',
  )
  check(
    result.revocationEvidence.pendingPairingPrompts >= 1,
    'revoked peer did not require a new pairing approval',
  )
  check(
    result.finalStateAfterRevocation ===
      result.revocationEvidence.finalState &&
      result.finalStateAfterRevocation !== 'authorized',
    'final state after revocation was inconsistent or authorized',
  )
  check(
    result.hostileCaseEvidence.failClosedObserved === true,
    'revocation did not fail closed',
  )
  check(
    result.noHttpFetchTransportUsed === true,
    'runtime reported HTTP transport use',
  )
  check(
    result.httpFetchCalls.length === 0,
    `runtime recorded ${result.httpFetchCalls.length} HTTP fetch calls`,
  )
  return failures
}

export function assertInteropBrowserResult(
  result: InteropBrowserResult,
  expectations: InteropResultExpectations,
): void {
  const failures = collectInteropAssertionFailures(result, expectations)
  if (failures.length > 0) {
    throw new Error(
      `WebRTC interop assertions failed:\n- ${failures.join('\n- ')}`,
    )
  }
}

export function forbiddenInteropTransportRequests<
  T extends InteropNetworkRequest,
>(
  requests: T[],
  harnessBaseUrl: string,
  brokerUrl: string,
): T[] {
  const harness = new URL(harnessBaseUrl)
  return requests.filter((request) => {
    if (request.url.startsWith(`blob:${harness.origin}/`)) return false
    try {
      const url = new URL(request.url)
      return !(
        (url.hostname === harness.hostname && url.port === harness.port) ||
        request.url.startsWith(brokerUrl)
      )
    } catch {
      return true
    }
  })
}
