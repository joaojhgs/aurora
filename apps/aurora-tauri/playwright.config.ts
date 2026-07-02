import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/playwright',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'reports/playwright-routes/report.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:1420',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'pnpm dev -- --host 127.0.0.1',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: !process.env.CI,
    env: {
      ...process.env,
      VITE_AURORA_GATEWAY_URL: '',
      VITE_AURORA_GATEWAY_TOKEN: '',
    },
    timeout: 120_000,
  },
})
