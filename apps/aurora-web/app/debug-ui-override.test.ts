import { describe, expect, it } from 'vitest'
import {
  AURORA_DEBUG_UI_COOKIE_NAME,
  AURORA_DEBUG_UI_DEFAULT_OVERRIDE,
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
    })

    expect(parseAuroraDebugUiOverride(
      '?aurora-surface=android&aurora-role=mesh-node&aurora-admin=0',
    )).toEqual({
      surface: 'android',
      role: 'mesh-node',
      admin: false,
    })

    expect(parseAuroraDebugUiOverride(
      'aurora-surface=desktop-local&aurora-role=python-full',
    )).toEqual({
      surface: 'desktop-local',
      role: 'python-full',
      admin: false,
    })
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
    })
  })

  it('stays inert in production even when query and cookie are present', () => {
    expect(resolveAuroraDebugUiOverride({
      nodeEnv: 'production',
      search: 'aurora-surface=android&aurora-role=mesh-node&aurora-admin=1',
      cookie: `${AURORA_DEBUG_UI_COOKIE_NAME}=aurora-surface=ios&aurora-role=python-full&aurora-admin=1`,
      sessionStorage: 'aurora-surface=desktop-local&aurora-role=python-full&aurora-admin=1',
    })).toBeNull()
  })

  it('serializes a stable query string and preserves it across product routes', () => {
    const query = serializeAuroraDebugUiOverride({
      surface: 'desktop-thin',
      role: 'mesh-node',
      admin: false,
    })
    expect(query).toBe('aurora-surface=desktop-thin&aurora-role=mesh-node&aurora-admin=0')
    expect(preserveAuroraDebugUiSearch('/mesh', `?${query}`)).toBe(
      `/mesh?${query}`,
    )
    expect(preserveAuroraDebugUiSearch('/settings?tab=voice', `?${query}`)).toBe(
      `/settings?tab=voice&${query}`,
    )
  })
})
