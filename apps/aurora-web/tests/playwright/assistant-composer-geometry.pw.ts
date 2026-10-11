import { expect, test, type Locator, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type HandsFreeState = 'available' | 'absent'
type CompactMode = 'phone' | 'tablet'

interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly right: number
  readonly bottom: number
}

const testDir = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(testDir, '../..')
const repoRoot = resolve(appRoot, '../..')
const componentBaseURL = process.env.AURORA_UI_VISUAL_COMPONENT_BASE_URL?.trim()
  || `http://127.0.0.1:${process.env.AURORA_UI_VISUAL_COMPONENT_PORT ?? '3429'}`

const physicalViewports = [
  { id: 'phone-physical', width: 390, height: 844 },
  { id: 'tablet-physical', width: 768, height: 1024 },
  { id: 'desktop-physical', width: 1440, height: 1024 },
] as const

const compactViewports = [
  { id: 'phone-compact', compact: 'phone' as const, frameWidth: 390 },
  { id: 'tablet-compact', compact: 'tablet' as const, frameWidth: 768 },
] as const

const handsFreeStates: readonly HandsFreeState[] = ['available', 'absent']

test.describe('assistant composer control geometry', () => {
  for (const viewport of physicalViewports) {
    for (const handsfree of handsFreeStates) {
      test(`${viewport.id}/${handsfree}`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height })
        await loadComposerHarness(page, { handsfree })
        await expectComposerControlsToBeContainedAndSeparate(page, handsfree)
      })
    }
  }

  for (const viewport of compactViewports) {
    for (const handsfree of handsFreeStates) {
      test(`${viewport.id}/desktop-window/${handsfree}`, async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 1024 })
        await loadComposerHarness(page, { handsfree, compact: viewport.compact })
        await expectFrameWidth(page, viewport.frameWidth)
        await expectComposerControlsToBeContainedAndSeparate(page, handsfree)
        await expectCompactDebugGridOverride(page, handsfree, viewport.compact)
      })
    }
  }
})

async function loadComposerHarness(
  page: Page,
  options: { readonly handsfree: HandsFreeState; readonly compact?: CompactMode },
): Promise<void> {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  const params = new URLSearchParams({
    case: 'assistant-composer',
    theme: 'dark',
    surface: 'desktop-local',
    handsfree: options.handsfree,
    text: 'Geometry check',
    'aurora-surface': 'desktop-local',
    'aurora-role': 'mesh-node',
    'aurora-tier': 'python-full',
    'aurora-admin': '0',
    'aurora-viewport': options.compact ?? 'full',
  })
  if (options.compact) params.set('compact', options.compact)

  await page.goto(`${componentBaseURL}/component-harness?${params.toString()}`, { waitUntil: 'domcontentloaded' })
  await page.addStyleTag({ content: readAuroraDebugRuntimeCss() })
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-delay: 0s !important;
        animation-duration: 0s !important;
        transition-delay: 0s !important;
        transition-duration: 0s !important;
      }
    `,
  })

  await expect(page.locator('[data-assistant-composer-harness="true"]')).toBeVisible()
  await expect(page.getByRole('form', { name: 'Prompt composer' })).toBeVisible()
  await expect(page.locator('[data-aurora-part="assistant-composer-control-row"]')).toBeVisible()
  await page.evaluate(async () => {
    await document.fonts?.ready
  })
}

async function expectComposerControlsToBeContainedAndSeparate(page: Page, handsfree: HandsFreeState): Promise<void> {
  const composer = page.locator('[data-aurora-part="assistant-composer"]')
  const row = page.locator('[data-aurora-part="assistant-composer-control-row"]')
  const pushToTalk = page.locator('[data-aurora-part="assistant-composer-push-to-talk"]')
  const send = page.locator('[data-aurora-part="assistant-composer-send"]')
  const handsFree = page.locator('[data-aurora-part="assistant-composer-hands-free"]')

  await expect(composer).toBeVisible()
  await expect(row).toBeVisible()
  await expect(pushToTalk).toBeVisible()
  await expect(send).toBeVisible()
  await expect(pushToTalk).toBeEnabled()
  await expect(send).toBeEnabled()
  await expect(composer.locator('[data-slot="model-selector-value"]').getByText("Aurora Small", { exact: true })).toBeVisible()

  const composerBox = await rectFor(composer)
  const rowBox = await rectFor(row)
  const pushToTalkBox = await rectFor(pushToTalk)
  const sendBox = await rectFor(send)
  const visibleControls: Array<[string, Rect]> = [
    ['push-to-talk', pushToTalkBox],
    ['send', sendBox],
  ]

  expectContainedBy(pushToTalkBox, composerBox, 'push-to-talk/composer')
  expectContainedBy(pushToTalkBox, rowBox, 'push-to-talk/control-row')
  expectContainedBy(sendBox, composerBox, 'send/composer')
  expectContainedBy(sendBox, rowBox, 'send/control-row')

  if (handsfree === 'available') {
    await expect(row).toHaveAttribute('data-aurora-hands-free', 'available')
    await expect(handsFree).toBeVisible()
    await expect(handsFree).toBeEnabled()
    const handsFreeBox = await rectFor(handsFree)
    expectContainedBy(handsFreeBox, composerBox, 'hands-free/composer')
    expectContainedBy(handsFreeBox, rowBox, 'hands-free/control-row')
    visibleControls.push(['hands-free', handsFreeBox])
  } else {
    await expect(row).not.toHaveAttribute('data-aurora-hands-free', /available/u)
    await expect(handsFree).toHaveCount(0)
  }

  for (const [name, box] of visibleControls) {
    expect(box.width, `${name} should have a clickable width`).toBeGreaterThanOrEqual(32)
    expect(box.height, `${name} should have a clickable height`).toBeGreaterThanOrEqual(32)
  }

  for (let first = 0; first < visibleControls.length; first += 1) {
    for (let second = first + 1; second < visibleControls.length; second += 1) {
      const [firstName, firstBox] = visibleControls[first]!
      const [secondName, secondBox] = visibleControls[second]!
      expect(overlapArea(firstBox, secondBox), `${firstName} must not overlap ${secondName}`).toBe(0)
    }
  }
}

async function expectCompactDebugGridOverride(page: Page, handsfree: HandsFreeState, compact: CompactMode): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-aurora-debug-compact', compact)
  const row = page.locator('[data-aurora-part="assistant-composer-control-row"]')
  const columns = await row.evaluate((element) => getComputedStyle(element).gridTemplateColumns)
  const columnCount = columns.split(/\s+/u).filter(Boolean).length
  expect(columnCount, `${compact} compact grid should expose the expected number of composer columns`).toBe(handsfree === 'available' ? 6 : 5)

  const controlSizes = await page.locator('[data-aurora-part="assistant-composer-control-row"] > [data-aurora-control="button"]').evaluateAll((controls) =>
    controls.map((control) => {
      const rect = control.getBoundingClientRect()
      return { width: rect.width, height: rect.height }
    }),
  )
  expect(controlSizes.length).toBe(handsfree === 'available' ? 5 : 4)
  for (const [index, size] of controlSizes.entries()) {
    expect(size.width, `${compact} compact control ${index} width`).toBeCloseTo(40, 0)
    expect(size.height, `${compact} compact control ${index} height`).toBeCloseTo(40, 0)
  }
}

async function expectFrameWidth(page: Page, expectedWidth: number): Promise<void> {
  const frame = page.locator('.aurora-debug-viewport-frame[data-fixture-viewport="assistant-composer"]')
  await expect(frame).toBeVisible()
  const box = await rectFor(frame)
  expect(box.width, `compact fixture frame should be ${expectedWidth}px wide inside the desktop browser window`).toBeCloseTo(expectedWidth, 0)
}

async function rectFor(locator: Locator): Promise<Rect> {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      right: rect.right,
      bottom: rect.bottom,
    }
  })
}

function expectContainedBy(inner: Rect, outer: Rect, label: string): void {
  const epsilon = 0.5
  expect(inner.x, `${label} left edge`).toBeGreaterThanOrEqual(outer.x - epsilon)
  expect(inner.y, `${label} top edge`).toBeGreaterThanOrEqual(outer.y - epsilon)
  expect(inner.right, `${label} right edge`).toBeLessThanOrEqual(outer.right + epsilon)
  expect(inner.bottom, `${label} bottom edge`).toBeLessThanOrEqual(outer.bottom + epsilon)
}

function overlapArea(first: Rect, second: Rect): number {
  const epsilon = 0.5
  const width = Math.max(0, Math.min(first.right, second.right) - Math.max(first.x, second.x) - epsilon)
  const height = Math.max(0, Math.min(first.bottom, second.bottom) - Math.max(first.y, second.y) - epsilon)
  return width * height
}

let cachedDebugRuntimeCss: string | null = null
function readAuroraDebugRuntimeCss(): string {
  if (cachedDebugRuntimeCss !== null) return cachedDebugRuntimeCss
  const source = readFileSync(resolve(repoRoot, 'apps/aurora-web/app/debug-ui-picker.tsx'), 'utf8')
  const match = /const AURORA_DEBUG_UI_RUNTIME_CSS = `([\s\S]*?)`/u.exec(source)
  if (!match?.[1]) throw new Error('Unable to extract AURORA_DEBUG_UI_RUNTIME_CSS from debug-ui-picker.tsx')
  cachedDebugRuntimeCss = match[1]
  return cachedDebugRuntimeCss
}
