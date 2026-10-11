const DEFAULT_TIMEOUT_MS = 120_000

export const NATIVE_TURN_PAIRING_PERMISSIONS = Object.freeze([
  'Gateway.use',
  'Gateway.GetRegistry',
  'Gateway.GetCapabilityCatalog',
  'Gateway.GetCapabilityGraph',
  'Gateway.GetMeshStatus',
  'Gateway.GetWebRTCDiagnostics',
  'Auth.WhoAmI',
  'Auth.MeshListPeers',
  'Auth.MeshGetPeer',
  'Config.use',
  'Orchestrator.use',
  'TTS.use',
  'DB.use',
  'Tooling.use',
  'Scheduler.use',
  'Backup.use',
])

export async function androidEvaluate(client, expression) {
  const response = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  return response?.result?.result?.value
}

export async function clickAndroidControl(client, label) {
  return await androidEvaluate(client, `(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)}
        && !candidate.disabled
        && candidate.getClientRects().length > 0);
    if (!button) return false;
    button.click();
    return true;
  })()`)
}

export async function enterAndroidInvite(client, inviteText, timeoutMs = DEFAULT_TIMEOUT_MS) {
  await waitFor(
    async () => await androidEvaluate(client, `(() => {
      const field = document.querySelector('#mesh-join-invite');
      return field instanceof HTMLTextAreaElement && field.getClientRects().length > 0;
    })()`),
    (value) => value === true,
    'Android invite field',
    timeoutMs,
  )
  const entered = await androidEvaluate(client, `(() => {
    const field = document.querySelector('#mesh-join-invite');
    if (!(field instanceof HTMLTextAreaElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(field, ${JSON.stringify(inviteText.trim())});
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return field.value === ${JSON.stringify(inviteText.trim())};
  })()`)
  if (entered !== true) throw new Error('Android invite field was not available.')
  await waitFor(
    async () => await clickAndroidControl(client, 'Apply invite'),
    (value) => value === true,
    'Android Apply invite control',
    timeoutMs,
  )
  await waitFor(
    async () => await androidEvaluate(client, `(() => document.body?.innerText?.includes('Invite applied') === true)()`),
    (value) => value === true,
    'Android invite application',
    timeoutMs,
  )
}

export async function readAndroidPairReadiness(client) {
  const expression = `(() => {
    const classifyPeerSessionError = (message) => {
      if (!message) return null;
      if (message.includes('Production MQTT signaling requires wss:// broker URLs')) return 'broker_policy_wss_required';
      if (message.includes('ws:// signaling is only allowed for explicit loopback development')) return 'broker_policy_loopback_opt_in_required';
      if (message.includes('ws:// signaling is restricted to loopback development brokers')) return 'broker_policy_loopback_host_required';
      if (message.includes('Browser MQTT signaling requires ws:// or wss:// broker URLs')) return 'broker_policy_unsupported_scheme';
      if (message.startsWith('MQTT signaling failed to connect to ')) {
        return message.includes('Timed out connecting to') ? 'mqtt_connect_timeout' : 'mqtt_signaling_all_brokers_failed';
      }

      switch (message) {
        case 'signaling timeout': return 'signaling_timeout';
        case 'peer discovery timeout': return 'peer_discovery_timeout';
        case 'pairing exchange timeout':
        case 'pairing timeout': return 'pairing_timeout';
        case 'auth timeout': return 'authentication_timeout';
        case 'negotiation timeout': return 'negotiation_timeout';
        case 'remote signaling identity mismatch':
        case 'remote stable identity mismatch':
        case 'remote stable identity changed':
        case 'remote signaling identity changed': return 'peer_identity_mismatch';
        case 'offer missing sdp':
        case 'answer missing sdp': return 'negotiation_protocol_error';
        case 'unexpected data channel label':
        case 'offerer received unexpected data channel': return 'data_channel_protocol_error';
        case 'invalid protocol hello': return 'protocol_hello_invalid';
        case 'preauth frame retry required':
        case 'authorized auth retry required':
        case 'reconnect retry required': return 'authentication_retry_required';
        case 'preauth frame denied':
        case 'authorized auth frame denied':
        case 'reconnect denied': return 'authentication_denied';
        case 'auth port with handleFrame is required': return 'authentication_configuration_missing';
        case 'remote signaling session changed':
        case 'remote signaling session departed': return 'signaling_peer_session_changed';
        case 'data channel closed':
        case 'data channel error':
        case 'peer connection failed':
        case 'peer connection disconnected': return 'peer_transport_disconnected';
        default:
          if (message.startsWith('preauth frame ') || message.startsWith('authorized auth ')) return 'authentication_protocol_error';
          if (message.startsWith('encrypted data channel frame rejected: ')) return 'data_channel_frame_rejected';
          return 'unclassified_peer_session_error';
      }
    };
    const safeLabel = (value) => typeof value === 'string' && /^[a-z0-9_-]{1,64}$/iu.test(value) ? value : null;
    const anchor = [...document.querySelectorAll('button')].slice(0, 2000)
      .find((button) => button.textContent?.trim() === 'Connect device');
    if (!anchor) return { available: false, reason: 'mesh-anchor-absent' };
    const fiberKey = Object.keys(anchor).find((key) => key.startsWith('__reactFiber$'));
    if (!fiberKey) return { available: false, reason: 'react-fiber-getter-absent' };
    let fiber = anchor[fiberKey];
    for (let depth = 0; fiber && depth < 80; depth += 1, fiber = fiber.return) {
      const thinPeer = fiber.memoizedProps?.thinPeer;
      if (!thinPeer || typeof thinPeer.snapshot !== 'function') continue;
      let snapshot;
      try { snapshot = thinPeer.snapshot(); } catch { return { available: false, reason: 'snapshot-getter-failed' }; }
      if (!snapshot || typeof snapshot !== 'object') return { available: false, reason: 'snapshot-unavailable' };
      let selectedSignalingBrokerOrigin = null;
      if (typeof snapshot.selectedSignalingBrokerOrigin === 'string') {
        try {
          const broker = new URL(snapshot.selectedSignalingBrokerOrigin);
          if (['ws:', 'wss:', 'http:', 'https:'].includes(broker.protocol)) selectedSignalingBrokerOrigin = broker.origin;
        } catch {}
      }
      const rawError = snapshot.lastRedactedError;
      const errorCode = safeLabel(rawError?.code);
      const rawMessage = typeof rawError?.message === 'string' ? rawError.message : '';
      // Classify only fixed SDK source messages; never return message text, URL, or credentials.
      const errorCategory = classifyPeerSessionError(rawMessage);
      const lastRedactedError = errorCode && rawMessage
        ? { code: errorCode, messagePresent: true, category: errorCategory }
        : null;
      return {
        available: true,
        status: safeLabel(snapshot.status),
        state: safeLabel(snapshot.state),
        diagnosticCode: errorCode,
        lastRedactedError,
        selectedSignalingBrokerOrigin,
        expectedPeerIdentityPresent: typeof snapshot.expectedStablePeerId === 'string' && snapshot.expectedStablePeerId.length > 0,
        connectedPeerIdentityPresent: typeof snapshot.connectedStablePeerId === 'string' && snapshot.connectedStablePeerId.length > 0,
        pairingSessionIdPresent: typeof snapshot.pairingSessionId === 'string' && snapshot.pairingSessionId.length > 0,
        verificationCodePresent: typeof snapshot.pairingVerificationCode === 'string' && snapshot.pairingVerificationCode.length > 0,
      };
    }
    return { available: false, reason: 'thin-peer-prop-getter-absent' };
  })()`
  let timeout
  try {
    const response = await Promise.race([
      client.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: false,
        timeout: 1_500,
      }),
      new Promise((resolve) => { timeout = setTimeout(() => resolve(null), 1_900) }),
    ])
    const value = response?.result?.result?.value
    if (!value || typeof value !== 'object') return { available: false, reason: 'react-owner-lookup-unavailable' }
    return value
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export function activeAndroidProfileDocument(rawValue) {
  if (typeof rawValue !== 'string' || !rawValue.trim()) throw new Error('Android thin profile is empty.')
  const document = JSON.parse(rawValue)
  if (!document || !Array.isArray(document.profiles)) throw new Error('Android thin profile has no profile list.')
  const active = document.profiles.find((profile) => profile?.id === document.activeProfileId)
  if (!active?.id || !active.localNode?.stablePeerId) throw new Error('Android thin profile has no active stable peer identity.')
  return { document, active }
}

export function matchPendingPairing(pairings, { verificationCode, androidPeerId, expectedDeviceName }) {
  const normalizedCode = String(verificationCode ?? '').replace(/[^a-z0-9]/giu, '').toLowerCase()
  if (!normalizedCode) throw new Error('Android pairing verification code is missing.')
  const matches = (pairings ?? []).filter((pairing) => {
    const candidateCode = String(pairing?.verification_code ?? '').replace(/[^a-z0-9]/giu, '').toLowerCase()
    return pairing?.status === 'pending'
      && candidateCode === normalizedCode
      && (!androidPeerId || pairing.remote_peer_id === androidPeerId)
      && (!expectedDeviceName || pairing.device_name === expectedDeviceName || pairing.remote_node_name === expectedDeviceName)
  })
  if (matches.length !== 1) throw new Error(`Expected exactly one pending Android pairing, found ${matches.length}.`)
  return matches[0]
}

export function assertPairingDiagnostics({ diagnostics, persistedPeers, nativeSession, androidPeerId, pythonPeerId, permissions = NATIVE_TURN_PAIRING_PERMISSIONS }) {
  const diagnostic = (diagnostics?.peers ?? []).find((peer) => peer.stable_peer_id === androidPeerId)
  if (!diagnostic || diagnostic.connection_state !== 'connected' || diagnostic.data_channel_state !== 'open' || diagnostic.auth_state !== 'authenticated') {
    throw new Error(`Android peer is not authenticated on the Python mesh: ${JSON.stringify({ androidPeerId, diagnostic })}`)
  }
  if (Number(diagnostic.effective_permission_count) !== permissions.length) throw new Error('Android effective permission count does not match the approved pairing set.')
  const persisted = (persistedPeers?.peers ?? []).find((peer) => peer.peer_id === androidPeerId)
  if (!persisted || persisted.outbound_status !== 'approved' || persisted.inbound_status !== 'approved' || persisted.connection_status !== 'connected') throw new Error(`Android peer is not bilaterally approved: ${JSON.stringify({ androidPeerId, persisted })}`)
  const granted = [...(persisted.outbound_permissions ?? [])].sort()
  const expected = [...permissions].sort()
  if (granted.length !== expected.length || granted.some((permission, index) => permission !== expected[index])) throw new Error('Android persisted outbound permissions do not match the approved pairing set.')
  if (!nativeSession?.peers?.some((peer) => peer.peerId === pythonPeerId && Number.isInteger(peer.connectionId))) throw new Error(`Android native session has no Python peer connection: ${pythonPeerId}`)
  return { androidPeerId, pythonPeerId, effectivePermissionCount: diagnostic.effective_permission_count, authenticated: true, bilaterallyApproved: true, nativeSessionBound: true }
}

function hasExactPermissions(peer, permissions) {
  const granted = [...(peer?.outbound_permissions ?? [])].sort()
  const expected = [...permissions].sort()
  return granted.length === expected.length && granted.every((permission, index) => permission === expected[index])
}

export async function waitFor(read, predicate, label, timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Timed out waiting for ${label}.`)
}

async function gatewayPost(request, gatewayUrl, apiKey, path, body = {}) {
  const response = await request.post(`${gatewayUrl}${path}`, {
    headers: { 'X-API-Key': apiKey, 'content-type': 'application/json' },
    data: body,
  })
  if (!response.ok()) throw new Error(`${path} failed with status ${response.status()}.`)
  return await response.json()
}

async function approvePairing(request, gatewayUrl, apiKey, pending, permissions, reason) {
  const draft = await gatewayPost(request, gatewayUrl, apiKey, '/api/Gateway/AdminActionDraft', {
    method_id: 'Auth.PairingApprove',
    payload: { code: pending.code, permissions, is_admin: false },
  })
  const confirmation = await gatewayPost(request, gatewayUrl, apiKey, '/api/Gateway/AdminActionConfirm', {
    action_id: draft.action_id,
    nonce: draft.nonce,
    digest: draft.digest,
    reason,
    reauth_confirmed: true,
    phrase: draft.required_phrase,
  })
  const response = await request.post(`${gatewayUrl}/api/Auth/PairingApprove`, {
    headers: {
      'X-API-Key': apiKey,
      'X-Aurora-AdminAction-Id': confirmation.action_id,
      'X-Aurora-AdminAction-Token': confirmation.confirmation_token,
      'X-Aurora-AdminAction-Digest': confirmation.digest,
      'content-type': 'application/json',
    },
    data: { code: pending.code, permissions, is_admin: false },
  })
  if (!response.ok()) throw new Error(`/api/Auth/PairingApprove failed with status ${response.status()}.`)
}

export async function pairFreshPythonWithAndroid({
  android,
  invoke,
  request,
  gatewayUrl,
  gatewayApiKey,
  inviteText,
  pythonPeerId,
  expectedDeviceName,
  permissions = NATIVE_TURN_PAIRING_PERMISSIONS,
  navigateToMesh,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!android?.client || typeof invoke !== 'function' || !request || !gatewayUrl || !gatewayApiKey || !inviteText || !pythonPeerId) throw new Error('Fresh Python pairing requires Android CDP, Tauri invoke, gateway, invite, and Python identity.')
  const stored = await invoke('aurora_thin_profile_get')
  const originalProfileValue = stored?.value
  const { active } = activeAndroidProfileDocument(originalProfileValue)
  const androidPeerId = active.localNode.stablePeerId
  const previousCredential = await invoke('aurora_thin_peer_credential_status', { request: { peerId: pythonPeerId } })
  if (previousCredential?.found !== false) throw new Error(`Python peer ${pythonPeerId} already has an Android credential; refusing to mutate the profile.`)
  const cleanup = createPairingCleanup({ invoke, originalProfileValue, pythonPeerId, previousCredential })
  try {
    if (navigateToMesh) await navigateToMesh(android.client)
    await waitFor(
      async () => await clickAndroidControl(android.client, 'Connect device'),
      (value) => value === true,
      'Android Connect device control',
      timeoutMs,
    )
    await waitFor(
      async () => await clickAndroidControl(android.client, 'Join from an invite'),
      (value) => value === true,
      'Android Join from an invite control',
      timeoutMs,
    )
    await enterAndroidInvite(android.client, inviteText, timeoutMs)
    try {
      await waitFor(
        async () => await clickAndroidControl(android.client, 'Review & approve'),
        (value) => value === true,
        'Android Review & approve control',
        timeoutMs,
      )
    } catch (error) {
      let readiness
      try {
        readiness = await readAndroidPairReadiness(android.client)
      } catch {
        readiness = { available: false, reason: 'diagnostic-unavailable' }
      }
      console.log('AURORA_ANDROID_PAIR_READINESS_FAILURE ' + JSON.stringify(readiness))
      throw error
    }
    const verificationCode = await waitFor(
      async () => await androidEvaluate(android.client, `(() => {
        const code = document.querySelector('[role="dialog"] [aria-label^="Verification code "]');
        return code?.getAttribute('aria-label')?.replace(/^Verification code\\s+/i, '') ?? '';
      })()`),
      (value) => Boolean(value),
      'Android pairing verification code',
      timeoutMs,
    )
    const pending = await waitFor(
      async () => {
        const output = await gatewayPost(request, gatewayUrl, gatewayApiKey, '/api/Auth/ListPendingPairings')
        try { return matchPendingPairing(output.pairings, { verificationCode, androidPeerId, expectedDeviceName }) } catch (error) {
          if (error instanceof Error && /found 0/u.test(error.message)) return null
          throw error
        }
      },
      Boolean,
      'matching Python pending Android pairing',
      timeoutMs,
    )
    await approvePairing(request, gatewayUrl, gatewayApiKey, pending, permissions, 'Verify the fresh Python and Android native pairing.')
    await waitFor(
      async () => await clickAndroidControl(android.client, 'Approve & pair'),
      (value) => value === true,
      'Android Approve & pair control',
      timeoutMs,
    )
    const diagnostics = await waitFor(
      async () => await gatewayPost(request, gatewayUrl, gatewayApiKey, '/api/Gateway/GetWebRTCDiagnostics'),
      (value) => (value?.peers ?? []).some((peer) => peer.stable_peer_id === androidPeerId
        && peer.connection_state === 'connected'
        && peer.data_channel_state === 'open'
        && peer.auth_state === 'authenticated'
        && Number(peer.effective_permission_count) === permissions.length),
      'authenticated Android diagnostic peer',
      timeoutMs,
    )
    const persistedPeers = await waitFor(
      async () => await gatewayPost(request, gatewayUrl, gatewayApiKey, '/api/Auth/MeshListPeers'),
      (value) => (value?.peers ?? []).some((peer) => peer.peer_id === androidPeerId
        && peer.outbound_status === 'approved'
        && peer.inbound_status === 'approved'
        && peer.connection_status === 'connected'
        && hasExactPermissions(peer, permissions)),
      'bilaterally approved Android peer',
      timeoutMs,
    )
    const nativeSession = await waitFor(
      async () => await invoke('aurora_mesh_session_snapshot'),
      (value) => value?.peers?.some((peer) => peer.peerId === pythonPeerId && Number.isInteger(peer.connectionId)),
      'native session binding for the fresh Python peer',
      timeoutMs,
    )
    const evidence = assertPairingDiagnostics({ diagnostics, persistedPeers, nativeSession, androidPeerId, pythonPeerId, permissions })
    return {
      ...evidence,
      verificationCode,
      originalProfileValue,
      cleanup,
    }
  } catch (error) {
    try {
      await cleanup()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Fresh Android pairing and cleanup failed.')
    }
    throw error
  }
}

export function createPairingCleanup({ invoke, originalProfileValue, pythonPeerId, previousCredential }) {
  return async function cleanup() {
    const errors = []
    try {
      if (originalProfileValue !== undefined) {
        const result = await invoke('aurora_thin_profile_set', { value: originalProfileValue })
        if (result?.ok !== true) throw new Error('Android profile restore was not acknowledged.')
        const readback = await invoke('aurora_thin_profile_get')
        if (readback?.value !== originalProfileValue) throw new Error('Android profile restore readback did not match the original value.')
      }
    } catch (error) { errors.push(error) }
    try {
      if (previousCredential?.found === false) {
        const result = await invoke('aurora_thin_peer_credential_delete', { request: { peerId: pythonPeerId } })
        if (result?.found !== false) throw new Error('Python credential deletion was not acknowledged as absent.')
        const status = await invoke('aurora_thin_peer_credential_status', { request: { peerId: pythonPeerId } })
        if (status?.found !== false) throw new Error('Python credential cleanup readback still reports a credential.')
      } else if (previousCredential?.found !== true) {
        throw new Error('Python credential preflight was not an acknowledged found/absent result.')
      }
    } catch (error) { errors.push(error) }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'Android pairing cleanup failed.')
  }
}
