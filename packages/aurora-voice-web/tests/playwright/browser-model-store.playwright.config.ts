import { defineConfig, devices } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const reportRoot =
  process.env.AURORA_VOICE_WEB_PLAYWRIGHT_REPORT_ROOT === undefined ||
  process.env.AURORA_VOICE_WEB_PLAYWRIGHT_REPORT_ROOT === ''
    ? join(tmpdir(), 'aurora-voice-web-browser-model-store')
    : resolve(process.cwd(), process.env.AURORA_VOICE_WEB_PLAYWRIGHT_REPORT_ROOT)

export default defineConfig({
  testDir: '.',
  testMatch: 'browser-model-store.pw.ts',
  outputDir: join(reportRoot, 'results'),
  timeout: 45_000,
  expect: {
    timeout: 10_000
  },
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
    }
  ]
})
