import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { auroraNavSections, getProductionRouteOracle } from '@aurora/ui'

const primaryNavItems = auroraNavSections.flatMap((section) => section.items)


const ROUTE_SPECIFIC_PLAYWRIGHT_LANDMARKS: Record<string, readonly string[]> = {
  assistant: ['Text chat', 'Prompt'],
  memory: ['Memory & Knowledge', 'Memory & RAG collections'],
  tools: ['Tools & Automations', 'Tool registry and Approval cards'],
  mesh: ['Mesh peers', 'Topology'],
  admin: ['Admin overview', 'AdminAction controller'],
  services: ['Services', 'Services table'],
  access: ['RBAC', 'Permission matrix'],
  tokens: ['RBAC', 'Scoped token inventory'],
  devices: ['Devices', 'Registered devices'],
  config: ['Configuration', 'Staged review', 'Diff preview'],
  contracts: ['Services', 'Contracts'],
  plugins: ['Plugins, MCP, and tools', 'Provider grouping'],
  pairing: ['Pairing queue'],
  backups: ['Backups & Restore', 'Create backup'],
  scheduler: ['Scheduler', 'Jobs'],
  audit: ['Audit log'],
  models: ['Models and runtime', 'Provider route policy'],
  diagnostics: ['Native boundary', 'Live probes'],
  onboarding: ['Connect Aurora'],
  settings: ['Settings and permissions', 'Route and fallback policy'],
  data: ['Data policy and retention', 'Audit trail for policy changes'],
  native: ['Native platform settings', 'Native permissions and capabilities'],
}

const screenshotDir = join(process.cwd(), 'reports', 'playwright-routes', 'screenshots')

const cockpitScreenshotViewports = [
  { id: 'desktop', width: 1440, height: 1024, expects: { sidebar: true, mobileTabs: false } },
  { id: 'mobile', width: 390, height: 844, expects: { sidebar: false, mobileTabs: true } },
] as const



async function expectFocusedWithVisibleOutline(page: import('@playwright/test').Page, label: string): Promise<void> {
  const focusState = await page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null
    if (!element) return null
    const style = window.getComputedStyle(element)
    return {
      tagName: element.tagName,
      className: element.className,
      ariaLabel: element.getAttribute('aria-label'),
      text: element.textContent?.replace(/\s+/g, ' ').trim().slice(0, 80) ?? '',
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor,
    }
  })

  expect(focusState, `${label} should have a focused element`).not.toBeNull()
  expect(focusState?.outlineStyle, `${label} should use a visible focus outline`).not.toBe('none')
  expect(Number.parseFloat(focusState?.outlineWidth ?? '0'), `${label} should use a non-zero focus outline`).toBeGreaterThan(0)
}


function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function routeScreenshotName(route: { id: string; href: string }): string {
  const suffix = route.href === '/' ? 'root' : route.href.replace(/^\//, '').replaceAll('/', '-')
  return `${route.id}-${suffix || 'root'}.png`
}

async function collectPageFailures(page: import('@playwright/test').Page, run: () => Promise<void>): Promise<string[]> {
  const failures: string[] = []
  const onConsole = (message: import('@playwright/test').ConsoleMessage) => {
    if (message.type() === 'error') {
      failures.push(`console error: ${message.text()}`)
    }
  }
  const onResponse = (response: import('@playwright/test').Response) => {
    const status = response.status()
    const url = response.url()
    if (status >= 400 && !url.startsWith('data:')) {
      failures.push(`HTTP ${status}: ${url}`)
    }
  }
  const onPageError = (error: Error) => {
    failures.push(`page error: ${error.message}`)
  }

  page.on('console', onConsole)
  page.on('response', onResponse)
  page.on('pageerror', onPageError)
  try {
    await run()
  } finally {
    page.off('console', onConsole)
    page.off('response', onResponse)
    page.off('pageerror', onPageError)
  }
  return failures
}

const PLACEHOLDER_COPY_MARKERS = [
  'A full product page still needs to be mounted',
  'full product page still needs to be mounted',
  'This Tauri route is now navigable',
  'rendering the assistant diagnostics on the wrong page',
  'TauriRoutePlaceholder',
  'ata-placeholder-panel',
  'debug-dashboard',
  'route is unregistered',
] as const

test.describe('Aurora Tauri Playwright route crawl', () => {
  test('captures desktop and mobile cockpit shell screenshots instead of a raw dashboard', async ({ page }) => {
    mkdirSync(screenshotDir, { recursive: true })
    const screenshotEvidence: Array<Record<string, unknown>> = []

    for (const viewport of cockpitScreenshotViewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.goto('/')
      await expect(page.locator('.aui-shell')).toBeVisible()
      await expect(page.locator('main#content')).toBeVisible()
      await expect(page.getByLabel('Aurora shell status')).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Text chat' })).toBeVisible()
      await expect(page.getByLabel('Conversation rail')).toBeVisible()
      await expect(page.getByLabel('Assistant route and privacy details')).toBeVisible()

      const sidebar = page.locator('.aui-sidebar')
      const mobileTabs = page.getByLabel('Mobile navigation', { exact: true })
      if (viewport.expects.sidebar) {
        await expect(sidebar).toBeVisible()
        await expect(mobileTabs).toBeHidden()
      } else {
        await expect(sidebar).toBeHidden()
        await expect(mobileTabs).toBeVisible()
        await expect(mobileTabs.locator('[data-mobile-tab="assistant"]')).toBeVisible()
      }

      const bodyText = await page.locator('body').innerText()
      expect(bodyText, `${viewport.id} screenshot text must identify cockpit shell`).toContain('Aurora')
      expect(bodyText, `${viewport.id} screenshot text must identify assistant cockpit`).toMatch(/assistant|conversation|prompt/i)
      for (const marker of PLACEHOLDER_COPY_MARKERS) {
        expect(bodyText, `${viewport.id} screenshot must not include placeholder marker: ${marker}`).not.toContain(marker)
      }
      expect(bodyText, `${viewport.id} screenshot must not expose raw dashboard language`).not.toMatch(/raw dashboard|backend-state dashboard|route dump/i)

      const screenshotPath = join(screenshotDir, `${viewport.id}-assistant-cockpit.png`)
      await page.screenshot({ path: screenshotPath, fullPage: true })
      screenshotEvidence.push({
        viewport: viewport.id,
        size: { width: viewport.width, height: viewport.height },
        path: screenshotPath,
        shell: '.aui-shell',
        main: 'main#content',
        navigation: viewport.expects.sidebar ? '.aui-sidebar' : '[aria-label="Mobile navigation"]',
      })
    }

    writeFileSync(
      join(screenshotDir, 'summary.json'),
      `${JSON.stringify({
        command: 'pnpm --filter @aurora/tauri-ui test:e2e:routes:playwright',
        route: '/',
        assertion: 'desktop and mobile screenshots render the production cockpit shell, not placeholder/debug/raw dashboard UI',
        screenshots: screenshotEvidence,
      }, null, 2)}\n`,
    )
  })


  test('supports keyboard focus through desktop nav and mobile menu sheet', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1024 })
    await page.goto('/')
    await expect(page.locator('.aui-shell')).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(page.locator('.aui-sidebar a').first()).toBeFocused()
    await expectFocusedWithVisibleOutline(page, 'desktop primary nav')

    await page.getByRole('link', { name: /Mesh Mesh route state/i }).focus()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/mesh$/)
    await expect(page.getByRole('heading', { name: /Mesh/i }).first()).toBeVisible()

    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    await expect(page.getByLabel('Mobile navigation', { exact: true })).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(page.getByLabel('Open menu')).toBeFocused()
    await expectFocusedWithVisibleOutline(page, 'mobile menu summary')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Mobile navigation sheet' })).toBeVisible()

    await page.keyboard.press('Tab')
    await expect(page.locator('.aui-mobile-sheet a').first()).toBeFocused()
    await expectFocusedWithVisibleOutline(page, 'mobile sheet route link')
  })


  test('production-crawls all primary routes without console, HTTP, placeholder, or landmark regressions', async ({ page }) => {
    const failures: string[] = []
    expect(primaryNavItems).toHaveLength(22)

    for (const route of primaryNavItems) {
      const routeFailures = await collectPageFailures(page, async () => {
        await page.goto(route.href)
        await expect(page.locator('main#content')).toBeVisible()
      })
      failures.push(...routeFailures.map((failure) => `${route.id} (${route.href}) ${failure}`))

      const bodyText = normalizeText(await page.locator('body').innerText())
      const mainText = normalizeText(await page.locator('main#content').innerText())
      const oracle = getProductionRouteOracle(route.id)

      if (!oracle) {
        failures.push(`${route.id} (${route.href}) is missing a production route oracle`)
      }
      for (const landmark of ROUTE_SPECIFIC_PLAYWRIGHT_LANDMARKS[route.id] ?? oracle?.renderedLandmarks ?? []) {
        if (!mainText.includes(landmark)) {
          failures.push(`${route.id} (${route.href}) missing route-specific landmark: ${landmark}`)
        }
      }
      for (const marker of PLACEHOLDER_COPY_MARKERS) {
        if (bodyText.includes(marker)) {
          failures.push(`${route.id} (${route.href}) rendered placeholder marker: ${marker}`)
        }
      }
      if (bodyText.includes(`${route.label} route registry error`)) {
        failures.push(`${route.id} (${route.href}) rendered route registry error`)
      }
    }

    expect(failures).toEqual([])
  })

  test('captures desktop screenshots for every primary route with stable route evidence', async ({ page }) => {
    mkdirSync(screenshotDir, { recursive: true })
    await page.setViewportSize({ width: 1440, height: 1024 })
    const screenshotEvidence: Array<Record<string, unknown>> = []

    for (const route of primaryNavItems) {
      await page.goto(route.href)
      await expect(page.locator('.aui-shell')).toBeVisible()
      await expect(page.locator('main#content')).toBeVisible()
      const oracle = getProductionRouteOracle(route.id)
      expect(oracle, `${route.id} should have production oracle screenshot evidence`).toBeDefined()
      for (const landmark of ROUTE_SPECIFIC_PLAYWRIGHT_LANDMARKS[route.id] ?? oracle?.renderedLandmarks ?? []) {
        await expect(page.locator('main#content'), `${route.id} should render ${landmark}`).toContainText(landmark)
      }

      const screenshotPath = join(screenshotDir, `route-${routeScreenshotName(route)}`)
      await page.screenshot({ path: screenshotPath, fullPage: true })
      screenshotEvidence.push({
        id: route.id,
        href: route.href,
        label: route.label,
        path: screenshotPath,
        landmarks: ROUTE_SPECIFIC_PLAYWRIGHT_LANDMARKS[route.id] ?? oracle?.renderedLandmarks ?? [],
        oracleLandmarks: oracle?.renderedLandmarks ?? [],
        oracleControls: oracle?.routeSpecificControls ?? [],
      })
    }

    writeFileSync(
      join(screenshotDir, 'all-routes-summary.json'),
      `${JSON.stringify({
        command: 'pnpm --filter @aurora/tauri-ui test:e2e:routes:playwright',
        assertion: 'all 22 primary routes captured at desktop viewport with production route oracle landmarks',
        routeCount: screenshotEvidence.length,
        screenshots: screenshotEvidence,
      }, null, 2)}\n`,
    )
  })
})
