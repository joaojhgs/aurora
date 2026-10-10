import { defineConfig, devices } from '@playwright/test'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const configDir = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(configDir, '../..')
const repoRoot = resolve(appRoot, '../..')
const reportRoot = resolve(appRoot, 'test-results/ui-visual')
const defaultPort = Number(process.env.AURORA_UI_VISUAL_PORT ?? '3428')
const defaultComponentPort = Number(process.env.AURORA_UI_VISUAL_COMPONENT_PORT ?? '3429')
const baseURL = process.env.AURORA_UI_VISUAL_BASE_URL?.trim() || `http://127.0.0.1:${defaultPort}`
const componentBaseURL = process.env.AURORA_UI_VISUAL_COMPONENT_BASE_URL?.trim() || `http://127.0.0.1:${defaultComponentPort}`
const exactPixels = process.env.AURORA_UI_VISUAL_PIXEL_EXACT === '1'
const captureReview = process.env.AURORA_UI_VISUAL_CAPTURE_REVIEW === '1'
const useExternalServer = Boolean(process.env.AURORA_UI_VISUAL_BASE_URL?.trim())
const useExternalComponentServer = Boolean(process.env.AURORA_UI_VISUAL_COMPONENT_BASE_URL?.trim())

export default defineConfig({
  testDir: configDir,
  testMatch: ['ui-visual-baseline.pw.ts', 'assistant-composer-geometry.pw.ts', 'assistant-history-scroller.pw.ts'],
  snapshotDir: join(configDir, '__screenshots__'),
  outputDir: join(reportRoot, 'artifacts'),
  timeout: 90_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: exactPixels ? 0 : 0.001,
      scale: 'css',
      threshold: exactPixels ? 0 : 0.2,
    },
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: join(reportRoot, 'html'), open: 'never' }],
    ['json', { outputFile: join(reportRoot, 'report.json') }],
  ],
  use: {
    baseURL,
    colorScheme: 'dark',
    locale: 'en-US',
    actionTimeout: 10_000,
    screenshot: captureReview ? { mode: 'on', fullPage: true } : 'only-on-failure',
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 1024 },
  },
  webServer: [
    ...(useExternalServer ? [] : [{
      command: `pnpm exec next dev --webpack --hostname 127.0.0.1 --port ${defaultPort}`,
      cwd: appRoot,
      env: {
        AURORA_WEB_DEMO_MODE: '1',
        NEXT_DIST_DIR: 'tmp/aurora-ui-visual-next',
        NEXT_PUBLIC_AURORA_DEBUG_UI: '1',
        NEXT_PUBLIC_AURORA_VERSION_LABEL: 'visual-baseline',
        NEXT_PUBLIC_AURORA_WEB_DEMO_MODE: '1',
        NEXT_PUBLIC_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK: '1',
        NEXT_TELEMETRY_DISABLED: '1',
      },
      reuseExistingServer: false,
      timeout: 300_000,
      url: baseURL,
    }]),
    ...(useExternalComponentServer ? [] : [{
      command: `node tests/fixtures/component-harness-server.mjs --port ${defaultComponentPort}`,
      cwd: appRoot,
      env: {
        AURORA_UI_VISUAL_REPO_ROOT: repoRoot,
        AURORA_UI_VISUAL_REPORT_ROOT: reportRoot,
        NODE_ENV: 'test',
      },
      reuseExistingServer: false,
      timeout: 120_000,
      url: componentBaseURL,
    }]),
  ],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
