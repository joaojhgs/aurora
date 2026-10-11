import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import {
  baseUrl,
  completedAssistantMessageTexts,
  configured,
  connectHostedPeer,
  confirmedAdminPost,
  expectNewCompletedAssistantMessage,
  liveShellAcceptance,
  normalizeVisibleText,
  post,
  readLiveShellSubscriptionDropState,
  readHostedLiveShellTrace,
  readShellStatusText,
  setLiveShellSubscriptionDrop,
  waitFor,
  waitForLiveShellSubscriptions,
  waitForLiveShellStreamsConnected,
  waitForShellStatusText,
  type JsonObject,
} from './hosted-peer-live-helpers'

type ConfigDiffPreviewResponse = {
  valid?: boolean
  base_revision?: number | null
  preview_token?: string | null
  changed_paths?: string[]
  errors?: string[]
}

type WebRtcPeerDiagnostic = {
  connection_state?: string
  data_channel_state?: string
}

type ConfigCommitChangeSetResponse = {
  success?: boolean
  revision?: number | null
  changed_paths?: string[]
  error?: string | null
  error_code?: string | null
}

type ConfigCommitTrace = {
  before?: unknown
  preview?: { base_revision?: number | null; preview_token_present?: boolean; preview_token_length?: number }
  commit?: ConfigCommitChangeSetResponse
  readback?: unknown
}

const assistantDraft = 'draft survives live config event'
const deterministicAcceptancePhrase = 'live acceptance ready'
const fallbackDraft = 'draft survives stream loss fallback'
const foregroundPrompt = [
  `Reply with exactly these three words and no other text: ${deterministicAcceptancePhrase}.`,
  'Do not add punctuation, quotes, markdown, or a greeting.',
].join(' ')

test.skip(
  !configured,
  'run through scripts/hosted_peer_e2e.sh so the full Python service and hosted UI are available',
)

test('live config changes update the shell without remounting the assistant workspace', async ({
  page,
  request,
}) => {
  await connectHostedPeer(page, request)
  await page.getByRole('link', { name: 'Assistant' }).click()
  await page.waitForURL(rootHostedPage, { timeout: 30_000 })
  await waitForLiveShellSubscriptions(request)
  await waitForLiveShellStreamsConnected(page)
  const prompt = page.locator('#assistant-prompt')
  await prompt.fill(assistantDraft)
  const assistantWorkspace = page.locator('[data-aurora-part="assistant-workspace"]')
  await expect(assistantWorkspace).toBeVisible()
  const workspaceBefore = await assistantWorkspace.elementHandle()
  const promptBefore = await prompt.elementHandle()
  if (!workspaceBefore || !promptBefore) {
    throw new Error('Assistant workspace and prompt handles must exist before config update')
  }
  const shellStatus = page.getByLabel('Aurora shell status')
  await expect(shellStatus).toBeVisible()
  const statusBefore = normalizeVisibleText(await shellStatus.innerText())
  expect(statusBefore).not.toMatch(/needs attention|refresh needed/i)
  await page.evaluate(() => {
    const status = document.querySelector('[aria-label="Aurora shell status"]')
    if (!status) throw new Error('Aurora shell status element is missing')
    const state = { matched: false, texts: [] as string[] }
    const sample = () => {
      const text = status.textContent?.replace(/\s+/gu, ' ').trim() ?? ''
      state.texts.push(text)
      if (/needs attention|refresh needed/iu.test(text)) state.matched = true
    }
    sample()
    const observer = new MutationObserver(sample)
    observer.observe(status, { childList: true, subtree: true, characterData: true })
    Object.assign(window, {
      __auroraLiveConfigStatusObserver: {
        state,
        disconnect: () => observer.disconnect(),
      },
    })
  })

  const beforeDarkMode = await readConfigValue<boolean>(request, 'ui.dark_mode', false)
  const nextDarkMode = !beforeDarkMode
  const configTrace: ConfigCommitTrace = { before: beforeDarkMode }
  try {
    const commit = await commitConfigChange(request, {
      key_path: 'ui.dark_mode',
      value: nextDarkMode,
    }, configTrace)
    expect(commit.success).toBe(true)
    expect(commit.changed_paths ?? []).toContain('ui.dark_mode')

    let observedStatus: Awaited<ReturnType<Page['waitForFunction']>>
    try {
      observedStatus = await page.waitForFunction(() => {
      const observer = (window as typeof window & {
        __auroraLiveConfigStatusObserver?: {
          state: { matched: boolean; texts: string[] }
        }
      }).__auroraLiveConfigStatusObserver
      if (!observer?.state.matched) return null
      return observer.state.texts.find((text) => /needs attention|refresh needed/iu.test(text)) ?? null
      }, undefined, { timeout: 30_000 })
    } catch (error) {
      configTrace.readback = await readConfigValue<boolean>(request, 'ui.dark_mode', nextDarkMode)
      const state = await readLiveShellSubscriptionDropState(request)
      const liveShellTrace = await readHostedLiveShellTrace(page)
      throw new Error(`${String(error)}\nPER278 config chronology=${JSON.stringify({ ...configTrace, state, liveShellTrace })}`)
    }
    const observedStatusText = await observedStatus.jsonValue()
    configTrace.readback = await readConfigValue<boolean>(request, 'ui.dark_mode', nextDarkMode)
    expect(configTrace.readback).toBe(nextDarkMode)
    expect(normalizeVisibleText(String(observedStatusText ?? ''))).toMatch(/needs attention|refresh needed/i)
    await expect(prompt).toHaveValue(assistantDraft)
    const workspaceAfter = await assistantWorkspace.elementHandle()
    const promptAfter = await prompt.elementHandle()
    if (!workspaceAfter || !promptAfter) {
      throw new Error('Assistant workspace and prompt handles must exist after config update')
    }
    try {
      expect(
        await page.evaluate(
          ({ before, after }) => before === after && before.isConnected,
          { before: workspaceBefore, after: workspaceAfter },
        ),
      ).toBe(true)
      expect(
        await page.evaluate(
          ({ before, after }) => before === after && before.isConnected,
          { before: promptBefore, after: promptAfter },
        ),
      ).toBe(true)
    } finally {
      await workspaceAfter.dispose()
      await promptAfter.dispose()
    }
    await expect(page.locator('[data-browser-shell-boot="true"]')).toHaveCount(0)
  } finally {
    const current = await readConfigValue<boolean>(request, 'ui.dark_mode', nextDarkMode)
    if (current !== beforeDarkMode) {
      await commitConfigChange(request, {
        key_path: 'ui.dark_mode',
        value: beforeDarkMode,
      })
    }
    await page.evaluate(() => {
      const observer = (window as typeof window & {
        __auroraLiveConfigStatusObserver?: { disconnect: () => void }
      }).__auroraLiveConfigStatusObserver
      observer?.disconnect()
      delete (window as typeof window & { __auroraLiveConfigStatusObserver?: unknown }).__auroraLiveConfigStatusObserver
    }).catch(() => undefined)
    await workspaceBefore?.dispose()
    await promptBefore?.dispose()
  }
})

test('foreground assistant turn exposes connecting state quickly and returns the live response', async ({
  page,
  request,
}) => {
  expect(process.env.AURORA_HOSTED_PEER_ENABLE_ORCHESTRATOR).toBe('1')
  await connectHostedPeer(page, request)
  await page.getByRole('link', { name: 'Assistant' }).click()
  await page.waitForURL(rootHostedPage, { timeout: 30_000 })

  const prompt = page.locator('#assistant-prompt')
  const completedBefore = await completedAssistantMessageTexts(page)
  await prompt.fill(foregroundPrompt)
  const sentAt = Date.now()
  await page.locator('[data-aurora-part="assistant-composer-send"]').click()

  try {
    await expect(page.getByLabel('Assistant conversation thread')).toContainText(
      'Aurora is preparing a response.',
      { timeout: 1_500 },
    )
  } catch (error) {
    const state = await readLiveShellSubscriptionDropState(request)
    throw new Error(`${String(error)}\nPER278 assistant RPC chronology=${JSON.stringify(state)}`)
  }
  expect(Date.now() - sentAt).toBeLessThan(1_700)
  await expectNewCompletedAssistantMessage(
    page,
    completedBefore.length,
    deterministicAcceptancePhrase,
  )
  const completedAfter = await completedAssistantMessageTexts(page)
  const newMessages = completedAfter.slice(completedBefore.length)
  expect(newMessages).toEqual([deterministicAcceptancePhrase])
  expect(newMessages.join(' ').toLowerCase()).not.toContain(
    'Assistant stream ended before Aurora returned a final response'.toLowerCase(),
  )
  await expect(page.locator('[data-aurora-part="assistant-composer-send"]')).toHaveAttribute(
    'data-composer-action',
    'send',
    { timeout: 90_000 },
  )
})


test('live shell falls back to polling during event stream loss and resumes push after recovery', async ({
  page,
  request,
}) => {
  expect(liveShellAcceptance).toBe(true)
  await connectHostedPeer(page, request)
  await page.getByRole('link', { name: 'Assistant' }).click()
  await page.waitForURL(rootHostedPage, { timeout: 30_000 })

  const prompt = page.locator('#assistant-prompt')
  await prompt.fill(fallbackDraft)
  const shellStatus = page.getByLabel('Aurora shell status')
  await expect(shellStatus).toBeVisible()
  await waitForLiveShellSubscriptions(request)
  await waitForLiveShellStreamsConnected(page, 60_000)
  await waitForCleanConnectedShell(page, 60_000)
  await setLiveShellSubscriptionDrop(request, false)
  await waitForLiveShellSubscriptions(request)
  await waitForLiveShellStreamsConnected(page)
  const connectedBaseline = await readLiveShellSubscriptionDropState(request)
  await page.waitForTimeout(16_500)
  const connectedBaselineAfter = await readLiveShellSubscriptionDropState(request)
  expect(snapshotRpcCallsSince(connectedBaselineAfter, connectedBaseline.now_monotonic_ms ?? 0)).toHaveLength(0)

  const beforeDarkMode = await readConfigValue<boolean>(request, 'ui.dark_mode', false)
  const fallbackDarkMode = !beforeDarkMode
  const restoredDarkMode = beforeDarkMode
  try {
    await waitForLiveShellSubscriptions(request)
    const drop = await setLiveShellSubscriptionDrop(request, true)
    expect(drop.enabled).toBe(true)
    expect(drop.dropped ?? 0).toBeGreaterThanOrEqual(2)
    await waitForShellStatusText(page, /syncing/i, 15_000)

    const diagnosticsDuringLoss = await post<{ peers?: WebRtcPeerDiagnostic[] }>(
      request,
      '/api/Gateway/GetWebRTCDiagnostics',
    )
    expect(
      diagnosticsDuringLoss.peers?.some(
        (peer) => peer.connection_state === 'connected' && peer.data_channel_state === 'open',
      ),
    ).toBe(true)

    const fallbackCommitWindow = await readLiveShellSubscriptionDropState(request)
    const fallbackCommit = await commitConfigChange(request, {
      key_path: 'ui.dark_mode',
      value: fallbackDarkMode,
    })
    expect(fallbackCommit.success).toBe(true)
    expect(fallbackCommit.changed_paths ?? []).toContain('ui.dark_mode')
    expect(await readConfigValue<boolean>(request, 'ui.dark_mode', beforeDarkMode)).toBe(fallbackDarkMode)
    await waitFor(
      async () => {
        const state = await readLiveShellSubscriptionDropState(request)
        const threshold = (fallbackCommitWindow.now_monotonic_ms ?? 0) + 14_000
        return snapshotRpcCallsSince(state, threshold).some((call) => call.drop_enabled === true) ? state : null
      },
      '15 second fallback polling RPC after stream loss',
      25_000,
    )
    await waitForShellStatusText(page, /needs attention|refresh needed/i, 5_000)
    await expect(prompt).toHaveValue(fallbackDraft)

    await setLiveShellSubscriptionDrop(request, false)
    await waitFor(
      async () => {
        const state = await readLiveShellSubscriptionDropState(request)
        return state.enabled === false && (state.subscriptions?.length ?? 0) >= 2 ? state : null
      },
      'restored live shell subscriptions',
      15_000,
    )
    await waitForCleanConnectedShell(page, 20_000)
    await waitForLiveShellStreamsConnected(page, 20_000)
    const recoveryIdleStart = await readLiveShellSubscriptionDropState(request)
    await page.waitForTimeout(16_500)
    const recoveryIdleEnd = await readLiveShellSubscriptionDropState(request)
    expect(snapshotRpcCallsSince(recoveryIdleEnd, recoveryIdleStart.now_monotonic_ms ?? 0)).toHaveLength(0)

    const beforeRestore = Date.now()
    const restoredCommitWindow = await readLiveShellSubscriptionDropState(request)
    const restoredCommit = await commitConfigChange(request, {
      key_path: 'ui.dark_mode',
      value: restoredDarkMode,
    })
    expect(restoredCommit.success).toBe(true)
    expect(restoredCommit.changed_paths ?? []).toContain('ui.dark_mode')
    expect(await readConfigValue<boolean>(request, 'ui.dark_mode', fallbackDarkMode)).toBe(restoredDarkMode)
    await waitFor(
      async () => {
        const state = await readLiveShellSubscriptionDropState(request)
        return snapshotRpcCallsSince(state, restoredCommitWindow.now_monotonic_ms ?? 0).some((call) => call.drop_enabled === false) ? state : null
      },
      'restored push-triggered shell snapshot RPC',
      5_000,
    )
    await waitForShellStatusText(page, /needs attention|refresh needed/i, 5_000)
    expect(Date.now() - beforeRestore).toBeLessThan(5_500)
    await expect(prompt).toHaveValue(fallbackDraft)
  } finally {
    await setLiveShellSubscriptionDrop(request, false).catch(() => undefined)
    const current = await readConfigValue<boolean>(request, 'ui.dark_mode', beforeDarkMode)
    if (current !== beforeDarkMode) {
      await commitConfigChange(request, {
        key_path: 'ui.dark_mode',
        value: beforeDarkMode,
      })
    }
  }
})

type SnapshotRpcCall = {
  monotonic_ms?: number
  method?: string
  request_id?: string
  params_keys?: string[]
  drop_enabled?: boolean
}

function snapshotRpcCallsSince(
  state: { rpc_calls?: SnapshotRpcCall[] },
  monotonicMs: number,
): SnapshotRpcCall[] {
  return (state.rpc_calls ?? []).filter(
    (call) => typeof call.monotonic_ms === 'number' && call.monotonic_ms >= monotonicMs,
  )
}

async function waitForCleanConnectedShell(page: Page, timeout: number): Promise<string> {
  return await waitFor(
    async () => {
      const text = await readShellStatusText(page)
      return /connected/i.test(text) && !/needs attention|refresh needed|syncing/i.test(text) ? text : null
    },
    'clean connected live shell state',
    timeout,
  )
}

async function readConfigValue<T>(
  request: APIRequestContext,
  key: string,
  fallback: T,
): Promise<T> {
  const response = await post<{ config?: JsonObject }>(
    request,
    '/api/Config/Get',
    { section: key.split('.')[0] },
  )
  const value = key.split('.').slice(1).reduce<unknown>((current, segment) => (
    current && typeof current === 'object' && segment in current
      ? (current as Record<string, unknown>)[segment]
      : undefined
  ), response.config)
  if (value === undefined) throw new Error(`Config/Get did not return ${key}`)
  if (typeof fallback === 'boolean' && typeof value !== 'boolean') {
    throw new Error(`Config/Get returned a non-boolean value for ${key}`)
  }
  return value as T
}

function rootHostedPage(url: URL): boolean {
  const root = new URL(baseUrl)
  return url.origin === root.origin && url.pathname === '/'
}


async function commitConfigChange(
  request: APIRequestContext,
  change: JsonObject,
  trace?: ConfigCommitTrace,
): Promise<ConfigCommitChangeSetResponse> {
  const preview = await post<ConfigDiffPreviewResponse>(
    request,
    '/api/Config/PreviewDiff',
    { changes: [change] },
  )
  expect(preview.valid, JSON.stringify(preview.errors ?? [])).toBe(true)
  expect(preview.preview_token).toEqual(expect.any(String))
  expect(preview.base_revision).toEqual(expect.any(Number))
  if (trace) {
    trace.preview = {
      base_revision: preview.base_revision,
      preview_token_present: Boolean(preview.preview_token),
      preview_token_length: preview.preview_token?.length,
    }
  }
  const commit = await confirmedAdminPost(
    request,
    '/api/Config/CommitChangeSet',
    'Config.CommitChangeSet',
    {
      changes: [change],
      base_revision: preview.base_revision,
      preview_token: preview.preview_token,
    },
  ) as ConfigCommitChangeSetResponse
  if (trace) trace.commit = commit
  return commit
}
