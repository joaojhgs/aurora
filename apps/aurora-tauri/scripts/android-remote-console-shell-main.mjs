import { randomUUID } from 'node:crypto'
import { androidEvaluate, clickAndroidControl, readAndroidPairReadiness } from './android-native-turn-pairing.mjs'

const TIMEOUT_MS = 30_000
const EMPTY_PROFILE = JSON.stringify({ version: 2, activeProfileId: null, profiles: [] })
const SAFE_PAIR_ERROR_CATEGORIES = new Set([
  'broker_policy_wss_required', 'broker_policy_loopback_opt_in_required', 'broker_policy_loopback_host_required',
  'broker_policy_unsupported_scheme', 'mqtt_connect_timeout', 'mqtt_signaling_all_brokers_failed',
  'signaling_timeout', 'peer_discovery_timeout', 'pairing_timeout', 'authentication_timeout',
  'negotiation_timeout', 'peer_identity_mismatch', 'negotiation_protocol_error', 'data_channel_protocol_error',
  'protocol_hello_invalid', 'authentication_retry_required', 'authentication_denied',
  'authentication_configuration_missing', 'signaling_peer_session_changed', 'peer_transport_disconnected',
  'authentication_protocol_error', 'data_channel_frame_rejected', 'unclassified_peer_session_error',
])

export async function runAndroidRemoteConsoleShellMain({ session, restart, originalProfileValue, pairing, deferMainFailure = false }) {
  if (!session?.client || typeof session.invoke !== 'function' || typeof restart !== 'function') {
    throw new Error('Android remote-console main flow is missing its packaged app boundary.')
  }
  if (!pairing?.request || !pairing.gatewayUrl || !pairing.gatewayApiKey || !pairing.inviteText || !pairing.pythonPeerId) {
    throw new Error('Android remote-console main flow requires the owned Python service and invite.')
  }
  if (!Array.isArray(pairing.permissions) || pairing.permissions.length === 0) {
    throw new Error('Android remote-console main flow requires the existing approved Python permission set.')
  }
  const originalDocument = originalProfileValue == null
    ? { version: 2, activeProfileId: null, profiles: [] }
    : parseProfileDocument(originalProfileValue)
  if (originalDocument.version !== 2 || !Array.isArray(originalDocument.profiles)) {
    throw new Error('Android remote-console setup requires a readable current profile document.')
  }
  const invite = parseJson(pairing.inviteText)
  const broker = invite?.signaling?.mqtt_brokers?.[0]
  if (invite?.node?.peer_id !== pairing.pythonPeerId
    || typeof invite?.node?.node_name !== 'string'
    || typeof invite?.signaling?.app_id !== 'string'
    || typeof invite?.signaling?.room !== 'string'
    || typeof invite?.signaling?.room_password !== 'string'
    || typeof broker !== 'string'
    || !['ws:', 'wss:'].includes(safeUrlProtocol(broker))) {
    throw new Error('The owned Python invite did not provide a complete WebRTC connection.')
  }
  const brokerUrl = new URL(broker)
  const loopbackBroker = brokerUrl.protocol === 'ws:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(brokerUrl.hostname.toLowerCase())
  if (brokerUrl.protocol === 'ws:' && !loopbackBroker) {
    throw new Error('The owned Python invite uses an insecure non-loopback WebRTC broker.')
  }

  const invoke = session.invoke
  const profileId = `android-remote-console-${randomUUID()}`
  const stablePeerId = `aurora-local-${randomUUID()}`
  const roomSecretRef = `aurora-android-main:${randomUUID()}`
  const currentCredential = await invoke('aurora_thin_peer_credential_status', { request: { peerId: pairing.pythonPeerId } })
  if (currentCredential?.found !== false) throw new Error('Android already has a credential for the owned Python peer.')
  const roomSecret = invite.signaling.room_password
  let secretMutationAttempted = false
  let secretOwned = false
  let profileMutationAttempted = false
  let configBefore
  let configCommittedRevision
  let configRestored = true
  let profileRestored = false
  let credentialRemoved = false
  let result
  let primaryError
  let mainStage = 'profile_setup'
  let mainOperation = 'save_room_secret'
  const cleanupErrors = []
  const document = {
    ...originalDocument,
    activeProfileId: profileId,
    profiles: [...originalDocument.profiles, {
      version: 2,
      id: profileId,
      label: 'Temporary connected-device check',
      nodeMode: 'remote-console',
      runtimeTier: 'none',
      homeConnection: {
        mode: 'webrtc-only',
        signalingUrl: broker,
        homePeerId: pairing.pythonPeerId,
        webrtcProfile: {
          mode: 'webrtc-only',
          appId: invite.signaling.app_id,
          room: invite.signaling.room,
          roomSecretRef,
          signalingBrokers: [broker],
          ...(loopbackBroker ? { production: false, allowInsecureLoopbackSignaling: true } : {}),
          expectedStablePeerId: pairing.pythonPeerId,
          nodeName: invite.node.node_name,
          requireAppLayerE2ee: invite.webrtc?.enable_app_layer_e2ee === true,
        },
      },
      localNode: {
        nodeName: 'Android remote console main',
        stablePeerId,
        enabledCapabilityPacks: [],
      },
    }],
  }
  const profileValue = JSON.stringify(document)
  try {
    mainOperation = 'save_room_secret'
    secretMutationAttempted = true
    const secretSaved = await invoke('aurora_thin_room_secret_set', { request: { ref: roomSecretRef, value: roomSecret } })
    secretOwned = secretSaved?.ok === true
    if (!secretOwned) throw new Error('Android could not store the temporary connection secret.')
    mainOperation = 'save_remote_console_profile'
    profileMutationAttempted = true
    const saved = await invoke('aurora_thin_profile_set', { value: profileValue })
    if (saved?.ok !== true) throw new Error('Android remote-console profile was not saved.')
    mainOperation = 'verify_remote_console_profile'
    const readback = await invoke('aurora_thin_profile_get')
    if (readback?.value !== profileValue) throw new Error('Android remote-console profile save readback did not match.')
    const activeProfile = parseProfileDocument(readback.value).profiles.find((item) => item.id === profileId)
    if (activeProfile?.nodeMode !== 'remote-console' || activeProfile.runtimeTier !== 'none'
      || activeProfile.localNode?.enabledCapabilityPacks?.length !== 0
      || activeProfile.homeConnection?.homePeerId !== pairing.pythonPeerId) {
      throw new Error('The saved Android profile did not resolve to the expected remote-console role.')
    }

    mainStage = 'profile_restart'
    mainOperation = 'restart_with_remote_console_profile'
    session = await restart()
    mainOperation = 'verify_restarted_profile'
    const bootReadback = await session.invoke('aurora_thin_profile_get')
    const bootActive = parseProfileDocument(bootReadback?.value).profiles.find((item) => item.id === profileId)
    if (bootReadback?.value !== profileValue || bootActive?.nodeMode !== 'remote-console'
      || bootActive.runtimeTier !== 'none' || bootActive.localNode?.stablePeerId !== stablePeerId) {
      throw new Error('Fresh Android launch did not retain the owned remote-console profile.')
    }
    mainStage = 'pairing'
    mainOperation = 'open_connected_devices'
    await navigateMesh(session.client)
    let reviewVisible
    try {
      mainOperation = 'wait_for_pairing_review'
      reviewVisible = await waitFor(async () => await androidEvaluate(session.client, `(() => [...document.querySelectorAll('button')]
        .some(button => button.textContent?.trim() === 'Review & approve' && button.getClientRects().length > 0))()`))
    } catch (error) {
      let readiness
      try { readiness = await readRemoteConsolePairReadiness(session.client) }
      catch { readiness = { available: false, reason: 'diagnostic-unavailable' } }
      let lastRedactedErrorCategory = null
      try {
        const pairReadiness = await readAndroidPairReadiness(session.client)
        const category = pairReadiness?.lastRedactedError?.category
        if (SAFE_PAIR_ERROR_CATEGORIES.has(category)) lastRedactedErrorCategory = category
      } catch {
        // Keep the original approval-readiness failure if the one bounded snapshot is unavailable.
      }
      console.log('AURORA_ANDROID_REMOTE_CONSOLE_REVIEW_READINESS_FAILURE ' + JSON.stringify({
        ...readiness,
        lastRedactedErrorCategory,
      }))
      throw error
    }
    if (!reviewVisible) throw new Error('The remote-console connection did not reach product approval.')
    mainOperation = 'open_pairing_review'
    const clicked = await clickAndroidControl(session.client, 'Review & approve')
    if (clicked !== true) throw new Error('The remote-console approval control was not available.')
    mainOperation = 'read_pairing_code'
    const code = await waitFor(async () => await androidEvaluate(session.client, `(() => document.querySelector('[role="dialog"] code[aria-label^="Verification code "]')?.getAttribute('aria-label')?.replace(/^Verification code\\s+/u, '') ?? '')()`))
    if (typeof code !== 'string' || !code.trim()) throw new Error('The remote-console approval code was not displayed.')
    mainOperation = 'wait_for_pairing_request'
    const pending = await waitFor(async () => {
      const payload = await post(pairing, '/api/Auth/ListPendingPairings')
      const matches = (payload.pairings ?? []).filter((item) => item.status === 'pending'
        && item.remote_peer_id === stablePeerId
        && normalizeCode(item.verification_code) === normalizeCode(code))
      if (matches.length > 1) throw new Error('The remote-console pairing request is ambiguous.')
      return matches[0] ?? null
    })
    if (!pending?.code) throw new Error('The remote-console pairing request was not published by the owned Python host.')
    mainOperation = 'approve_on_gateway'
    await approvePairing(pairing, pending)
    mainOperation = 'confirm_pairing_in_app'
    const accepted = await clickAndroidControl(session.client, 'Approve & pair')
    if (accepted !== true) throw new Error('The Android remote-console approval was not confirmed.')
    mainStage = 'peer_readiness'
    mainOperation = 'verify_authenticated_peer'
    const diagnostics = await waitFor(async () => {
      const value = await post(pairing, '/api/Gateway/GetWebRTCDiagnostics')
      return (value.peers ?? []).find((peer) => peer.stable_peer_id === stablePeerId
        && peer.connection_state === 'connected' && peer.data_channel_state === 'open'
        && peer.auth_state === 'authenticated'
        && Number(peer.effective_permission_count) === pairing.permissions.length) ?? null
    })
    if (!diagnostics) throw new Error('The remote-console connection was not authenticated by the owned Python host.')
    mainOperation = 'verify_saved_peer_credential'
    const credential = await session.invoke('aurora_thin_peer_credential_status', { request: { peerId: pairing.pythonPeerId } })
    if (credential?.found !== true || credential?.credential?.claimantPeerId !== stablePeerId) {
      throw new Error('The remote-console credential did not match the temporary profile identity.')
    }

    mainStage = 'assistant_continuity'
    mainOperation = 'open_assistant'
    await openAssistant(session.client)
    mainOperation = 'read_initial_config'
    const before = await getConfig(pairing)
    if (typeof before !== 'boolean') throw new Error('The owned Python host returned no boolean setting to change.')
    configBefore = before
    const draft = 'draft survives the connected settings update'
    mainOperation = 'verify_initial_shell_health'
    const healthyShellStatus = await androidEvaluate(session.client, `(() => {
      const status = document.querySelector('[aria-label="Aurora shell status"]');
      return Boolean(status && !/needs attention|refresh needed/i.test(status.textContent ?? ''));
    })()`);
    if (healthyShellStatus !== true) throw new Error('The Assistant shell was already reporting a health notice before the config update.')
    mainOperation = 'stage_assistant_draft'
    const marker = await androidEvaluate(session.client, `(() => {
      const workspace = document.querySelector('[data-aurora-part="assistant-workspace"]');
      const prompt = document.querySelector('#assistant-prompt');
      const status = document.querySelector('[aria-label="Aurora shell status"]');
      if (!workspace || !(prompt instanceof HTMLTextAreaElement) || !status) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(prompt, ${JSON.stringify(draft)});
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
      prompt.dispatchEvent(new Event('change', { bubbles: true }));
      const state = { workspace, prompt, status, statusChanged: false };
      const observer = new MutationObserver(() => {
        state.statusChanged ||= /needs attention|refresh needed/i.test(status.textContent ?? '');
      });
      observer.observe(status, { childList: true, subtree: true, characterData: true });
      state.observer = observer;
      window.__auroraPer278RemoteConsoleMain = state;
      return prompt.value === ${JSON.stringify(draft)};
    })()`)
    if (marker !== true) throw new Error('The Assistant draft was not available in the packaged remote-console shell.')
    const change = { key_path: 'ui.dark_mode', value: !before }
    mainStage = 'config_update'
    mainOperation = 'commit_config_change'
    const committed = await commitConfig(pairing, change)
    if (committed?.success !== true || !(committed.changed_paths ?? []).includes('ui.dark_mode')
      || !Number.isInteger(committed.revision)) {
      throw new Error('The owned Python config change was not committed with a revision.')
    }
    configCommittedRevision = committed.revision
    mainOperation = 'verify_draft_after_config_change'
    const observed = await waitFor(async () => await androidEvaluate(session.client, `(() => {
      const state = window.__auroraPer278RemoteConsoleMain;
      const status = document.querySelector('[aria-label="Aurora shell status"]');
      return Boolean(state?.statusChanged && state.workspace?.isConnected && state.prompt?.isConnected
        && state.workspace === document.querySelector('[data-aurora-part="assistant-workspace"]')
        && state.prompt === document.querySelector('#assistant-prompt')
        && state.prompt.value === ${JSON.stringify(draft)}
        && /needs attention|refresh needed/i.test(status?.textContent ?? ''));
    })()`))
    if (observed !== true) throw new Error('The packaged Assistant shell did not retain its draft through the real config update.')
    mainOperation = 'verify_config_readback'
    const configReadback = await getConfig(pairing)
    if (configReadback !== !before) throw new Error('The owned Python config readback did not match the committed value.')
    result = { configUpdated: true, configReadback: true, assistantDraftPreserved: true, assistantDomPreserved: true, remoteConsoleRole: true }
  } catch (error) {
    primaryError = error
  } finally {
    const addCleanup = (label, error) => cleanupErrors.push(new Error(`${label}: ${String(error?.message ?? error)}`))
    try {
      if (configBefore !== undefined) {
        const current = await getConfig(pairing)
        if (current !== configBefore) {
          if (current !== !configBefore || !Number.isInteger(configCommittedRevision)) {
            throw new Error('Config changed outside the owned update; restoration was not attempted.')
          }
          const restored = await commitConfig(
            pairing,
            { key_path: 'ui.dark_mode', value: configBefore },
            configCommittedRevision,
          )
          if (restored?.success !== true || await getConfig(pairing) !== configBefore) {
            throw new Error('Config restoration readback mismatch.')
          }
        }
      }
    } catch (error) {
      configRestored = false
      addCleanup('config_restore', error)
    }
    try {
      if (session?.client) await androidEvaluate(session.client, `window.__auroraPer278RemoteConsoleMain?.observer?.disconnect()`)
    } catch (error) { addCleanup('observer_cleanup', error) }
    if (profileMutationAttempted) {
      try {
        const current = await session.invoke('aurora_thin_profile_get')
        const originalStoredValue = originalProfileValue == null ? EMPTY_PROFILE : originalProfileValue
        if (current?.value === profileValue) {
          const restored = await session.invoke('aurora_thin_profile_set', { value: originalStoredValue })
          if (restored?.ok !== true) throw new Error('Profile restore was rejected.')
        } else if (current?.value !== originalStoredValue
          && !(originalProfileValue == null && current?.value == null)) {
          throw new Error('The current profile document no longer matches the exact temporary remote-console document.')
        }
      } catch (error) { addCleanup('profile_restore', error) }
    } else {
      try {
        const current = await session.invoke('aurora_thin_profile_get')
        const originalStoredValue = originalProfileValue == null ? EMPTY_PROFILE : originalProfileValue
        const semanticEmpty = originalProfileValue == null
          && (current?.value == null || current.value === EMPTY_PROFILE)
        if (originalProfileValue == null ? !semanticEmpty : current?.value !== originalStoredValue) {
          throw new Error('The original Android profile changed before the temporary profile was saved.')
        }
        profileRestored = true
      } catch (error) { addCleanup('profile_restore', error) }
    }
    try {
      const status = await session.invoke('aurora_thin_peer_credential_status', { request: { peerId: pairing.pythonPeerId } })
      if (status?.found === true) {
        if (status?.credential?.claimantPeerId !== stablePeerId) throw new Error('Credential owner changed during remote-console cleanup.')
        const removed = await session.invoke('aurora_thin_peer_credential_delete', { request: { peerId: pairing.pythonPeerId } })
        if (removed?.found !== false) throw new Error('Owned peer credential deletion was not acknowledged.')
        const readback = await session.invoke('aurora_thin_peer_credential_status', { request: { peerId: pairing.pythonPeerId } })
        if (readback?.found !== false) throw new Error('Owned peer credential remains after deletion.')
        credentialRemoved = true
      } else if (status?.found === false) credentialRemoved = true
      else throw new Error('Credential cleanup status was not definitive.')
    } catch (error) { addCleanup('credential_restore', error) }
    if (secretMutationAttempted) {
      try {
        const secret = await session.invoke('aurora_thin_room_secret_get', { request: { ref: roomSecretRef } })
        if (secret?.value === roomSecret) {
          const removed = await session.invoke('aurora_thin_room_secret_delete', { request: { ref: roomSecretRef } })
          if (removed?.ok !== true) throw new Error('Temporary secret deletion was not acknowledged.')
          const readback = await session.invoke('aurora_thin_room_secret_get', { request: { ref: roomSecretRef } })
          if (readback?.value != null) throw new Error('Temporary secret remains after deletion.')
          secretOwned = false
        } else if (secret?.value == null) {
          secretOwned = false
        } else throw new Error('Temporary secret reference no longer identifies this run’s secret.')
      } catch (error) { addCleanup('secret_restore', error) }
    }
    if (profileMutationAttempted) {
      try {
        session = await restart()
        const finalProfile = await session.invoke('aurora_thin_profile_get')
        const originalStoredValue = originalProfileValue == null ? EMPTY_PROFILE : originalProfileValue
        const semanticEmpty = originalProfileValue == null
          && (finalProfile?.value == null || finalProfile.value === EMPTY_PROFILE)
        if (originalProfileValue == null ? !semanticEmpty : finalProfile?.value !== originalStoredValue) {
          throw new Error('Fresh Android launch did not restore the original profile document.')
        }
        profileRestored = true
      } catch (error) { addCleanup('profile_restart', error) }
    }
  }
  const cleanupVerified = cleanupErrors.length === 0
    && configRestored && profileRestored && credentialRemoved && !secretOwned
  if (primaryError) {
    if (deferMainFailure && cleanupVerified) {
      console.log('AURORA_ANDROID_REMOTE_CONSOLE_SHELL_MAIN ' + JSON.stringify({
        ok: false,
        mainFailure: true,
        stage: mainStage,
        operation: mainOperation,
        code: 'phase_failed',
        failureCategory: safeFailureCategory(primaryError),
        errorCode: safeErrorCode(primaryError),
        cleanupVerified: true,
        profileRestored,
        credentialRemoved,
        roomSecretRemoved: !secretOwned,
        configRestored,
      }))
      return { session, mainError: primaryError, cleanupVerified: true }
    }
    const failure = cleanupErrors.length > 0
      ? new AggregateError([primaryError, ...cleanupErrors], 'Android remote-console main and cleanup failed.')
      : primaryError
    failure.androidConnectedCleanupVerified = cleanupVerified
    throw failure
  }
  if (cleanupErrors.length > 0) {
    const failure = new AggregateError(cleanupErrors, 'Android remote-console main cleanup failed.')
    failure.androidConnectedCleanupVerified = false
    throw failure
  }
  if (!result) throw new Error('Android remote-console main did not produce a result.')
  console.log('AURORA_ANDROID_REMOTE_CONSOLE_SHELL_MAIN ' + JSON.stringify({
    ...result, profileRestored, credentialRemoved, roomSecretRemoved: !secretOwned, configRestored,
  }))
  return { session, cleanupVerified, mainError: null }
}

async function openAssistant(client) {
  const opened = await androidEvaluate(client, `(() => {
    const link = [...document.querySelectorAll('a[href="/"]')].find((item) => item.textContent?.trim() === 'Assistant' && item.getClientRects().length > 0);
    if (!link) return false;
    link.click();
    return true;
  })()`)
  if (opened !== true) throw new Error('The packaged Assistant navigation control was not available.')
  const ready = await waitFor(async () => await androidEvaluate(client, `(() => Boolean(window.location.pathname === '/'
    && document.querySelector('[data-aurora-part="assistant-workspace"]')
    && document.querySelector('#assistant-prompt')
    && document.querySelector('[aria-label="Aurora shell status"]')) )()`))
  if (ready !== true) throw new Error('The packaged Assistant shell did not load.')
  return true
}

async function navigateMesh(client) {
  const ready = await waitFor(async () => await androidEvaluate(client, `(() => typeof window.__TAURI_INTERNALS__?.invoke === 'function')()`))
  if (ready !== true) throw new Error('Android Tauri commands are unavailable.')
  const route = await androidEvaluate(client, `(() => {
    const link = [...document.querySelectorAll('a[href="/mesh"]')].find((item) => item.getClientRects().length > 0);
    if (link) { link.click(); return true; }
    window.history.pushState({}, '', '/mesh'); window.dispatchEvent(new PopStateEvent('popstate')); return true;
  })()`)
  if (route !== true) throw new Error('Android Connected devices is not available.')
  const readyMesh = await waitFor(async () => await androidEvaluate(client, `(() => window.location.pathname === '/mesh'
    && [...document.querySelectorAll('h1')].some(item => item.textContent?.trim() === 'Connected devices'))()`))
  if (readyMesh !== true) throw new Error('Android Connected devices did not load.')
}

async function approvePairing(pairing, pending) {
  const payload = { code: pending.code, permissions: pairing.permissions, is_admin: false }
  const draft = await post(pairing, '/api/Gateway/AdminActionDraft', { method_id: 'Auth.PairingApprove', payload })
  const confirmation = await post(pairing, '/api/Gateway/AdminActionConfirm', {
    action_id: draft.action_id, nonce: draft.nonce, digest: draft.digest,
    reason: 'Approve the owned temporary Android remote-console connection.',
    reauth_confirmed: true, phrase: draft.required_phrase,
  })
  await post(pairing, '/api/Auth/PairingApprove', payload, {
    'X-Aurora-AdminAction-Id': confirmation.action_id,
    'X-Aurora-AdminAction-Token': confirmation.confirmation_token,
    'X-Aurora-AdminAction-Digest': confirmation.digest,
  })
}

async function getConfig(pairing) {
  const value = await post(pairing, '/api/Config/Get', { section: 'ui' })
  if (typeof value?.config?.dark_mode !== 'boolean') throw new Error('Config/Get did not return ui.dark_mode.')
  return value.config.dark_mode
}

async function commitConfig(pairing, change, expectedBaseRevision = null) {
  const preview = await post(pairing, '/api/Config/PreviewDiff', { changes: [change] })
  if (preview?.valid !== true || typeof preview.preview_token !== 'string' || !Number.isInteger(preview.base_revision)) {
    throw new Error('The owned Python host rejected the config preview.')
  }
  if (expectedBaseRevision !== null && preview.base_revision !== expectedBaseRevision) {
    throw new Error('The config revision changed after the owned update; restoration was not attempted.')
  }
  const payload = { changes: [change], base_revision: preview.base_revision, preview_token: preview.preview_token }
  const draft = await post(pairing, '/api/Gateway/AdminActionDraft', { method_id: 'Config.CommitChangeSet', payload })
  const confirmation = await post(pairing, '/api/Gateway/AdminActionConfirm', {
    action_id: draft.action_id, nonce: draft.nonce, digest: draft.digest,
    reason: 'Verify the packaged Android Assistant shell survives a real setting update.',
    reauth_confirmed: true, phrase: draft.required_phrase,
  })
  return await post(pairing, '/api/Config/CommitChangeSet', payload, {
    'X-Aurora-AdminAction-Id': confirmation.action_id,
    'X-Aurora-AdminAction-Token': confirmation.confirmation_token,
    'X-Aurora-AdminAction-Digest': confirmation.digest,
  })
}

async function post(pairing, path, body = {}, extraHeaders = {}) {
  const response = await pairing.request.post(`${pairing.gatewayUrl}${path}`, {
    headers: { 'X-API-Key': pairing.gatewayApiKey, 'content-type': 'application/json', ...extraHeaders },
    data: body,
  })
  if (!response.ok()) throw new Error(`Owned Python request failed at ${path} (${response.status()}).`)
  return await response.json()
}


async function readRemoteConsolePairReadiness(client) {
  return await androidEvaluate(client, `(() => {
    const safeLabel = (value) => typeof value === 'string' && /^[a-z0-9_-]{1,64}$/iu.test(value) ? value : null;
    const root = document.querySelector('[aria-labelledby="mesh-peers-title"]');
    if (!root) return { available: false, reason: 'mesh-page-absent' };
    return {
      available: true,
      status: safeLabel(root.getAttribute('data-thin-peer-status')),
      state: safeLabel(root.getAttribute('data-thin-peer-state')),
      errorCode: safeLabel(root.getAttribute('data-thin-peer-error')),
      reviewControlVisible: [...document.querySelectorAll('button')]
        .some(button => button.textContent?.trim() === 'Review & approve' && button.getClientRects().length > 0),
    };
  })()`)
}

async function waitFor(read, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  throw new Error('Android remote-console main flow timed out.')
}

const SAFE_NATIVE_ERROR_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE'])

function safeErrorCode(error) {
  return typeof error?.code === 'string' && SAFE_NATIVE_ERROR_CODES.has(error.code) ? error.code : null
}

function safeFailureCategory(error) {
  if (error instanceof AggregateError) return 'aggregate_error'
  if (error?.name === 'TimeoutError' || safeErrorCode(error) === 'ETIMEDOUT') return 'timeout'
  if (error?.name === 'TypeError') return 'type_error'
  return 'operation_failed'
}

function parseProfileDocument(value) {
  try { return JSON.parse(value) } catch { throw new Error('Android profile document could not be read.') }
}
function parseJson(value) { try { return JSON.parse(value) } catch { return null } }
function normalizeCode(value) { return String(value ?? '').replace(/[^a-z0-9]/giu, '').toLowerCase() }
function safeUrlProtocol(value) { try { return new URL(value).protocol } catch { return '' } }
