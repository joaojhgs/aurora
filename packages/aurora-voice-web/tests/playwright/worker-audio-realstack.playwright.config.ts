import { defineConfig, devices } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const reportRoot =
  process.env.AURORA_VOICE_WEB_REAL_AUDIO_REPORT_ROOT === undefined ||
  process.env.AURORA_VOICE_WEB_REAL_AUDIO_REPORT_ROOT === ''
    ? join(tmpdir(), 'aurora-voice-web-real-audio')
    : resolve(process.cwd(), process.env.AURORA_VOICE_WEB_REAL_AUDIO_REPORT_ROOT)

const fakeMediaArgs = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required'
]

export default defineConfig({
  testDir: '.',
  testMatch: 'worker-audio-realstack.pw.ts',
  outputDir: join(reportRoot, 'results'),
  timeout: 60_000,
  expect: {
    timeout: 10_000
  },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: join(reportRoot, 'report.json') }]],
  projects: [
    {
      name: 'chromium-real-browser-api',
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['microphone'],
        launchOptions: { args: fakeMediaArgs }
      }
    },
    {
      name: 'chromium-mobile-emulation-real-browser-api',
      use: {
        ...devices['Pixel 5'],
        permissions: ['microphone'],
        launchOptions: { args: fakeMediaArgs }
      }
    }
  ]
})
