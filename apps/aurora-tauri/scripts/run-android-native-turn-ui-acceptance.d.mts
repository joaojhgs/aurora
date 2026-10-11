import type { ChildProcess } from 'node:child_process'

interface IsolatedAssistantConfig {
  services: {
    auth: { enabled: boolean }
    db: { enabled: boolean; embeddings: { use_local: boolean } }
    orchestrator: { enabled: boolean }
    tooling: { enabled: boolean }
    scheduler: { enabled: boolean }
    stt: {
      coordinator: { enabled: boolean }
      transcription: { enabled: boolean }
      wakeword: { enabled: boolean }
    }
    gateway: {
      webrtc: { strategy: string; app_id: string; room: string; password: string }
    }
  }
}

export function acceptanceCommands(): {
  modelFixture: [string, string]
  threeNode: [string, string]
  voiceTurn: [string, string]
}

export function buildIsolatedAssistantConfig(options: {
  gatewayPort: number
  brokerUrl: string
  appId: string
  room: string
  roomPassword?: string
}): IsolatedAssistantConfig

export function cleanupAcceptanceResources(options: {
  python: unknown
  fixture: unknown
  configDir?: string
  stop?: (child: any) => Promise<void>
  remove?: (directory: string) => void
}): Promise<unknown[]>

export function readFixtureReady(fixture: ChildProcess, timeoutMs?: number): Promise<string>
export function stopChild(child: ChildProcess, options?: { graceMs?: number }): Promise<void>
export function throwAcceptanceErrors(primaryError: unknown, cleanupErrors: unknown[]): void

export function waitForOwnedStack(options: {
  baseUrl: string
  apiKey: string
  expectedNodeName: string
  expectedAppId: string
  expectedRoom: string
  child: ChildProcess
  timeoutMs?: number
}): Promise<{
  health: Record<string, unknown>
  mesh: Record<string, unknown>
  invite: Record<string, unknown>
}>
