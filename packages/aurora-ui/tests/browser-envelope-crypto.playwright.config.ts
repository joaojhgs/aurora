import { defineConfig, devices } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const suiteName = 'envelope-key-smoke'
const outputDir = join(process.env.BROWSER_STORAGE_REPORT_ROOT ?? join(tmpdir(), 'aurora-browser-storage'), suiteName)

export default defineConfig({
  testDir: '.',
  testMatch: 'browser-envelope-crypto.chromium.pw.ts',
  outputDir,
  timeout: 30_000,
  reporter: 'list',
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
