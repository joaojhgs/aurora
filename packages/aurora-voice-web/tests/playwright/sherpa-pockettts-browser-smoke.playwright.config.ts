import { defineConfig, devices } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const reportRoot =
  process.env.AURORA_VOICE_WEB_SHERPA_POCKETTTS_REPORT_ROOT === undefined ||
  process.env.AURORA_VOICE_WEB_SHERPA_POCKETTTS_REPORT_ROOT === ''
    ? join(tmpdir(), 'aurora-voice-web-sherpa-pockettts-browser-smoke')
    : resolve(process.cwd(), process.env.AURORA_VOICE_WEB_SHERPA_POCKETTTS_REPORT_ROOT)

export default defineConfig({
  testDir: '.',
  testMatch: 'sherpa-pockettts-browser-smoke.pw.ts',
  outputDir: join(reportRoot, 'results'),
  timeout: 900_000,
  expect: { timeout: 30_000 },
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
