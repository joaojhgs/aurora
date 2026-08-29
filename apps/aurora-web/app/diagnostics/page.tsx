import { getShellSnapshot } from '../shell-state'
import { DiagnosticsClientPage } from './diagnostics-client'

export default async function Page() {
  const shell = await getShellSnapshot()
  const diagnosticsRoute = shell.routes.find((candidate) => candidate.item.id === 'diagnostics') ?? shell.routes[0]!
  return <DiagnosticsClientPage diagnosticsRoute={diagnosticsRoute} />
}
