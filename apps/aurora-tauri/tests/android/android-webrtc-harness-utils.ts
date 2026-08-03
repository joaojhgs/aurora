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

export type AndroidRuntimeExceptionDetails = {
  text?: unknown
  lineNumber?: unknown
  columnNumber?: unknown
  scriptId?: unknown
  exception?: {
    description?: unknown
  }
  stackTrace?: {
    callFrames?: unknown
  }
}

type AndroidRuntimeCallFrame = {
  functionName?: unknown
  scriptId?: unknown
  url?: unknown
  lineNumber?: unknown
  columnNumber?: unknown
}

const tauriBootstrapRedefineProperties = new Set([
  'postMessage',
  'metadata',
  '__TAURI_PATTERN__',
  'path',
  '__TAURI_EVENT_PLUGIN_INTERNALS__',
])

const tauriBootstrapSourceAnchors: Record<string, string[]> = {
  postMessage: [
    'Tauri Programme within The Commons Conservancy',
    "Object.defineProperty(window.__TAURI_INTERNALS__, 'postMessage'",
  ],
  metadata: [
    "Object.defineProperty(window.__TAURI_INTERNALS__, 'metadata'",
    'currentWindow',
    'currentWebview',
  ],
  __TAURI_PATTERN__: [
    'Tauri Programme within The Commons Conservancy',
    "Object.defineProperty(window.__TAURI_INTERNALS__, '__TAURI_PATTERN__'",
  ],
  path: [
    'Tauri Programme within The Commons Conservancy',
    "Object.defineProperty(window.__TAURI_INTERNALS__.plugins, 'path'",
  ],
  __TAURI_EVENT_PLUGIN_INTERNALS__: [
    'Tauri Programme within The Commons Conservancy',
    "Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__'",
  ],
}

function runtimeExceptionSummary(
  details: AndroidRuntimeExceptionDetails | undefined,
): string {
  return String(
    details?.exception?.description ??
      details?.text ??
      'Uncaught Android WebView exception',
  )
}

function runtimeCallFrames(
  details: AndroidRuntimeExceptionDetails | undefined,
): AndroidRuntimeCallFrame[] {
  const frames = details?.stackTrace?.callFrames
  if (!Array.isArray(frames)) return []
  return frames.filter(
    (frame): frame is AndroidRuntimeCallFrame =>
      typeof frame === 'object' && frame !== null,
  )
}

function formatRuntimeCallFrame(frame: AndroidRuntimeCallFrame): string {
  const functionName =
    typeof frame.functionName === 'string' && frame.functionName.length > 0
      ? frame.functionName
      : '<anonymous>'
  const url =
    typeof frame.url === 'string' && frame.url.length > 0
      ? frame.url
      : '<anonymous>'
  const line =
    typeof frame.lineNumber === 'number' ? frame.lineNumber + 1 : '?'
  const column =
    typeof frame.columnNumber === 'number' ? frame.columnNumber + 1 : '?'
  return `    at ${functionName} (${url}:${line}:${column})`
}

function isVerifiedTauriBootstrapException(
  details: AndroidRuntimeExceptionDetails | undefined,
  scriptSource: string | undefined,
): boolean {
  if (scriptSource === undefined) return false
  const match =
    /^(?:Uncaught )?TypeError: Cannot redefine property: ([\w$]+)$/u.exec(
      runtimeExceptionSummary(details),
    )
  const property = match?.[1]
  if (property === undefined) return false
  const anchors = tauriBootstrapSourceAnchors[property]
  if (anchors === undefined || !anchors.every((anchor) => scriptSource.includes(anchor))) {
    return false
  }

  const frames = runtimeCallFrames(details)
  const scriptId = details?.scriptId
  if (
    frames.length === 0 ||
    (typeof scriptId !== 'string' && typeof scriptId !== 'number')
  ) {
    return false
  }
  if (
    !frames.every(
      (frame) =>
        frame.scriptId === scriptId &&
        frame.functionName === '' &&
        frame.url === '',
    )
  ) {
    return false
  }

  const firstFrame = frames[0]
  return (
    firstFrame?.lineNumber === details?.lineNumber &&
    firstFrame?.columnNumber === details?.columnNumber
  )
}

export function formatAndroidRuntimeException(
  details: AndroidRuntimeExceptionDetails | undefined,
  scriptSource?: string,
): string {
  const summary = runtimeExceptionSummary(details)
  const frames = runtimeCallFrames(details).map(formatRuntimeCallFrame)
  if (isVerifiedTauriBootstrapException(details, scriptSource)) {
    return [
      summary,
      '    at Function.defineProperty (<anonymous>)',
      ...frames,
    ].join('\n')
  }
  return [summary, ...frames].join('\n')
}

export function isBenignTauriBootstrapRedefineError(
  message: string,
): boolean {
  const [summary = '', firstStackLine, ...rest] = message
    .trim()
    .split('\n')
  const match =
    /^(?:Uncaught )?TypeError: Cannot redefine property: ([\w$]+)$/u.exec(
      summary,
    )
  if (
    match === null ||
    !tauriBootstrapRedefineProperties.has(match[1] ?? '')
  ) {
    return false
  }
  if (firstStackLine === undefined) return false
  if (
    !/^\s+at Function\.defineProperty \(<anonymous>\)$/u.test(
      firstStackLine,
    )
  ) {
    return false
  }
  return rest.every((line) => /^\s+at /u.test(line))
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
