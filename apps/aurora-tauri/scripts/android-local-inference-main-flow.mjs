import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { acquireAndroidSmokeLock, resolveAndroidSmokeLockPath } from './android-emulator-smoke-runner.mjs'
import { connectInstalledWebview, invokeTauri, resolveAndroidDeviceSerial } from './android-voice-live-smoke.mjs'

const APP_ID = process.env.AURORA_ANDROID_APP_ID ?? 'dev.aurora.desktop'
const MODEL_ID = 'chat-qwen3-0b8'
const MODEL_DOWNLOAD_TIMEOUT_MS = 600_000
const ASSISTANT_TURN_TIMEOUT_MS = 180_000
const PROFILE_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 500
const PROMPT = 'What is 2 + 2? Answer with just the number.'
const EMPTY_PROFILE = JSON.stringify({ version: 2, activeProfileId: null, profiles: [] })
const MODE_KEY = 'aurora.session.onboarding-mode'
const TIER_KEY = 'aurora.session.runtime-tier'

export async function runAndroidLocalInferenceMainFlow({
  adb = process.env.ADB ?? 'adb',
  serial = process.env.AURORA_ANDROID_DEVICE_SERIAL ?? process.env.ANDROID_SERIAL ?? null,
  appId = APP_ID,
  modelDownloadTimeoutMs = MODEL_DOWNLOAD_TIMEOUT_MS,
  assistantTurnTimeoutMs = ASSISTANT_TURN_TIMEOUT_MS,
} = {}) {
  if (process.env.AURORA_ANDROID_LOCAL_INFERENCE_MAIN_FLOW !== '1') {
    throw new Error('Set AURORA_ANDROID_LOCAL_INFERENCE_MAIN_FLOW=1 after Root grants the Android validation reservation.')
  }

  let context
  let webview
  let releaseDeviceLock
  let originalProfileValue
  let originalMode
  let originalTier
  let originalNetwork
  let profileCreated = false
  let profileCreateReadback
  let modelDownloadedByRun = false
  let networkOffline = false
  let result
  let primaryError

  try {
    serial = resolveAndroidDeviceSerial(run(adb, ['devices', '-l']), serial)
    context = { adb, serial, appId }
    releaseDeviceLock = await acquireAndroidSmokeLock({
      lockPath: resolveAndroidSmokeLockPath(serial),
      waitTimeoutMs: 90_000,
    })
    run(adb, ['-s', serial, 'wait-for-device'], { timeout: 60_000 })
    await waitForApp(context)
    webview = await connectInstalledWebview(context)

    const stored = await invokeTauri(webview.client, 'aurora_thin_profile_get')
    originalProfileValue = typeof stored?.value === 'string' ? stored.value : null
    const originalProfile = parseRuntimeProfile(originalProfileValue)
    if (originalProfileValue !== null
      && (!originalProfile || originalProfile.version !== 2 || originalProfile.profiles.length !== 0 || originalProfile.activeProfileId !== null)) {
      throw new Error('Refusing onboarding because the current Android profile is not canonical empty.')
    }
    const [mode, tier] = await Promise.all([
      invokeTauri(webview.client, 'aurora_secure_storage_get', { key: MODE_KEY }),
      invokeTauri(webview.client, 'aurora_secure_storage_get', { key: TIER_KEY }),
    ])
    originalMode = typeof mode?.value === 'string' ? mode.value : null
    originalTier = typeof tier?.value === 'string' ? tier.value : null
    originalNetwork = await readNetworkState(webview.client)

    await createOfflineProfileThroughOnboarding(webview.client)
    profileCreated = true
    profileCreateReadback = await waitForOfflineProfile(webview.client)
    webview = await restartApp(context, webview)
    const restartedProfile = await waitForOfflineProfile(webview.client)
    if (restartedProfile.activeProfileId !== profileCreateReadback.activeProfileId
      || restartedProfile.activeLocalNodeId !== profileCreateReadback.activeLocalNodeId) {
      throw new Error('The owned offline profile identity changed.')
    }

    const catalog = await invokeTauri(webview.client, 'aurora_local_inference_catalog')
    const model = catalog?.data?.find((entry) => entry?.modelId === MODEL_ID)
    if (catalog?.ok !== true || model?.capabilities?.chat !== true) {
      throw new Error(`The production-selected Android model ${MODEL_ID} is not available in the native catalog.`)
    }
    const initialStatus = await invokeTauri(webview.client, 'aurora_local_inference_model_status', { modelId: MODEL_ID })
    const state = initialStatus?.data?.state
    if (initialStatus?.ok !== true || !['ready', 'absent'].includes(state)) {
      throw new Error(`The selected Android model is in an unsupported state (${state ?? 'unknown'}); preserving it.`)
    }

    await openSettings(webview.client)
    if (state === 'absent') {
      await waitForVisibleEnabledControl(webview.client, 'Download offline answers')
      await clickExact(webview.client, 'button', 'Download offline answers')
      await waitForModelStatus(webview.client, 'ready', modelDownloadTimeoutMs, 2_000)
      modelDownloadedByRun = true
    }
    const ready = await invokeTauri(webview.client, 'aurora_local_inference_model_status', { modelId: MODEL_ID })
    if (ready?.ok !== true || ready?.data?.state !== 'ready') {
      throw new Error('The selected model did not pass native readiness status after Settings setup.')
    }
    await setOfflineAnswers(webview.client, true)
    const settingsProfile = await assertOfflineProfile(webview.client)
    if (settingsProfile.activeProfileId !== profileCreateReadback.activeProfileId
      || settingsProfile.activeLocalNodeId !== profileCreateReadback.activeLocalNodeId) {
      throw new Error('The owned offline profile identity changed.')
    }

    await setOfflineNetwork(webview.client, true)
    networkOffline = true
    await waitFor(webview.client, async () => (await readNetworkState(webview.client)).online === false,
      10_000, 'scoped packaged WebView offline state')
    await openAssistant(webview.client)
    await startNewConversation(webview.client)
    await submitPrompt(webview.client, PROMPT)
    const firstAnswer = await waitForPureAssistantAnswer(webview.client, PROMPT, assistantTurnTimeoutMs)

    await waitForVisibleEnabledControl(webview.client, 'Open conversations')
    await clickVisibleText(webview.client, 'Open conversations')
    await waitFor(webview.client, async () => evaluate(webview.client, `(() => {
      const list = document.querySelector('ul[aria-label="Assistant conversation list"]');
      return Boolean(list && list.querySelectorAll('button[aria-current="true"]').length === 1);
    })()`), 30_000, 'saved active conversation in history')
    await clickSelector(webview.client, 'ul[aria-label="Assistant conversation list"] button[aria-current="true"]')
    const savedAnswer = await waitForPureAssistantAnswer(webview.client, PROMPT, 30_000)
    if (savedAnswer !== firstAnswer) throw new Error('The reopened conversation did not preserve the same assistant answer.')

    result = {
      ok: true,
      device: { serial, appId },
      profile: { createdThroughOnboarding: true, nodeMode: 'mesh-node', runtimeTier: 'lightweight-ts', packs: ['local-inference'], membership: false },
      model: { id: MODEL_ID, state: 'ready', preexisting: !modelDownloadedByRun, downloadedThroughSettings: modelDownloadedByRun },
      offline: { scope: 'packaged WebView CDP target', enabled: true },
      turn: { prompt: PROMPT, answer: firstAnswer, tools: [] },
      savedConversationReadback: true,
      originalProfile: { canonicalEmpty: true, rawValueWasNull: originalProfileValue === null },
    }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    const cleanupErrors = []
    if (networkOffline && webview?.client) {
      try {
        await setOfflineNetwork(webview.client, originalNetwork)
        networkOffline = false
      } catch (error) { cleanupErrors.push(error) }
    }
    if (profileCreated && webview?.client) {
      try {
        const ownedReadback = profileCreateReadback ?? await waitForOfflineProfile(webview.client)
        const currentProfile = await invokeTauri(webview.client, 'aurora_thin_profile_get')
        const owned = parseRuntimeProfile(currentProfile?.value)
        const active = owned?.profiles?.find((item) => item.id === owned.activeProfileId)
        if (!active || active.id !== ownedReadback.activeProfileId
          || active.localNode?.stablePeerId !== ownedReadback.activeLocalNodeId
          || active.nodeMode !== 'mesh-node' || active.runtimeTier !== 'lightweight-ts'
          || active.homeConnection || active.localNode?.meshMembership
          || stablePacks(active.localNode?.enabledCapabilityPacks) !== 'local-inference') {
          throw new Error('Refusing cleanup because the active profile no longer matches this run-owned offline profile.')
        }
        webview = await restartApp(context, webview)
        const restoreValue = originalProfileValue ?? EMPTY_PROFILE
        const restored = await invokeTauri(webview.client, 'aurora_thin_profile_set', { value: restoreValue })
        if (restored?.ok !== true) throw new Error('The original canonical-empty profile could not be restored.')
        await restoreSecureValue(webview.client, MODE_KEY, originalMode)
        await restoreSecureValue(webview.client, TIER_KEY, originalTier)
        const [restoredMode, restoredTier] = await Promise.all([
          invokeTauri(webview.client, 'aurora_secure_storage_get', { key: MODE_KEY }),
          invokeTauri(webview.client, 'aurora_secure_storage_get', { key: TIER_KEY }),
        ])
        if ((restoredMode?.value ?? null) !== originalMode || (restoredTier?.value ?? null) !== originalTier) {
          throw new Error('Original Android onboarding preferences did not pass readback.')
        }
        webview = await restartApp(context, webview)
        const profileReadback = await invokeTauri(webview.client, 'aurora_thin_profile_get')
        const profile = parseRuntimeProfile(profileReadback?.value)
        if (profile?.profiles?.length !== 0 || profile.activeProfileId !== null
          || (originalProfileValue !== null && profileReadback?.value !== originalProfileValue)) {
          throw new Error('The restored canonical-empty profile did not survive a fresh app launch.')
        }
        if (result) result.restoration = { canonicalEmptyProfile: true, preferences: true, newlyProvisionedModelPreserved: modelDownloadedByRun }
      } catch (error) { cleanupErrors.push(error) }
    }
    try { webview?.close() } catch (error) { cleanupErrors.push(error) }
    try { releaseDeviceLock?.() } catch (error) { cleanupErrors.push(error) }
    if (primaryError && cleanupErrors.length) {
      throw new AggregateError([primaryError, ...cleanupErrors], 'Android offline main flow failed and cleanup also failed.')
    }
    if (!primaryError && cleanupErrors.length) {
      throw new AggregateError(cleanupErrors, 'Android offline main-flow cleanup failed.')
    }
    if (!result && !primaryError) throw new Error('Android offline main flow did not reach a terminal result.')
  }
  console.log(JSON.stringify(result, null, 2))
  return result
}

async function createOfflineProfileThroughOnboarding(client) {
  await waitFor(client, async () => evaluate(client, `(() => {
    const step = document.querySelector('[data-step="detect"]');
    return Boolean(step && step.getClientRects().length);
  })()`), 30_000, 'device setup onboarding')
  const selected = await evaluate(client, `(() => {
    const radio = document.querySelector('button[role="radio"][title="Make this device available"]');
    if (!radio || radio.disabled || radio.getAttribute('aria-disabled') === 'true') return false;
    if (radio.getAttribute('aria-checked') !== 'true') radio.click();
    return true;
  })()`)
  if (!selected) throw new Error('The product could not select “Make this device available”.')
  await waitFor(client, async () => evaluate(client, `(() => {
    const step = document.querySelector('[data-step="detect"]');
    const button = [...(step?.querySelectorAll('button') ?? [])]
      .find((item) => item.innerText?.trim() === 'Continue' && !item.disabled
        && item.getAttribute('aria-disabled') !== 'true' && item.getClientRects().length > 0);
    if (!button) return false;
    button.click();
    return true;
  })()`), 30_000, 'enabled setup Continue')
  await waitFor(client, async () => evaluate(client, `Boolean(document.querySelector('[data-step="setup"]'))`), 30_000, 'device setup choice')
  await waitForVisibleEnabledControl(client, 'Continue on this device')
  await clickVisibleText(client, 'Continue on this device')
}

async function waitForOfflineProfile(client) {
  return waitFor(client, async () => {
    const stored = await invokeTauri(client, 'aurora_thin_profile_get')
    const profile = parseRuntimeProfile(stored?.value)
    const active = profile?.profiles?.find((item) => item.id === profile.activeProfileId)
    if (!active || profile.profiles.length !== 1 || active.nodeMode !== 'mesh-node'
      || active.runtimeTier !== 'lightweight-ts' || active.homeConnection
      || active.localNode?.meshMembership || stablePacks(active.localNode?.enabledCapabilityPacks) !== 'local-inference'
      || typeof active.localNode?.stablePeerId !== 'string') return false
    return { activeProfileId: active.id, activeLocalNodeId: active.localNode.stablePeerId }
  }, PROFILE_TIMEOUT_MS, 'saved local-only Android profile')
}

async function assertOfflineProfile(client) {
  const profile = await waitForOfflineProfile(client)
  return profile
}

function stablePacks(packs) {
  return Array.isArray(packs) ? [...packs].sort().join(',') : ''
}

async function restoreSecureValue(client, key, value) {
  const command = value === null ? 'aurora_secure_storage_delete' : 'aurora_secure_storage_set'
  const args = value === null ? { key } : { key, value }
  const restored = await invokeTauri(client, command, args)
  if (restored?.ok !== true) throw new Error('An original Android onboarding preference could not be restored.')
}

async function restartApp(context, currentWebview) {
  try { currentWebview?.close() } catch { /* Always attempt a fresh process. */ }
  run(context.adb, ['-s', context.serial, 'shell', 'am', 'force-stop', '--user', 'current', context.appId])
  run(context.adb, ['-s', context.serial, 'shell', 'am', 'start', '--user', 'current', '-W', '-n', `${context.appId}/.MainActivity`], { timeout: 60_000 })
  await waitForApp(context)
  return connectInstalledWebview(context)
}

async function waitForPureAssistantAnswer(client, prompt, timeoutMs) {
  return waitFor(client, async () => evaluate(client, `(() => {
    const items = [...document.querySelectorAll('[data-slot="message-scroller-item"]')];
    const answerItem = [...items].reverse().find((item) => [...item.querySelectorAll('span.sr-only')]
      .some((status) => status.textContent?.trim() === 'Aurora · sent'));
    if (!answerItem || answerItem.querySelector('[role="status"][aria-busy="true"]')) return false;
    const answer = answerItem.querySelector('p')?.textContent?.trim() ?? '';
    const allText = items.map((item) => item.innerText ?? '').join(' ');
    if (!allText.includes(${JSON.stringify(prompt)}) || !/^4[.!]?$/.test(answer)) return false;
    if (answerItem.querySelector('[aria-label="Assistant tool call cards"]')
      || document.querySelector('[aria-label="Assistant tool call cards"]')) return false;
    return answer;
  })()`), timeoutMs, 'tools-empty on-device answer and rendered history')
}

async function openSettings(client) {
  await waitForVisibleEnabledControl(client, 'Settings')
  await clickVisibleText(client, 'Settings')
  await waitFor(client, async () => (await bodyText(client)).includes('Assistant on this device'), 30_000, 'Assistant device settings')
}

async function openAssistant(client) {
  await waitForVisibleEnabledControl(client, 'Assistant')
  await clickVisibleText(client, 'Assistant')
  await waitFor(client, async () => await evaluate(client, "Boolean(document.querySelector('#assistant-prompt'))"), 30_000, 'assistant conversation')
}

async function startNewConversation(client) {
  const direct = await evaluate(client, `(() => [...document.querySelectorAll('button')]
    .some((item) => item.getAttribute('aria-label') === 'New conversation' && item.getClientRects().length > 0))()`)
  if (!direct) {
    await waitForVisibleEnabledControl(client, 'Open conversations')
    await clickVisibleText(client, 'Open conversations')
  }
  await waitForVisibleEnabledControl(client, 'New conversation')
  await clickVisibleText(client, 'New conversation')
  await waitFor(client, async () => await evaluate(client, `(() => {
    const input = document.querySelector('#assistant-prompt');
    return Boolean(input && !input.disabled && !input.readOnly);
  })()`), 30_000, 'new conversation composer')
}

async function waitForVisibleEnabledControl(client, text) {
  await waitFor(client, async () => evaluate(client, `(() => {
    const expected = ${JSON.stringify(text)};
    const candidates = [...document.querySelectorAll('button, a, [role="button"], [role="link"], [role="tab"]')];
    const target = candidates.find((item) => (item.innerText?.trim() === expected || item.getAttribute('aria-label') === expected) && item.getClientRects().length > 0);
    return Boolean(target && !target.disabled && target.getAttribute('aria-disabled') !== 'true');
  })()`), 30_000, `visible enabled product control: ${text}`)
}

async function setOfflineAnswers(client, enabled) {
  const current = await readOfflineAnswers(client)
  if (current !== enabled) {
    await waitForOfflineAnswersReady(client, null, 'offline answers setting ready')
    const clicked = await evaluate(client, `(() => {
      const control = document.querySelector('#offline-assistant-enabled')
        ?? [...document.querySelectorAll('[role="switch"]')].find((item) => item.getAttribute('aria-label') === 'Use offline answers');
      if (!control || control.disabled || control.getAttribute('aria-disabled') === 'true') return false;
      control.click();
      return true;
    })()`)
    if (!clicked) throw new Error('The offline answers setting could not be changed in Settings.')
  }
  await waitForOfflineAnswersReady(
    client,
    enabled,
    `offline answers ${enabled ? 'enabled' : 'disabled'} and ready`,
  )
}

async function waitForOfflineAnswersReady(client, expected, label) {
  const expectedValue = JSON.stringify(expected)
  await waitFor(client, async () => evaluate(client, `(() => {
    const control = document.querySelector('#offline-assistant-enabled')
      ?? [...document.querySelectorAll('[role="switch"]')].find((item) => item.getAttribute('aria-label') === 'Use offline answers');
    if (!control) return false;
    const checked = control.checked ?? control.getAttribute('aria-checked') === 'true';
    const enabled = !control.disabled
      && control.getAttribute('aria-disabled') !== 'true'
      && control.getClientRects().length > 0;
    return enabled && (${expectedValue} === null || checked === ${expectedValue});
  })()`), 30_000, label)
}


async function readOfflineAnswers(client) {
  return evaluate(client, `(() => {
    const control = document.querySelector('#offline-assistant-enabled')
      ?? [...document.querySelectorAll('[role="switch"]')].find((item) => item.getAttribute('aria-label') === 'Use offline answers');
    return control ? (control.checked ?? control.getAttribute('aria-checked') === 'true') : null;
  })()`)
}




async function waitForModelStatus(client, expected, timeoutMs, pollIntervalMs = POLL_INTERVAL_MS) {
  return waitFor(client, async () => {
    const status = (await invokeTauri(client, 'aurora_local_inference_model_status', { modelId: MODEL_ID }))?.data
    return status?.state === expected ? { ready: true, status } : false
  }, timeoutMs, `trusted model ${expected}`, pollIntervalMs)
}

async function readNetworkState(client) {
  return evaluate(client, `(() => {
    const connection = navigator.connection;
    return {
      online: navigator.onLine,
      type: connection?.type ?? 'wifi',
      latency: Number.isFinite(connection?.rtt) ? connection.rtt : 0,
      downloadThroughput: Number.isFinite(connection?.downlink) ? connection.downlink * 1024 * 1024 / 8 : -1,
    };
  })()`)
}

async function setOfflineNetwork(client, state) {
  const baseline = typeof state === 'object' && state !== null ? state : null
  const offline = state === true || baseline?.online === false
  const response = await client.send('Network.enable', {}, 5_000)
  void response
  await client.send('Network.emulateNetworkConditions', {
    offline,
    latency: offline ? 0 : baseline?.latency ?? 0,
    downloadThroughput: offline ? 0 : baseline?.downloadThroughput ?? -1,
    uploadThroughput: offline ? 0 : -1,
    connectionType: offline ? 'none' : normalizeConnectionType(baseline?.type),
  }, 5_000)
}

function normalizeConnectionType(value) {
  return ['none', 'cellular2g', 'cellular3g', 'cellular4g', 'bluetooth', 'ethernet', 'wifi', 'wimax', 'other'].includes(value)
    ? value
    : 'unknown'
}

async function submitPrompt(client, prompt) {
  const prepared = await evaluate(client, `(() => {
    const input = document.querySelector('#assistant-prompt');
    if (!input || input.disabled || input.readOnly) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(prompt)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`)
  if (!prepared) throw new Error('The assistant composer is not ready for the offline request.')
  await clickSelector(client, '[data-aurora-part="assistant-composer-send"]')
}





async function clickVisibleText(client, text) {
  const clicked = await evaluate(client, `(() => {
    const expected = ${JSON.stringify(text)};
    const candidates = [...document.querySelectorAll('button, a, [role="button"], [role="link"], [role="tab"]')];
    const target = candidates.find((item) => (item.innerText?.trim() === expected || item.getAttribute('aria-label') === expected) && item.getClientRects().length > 0);
    if (!target || target.disabled || target.getAttribute('aria-disabled') === 'true') return false;
    target.click();
    return true;
  })()`)
  if (!clicked) throw new Error(`Visible product control not found: ${text}`)
}

async function clickExact(client, tag, text) {
  const clicked = await evaluate(client, `(() => {
    const expected = ${JSON.stringify(text)};
    const target = [...document.querySelectorAll(${JSON.stringify(tag)})]
      .find((item) => item.innerText?.trim() === expected && item.getClientRects().length > 0);
    if (!target || target.disabled) return false;
    target.click();
    return true;
  })()`)
  if (!clicked) throw new Error(`Visible product control not found: ${text}`)
}

async function clickSelector(client, selector) {
  const clicked = await evaluate(client, `(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target || target.disabled || !target.getClientRects().length) return false;
    target.click();
    return true;
  })()`)
  if (!clicked) throw new Error(`Assistant product control not found: ${selector}`)
}

async function bodyText(client) {
  return evaluate(client, 'document.body?.innerText ?? ""')
}

async function evaluate(client, expression) {
  const response = await client.send('Runtime.evaluate', {
    expression: `(async () => JSON.stringify(await (${expression})))()`,
    returnByValue: true,
    awaitPromise: true,
  }, 30_000)
  if (response.exceptionDetails) {
    throw new Error(`WebView evaluation failed: ${JSON.stringify(response.exceptionDetails)}`)
  }
  const raw = response.result?.result?.value
  if (typeof raw !== 'string') throw new Error(`WebView evaluation returned no value: ${JSON.stringify(response)}`)
  return JSON.parse(raw)
}

async function waitFor(client, check, timeoutMs, label, pollIntervalMs = POLL_INTERVAL_MS) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const result = await check()
      if (result) return result
    } catch (error) { lastError = error }
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())))
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms${lastError ? `: ${message(lastError)}` : ''}`)
}

async function waitForApp(context) {
  await waitFor(null, async () => appPid(context), 60_000, `Android app ${context.appId}`)
}

function appPid(context) {
  const output = adb(context, ['shell', 'pidof', context.appId], true).trim()
  return output.split(/\s+/u)[0] || null
}

function parseRuntimeProfile(value) {
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && Array.isArray(parsed.profiles) ? parsed : null
  } catch { return null }
}


function adb(context, args, allowFailure = false) {
  return run(context.adb, ['-s', context.serial, ...args], { allowFailure })
}

function run(command, args, { allowFailure = false, timeout = 30_000 } = {}) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    if (allowFailure) return `${error.stdout ?? ''}${error.stderr ?? ''}`
    if (error?.code === 'ETIMEDOUT') throw new Error(`${command} timed out after ${timeout}ms`)
    throw new Error(`${command} ${args.join(' ')} failed: ${error.stderr?.trim() || message(error)}`)
  }
}

function sleep(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)) }
function message(error) { return error instanceof Error ? error.message : String(error) }

const invokedAsScript = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invokedAsScript) {
  runAndroidLocalInferenceMainFlow().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: message(error) }, null, 2))
    process.exitCode = 1
  })
}
