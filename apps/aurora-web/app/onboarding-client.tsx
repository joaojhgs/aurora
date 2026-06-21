'use client'

import { OnboardingView, type AuroraShellSnapshot } from '@aurora/ui'
import { createAuroraBrowserClient } from './aurora-client'

export function OnboardingClientPage({ snapshot }: { snapshot: AuroraShellSnapshot }) {
  return <OnboardingView client={createAuroraBrowserClient()} snapshot={snapshot} />
}
