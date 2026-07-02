import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { auroraNavSections } from '@aurora/ui'

const primaryNavItems = auroraNavSections.flatMap((section) => section.items)

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


  test('fails if any primary route renders placeholder copy', async ({ page }) => {
    const failures: string[] = []

    for (const route of primaryNavItems) {
      await page.goto(route.href)
      await expect(page.locator('main#content')).toBeVisible()
      const bodyText = await page.locator('body').innerText()

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
})
