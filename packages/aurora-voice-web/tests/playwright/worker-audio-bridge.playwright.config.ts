import { defineConfig, devices } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const reportRoot =
  process.env.AURORA_VOICE_WEB_WORKER_AUDIO_BRIDGE_REPORT_ROOT === undefined ||
  process.env.AURORA_VOICE_WEB_WORKER_AUDIO_BRIDGE_REPORT_ROOT === ''
    ? join(tmpdir(), 'aurora-voice-web-worker-audio-bridge')
    : resolve(process.cwd(), process.env.AURORA_VOICE_WEB_WORKER_AUDIO_BRIDGE_REPORT_ROOT)

export default defineConfig({
  testDir: '.',
  testMatch: 'worker-audio-bridge.pw.ts',
  outputDir: join(reportRoot, 'results'),
  timeout: 90_000,
  expect: {
    timeout: 10_000
  },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: join(reportRoot, 'report.json') }]],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] }
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] }
    },
    {
      name: 'chrome-android-emulated',
      use: { ...devices['Pixel 5'] }
    },
    {
      name: 'mobile-safari-emulated',
      use: { ...devices['iPhone 12'] }
    }
  ]
})
