import { describe, expect, it } from 'vitest'
import {
  AURORA_DEBUG_UI_COOKIE_NAME,
  AURORA_DEBUG_UI_DEFAULT_OVERRIDE,
  AURORA_DEBUG_UI_VIEWPORT_PRESETS,
  defaultAuroraDebugUiViewport,
  mergeAuroraDebugUiOverride,
  parseAuroraDebugUiOverride,
  parseAuroraDebugUiOverrideFromCookie,
  preserveAuroraDebugUiSearch,
  resolveAuroraDebugUiOverride,
  serializeAuroraDebugUiOverride,
} from './debug-ui-override'

describe('debug UI runtime override', () => {
  it('parses the agent query contract and aliases', () => {
    expect(parseAuroraDebugUiOverride(
      'aurora-surface=web-thin&aurora-role=remote-console&aurora-admin=1',
    )).toEqual({
      surface: 'web',
      role: 'remote-console',
      admin: true,
      viewport: 'full',
      viewportExplicit: false,
    })

    expect(parseAuroraDebugUiOverride(
      '?aurora-surface=android&aurora-role=mesh-node&aurora-admin=0',
    )).toEqual({
      surface: 'android',
      role: 'mesh-node',
      admin: false,
      viewport: 'phone',
      viewportExplicit: false,
    })

    expect(parseAuroraDebugUiOverride(
      'aurora-surface=desktop-local&aurora-role=python-full',
    )).toEqual({
      surface: 'desktop-local',
      role: 'python-full',
      admin: false,
      viewport: 'full',
      viewportExplicit: false,
    })
  })

  it('parses an explicit viewport and defaults mobile surfaces to phone', () => {
    expect(parseAuroraDebugUiOverride(
      'aurora-surface=android&aurora-viewport=tablet',
    )).toEqual({
      surface: 'android',
      role: 'remote-console',
      admin: false,
      viewport: 'tablet',
      viewportExplicit: true,
    })

    expect(parseAuroraDebugUiOverride('aurora-viewport=iphone')).toEqual({
      ...AURORA_DEBUG_UI_DEFAULT_OVERRIDE,
      viewport: 'phone',
      viewportExplicit: true,
    })

    expect(defaultAuroraDebugUiViewport('ios')).toBe('phone')
    expect(defaultAuroraDebugUiViewport('mobile')).toBe('phone')
    expect(defaultAuroraDebugUiViewport('web')).toBe('full')
    expect(defaultAuroraDebugUiViewport('desktop-thin')).toBe('full')
    expect(AURORA_DEBUG_UI_VIEWPORT_PRESETS.phone).toEqual({ width: 390, height: 844 })
    expect(AURORA_DEBUG_UI_VIEWPORT_PRESETS.tablet).toEqual({ width: 768, height: 1024 })
  })

  it('fills missing fields from the hosted-web default', () => {
    expect(parseAuroraDebugUiOverride('aurora-admin=1')).toEqual({
      ...AURORA_DEBUG_UI_DEFAULT_OVERRIDE,
      admin: true,
    })
  })

  it('reads cookie persistence and prefers query over cookie and sessionStorage', () => {
    const cookie = `${AURORA_DEBUG_UI_COOKIE_NAME}=${encodeURIComponent('aurora-surface=ios&aurora-role=mesh-node&aurora-admin=0')}`
    expect(parseAuroraDebugUiOverrideFromCookie(cookie)).toEqual({
      surface: 'ios',
      role: 'mesh-node',
      admin: false,
      viewport: 'phone',
      viewportExplicit: false,
    })

    expect(resolveAuroraDebugUiOverride({
      nodeEnv: 'development',
      search: 'aurora-surface=android&aurora-role=remote-console&aurora-admin=1',
      cookie,
      sessionStorage: 'aurora-surface=web&aurora-role=mesh-node&aurora-admin=0',
    })).toEqual({
      surface: 'android',
      role: 'remote-console',
      admin: true,
      viewport: 'phone',
      viewportExplicit: false,
    })
  })

  it('stays inert in production even when query and cookie are present', () => {
    expect(resolveAuroraDebugUiOverride({
      nodeEnv: 'production',
      search: 'aurora-surface=android&aurora-role=mesh-node&aurora-admin=1&aurora-viewport=phone',
      cookie: `${AURORA_DEBUG_UI_COOKIE_NAME}=aurora-surface=ios&aurora-role=python-full&aurora-admin=1`,
      sessionStorage: 'aurora-surface=desktop-local&aurora-role=python-full&aurora-admin=1',
    })).toBeNull()
  })

  it('serializes a stable query string and preserves it across product routes', () => {
    const query = serializeAuroraDebugUiOverride({
      surface: 'desktop-thin',
      role: 'mesh-node',
      admin: false,
      viewport: 'full',
      viewportExplicit: false,
    })
    expect(query).toBe('aurora-surface=desktop-thin&aurora-role=mesh-node&aurora-admin=0')
    expect(serializeAuroraDebugUiOverride({
      surface: 'android',
      role: 'mesh-node',
      admin: false,
      viewport: 'tablet',
      viewportExplicit: true,
    })).toBe('aurora-surface=android&aurora-role=mesh-node&aurora-admin=0&aurora-viewport=tablet')
    expect(preserveAuroraDebugUiSearch('/mesh', `?${query}`)).toBe(
      `/mesh?${query}`,
    )
    expect(preserveAuroraDebugUiSearch('/settings?tab=voice', `?${query}`)).toBe(
      `/settings?tab=voice&${query}`,
    )
  })

  it('defaults viewport from surface until the user picks one this session', () => {
    const androidDefault = parseAuroraDebugUiOverride('aurora-surface=android')
    expect(mergeAuroraDebugUiOverride(androidDefault, { surface: 'web' })).toEqual({
      surface: 'web',
      role: 'remote-console',
      admin: false,
      viewport: 'full',
      viewportExplicit: false,
    })

    const chosen = mergeAuroraDebugUiOverride(androidDefault, { viewport: 'tablet' })
    expect(chosen).toMatchObject({ viewport: 'tablet', viewportExplicit: true })
    expect(mergeAuroraDebugUiOverride(chosen, { surface: 'web' })).toMatchObject({
      surface: 'web',
      viewport: 'tablet',
      viewportExplicit: true,
    })

    const leftoverFull = parseAuroraDebugUiOverride(
      'aurora-surface=web&aurora-role=remote-console&aurora-admin=0&aurora-viewport=full',
    )
    expect(leftoverFull).toMatchObject({ viewport: 'full', viewportExplicit: true })
    expect(mergeAuroraDebugUiOverride(leftoverFull, { surface: 'android' })).toEqual({
      surface: 'android',
      role: 'remote-console',
      admin: false,
      viewport: 'phone',
      viewportExplicit: false,
    })
  })
})
