export default function init(input?: RequestInfo | URL | Response | BufferSource | WebAssembly.Module): Promise<void>

export class AuroraVoiceWasmRuntime {
  constructor(config?: unknown)
  free(): void
  start_session(request: unknown): unknown
  push_pcm_i16(frame: unknown): unknown
  stop_session(request: unknown): unknown
  cancel_generation(request: unknown): void
  transition_response_ready(request: unknown): string
  complete_turn(request: unknown): string
  abandon_turn(request: unknown): string
  snapshot(): unknown
  capabilities(): unknown
  resource_report(atMicros: number): unknown
}
