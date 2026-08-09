#!/usr/bin/env node
import fs from 'node:fs'

const pidFile = process.env.AURORA_DESKTOP_NATIVE_VOICE_E2E_SIDECAR_PID_FILE
if (!pidFile) {
  throw new Error('AURORA_DESKTOP_NATIVE_VOICE_E2E_SIDECAR_PID_FILE is required')
}

fs.writeFileSync(pidFile, `${process.pid}\n`, { encoding: 'utf8', mode: 0o600 })

const keepAlive = setInterval(() => undefined, 60_000)
const shutdown = () => {
  clearInterval(keepAlive)
  process.exit(0)
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
