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
    command: 'pnpm --filter @aurora/voice-web build:typescript && pnpm build && pnpm exec vite preview --host 127.0.0.1 --port 1420',
    url: 'http://127.0.0.1:1420',
    // Exercise the production chunks. Repeated full-page navigation against
    // Vite's source-module server exhausts Chromium's request resources before
    // the later admin routes load, which made this gate order-dependent.
    reuseExistingServer: false,
    env: {
      ...process.env,
      VITE_AURORA_GATEWAY_URL: '',
    },
    timeout: 180_000,
  },
})
