import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'

type Surface = 'web' | 'desktop-local' | 'desktop-thin' | 'android' | 'ios'
type Viewport = 'full' | 'tablet' | 'phone'
type Theme = 'dark' | 'light'

interface SurfaceCase {
  readonly id: Surface
  readonly role: 'remote-console' | 'mesh-node'
  readonly admin: '0' | '1'
  readonly tier?: 'none' | 'lightweight-ts' | 'python-full'
}

interface MatrixContext {
  readonly surface: SurfaceCase
  readonly viewport: Viewport
  readonly theme: Theme
}

interface ViewCase {
  readonly id: string
  readonly path: string
  readonly admin?: '0' | '1'
  readonly heading: RegExp | string
  readonly anchorRole?: 'heading' | 'region'
  readonly contexts?: readonly MatrixContext[]
  readonly prepare?: (page: Page, context: MatrixContext) => Promise<void>
}

interface ComponentViewCase {
  readonly id: string
  readonly harnessCase: string
  readonly heading: RegExp | string
  readonly contexts: readonly MatrixContext[]
  readonly prepare?: (page: Page, context: MatrixContext) => Promise<void>
}

const surfaces: SurfaceCase[] = [
  { id: 'web', role: 'remote-console', admin: '0', tier: 'none' },
  { id: 'desktop-local', role: 'mesh-node', admin: '0', tier: 'python-full' },
  { id: 'desktop-thin', role: 'remote-console', admin: '0', tier: 'none' },
  { id: 'android', role: 'mesh-node', admin: '0', tier: 'lightweight-ts' },
  { id: 'ios', role: 'remote-console', admin: '0', tier: 'none' },
]

const viewports: Record<Viewport, { width: number; height: number }> = {
  full: { width: 1440, height: 1024 },
  tablet: { width: 768, height: 1024 },
  phone: { width: 390, height: 844 },
}

const themes: Theme[] = ['dark', 'light']

const productMatrix: MatrixContext[] = surfaces.flatMap((surface) =>
  (Object.keys(viewports) as Viewport[]).flatMap((viewport) =>
    themes.map((theme) => ({ surface, viewport, theme })),
  ),
)

const overlayMatrix: MatrixContext[] = [
  { surface: surfaces[0], viewport: 'full', theme: 'dark' },
  { surface: surfaces[0], viewport: 'full', theme: 'light' },
  { surface: surfaces[1], viewport: 'tablet', theme: 'dark' },
  { surface: surfaces[3], viewport: 'phone', theme: 'dark' },
  { surface: surfaces[4], viewport: 'phone', theme: 'light' },
]

const mobileSheetMatrix: MatrixContext[] = [
  { surface: surfaces[0], viewport: 'phone', theme: 'dark' },
  { surface: surfaces[3], viewport: 'phone', theme: 'dark' },
  { surface: surfaces[4], viewport: 'phone', theme: 'light' },
]

const componentMatrix: MatrixContext[] = [
  { surface: surfaces[0], viewport: 'full', theme: 'dark' },
  { surface: surfaces[0], viewport: 'full', theme: 'light' },
  { surface: surfaces[1], viewport: 'tablet', theme: 'dark' },
  { surface: surfaces[3], viewport: 'phone', theme: 'dark' },
]

const productViews: ViewCase[] = [
  { id: 'assistant', path: '/', heading: 'Text chat with Aurora' },
  {
    id: 'shell-navigation',
    path: '/settings',
    heading: 'This device',
    contexts: mobileSheetMatrix,
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Show navigation menu' }).click()
      await expect(page.getByRole('dialog', { name: 'Navigation', exact: true })).toBeVisible()
    },
  },
  { id: 'mesh-peers', path: '/mesh', heading: 'Connected devices' },
  { id: 'models', path: '/models', heading: 'Models & Sources' },
  { id: 'settings', path: '/settings', heading: 'This device' },
  { id: 'voice-settings', path: '/admin/voice', admin: '1', heading: 'Spoken replies', anchorRole: 'region' },
  { id: 'onboarding', path: '/onboarding', heading: /Set up Aurora|Aurora/u },
  { id: 'admin-overview', path: '/admin', admin: '1', heading: 'Admin overview' },
]

const overlayViews: ViewCase[] = [
  {
    id: 'assistant-execution-popover',
    path: '/',
    heading: 'Text chat with Aurora',
    contexts: overlayMatrix,
    prepare: async (page) => {
      const executionSelector = page.getByRole('combobox', { name: /^Using\b/iu })
      await expect(executionSelector).toBeVisible({ timeout: 10_000 })
      await executionSelector.click()
      await expect(page.getByRole('listbox', { name: 'Suggestions', exact: true })).toBeVisible()
    },
  },
  {
    id: 'assistant-model-popover',
    path: '/',
    heading: 'Text chat with Aurora',
    contexts: overlayMatrix,
    prepare: async (page) => {
      const modelSelector = page.getByRole('combobox', { name: /^Model:/u })
      await expect(modelSelector).toBeVisible({ timeout: 10_000 })
      await modelSelector.click()
      await expect(page.getByPlaceholder('Search available models...')).toBeVisible()
    },
  },
  {
    id: 'assistant-conversations-sheet',
    path: '/',
    heading: 'Text chat with Aurora',
    contexts: mobileSheetMatrix,
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Open conversations' }).click()
      await expect(page.getByRole('heading', { name: 'Conversations' })).toBeVisible()
    },
  },
  {
    id: 'debug-preview-panel',
    path: '/',
    heading: 'Text chat with Aurora',
    contexts: overlayMatrix,
    prepare: async (page) => {
      const badge = page.getByRole('button', { name: /^Development preview:/u })
      await expect(badge).toHaveCSS('position', 'fixed')
      await expect(badge).toHaveCSS('right', '16px')
      await expect(badge).toHaveCSS('bottom', '16px')
      await badge.click()
      await expect(badge).toHaveAttribute('aria-expanded', 'true')
      await expect(page.locator('select[aria-label="Development preview surface"]')).toBeVisible()
    },
  },
  {
    id: 'voice-settings-language-popover',
    path: '/settings',
    heading: 'This device',
    // The iOS browser preview has no native voice adapter, so local voice controls
    // are unavailable. iOS overlays remain covered by the other popover cases.
    contexts: overlayMatrix.filter((context) => context.surface.id !== 'ios'),
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Choose primary language' }).click()
      await expect(page.getByPlaceholder('Search languages')).toBeVisible()
    },
  },
]

const componentViews: ComponentViewCase[] = [
  { id: 'route-sheet-open', harnessCase: 'route-sheet', heading: 'Route and privacy', contexts: componentMatrix },
  {
    id: 'route-sheet-loading', harnessCase: 'route-sheet-loading', heading: 'Route and privacy', contexts: componentMatrix,
    prepare: async (page, context) => {
      await expect(page.locator('section[data-state="loading"]')).toBeVisible()
      const notice = page.getByText('Loading policy from Aurora.').locator('..')
      await expect(notice).toHaveCSS('background-color', context.theme === 'dark' ? 'rgb(17, 20, 26)' : 'rgb(255, 255, 255)')
      await expect(notice).toHaveClass(/border-border/)
      await expect(notice).toContainText('Loading policy from Aurora.')
      await expect(page.getByRole('button', { name: 'Use selected route' })).toBeDisabled()
    },
  },
  { id: 'tool-details', harnessCase: 'tool-details', heading: 'Tool request and result', contexts: componentMatrix },
  { id: 'route-policy', harnessCase: 'route-policy', heading: 'How Aurora chooses a device', contexts: componentMatrix },
  { id: 'audio-recorder', harnessCase: 'audio-recorder', heading: 'Voice recorder states', contexts: componentMatrix },
  { id: 'component-dialog-open', harnessCase: 'dialog-open', heading: 'Connection choice', contexts: componentMatrix },
  { id: 'component-sheet-open', harnessCase: 'sheet-open', heading: 'Navigation', contexts: componentMatrix },
  {
    id: 'component-popover-open',
    harnessCase: 'popover-open',
    heading: 'Open component popover',
    contexts: componentMatrix,
    prepare: async (page) => {
      const popup = page.getByRole('dialog')
      await expect(popup).toBeVisible()
      await expect(popup).toBeInViewport()
    },
  },
  { id: 'managed-voices-confirmation', harnessCase: 'managed-voices-confirmation', heading: 'Delete voice?', contexts: componentMatrix },
  { id: 'managed-voices-populated', harnessCase: 'managed-voices-populated', heading: 'Voices available to Aurora', contexts: componentMatrix },
]

const componentBaseURL = process.env.AURORA_UI_VISUAL_COMPONENT_BASE_URL?.trim()
  || `http://127.0.0.1:${process.env.AURORA_UI_VISUAL_COMPONENT_PORT ?? '3429'}`


test.describe('Aurora UI visual baselines', () => {
  for (const view of [...productViews, ...overlayViews]) {
    for (const context of view.contexts ?? productMatrix) {
      test(`${view.id}/${context.surface.id}/${context.viewport}/${context.theme}`, async ({ page }) => {
        await loadProductView(page, view, context)
        await expect(page).toHaveScreenshot([view.id, `${context.surface.id}-${context.viewport}-${context.theme}.png`], {
          fullPage: true,
        })
      })
    }
  }

  for (const view of componentViews) {
    for (const context of view.contexts) {
      test(`${view.id}/${context.surface.id}/${context.viewport}/${context.theme}`, async ({ page }) => {
        await loadComponentView(page, view, context)
        await expect(page).toHaveScreenshot([view.id, `${context.surface.id}-${context.viewport}-${context.theme}.png`], {
          fullPage: true,
        })
      })
    }
  }

  test('theme and surface tokens expose usable contrast and radius', async ({ page }) => {
    const snapshots: Array<{ shellBackground: string; shellInk: string; sidebarBackground: string; sidebarInk: string; tabBackground: string; tabInk: string; chipBackground: string; chipInk: string; chipBorder: string; sidebarContrast: number; tabContrast: number; chipContrast: number }> = []
    for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize(viewports.full)
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
      await page.goto(`/?aurora-surface=web&aurora-role=remote-console&aurora-viewport=full&theme=${theme}`, {
        waitUntil: 'domcontentloaded',
      })
      await expect(page.getByRole('heading', { name: 'Text chat with Aurora' })).toBeVisible()
      await expect(page.locator('.aui-sidebar')).toBeVisible()
      const desktop = await page.evaluate(() => {
        const shell = document.querySelector<HTMLElement>('.aui-shell')
        const sidebar = document.querySelector<HTMLElement>('.aui-sidebar')
        const style = (element: HTMLElement | null) => element ? getComputedStyle(element) : null
        const shellStyle = style(shell); const sidebarStyle = style(sidebar)
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
        const context = canvas.getContext('2d')!
        const cssColor = (value: string) => { context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1); const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data; return [r / 255, g / 255, b / 255, a / 255] }
        const composite = (foreground: number[], background: number[]) => { const alpha = foreground[3] + background[3] * (1 - foreground[3]); if (!alpha) return [0, 0, 0, 0]; return [(foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) / alpha, (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) / alpha, (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) / alpha, alpha] }
        const effectiveBackground = (element: HTMLElement | null | undefined) => { let result = [0, 0, 0, 0]; for (let node = element; node; node = node.parentElement) { const nodeStyle = getComputedStyle(node); if (nodeStyle.backgroundImage !== 'none') throw new Error(`unsupported background image on ${node.className}`); result = composite(result, cssColor(nodeStyle.backgroundColor)); } if (result[3] < 0.999) throw new Error('effective background is not opaque'); return result }
        const luminance = (value: number[]) => value.slice(0, 3).map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0)
        const contrast = (foreground: number[], background: number[]) => { const a = luminance(foreground); const b = luminance(background); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) }
        const sidebarBackground = effectiveBackground(sidebar); const sidebarForeground = composite(cssColor(sidebarStyle?.color ?? ''), sidebarBackground)
        return {
          shellBackground: shellStyle?.backgroundColor ?? '',
          shellInk: shellStyle?.color ?? '',
          sidebarBackground: sidebarStyle?.backgroundColor ?? '',
          sidebarInk: sidebarStyle?.color ?? '',
          sidebarContrast: contrast(sidebarForeground, sidebarBackground),
        }
      })
      expect(desktop.sidebarContrast).toBeGreaterThanOrEqual(4.5)
      await page.setViewportSize(viewports.phone)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await expect(page.locator('.aui-mobile-tabs')).toBeVisible()
      const sourceChip = page.locator('div').filter({ hasText: /^Sources:/u }).locator('code').first()
      await expect(sourceChip).toBeVisible()
      const mobile = await page.evaluate(() => {
        const tab = document.querySelector<HTMLElement>('.aui-mobile-tabs'); const text = tab?.querySelector<HTMLElement>('[data-mobile-tab]:not([aria-current])')
        const sourceRow = [...document.querySelectorAll<HTMLElement>('div')].find((element) => element.textContent?.trim().startsWith('Sources:')); const chip = sourceRow?.querySelector<HTMLElement>('code'); const style = (element: HTMLElement | null | undefined) => element ? getComputedStyle(element) : null
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const context = canvas.getContext('2d')!
        const cssColor = (value: string) => { context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1); const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data; return [r / 255, g / 255, b / 255, a / 255] }
        const composite = (foreground: number[], background: number[]) => { const alpha = foreground[3] + background[3] * (1 - foreground[3]); if (!alpha) return [0, 0, 0, 0]; return [(foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) / alpha, (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) / alpha, (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) / alpha, alpha] }
        const effectiveBackground = (element: HTMLElement | null | undefined) => { let result = [0, 0, 0, 0]; for (let node = element; node; node = node.parentElement) { const nodeStyle = getComputedStyle(node); if (nodeStyle.backgroundImage !== 'none') throw new Error(`unsupported background image on ${node.className}`); result = composite(result, cssColor(nodeStyle.backgroundColor)); } if (result[3] < 0.999) throw new Error('effective background is not opaque'); return result }
        const luminance = (value: number[]) => value.slice(0, 3).map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0)
        const contrast = (foreground: number[], background: number[]) => { const a = luminance(foreground); const b = luminance(background); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) }
        const tabBackground = effectiveBackground(tab); const tabForeground = composite(cssColor(style(text)?.color ?? ''), tabBackground); const chipBackground = effectiveBackground(chip); const chipForeground = composite(cssColor(style(chip)?.color ?? ''), chipBackground)
        return { tabBackground: style(tab)?.backgroundColor ?? '', tabInk: style(text)?.color ?? '', tabContrast: contrast(tabForeground, tabBackground), chipBackground: style(chip)?.backgroundColor ?? '', chipInk: style(chip)?.color ?? '', chipBorder: style(chip)?.borderColor ?? '', chipContrast: contrast(chipForeground, chipBackground) }
      })
      expect(mobile.tabContrast).toBeGreaterThanOrEqual(4.5)
      expect(mobile.chipBackground).not.toBe('rgba(0, 0, 0, 0)')
      expect(mobile.chipBorder).not.toBe('rgba(0, 0, 0, 0)')
      expect(mobile.chipContrast).toBeGreaterThanOrEqual(4.5)
      snapshots.push({ ...desktop, ...mobile })
    }
    expect(snapshots[0].shellBackground).not.toBe(snapshots[1].shellBackground)
    expect(snapshots[0].shellInk).not.toBe(snapshots[1].shellInk)
    expect(snapshots[0].sidebarBackground).not.toBe(snapshots[1].sidebarBackground)
    expect(snapshots[0].tabBackground).not.toBe(snapshots[1].tabBackground)
    expect(snapshots[0].chipBackground).not.toBe(snapshots[1].chipBackground)
  })

  test('playwright-threshold/rejects-2px-mutation @mutation', async ({ page }, testInfo) => {
    const context: MatrixContext = { surface: surfaces[0], viewport: 'full', theme: 'dark' }
    await loadComponentView(page, {
      id: 'playwright-threshold',
      harnessCase: 'playwright-threshold',
      heading: 'Playwright threshold visual harness',
      contexts: [context],
    }, context)
    const target = page.locator('[data-visual-threshold-target]')
    await expect(target).toHaveScreenshot(['playwright-threshold', 'target.png'])
    if (isUpdatingSnapshots(testInfo)) return

    await target.evaluate((element) => {
      const mutation = document.createElement('div')
      mutation.setAttribute('data-visual-threshold-mutation', 'true')
      Object.assign(mutation.style, {
        position: 'absolute',
        top: '20px',
        bottom: '20px',
        left: '42px',
        width: '2px',
        background: 'rgb(255, 0, 0)',
      })
      element.appendChild(mutation)
    })
    await expectPlaywrightScreenshotToReject(target)
  })
})

async function loadProductView(page: Page, view: ViewCase, context: MatrixContext): Promise<void> {
  await preparePage(page, context)
  await page.goto(`${view.path}?${queryFor(context, view.admin).toString()}`, { waitUntil: 'domcontentloaded' })
  await waitForShellSettled(page, view.heading, view.anchorRole)
  await settlePage(page, context.theme)
  await view.prepare?.(page, context)
  await waitForNoShellLoading(page)
  await settlePage(page, context.theme)
}

async function loadComponentView(page: Page, view: ComponentViewCase, context: MatrixContext): Promise<void> {
  await preparePage(page, context)
  const params = queryFor(context)
  params.set('case', view.harnessCase)
  params.set('theme', context.theme)
  params.set('surface', context.surface.id)
  await page.goto(`${componentBaseURL}/component-harness?${params.toString()}`, { waitUntil: 'domcontentloaded' })
  await waitForHeading(page, view.heading)
  await settlePage(page, context.theme)
  await view.prepare?.(page, context)
  await settlePage(page, context.theme)
}

async function preparePage(page: Page, context: MatrixContext): Promise<void> {
  await page.setViewportSize(viewports[context.viewport])
  await page.emulateMedia({ colorScheme: context.theme, reducedMotion: 'reduce' })
  await page.addInitScript((theme) => {
    try {
      window.localStorage.clear()
      window.sessionStorage.clear()
    } catch {
      // Some harness documents may not expose storage consistently across engines.
    }
    document.documentElement?.classList.toggle('dark', theme === 'dark')
  }, context.theme)
}

async function waitForShellSettled(page: Page, heading: RegExp | string, role: 'heading' | 'region' = 'heading'): Promise<void> {
  await waitForNoShellLoading(page)
  await expect(page.getByRole(role, { name: heading, exact: typeof heading === 'string' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/Loading Aurora|Connecting to Aurora/iu)).toHaveCount(0)
}

async function waitForNoShellLoading(page: Page): Promise<void> {
  await expect(page.getByText(/Loading Aurora|Connecting to Aurora/iu)).toHaveCount(0, { timeout: 30_000 })
}

async function waitForHeading(page: Page, heading: RegExp | string): Promise<void> {
  await expect(page.getByRole('heading', { name: heading, exact: typeof heading === 'string' })).toBeVisible({ timeout: 30_000 })
}

async function settlePage(page: Page, theme: Theme): Promise<void> {
  await page.locator('body').waitFor({ state: 'visible' })
  await page.evaluate(async (themeId) => {
    document.documentElement.classList.toggle('dark', themeId === 'dark')
    document.body.dataset.auroraVisualBaseline = 'true'
    const existing = document.head.querySelector('style[data-aurora-visual-baseline="stable"]')
    if (!existing) {
      const style = document.createElement('style')
      style.dataset.auroraVisualBaseline = 'stable'
      style.textContent = `
        *, *::before, *::after {
          animation-delay: 0s !important;
          animation-duration: 0s !important;
          caret-color: transparent !important;
          transition-delay: 0s !important;
          transition-duration: 0s !important;
        }
        [data-nextjs-toast],
        [data-nextjs-dialog],
        nextjs-portal {
          display: none !important;
        }
      `
      document.head.appendChild(style)
    }
    await document.fonts?.ready
  }, theme)
  await page.waitForLoadState('networkidle').catch(() => undefined)
  await page.waitForTimeout(150)
}

function queryFor(context: MatrixContext, adminOverride?: '0' | '1'): URLSearchParams {
  return new URLSearchParams({
    'aurora-surface': context.surface.id,
    'aurora-role': context.surface.role,
    'aurora-admin': adminOverride ?? context.surface.admin,
    'aurora-viewport': context.viewport,
    ...(context.surface.tier ? { 'aurora-tier': context.surface.tier } : {}),
  })
}

async function expectPlaywrightScreenshotToReject(target: Locator): Promise<void> {
  let rejected = false
  try {
    await expect(target).toHaveScreenshot(['playwright-threshold', 'target.png'])
  } catch {
    rejected = true
  }
  expect(rejected).toBe(true)
}

function isUpdatingSnapshots(testInfo: TestInfo): boolean {
  const updateMode = testInfo.config.updateSnapshots
  return updateMode === 'all'
    || updateMode === 'changed'
    || process.argv.some((arg) => arg === '-u' || arg === '--update-snapshots' || arg.startsWith('--update-snapshots='))
}
