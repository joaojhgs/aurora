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
  finalStateAfterRevocation: string
  selectedCandidatePair: InteropCandidatePairEvidence
  selectedSignalingBrokerOrigin?: string
  connectedStablePeerId?: string
  pendingCallCount: number
  registryModuleCount: number
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
