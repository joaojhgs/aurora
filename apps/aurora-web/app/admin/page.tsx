import { AdminOverviewView } from '@aurora/ui'
import { createAuroraWebClient } from '../aurora-client'

export default function Page() {
  return <AdminOverviewView client={createAuroraWebClient()} />
}
