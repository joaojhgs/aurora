import { defineConfig, devices } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const reportRoot =
  process.env.AURORA_WEB_BROWSER_VOICE_REPORT_ROOT === undefined
  || process.env.AURORA_WEB_BROWSER_VOICE_REPORT_ROOT === ''
    ? join(tmpdir(), 'aurora-web-browser-voice')
    : resolve(process.cwd(), process.env.AURORA_WEB_BROWSER_VOICE_REPORT_ROOT)

const chromiumFakeMediaArgs = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
]

const commonUse = {
  baseURL: 'http://127.0.0.1:3427',
  screenshot: 'only-on-failure' as const,
  trace: 'retain-on-failure' as const,
}

export default defineConfig({
  testDir: '.',
  testMatch: 'assistant-browser-voice.pw.ts',
  outputDir: join(reportRoot, 'results'),
  timeout: 120_000,
  expect: {
    timeout: 20_000,
  },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: join(reportRoot, 'report.json') }]],
  webServer: {
    command: 'pnpm exec next build && pnpm exec next start --hostname 127.0.0.1 --port 3427',
    url: 'http://127.0.0.1:3427',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      AURORA_WEB_DEMO_MODE: '1',
      NEXT_TELEMETRY_DISABLED: '1',
      NEXT_PUBLIC_AURORA_WEB_DEMO_MODE: '1',
      NEXT_PUBLIC_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK: '1',
    },
  },
  projects: [
    {
      name: 'chromium-hosted-assistant',
      use: {
        ...devices['Desktop Chrome'],
        ...commonUse,
        permissions: ['microphone'],
        launchOptions: {
          args: chromiumFakeMediaArgs,
        },
      },
    },
    {
      name: 'chrome-android-emulated-hosted-assistant',
      use: {
        ...devices['Pixel 5'],
        ...commonUse,
        permissions: ['microphone'],
        launchOptions: {
          args: chromiumFakeMediaArgs,
        },
      },
    },
  ],
})
