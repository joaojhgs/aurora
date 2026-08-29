import { getShellSnapshot } from '../../shell-state'
import { NativeSettingsClientPage } from './native-settings-client'

export default async function Page() {
  const snapshot = await getShellSnapshot()
  return <NativeSettingsClientPage snapshot={snapshot} />
}
