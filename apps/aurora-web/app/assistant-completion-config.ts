export interface AssistantCompletionServerConfig {
  readonly endpoint: string
  readonly model: string
  readonly apiKey?: string | undefined
}

export function assistantCompletionServerConfig(): AssistantCompletionServerConfig | null {
  const endpoint = process.env.AURORA_LIGHTWEIGHT_ASSISTANT_ENDPOINT?.trim()
  const model = process.env.AURORA_LIGHTWEIGHT_ASSISTANT_MODEL?.trim()
  const apiKey = process.env.AURORA_LIGHTWEIGHT_ASSISTANT_API_KEY?.trim()
  if (!endpoint || !model || !apiKey) return null
  return { endpoint, model, apiKey }
}

export function assistantCompletionPublicConfig(): { enabled: boolean } {
  return { enabled: assistantCompletionServerConfig() !== null }
}
