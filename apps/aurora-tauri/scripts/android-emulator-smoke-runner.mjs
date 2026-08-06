import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const DEFAULT_WAIT_TIMEOUT_MS = 15 * 60_000
const DEFAULT_POLL_INTERVAL_MS = 1_000
const INVALID_LOCK_GRACE_MS = 30_000

export function resolveAndroidSmokeLockPath(serial = process.env.ANDROID_SERIAL ?? 'default') {
  const safeSerial = serial.replace(/[^a-zA-Z0-9._-]/g, '_')
  return join(os.tmpdir(), `aurora-android-smoke-${safeSerial}.lock`)
}

export async function acquireAndroidSmokeLock({
  lockPath = resolveAndroidSmokeLockPath(),
  waitTimeoutMs = Number(process.env.AURORA_ANDROID_SMOKE_LOCK_TIMEOUT_MS ?? DEFAULT_WAIT_TIMEOUT_MS),
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
} = {}) {
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`
  const owner = JSON.stringify({ pid: process.pid, token, startedAt: Date.now() })
  const deadline = Date.now() + waitTimeoutMs

  while (true) {
    try {
      const descriptor = openSync(lockPath, 'wx', 0o600)
      try {
        writeFileSync(descriptor, owner, 'utf8')
      } finally {
        closeSync(descriptor)
      }
      return () => releaseAndroidSmokeLock(lockPath, token)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }

    const observed = readLockOwner(lockPath)
    if (observed && !isProcessAlive(observed.owner.pid)) {
      removeObservedLock(lockPath, observed.raw)
      continue
    }
    if (!observed && isInvalidLockStale(lockPath)) {
      removeObservedLock(lockPath, readLockRaw(lockPath))
      continue
    }
    if (Date.now() >= deadline) {
      const ownerPid = observed?.owner.pid ?? 'unknown'
      throw new Error(`android_smoke_lock_timeout: emulator smoke is still owned by process ${ownerPid}`)
    }
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())))
  }
}

export async function runSerializedAndroidSmoke() {
  const release = await acquireAndroidSmokeLock()
  try {
    const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
    return await runChild(executable, [
      'exec',
      'vitest',
      'run',
      '--environment',
      'node',
      'tests/android/android-emulator.e2e.test.ts',
    ])
  } finally {
    release()
  }
}

function runChild(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    const forwardSignal = (signal) => child.kill(signal)
    const onInterrupt = () => forwardSignal('SIGINT')
    const onTerminate = () => forwardSignal('SIGTERM')
    process.once('SIGINT', onInterrupt)
    process.once('SIGTERM', onTerminate)

    child.once('error', (error) => {
      process.off('SIGINT', onInterrupt)
      process.off('SIGTERM', onTerminate)
      rejectPromise(error)
    })
    child.once('exit', (code, signal) => {
      process.off('SIGINT', onInterrupt)
      process.off('SIGTERM', onTerminate)
      if (signal) {
        rejectPromise(new Error(`android_smoke_interrupted: child exited from ${signal}`))
        return
      }
      resolvePromise(code ?? 1)
    })
  })
}

function readLockOwner(lockPath) {
  const raw = readLockRaw(lockPath)
  if (raw === null) return null
  try {
    const owner = JSON.parse(raw)
    if (!Number.isInteger(owner?.pid) || owner.pid <= 0 || typeof owner.token !== 'string') return null
    return { owner, raw }
  } catch {
    return null
  }
}

function readLockRaw(lockPath) {
  try {
    return readFileSync(lockPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function isInvalidLockStale(lockPath) {
  try {
    return Date.now() - statSync(lockPath).mtimeMs >= INVALID_LOCK_GRACE_MS
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

function removeObservedLock(lockPath, observedRaw) {
  if (observedRaw === null || readLockRaw(lockPath) !== observedRaw) return
  try {
    unlinkSync(lockPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function releaseAndroidSmokeLock(lockPath, token) {
  const observed = readLockOwner(lockPath)
  if (observed?.owner.token !== token) return
  removeObservedLock(lockPath, observed.raw)
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

const invokedAsScript =
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (invokedAsScript) {
  process.exitCode = await runSerializedAndroidSmoke()
}
