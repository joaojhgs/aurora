import { describe, expect, it } from 'vitest'

import { mobileTabs, navSections } from './nav'

describe('Aurora reference navigation', () => {
  it('keeps route hrefs unique inside sidebar sections', () => {
    const hrefs = navSections.flatMap((section) => section.items.map((item) => item.href))

    expect(new Set(hrefs).size).toBe(hrefs.length)
  })

  it('keeps admin routes explicitly admin gated', () => {
    const adminItems = navSections.flatMap((section) =>
      section.items.filter((item) => item.href.startsWith('/admin')),
    )

    expect(adminItems.length).toBeGreaterThan(0)
    expect(adminItems.every((item) => item.adminGated)).toBe(true)
  })

  it('keeps mobile tabs mapped to known sidebar routes', () => {
    const sidebarHrefs = new Set(navSections.flatMap((section) => section.items.map((item) => item.href)))

    expect(mobileTabs.every((tab) => sidebarHrefs.has(tab.href))).toBe(true)
  })
})
