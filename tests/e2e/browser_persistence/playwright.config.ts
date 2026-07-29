import { defineConfig, devices } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const suiteName = 'persistence-matrix'
const outputDir = join(process.env.BROWSER_STORAGE_REPORT_ROOT ?? join(tmpdir(), 'aurora-browser-storage'), suiteName)

export default defineConfig({
  testDir: '.',
  testMatch: /browser-(?:indexeddb-local-data|peer-persistence|sqlite-opfs)\.spec\.ts/u,
  outputDir,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  retries: 0,
  reporter: 'list',
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
      testIgnore: /browser-(?:indexeddb-local-data|sqlite-opfs)\.spec\.ts/u,
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      testIgnore: /browser-(?:indexeddb-local-data|sqlite-opfs)\.spec\.ts/u,
    },
  ],
})
