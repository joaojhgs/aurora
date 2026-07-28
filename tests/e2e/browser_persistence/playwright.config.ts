import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: /browser-(?:indexeddb-local-data|peer-persistence|sqlite-opfs)\.spec\.ts/u,
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
