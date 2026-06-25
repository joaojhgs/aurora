import { SettingsPermissionsView } from '@aurora/ui'
import { getShellSnapshot } from '../../shell-state'

export default async function Page() {
  const snapshot = await getShellSnapshot()
  return <SettingsPermissionsView snapshot={snapshot} />
}
