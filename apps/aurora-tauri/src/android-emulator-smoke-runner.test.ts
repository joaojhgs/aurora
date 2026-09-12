import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

// @ts-expect-error The Node-executed .mjs runner intentionally has no TS build output.
import { acquireAndroidSmokeLock } from '../scripts/android-emulator-smoke-runner.mjs'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Android emulator smoke serialization', () => {
  it('queues a second run until the current owner releases the emulator', async () => {
    const lockPath = createLockPath()
    const releaseFirst = await acquireAndroidSmokeLock({ lockPath, waitTimeoutMs: 500, pollIntervalMs: 5 })
    let secondAcquired = false
    const second = acquireAndroidSmokeLock({ lockPath, waitTimeoutMs: 500, pollIntervalMs: 5 })
      .then((release: () => void) => {
        secondAcquired = true
        return release
      })

    await delay(25)
    expect(secondAcquired).toBe(false)

    releaseFirst()
    const releaseSecond = await second
    expect(secondAcquired).toBe(true)
    releaseSecond()
  })

  it('recovers a lock whose owner process no longer exists', async () => {
    const lockPath = createLockPath()
    writeFileSync(lockPath, JSON.stringify({
      pid: 2_147_483_647,
      token: 'stale-owner',
      startedAt: 1,
    }))

    const release = await acquireAndroidSmokeLock({ lockPath, waitTimeoutMs: 100, pollIntervalMs: 5 })
    release()
  })

  it('fails with a stable code when a live owner exceeds the wait budget', async () => {
    const lockPath = createLockPath()
    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      token: 'live-owner',
      startedAt: Date.now(),
    }))

    await expect(acquireAndroidSmokeLock({
      lockPath,
      waitTimeoutMs: 20,
      pollIntervalMs: 5,
    })).rejects.toThrow('android_smoke_lock_timeout')
  })
})

function createLockPath() {
  const directory = mkdtempSync(join(os.tmpdir(), 'aurora-android-smoke-lock-test-'))
  temporaryDirectories.push(directory)
  return join(directory, 'emulator.lock')
}

function delay(milliseconds: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}
