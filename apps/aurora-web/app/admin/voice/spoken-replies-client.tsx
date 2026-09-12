'use client'

import { VoiceSettingsView } from '@aurora/ui'
import { useBrowserRuntimeProfile, useBrowserShellRuntime } from '../../browser-shell-runtime'

export function SpokenRepliesClientPage() {
  const runtime = useBrowserShellRuntime()
  const runtimeProfile = useBrowserRuntimeProfile()

  return (
    <section aria-label="Spoken replies">
      <VoiceSettingsView
        client={runtime.client}
        runtimeProfile={runtimeProfile}
        surfaceProfile={runtime.surface}
        hideOnDeviceSections
      />
    </section>
  )
}
