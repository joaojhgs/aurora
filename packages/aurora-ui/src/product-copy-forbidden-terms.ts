export interface ProductionCopyForbiddenTerm {
  readonly id: string
  readonly pattern: RegExp
  readonly examples: readonly string[]
}

export const PRODUCTION_COPY_FORBIDDEN_TERMS = [
  term('proof', /\bproof\b/iu),
  term('evidence', /\bevidence\b/iu),
  term('fixture', /\bfixtures?\b/iu),
  term('assertion', /\bassertions?\b/iu),
  term('implementation', /\bimplement(?:ation|ed|ing)?\b/iu),
  term('tested', /\btested\b/iu),
  term('debug', /\bdebug(?:ging)?\b/iu),
  term('fallback', /\bfall[-_]?back\b/iu, ['fallback', 'fall-back', 'fall_back']),
  term('provider-consumer-role', /\b(?:provider|consumer|hybrid)\b/iu, ['provider', 'consumer', 'hybrid']),
  term('route-counts', /\b\d+\s*\/\s*\d+\s+routes?\b|\broute counts?\b/iu, ['0/22 routes', 'route count']),
  term('manifest', /\bmanifest\b/iu),
  term('catalog', /\bcatalogs?\b/iu),
  term('contract', /\bcontracts?\b/iu),
  term('protocol', /\bprotocol\b/iu),
  term('transport', /\btransport\b/iu),
  term('runtime', /\bruntime\b/iu),
  term('schema', /\bschema\b/iu),
  term('migration', /\bmigrations?\b/iu),
  term('sqlite', /\bsqlite\b/iu),
  term('indexeddb', /\bindexeddb\b/iu),
  term('opfs', /\bopfs\b/iu),
  term('sidecar', /\bsidecar\b/iu),
  term('thin', /\bthin\b/iu),
  term('http', /\bhttps?\b/iu, ['HTTP', 'HTTPS']),
  term('webrtc-wss', /\b(?:webrtc|wss?)\b/iu, ['WebRTC', 'WS', 'WSS']),
  term('signaling', /\bsignaling\b/iu),
  term('datachannel', /\bdatachannel\b/iu),
  term('remote-console', /\bremote[-_ /]?console\b/iu, ['remote-console', 'remote_console', 'remote/console']),
  term('mesh-node', /\bmesh[-_ /]?node\b/iu, ['mesh-node', 'mesh_node', 'mesh/node']),
  term('runtime-tier', /\bruntime[-_ /]?tier\b/iu, ['runtime-tier', 'runtime_tier', 'runtime/tier']),
  term('room-password', /\broom[-_ /]?password\b/iu, ['room password', 'room_password', 'room-password', 'room/password']),
  term('sdk', /\bsdk\b/iu, ['SDK']),
  term('webview', /\bwebview\b/iu, ['WebView']),
  term('daemon', /\bdaemon\b/iu),
  term('orchestrator', /\borchestrator\b/iu, ['Orchestrator']),
  term('raw', /\braw\b(?!-render-expression)/iu),
  term(
    'key-path',
    /\bkey[-_ ]?paths?\b|\b(?:services|gateway|auth|config|orchestrator|tts|stt|db|tooling|scheduler)(?:[._/-][a-z0-9]+){2,}\b/iu,
    ['services.tts.mesh_sharing.share', 'services/gateway/api/port', 'services-orchestrator-llm-provider'],
  ),
] as const satisfies readonly ProductionCopyForbiddenTerm[]

export function findForbiddenProductionCopyTerms(value: string): ProductionCopyForbiddenTerm[] {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  return PRODUCTION_COPY_FORBIDDEN_TERMS.filter((term) => term.pattern.test(normalized))
}

function term(id: string, pattern: RegExp, examples: readonly string[] = [id]): ProductionCopyForbiddenTerm {
  return { id, pattern, examples }
}
