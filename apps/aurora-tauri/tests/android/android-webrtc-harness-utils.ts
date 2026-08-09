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

export type AndroidWebRtcServicePorts = {
  mqttWsHostPort: number
  turnHostPort: number
}

export function resolveAndroidWebRtcServicePorts(
  env: Record<string, string | undefined> = process.env,
): AndroidWebRtcServicePorts {
  return {
    mqttWsHostPort: readPortEnv(
      env.AURORA_ANDROID_WEBRTC_MQTT_WS_HOST_PORT,
      'AURORA_ANDROID_WEBRTC_MQTT_WS_HOST_PORT',
      9001,
    ),
    turnHostPort: readPortEnv(
      env.AURORA_ANDROID_WEBRTC_TURN_HOST_PORT,
      'AURORA_ANDROID_WEBRTC_TURN_HOST_PORT',
      3478,
    ),
  }
}

export function androidWebRtcBrokerUrl(
  ports: AndroidWebRtcServicePorts,
): string {
  return `ws://127.0.0.1:${ports.mqttWsHostPort}/mqtt`
}

export function androidWebRtcStunUrl(
  hostIpv4: string,
  ports: AndroidWebRtcServicePorts,
): string {
  return `stun:${hostIpv4}:${ports.turnHostPort}`
}

export function androidWebRtcTurnUrl(
  hostIpv4: string,
  ports: AndroidWebRtcServicePorts,
): string {
  return `turn:${hostIpv4}:${ports.turnHostPort}?transport=tcp`
}

export function androidWebRtcServicesComposeYaml(
  ports: AndroidWebRtcServicePorts,
): string {
  return `services:
  webrtc-interop-mqtt:
    image: eclipse-mosquitto:2
    entrypoint: ["/bin/sh", "-lc"]
    command:
      - |
        cat > /tmp/mosquitto.conf <<'MOSQ'
        per_listener_settings false
        allow_anonymous true
        listener 1883 0.0.0.0
        protocol mqtt
        listener 9001 0.0.0.0
        protocol websockets
        MOSQ
        exec mosquitto -c /tmp/mosquitto.conf
    ports:
      - "${ports.mqttWsHostPort}:9001"
  webrtc-interop-turn:
    image: coturn/coturn:4.6
    entrypoint: ["/bin/sh", "-lc"]
    command:
      - |
        cat > /tmp/turnserver.conf <<'TURN'
        listening-port=3478
        fingerprint
        lt-cred-mech
        user=interop:interop
        realm=aurora-interop.test
        no-tls
        no-dtls
        verbose
        TURN
        exec turnserver -c /tmp/turnserver.conf
    ports:
      - "${ports.turnHostPort}:3478/udp"
      - "${ports.turnHostPort}:3478/tcp"
`
}

export function androidWebRtcComposeArgs(
  composePath: string,
  action: 'up' | 'down' | 'logs',
  projectName: string,
): string[] {
  const base = ['compose', '-p', projectName, '-f', composePath]
  if (action === 'up') {
    return [
      ...base,
      'up',
      '-d',
      'webrtc-interop-mqtt',
      'webrtc-interop-turn',
    ]
  }
  if (action === 'down') {
    return [...base, 'down', '-v', '--remove-orphans']
  }
  return [...base, 'logs', '--no-color', 'webrtc-interop-mqtt', 'webrtc-interop-turn']
}

function readPortEnv(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  if (value === undefined || value.trim() === '') return fallback
  if (!/^\d+$/u.test(value.trim())) {
    throw new Error(`${name} must be a TCP/UDP port number`)
  }
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be between 1 and 65535`)
  }
  return port
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
