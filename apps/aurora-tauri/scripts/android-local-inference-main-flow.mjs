import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { acquireAndroidSmokeLock, resolveAndroidSmokeLockPath } from './android-emulator-smoke-runner.mjs'
import { connectInstalledWebview, invokeTauri, resolveAndroidDeviceSerial } from './android-voice-live-smoke.mjs'

const APP_ID = process.env.AURORA_ANDROID_APP_ID ?? 'dev.aurora.desktop'
const MODEL_ID = 'chat-qwen3-0b8'
const MODEL_DOWNLOAD_TIMEOUT_MS = 35 * 60_000
const ASSISTANT_TURN_TIMEOUT_MS = 8 * 60_000
const PROFILE_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 500
const PROMPT = "Show one local notification titled 'Aurora offline flow' with the message 'PER-284 offline tool check'. After I approve it, tell me when it is done."

export async function runAndroidLocalInferenceMainFlow({
  adb = process.env.ADB ?? 'adb',
  serial = process.env.AURORA_ANDROID_DEVICE_SERIAL ?? process.env.ANDROID_SERIAL ?? null,
  appId = APP_ID,
  modelDownloadTimeoutMs = MODEL_DOWNLOAD_TIMEOUT_MS,
  assistantTurnTimeoutMs = ASSISTANT_TURN_TIMEOUT_MS,
  allowRunOwnedEmptyThread = false,
} = {}) {
  if (process.env.AURORA_ANDROID_LOCAL_INFERENCE_MAIN_FLOW !== '1') {
    throw new Error('Set AURORA_ANDROID_LOCAL_INFERENCE_MAIN_FLOW=1 after Root grants the Android validation reservation.')
  }

  let context
  let webview
  let releaseDeviceLock
  let originalProfileValue
  let originalProfile
  let originalProfileId
  let originalLocalNodeId
  let originalLocalInferenceEnabled
  let originalNetwork
  let modelDownloadedByRun = false
  let result
  let offlineApplied = false
  let success = false
  let primaryError

  try {
    const devices = run(adb, ['devices', '-l'])
    serial = resolveAndroidDeviceSerial(devices, serial)
    context = { adb, serial, appId }
    releaseDeviceLock = await acquireAndroidSmokeLock({
      lockPath: resolveAndroidSmokeLockPath(serial),
      waitTimeoutMs: 90_000,
    })
    run(adb, ['-s', serial, 'wait-for-device'], { timeout: 60_000 })
    await waitForApp(context)
    webview = await connectInstalledWebview(context)
    await installInvokeRecorder(webview.client)

    const stored = await invokeTauri(webview.client, 'aurora_thin_profile_get')
    originalProfileValue = typeof stored?.value === 'string' ? stored.value : null
    originalProfile = parseRuntimeProfile(originalProfileValue)
    const active = originalProfile?.profiles?.find((item) => item.id === originalProfile.activeProfileId)
    if (!active || active.nodeMode !== 'mesh-node' || active.runtimeTier !== 'lightweight-ts') {
      throw new Error('PER-284 prerequisite missing: the persisted active profile must be mesh-node with lightweight-ts runtime.')
    }
    if (typeof active.id !== 'string' || typeof active.localNode?.stablePeerId !== 'string') {
      throw new Error('PER-284 prerequisite missing: the active profile identity is incomplete.')
    }
    originalProfileId = active.id
    originalLocalNodeId = active.localNode.stablePeerId
    originalLocalInferenceEnabled = active.localNode?.enabledCapabilityPacks?.includes('local-inference') === true
    originalNetwork = await readNetworkState(webview.client)
    if (!originalNetwork.online) throw new Error('PER-284 prerequisite missing: packaged WebView must be online for the trusted model download.')

    const beforeEnvelope = await invokeTauri(webview.client, 'aurora_local_inference_model_status', { modelId: MODEL_ID })
    const before = beforeEnvelope?.data
    if (before?.state !== 'absent') {
      throw new Error(`PER-284 needs a fresh trusted-model download; ${MODEL_ID} is currently ${before?.state ?? 'unavailable'}. Preserve the existing download and use a clean app-private model state.`)
    }

    await openSettings(webview.client)
    const settings = await waitForModelStatus(webview.client, 'absent', 30_000)
    if (!settings.ready) throw new Error('PER-284 prerequisite missing: assistant device settings did not become available.')
    if (originalLocalInferenceEnabled) await setOfflineAnswers(webview.client, false)

    const downloadStartedAt = Date.now()
    await clickExact(webview.client, 'button', 'Download offline answers')
    await waitForModelStatus(webview.client, 'ready', modelDownloadTimeoutMs, 2_000)
    const downloadElapsedMs = Date.now() - downloadStartedAt
    if ((await invokeTauri(webview.client, 'aurora_local_inference_model_status', { modelId: MODEL_ID }))?.data?.state !== 'ready') {
      throw new Error('The trusted offline model did not pass native verification after its download.')
    }
    modelDownloadedByRun = true
    await setOfflineAnswers(webview.client, true)
    await assertLocalInferenceOptIn(webview.client, true)

    offlineApplied = true
    await setOfflineNetwork(webview.client, true)
    await waitFor(webview.client, async () => (await readNetworkState(webview.client)).online === false, 10_000, 'scoped packaged WebView offline state')
    await openAssistant(webview.client)
    await startNewConversation(webview.client, { allowRunOwnedEmptyThread })
    await submitPrompt(webview.client, PROMPT)

    const proposal = await waitForApprovalProposal(webview.client, assistantTurnTimeoutMs)
    if (proposal.pendingCards !== 1 || proposal.approveOnceButtons !== 1 || !/action needs approval/iu.test(proposal.text)) {
      throw new Error(`Expected exactly one local action waiting for one-time approval; found ${JSON.stringify(proposal)}`)
    }
    await clickExact(webview.client, 'button', 'Approve once')

    const final = await waitForAssistantFinal(webview.client, assistantTurnTimeoutMs)
    const observed = await readInvokeRecorder(webview.client)
    const completions = observed.filter((entry) => entry.command === 'aurora_local_inference_complete')
    const downloads = observed.filter((entry) => entry.command === 'aurora_local_inference_download_model')
    const notifications = observed.filter((entry) => entry.command === 'aurora_native_show_notification')
    if (downloads.length !== 1 || downloads[0]?.ok !== true) {
      throw new Error(`Expected one successful product trusted-model download; observed ${downloads.length}.`)
    }
    if (completions.length < 2) {
      throw new Error(`The product did not route both the action and final reply through native local inference (${completions.length} completion calls).`)
    }
    if (completions.some((entry) => entry.online !== false)) {
      throw new Error('At least one native local-inference completion started while the packaged WebView was online.')
    }
    if (!completions.some((entry) => entry.type === 'tool_calls') || !completions.some((entry) => entry.type === 'message')) {
      throw new Error('The local model did not return both a tool proposal and a final message through the native completion path.')
    }
    if (notifications.length !== 1 || notifications[0]?.ok !== true || notifications[0]?.online !== false) {
      throw new Error(`Expected exactly one approved local notification action; observed ${notifications.length}.`)
    }
    if (!final.assistantText || !/done|shown|notification/iu.test(final.assistantText)) {
      throw new Error(`The product did not render a final assistant reply after approval: ${JSON.stringify(final)}`)
    }
    success = true
    result = {
      ok: true,
      device: { serial, appId },
      model: { id: MODEL_ID, state: 'ready', downloadElapsedMs },
      offline: { scope: 'packaged WebView CDP target', enabled: true },
      localInferenceCompletionCalls: completions.length,
      approvedLocalToolCalls: notifications.length,
      approval: 'Approve once',
      finalAssistantReply: final.assistantText,
      profile: { nodeMode: active.nodeMode, runtimeTier: active.runtimeTier, optedIn: true },
    }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    const cleanupErrors = []
    if (offlineApplied && webview?.client) {
      try {
        await setOfflineNetwork(webview.client, originalNetwork)
        offlineApplied = false
      } catch (error) { cleanupErrors.push(error) }
    }
    if (originalProfile && typeof originalLocalInferenceEnabled === 'boolean' && webview?.client) {
      try {
        await assertOriginalProfileIdentity(webview.client, originalProfileId, originalLocalNodeId)
        if (modelDownloadedByRun) {
          // Saving this Settings value rebuilds the product runtime and awaits its local session teardown.
          await restoreLocalInferenceOptIn(webview.client, false, originalProfileId, originalLocalNodeId)
          await assertOriginalProfileIdentity(webview.client, originalProfileId, originalLocalNodeId)
          await waitForProductSessionsReleased(webview.client)
          if (originalLocalInferenceEnabled) {
            await restoreLocalInferenceOptIn(webview.client, true, originalProfileId, originalLocalNodeId)
            await assertOriginalProfileIdentity(webview.client, originalProfileId, originalLocalNodeId)
            const deleted = await invokeTauri(webview.client, 'aurora_local_inference_delete_model', { modelId: MODEL_ID })
            if (deleted?.ok !== true || deleted?.data?.state !== 'absent') {
              throw new Error(`The run-owned trusted model could not be removed: ${JSON.stringify(deleted)}`)
            }
          } else {
            await assertOriginalProfileIdentity(webview.client, originalProfileId, originalLocalNodeId)
            await waitForVisibleEnabledControl(webview.client, 'Remove download')
            await clickExact(webview.client, 'button', 'Remove download')
          }
          await waitForModelStatus(webview.client, 'absent', 30_000)
        } else {
          await restoreLocalInferenceOptIn(webview.client, originalLocalInferenceEnabled, originalProfileId, originalLocalNodeId)
        }
        await assertLocalInferenceOptIn(webview.client, originalLocalInferenceEnabled)
        const restored = await invokeTauri(webview.client, 'aurora_thin_profile_get')
        const restoredProfile = parseRuntimeProfile(restored?.value)
        const restoredActive = restoredProfile?.profiles?.find((item) => item.id === restoredProfile.activeProfileId)
        if (!restoredActive
          || restoredActive.id !== originalProfileId
          || restoredActive.localNode?.stablePeerId !== originalLocalNodeId
          || restoredActive.nodeMode !== 'mesh-node'
          || restoredActive.runtimeTier !== 'lightweight-ts') {
          throw new Error('The original Android runtime profile could not be restored.')
        }
        if (stableProfile(restoredProfile) !== stableProfile(originalProfile)) {
          throw new Error('The Android runtime profile did not return to its original persisted state.')
        }
      } catch (error) { cleanupErrors.push(error) }
    }
    try { webview?.close() } catch (error) { cleanupErrors.push(error) }
    try { releaseDeviceLock?.() } catch (error) { cleanupErrors.push(error) }
    if (primaryError && cleanupErrors.length) {
      throw new AggregateError([primaryError, ...cleanupErrors], 'PER-284 main flow failed and cleanup also failed.')
    }
    if (!primaryError && cleanupErrors.length) {
      throw new AggregateError(cleanupErrors, 'PER-284 main-flow cleanup failed.')
    }
    if (!success && !primaryError) throw new Error('PER-284 main flow did not reach a terminal result.')
  }
  console.log(JSON.stringify(result, null, 2))
  return result
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

async function startNewConversation(client, { allowRunOwnedEmptyThread = false } = {}) {
  if (allowRunOwnedEmptyThread && await hasVisibleEmptyWritableAssistantThread(client)) return
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

async function hasVisibleEmptyWritableAssistantThread(client) {
  return evaluate(client, `(() => {
    const input = document.querySelector('#assistant-prompt');
    const threadItems = [...document.querySelectorAll('[data-message-id]')];
    const visible = (element) => Boolean(element && element.getClientRects().length > 0
      && getComputedStyle(element).display !== 'none'
      && getComputedStyle(element).visibility !== 'hidden');
    return Boolean(input && visible(input) && !input.disabled && !input.readOnly
      && input.value.trim() === ''
      && threadItems.length === 1
      && threadItems[0].getAttribute('data-message-id') === 'assistant-empty'
      && visible(threadItems[0]));
  })()`)
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

async function restoreLocalInferenceOptIn(client, enabled, profileId, localNodeId) {
  await openSettings(client)
  await assertOriginalProfileIdentity(client, profileId, localNodeId)
  await setOfflineAnswers(client, enabled)
}

async function readOfflineAnswers(client) {
  return evaluate(client, `(() => {
    const control = document.querySelector('#offline-assistant-enabled')
      ?? [...document.querySelectorAll('[role="switch"]')].find((item) => item.getAttribute('aria-label') === 'Use offline answers');
    return control ? (control.checked ?? control.getAttribute('aria-checked') === 'true') : null;
  })()`)
}

async function assertLocalInferenceOptIn(client, enabled) {
  await waitFor(client, async () => {
    const stored = await invokeTauri(client, 'aurora_thin_profile_get')
    const profile = parseRuntimeProfile(stored?.value)
    const active = profile?.profiles?.find((item) => item.id === profile.activeProfileId)
    return active?.nodeMode === 'mesh-node'
      && active?.runtimeTier === 'lightweight-ts'
      && (active?.localNode?.enabledCapabilityPacks?.includes('local-inference') === true) === enabled
  }, PROFILE_TIMEOUT_MS, `persisted local inference ${enabled ? 'opt-in' : 'opt-out'}`)
}

async function assertOriginalProfileIdentity(client, profileId, localNodeId) {
  const stored = await invokeTauri(client, 'aurora_thin_profile_get')
  const profile = parseRuntimeProfile(stored?.value)
  const active = profile?.profiles?.find((item) => item.id === profile.activeProfileId)
  if (active?.id !== profileId || active.localNode?.stablePeerId !== localNodeId) {
    throw new Error('Refusing Android cleanup because the active profile or local node changed during the main flow.')
  }
}

async function waitForProductSessionsReleased(client) {
  await waitFor(client, async () => {
    const calls = await readInvokeRecorder(client)
    const created = new Set(calls
      .filter((entry) => (
        ['aurora_local_inference_session_create', 'aurora_local_inference_complete'].includes(entry.command)
        && entry.ok
        && entry.sessionId
      ))
      .map((entry) => entry.sessionId))
    const destroyed = new Set(calls
      .filter((entry) => entry.command === 'aurora_local_inference_session_destroy' && entry.ok && entry.sessionId)
      .map((entry) => entry.sessionId))
    return [...created].every((sessionId) => destroyed.has(sessionId))
  }, PROFILE_TIMEOUT_MS, 'product local-inference session release')
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
  const offline = state === true
  const baseline = typeof state === 'object' && state !== null ? state : null
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

async function waitForApprovalProposal(client, timeoutMs) {
  return waitFor(client, async () => {
    const value = await evaluate(client, `(() => {
      const text = document.body?.innerText ?? '';
      const buttons = [...document.querySelectorAll('[aria-label="Assistant action approval choices"] button')];
      const pendingCards = [...document.querySelectorAll('[aria-label="Assistant action status"]')]
        .filter((card) => card.innerText.includes('Needs approval')).length;
      return { text: text.slice(-5000), pendingCards, approveOnceButtons: buttons.filter((button) => button.innerText.trim() === 'Approve once').length };
    })()`)
    return value.pendingCards > 0 ? value : false
  }, timeoutMs, 'one local action approval proposal')
}

async function waitForAssistantFinal(client, timeoutMs) {
  return waitFor(client, async () => {
    const value = await evaluate(client, `(() => {
      const messages = [...document.querySelectorAll('span.sr-only')]
        .filter((item) => item.textContent?.startsWith('Aurora · sent'))
        .map((item) => {
          let parent = item.parentElement;
          while (parent && !parent.querySelector('p')) parent = parent.parentElement;
          return parent?.querySelector('p')?.textContent?.trim() ?? '';
        }).filter(Boolean);
      const pending = [...document.querySelectorAll('[role="status"][aria-busy="true"]')].length > 0;
      return { assistantText: messages.at(-1) ?? '', pending };
    })()`)
    return value.assistantText && !value.pending ? value : false
  }, timeoutMs, 'final assistant reply after local approval')
}

async function installInvokeRecorder(client) {
  await evaluate(client, `(() => {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== 'function') throw new Error('tauri_invoke_unavailable');
    if (window.__auroraOfflineMainFlow) return true;
    const original = internals.invoke.bind(internals);
    const calls = [];
    internals.invoke = async (command, args) => {
      const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : null;
      try {
        const result = await original(command, args);
        calls.push({ command, ok: result?.ok ?? true, sessionId, state: result?.data?.state ?? null, type: result?.data?.type ?? null, online: navigator.onLine });
        return result;
      } catch (error) {
        calls.push({ command, ok: false, sessionId });
        throw error;
      }
    };
    window.__auroraOfflineMainFlow = { calls };
    return true;
  })()`)
}

async function readInvokeRecorder(client) {
  return evaluate(client, 'window.__auroraOfflineMainFlow?.calls ?? []')
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

function stableProfile(value) {
  if (value == null) return null
  const normalize = (item) => {
    if (Array.isArray(item)) return item.map(normalize)
    if (!item || typeof item !== 'object') return item
    return Object.fromEntries(Object.keys(item).sort().map((key) => [
      key,
      key === 'enabledCapabilityPacks' && Array.isArray(item[key])
        ? [...item[key]].sort()
        : normalize(item[key]),
    ]))
  }
  return JSON.stringify(normalize(value))
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
