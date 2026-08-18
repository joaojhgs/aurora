'use client'

import { useEffect, useState } from 'react'
import {
  AURORA_DEBUG_UI_ROLES,
  AURORA_DEBUG_UI_SURFACES,
  persistAuroraDebugUiOverride,
  type AuroraDebugUiOverride,
  type AuroraDebugUiRole,
  type AuroraDebugUiSurface,
} from './debug-ui-override'
import {
  isAuroraDebugUiPickerEnabled,
  overrideFromDebugUiLaunch,
  resolveAuroraDebugUiLaunch,
} from './debug-ui-launch'

const SURFACE_LABELS: Record<AuroraDebugUiSurface, string> = {
  web: 'Web',
  'desktop-local': 'Desktop local',
  'desktop-thin': 'Desktop client',
  android: 'Android',
  ios: 'iOS',
  mobile: 'Mobile',
}

const ROLE_LABELS: Record<AuroraDebugUiRole, string> = {
  'remote-console': 'Connect',
  'mesh-node': 'Make this device available',
  'python-full': 'Run Aurora on this computer',
}

type DebugUiPickerProps = {
  onOverrideChange?: (override: AuroraDebugUiOverride) => void
}

export function DebugUiPicker({ onOverrideChange }: DebugUiPickerProps) {
  const [enabled, setEnabled] = useState(false)
  const [override, setOverride] = useState<AuroraDebugUiOverride | null>(null)

  useEffect(() => {
    if (!isAuroraDebugUiPickerEnabled()) return
    const launch = resolveAuroraDebugUiLaunch()
    const next = launch
      ? launch.override
      : overrideFromDebugUiLaunch({
        runtimeMode: 'web-thin',
        nodeMode: 'remote-console',
        runtimeTier: 'none',
        sessionRole: 'member',
      })
    setEnabled(true)
    setOverride(next)
    if (launch) persistAuroraDebugUiOverride(next)
  }, [])

  if (!enabled || !override) return null

  const apply = (patch: Partial<AuroraDebugUiOverride>) => {
    const next = persistAuroraDebugUiOverride({ ...override, ...patch })
    setOverride(next)
    onOverrideChange?.(next)
  }

  return (
    <div
      data-aurora-dev-preview="true"
      className="fixed bottom-3 right-3 z-[80] w-[min(22rem,calc(100vw-1.5rem))] rounded-xl border border-border bg-background/95 p-3 shadow-lg backdrop-blur"
    >
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Development preview
      </p>
      <div className="grid gap-2">
        <label className="grid gap-1 text-xs">
          Surface
          <select
            aria-label="Development preview surface"
            className="rounded-md border border-border bg-background px-2 py-1 text-sm"
            value={override.surface}
            onChange={(event) => apply({ surface: event.target.value as AuroraDebugUiSurface })}
          >
            {AURORA_DEBUG_UI_SURFACES.map((surface) => (
              <option key={surface} value={surface}>{SURFACE_LABELS[surface]}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs">
          Role
          <select
            aria-label="Development preview role"
            className="rounded-md border border-border bg-background px-2 py-1 text-sm"
            value={override.role}
            onChange={(event) => apply({ role: event.target.value as AuroraDebugUiRole })}
          >
            {AURORA_DEBUG_UI_ROLES.map((role) => (
              <option key={role} value={role}>{ROLE_LABELS[role]}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs">
          Access
          <select
            aria-label="Development preview access"
            className="rounded-md border border-border bg-background px-2 py-1 text-sm"
            value={override.admin ? 'admin' : 'member'}
            onChange={(event) => apply({ admin: event.target.value === 'admin' })}
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </label>
      </div>
    </div>
  )
}
