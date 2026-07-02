import { expect, test } from '@playwright/test'
import { auroraNavSections } from '@aurora/ui'

const primaryNavItems = auroraNavSections.flatMap((section) => section.items)

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
