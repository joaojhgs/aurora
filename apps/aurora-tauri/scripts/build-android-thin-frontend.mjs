#!/usr/bin/env node
import { spawnSync } from 'node:child_process'

const env = {
  ...process.env,
  VITE_AURORA_RUNTIME_MODE: 'android-thin',
  VITE_AURORA_WEBVIEW_TARGET: 'chrome83',
  VITE_AURORA_GATEWAY_URL: '',
  VITE_AURORA_SIGNALING_URL: '',
  VITE_AURORA_CONNECTION_MODE: '',
}

const result = spawnSync('pnpm', ['build'], {
  cwd: new URL('..', import.meta.url),
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

if (result.error) throw result.error
if (result.status !== 0) {
  throw new Error(`Android-thin frontend build failed with status ${result.status}`)
}
