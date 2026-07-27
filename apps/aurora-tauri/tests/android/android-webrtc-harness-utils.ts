export type AndroidHarnessRequestKind =
  | 'document'
  | 'bundle'
  | 'config'
  | 'result'
  | 'asset'

export type AndroidHarnessRequestLogEntry = {
  kind: AndroidHarnessRequestKind
  path: string
  method: string
  at: string
}

const tauriBootstrapRedefineProperties = new Set([
  'postMessage',
  'metadata',
  '__TAURI_PATTERN__',
  'path',
  '__TAURI_EVENT_PLUGIN_INTERNALS__',
])

export function isBenignTauriBootstrapRedefineError(
  message: string,
): boolean {
  const match =
    /^TypeError: Cannot redefine property: ([\w$]+)\n\s+at Function\.defineProperty \(<anonymous>\)/u.exec(
      message.trim(),
    )
  return (
    match !== null &&
    tauriBootstrapRedefineProperties.has(match[1] ?? '')
  )
}

export function splitAndroidConsoleErrors(errors: string[]): {
  actionable: string[]
  ignoredTauriBootstrap: string[]
} {
  const actionable: string[] = []
  const ignoredTauriBootstrap: string[] = []
  for (const error of errors) {
    if (isBenignTauriBootstrapRedefineError(error)) {
      ignoredTauriBootstrap.push(error)
    } else {
      actionable.push(error)
    }
  }
  return { actionable, ignoredTauriBootstrap }
}

export function createAndroidHarnessRequestLog() {
  const entries: AndroidHarnessRequestLogEntry[] = []

  return {
    record(
      kind: AndroidHarnessRequestKind,
      path: string,
      method = 'GET',
    ): void {
      entries.push({
        kind,
        path,
        method,
        at: new Date().toISOString(),
      })
    },
    snapshot(): AndroidHarnessRequestLogEntry[] {
      return entries.slice()
    },
    has(kind: AndroidHarnessRequestKind): boolean {
      return entries.some((entry) => entry.kind === kind)
    },
    hasAll(kinds: AndroidHarnessRequestKind[]): boolean {
      return kinds.every((kind) =>
        entries.some((entry) => entry.kind === kind),
      )
    },
  }
}
