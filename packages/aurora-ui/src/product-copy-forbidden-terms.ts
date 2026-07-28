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
  term('fallback', /\bfallback\b/iu),
  term('provider-consumer-role', /\b(?:provider|consumer|hybrid)\b/iu, ['provider', 'consumer', 'hybrid']),
  term('route-counts', /\b\d+\s*\/\s*\d+\s+routes?\b|\broute counts?\b/iu, ['0/22 routes', 'route count']),
  term('manifest', /\bmanifest\b/iu),
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
  term('signaling', /\bsignaling\b/iu),
  term('datachannel', /\bdatachannel\b/iu),
  term('room-password', /\broom password\b/iu),
  term('key-path', /\bkey[-_ ]?paths?\b|\b(?:services|gateway|auth|config|orchestrator|tts|stt|db|tooling|scheduler)\.[a-z0-9_.]+\b/iu, ['services.tts.mesh_sharing.share']),
] as const satisfies readonly ProductionCopyForbiddenTerm[]

export function findForbiddenProductionCopyTerms(value: string): ProductionCopyForbiddenTerm[] {
  return PRODUCTION_COPY_FORBIDDEN_TERMS.filter((term) => term.pattern.test(value))
}

function term(id: string, pattern: RegExp, examples: readonly string[] = [id]): ProductionCopyForbiddenTerm {
  return { id, pattern, examples }
}
