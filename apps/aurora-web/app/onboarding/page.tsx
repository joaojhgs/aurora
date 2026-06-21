import { getShellSnapshot } from '../shell-state'
import { OnboardingClientPage } from '../onboarding-client'

export default async function Page() {
  const snapshot = await getShellSnapshot()
  return <OnboardingClientPage snapshot={snapshot} />
}
