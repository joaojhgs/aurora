import { defineConfig, devices } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const reportRoot =
  process.env.AURORA_VOICE_WEB_SHERPA_BROWSER_REPORT_ROOT === undefined ||
  process.env.AURORA_VOICE_WEB_SHERPA_BROWSER_REPORT_ROOT === ''
    ? join(tmpdir(), 'aurora-voice-web-sherpa-browser-smoke')
    : resolve(process.cwd(), process.env.AURORA_VOICE_WEB_SHERPA_BROWSER_REPORT_ROOT)

export default defineConfig({
  testDir: '.',
  testMatch: 'sherpa-browser-smoke.pw.ts',
  outputDir: join(reportRoot, 'results'),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: join(reportRoot, 'report.json') }]],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
})
