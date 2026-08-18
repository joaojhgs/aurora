import { getShellSnapshot } from '../../shell-state'
import { SpokenRepliesClientPage } from './spoken-replies-client'

export default async function Page() {
  const snapshot = await getShellSnapshot()
  if (!snapshot.routes.some((candidate) => candidate.item.id === 'spoken-replies')) {
    throw new Error('Spoken replies route is not registered in the Aurora shell')
  }
  return <SpokenRepliesClientPage />
}
