'use client'

import { SettingsNativeView, type AuroraShellSnapshot } from '@aurora/ui'
import { useBrowserRuntimeProfile, useBrowserShellRuntime } from '../../browser-shell-runtime'

export function NativeSettingsClientPage({ snapshot }: { snapshot: AuroraShellSnapshot }) {
  const runtime = useBrowserShellRuntime()
  const runtimeProfile = useBrowserRuntimeProfile()

  return (
    <SettingsNativeView
      snapshot={snapshot}
      runtimeProfile={runtimeProfile}
      surfaceProfile={runtime.surface}
    />
  )
}
