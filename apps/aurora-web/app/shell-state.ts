import { buildShellSnapshot, type AuroraShellSnapshot } from '@aurora/ui'
import { createAuroraWebClient } from './aurora-client'

export async function getShellSnapshot(): Promise<AuroraShellSnapshot> {
  return buildShellSnapshot(createAuroraWebClient())
}
