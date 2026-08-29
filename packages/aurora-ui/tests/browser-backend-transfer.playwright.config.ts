import { defineConfig, devices } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const suiteName = 'backend-transfer-smoke'
const reportRoot =
  process.env.BROWSER_STORAGE_REPORT_ROOT === undefined || process.env.BROWSER_STORAGE_REPORT_ROOT === ''
    ? join(tmpdir(), 'aurora-browser-storage')
    : resolve(process.cwd(), process.env.BROWSER_STORAGE_REPORT_ROOT)
const outputDir = join(reportRoot, suiteName)

export default defineConfig({
  testDir: '.',
  testMatch: 'browser-backend-transfer.chromium.pw.ts',
  outputDir,
  timeout: 45_000,
  reporter: 'list',
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
