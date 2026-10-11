import { expect, test, type Page } from '@playwright/test'

const componentBaseURL = process.env.AURORA_UI_VISUAL_COMPONENT_BASE_URL?.trim() ?? 'http://127.0.0.1:3429'

async function firstVisibleAnchor(page: Page): Promise<{ id: string; top: number }> {
  return page.locator('[data-slot="message-scroller-viewport"]').evaluate((viewport) => {
    const viewportRect = viewport.getBoundingClientRect()
    const item = Array.from(viewport.querySelectorAll<HTMLElement>('[data-message-id]')).find((candidate) => {
      const rect = candidate.getBoundingClientRect()
      return rect.bottom > viewportRect.top && rect.top < viewportRect.bottom
    })
    if (!item?.dataset.messageId) throw new Error('No visible history message anchor')
    return { id: item.dataset.messageId, top: item.getBoundingClientRect().top - viewportRect.top }
  })
}

async function messageTop(page: Page, id: string): Promise<number> {
  return page.locator(`[data-message-id="${id}"]`).evaluate((node) => {
    const viewport = node.closest<HTMLElement>('[data-slot="message-scroller-viewport"]')
    if (!viewport) throw new Error('History message is outside its viewport')
    return node.getBoundingClientRect().top - viewport.getBoundingClientRect().top
  })
}

test.describe('Assistant history scroller', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${componentBaseURL}/component-harness?case=history-scroller`)
    await page.locator('[data-history-scroller-fixture]').waitFor()
  })

  test('preserves exact anchor offset after older rows settle', async ({ page }) => {
    const viewport = page.locator('[data-slot="message-scroller-viewport"]')
    await viewport.dispatchEvent('wheel', { deltaY: 1 })
    await viewport.evaluate((node) => { node.scrollTop = 270 })
    await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBe(270)
    const before = await firstVisibleAnchor(page)
    await page.getByRole('button', { name: 'Load older messages' }).evaluate((button) => (button as HTMLButtonElement).click())
    await expect(page.locator('[data-history-scroller-fixture]')).toHaveAttribute('data-history-load-state', 'settled')
    await expect(page.locator('[data-message-id="conversation-a-older-0"]')).toBeVisible()
    await expect.poll(async () => {
      const after = await messageTop(page, before.id)
      return Math.abs(after - before.top)
    }).toBeLessThanOrEqual(1)
  })

  test('restores exact anchor offset after explicit delayed row growth', async ({ page }) => {
    const viewport = page.locator('[data-slot="message-scroller-viewport"]')
    await viewport.dispatchEvent('wheel', { deltaY: 1 })
    await viewport.evaluate((node) => { node.scrollTop = 270 })
    await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBe(270)
    const before = await firstVisibleAnchor(page)
    await page.getByRole('button', { name: 'Load older messages' }).evaluate((button) => (button as HTMLButtonElement).click())
    await expect(page.locator('[data-history-scroller-fixture]')).toHaveAttribute('data-history-load-state', 'settled')
    await expect(page.locator('[data-message-id="conversation-a-older-0"]')).toBeVisible()
    const oldHeight = await page.locator('[data-message-id="conversation-a-older-0"]').evaluate((node) => node.getBoundingClientRect().height)
    await page.getByRole('button', { name: 'Grow delayed row' }).click()
    await expect.poll(() => page.locator('[data-message-id="conversation-a-older-0"]').evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThan(oldHeight)
    await expect.poll(async () => {
      const after = await messageTop(page, before.id)
      return Math.abs(after - before.top)
    }).toBeLessThanOrEqual(1)
  })

  test('releases anchor on wheel and keeps user-selected offset', async ({ page }) => {
    const viewport = page.locator('[data-slot="message-scroller-viewport"]')
    await viewport.dispatchEvent('wheel', { deltaY: 1 }); await viewport.evaluate((node) => { node.scrollTop = 270 }); await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBe(270)
    const before = await firstVisibleAnchor(page)
    await page.getByRole('button', { name: 'Load older messages' }).evaluate((button) => (button as HTMLButtonElement).click()); await expect(page.locator('[data-history-scroller-fixture]')).toHaveAttribute('data-history-load-state', 'pending')
    const originalTop = await messageTop(page, before.id)
    const originalScrollTop = await viewport.evaluate((node) => node.scrollTop)
    await viewport.dispatchEvent('wheel', { deltaY: 90 })
    await viewport.evaluate((node) => { node.scrollTop += 90 })
    await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBeGreaterThan(originalScrollTop)
    const chosenTop = await messageTop(page, before.id)
    const chosenScrollTop = await viewport.evaluate((node) => node.scrollTop)
    await expect(page.locator('[data-history-scroller-fixture]')).toHaveAttribute('data-history-load-state', 'settled'); await expect(page.locator('[data-message-id="conversation-a-older-0"]')).toBeVisible(); await page.getByRole('button', { name: 'Grow delayed row' }).click()
    await expect.poll(() => page.locator('[data-message-id="conversation-a-older-0"]').evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThan(72)
    const afterTop = await messageTop(page, before.id); const afterScrollTop = await viewport.evaluate((node) => node.scrollTop); expect(Math.abs(chosenTop - originalTop)).toBeGreaterThan(1); expect(Math.abs(afterTop - chosenTop)).toBeGreaterThan(100); expect(Math.abs(afterScrollTop - chosenScrollTop)).toBeLessThanOrEqual(1)
  })

  test('drops stale old load on history scope switch with same conversation', async ({ page }) => {
    const viewport = page.locator('[data-slot="message-scroller-viewport"]')
    const anchor = page.locator('[data-message-id="conversation-a-message-3"]')
    await viewport.evaluate((node) => { node.scrollTop = 100 }); await page.getByRole('button', { name: 'Load older messages' }).click(); await page.getByRole('button', { name: 'Switch scope' }).click(); await viewport.evaluate((node) => { node.scrollTop = 220 }); const chosen = await anchor.boundingBox(); const chosenScrollTop = await viewport.evaluate((node) => node.scrollTop); await page.getByRole('button', { name: 'Grow delayed row' }).click(); await expect(page.locator('[data-history-scroller-fixture]')).toHaveAttribute('data-history-load-state', 'settled'); await expect(page.locator('[data-message-id="conversation-a-message-3"]')).toBeVisible(); await expect(page.locator('[data-message-id="conversation-a-older-0"]')).not.toBeAttached(); const after = await anchor.boundingBox(); const afterScrollTop = await viewport.evaluate((node) => node.scrollTop); expect(Math.abs(after!.y - chosen!.y)).toBeGreaterThan(100); expect(Math.abs(afterScrollTop - chosenScrollTop)).toBeLessThanOrEqual(1)
  })

  test('follows bottom after an explicit append control', async ({ page }) => {
    const viewport = page.locator('[data-slot="message-scroller-viewport"]'); await viewport.evaluate((node) => { node.scrollTop = node.scrollHeight })
    await page.getByRole('button', { name: 'Append message' }).click(); await expect(page.locator('[data-message-id="conversation-a-appended-12"]')).toBeVisible(); await expect.poll(() => viewport.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThanOrEqual(2)
  })
})
