#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const reportRoot = join(packageRoot, 'reports', 'webrtc-interop')
const aggregateReportPath = join(
  reportRoot,
  'android-aggregate-report.json',
)
const webviewReportPath = join(
  reportRoot,
  'android-webview',
  'report.json',
)
const browserReportPath = join(
  reportRoot,
  'android-mobile-browser',
  'report.json',
)
const mobileBrowserExpectations = resolveMobileBrowserExpectations(
  process.env.AURORA_ANDROID_MOBILE_WEBRTC_LANE,
)
const testFiles = [
  'tests/android/android-python-webrtc.e2e.test.ts',
  'tests/android/android-browser-python-webrtc.e2e.test.ts',
]

const requiredProtocolEvidence = [
  'negotiationDirectionPassed',
  'manifestPassed',
  'errorPassed',
  'largeRpcPassed',
  'rpcStreamPassed',
]

const requiredPositiveAssertions = [
  'rtcStarted',
  'registryReadOverDataChannel',
  'negotiationDirection',
  'manifestExchange',
  'errorParity',
  'fragmented512KiBRpc',
  'streamCompletionAndCancel',
  'eventOverDataChannel',
  'eventSentByPython',
  'ttsEventOverDataChannel',
  'ttsEventSentByPython',
  'reconnectWithoutSas',
  'revokedCredentialFailsClosed',
  'mutationAtMostOnce',
  'mutationUncertainLossWindow',
]

const requiredNegativeAssertions = [
  'wrongCorrelationDelivered',
  'wildcardDelivered',
  'wildcardInterestedByPython',
]

/**
 * Build a bounded aggregate without copying arbitrary child-report content.
 *
 * @param {{
 *   commandStatus: number,
 *   generatedAt: string,
 *   webview: {
 *     present: boolean,
 *     parsed: boolean,
 *     digest: string | null,
 *     report?: unknown,
 *   },
 *   browser: {
 *     present: boolean,
 *     parsed: boolean,
 *     digest: string | null,
 *     report?: unknown,
 *   },
 * }} input
 */
export function buildAndroidInteropAggregate(
  input,
  expectations = mobileBrowserExpectations,
) {
  const webview = summarizeChild({
    id: 'android-webview',
    sourceReport: 'android-webview/report.json',
    expectedLane: 'turn',
    expectedPathCategories: ['relay'],
    readResult: input.webview,
  })
  const browser = summarizeChild({
    id: 'android-mobile-browser',
    sourceReport: 'android-mobile-browser/report.json',
    expectedLane: expectations.lane,
    expectedPathCategories: expectations.pathCategories,
    readResult: input.browser,
  })
  const testCommandPassed = input.commandStatus === 0
  const bothChildReportsPassed = webview.passed && browser.passed
  const status =
    testCommandPassed && bothChildReportsPassed ? 'passed' : 'failed'

  return {
    schema: 'aurora.android_webrtc_interop.aggregate.v1',
    generatedAt: input.generatedAt,
    status,
    command:
      'pnpm --filter @aurora/tauri-ui android:webrtc:interop',
    acceptance: {
      testCommandPassed,
      bothChildReportsPassed,
      bothHttpDisabledProofsPassed:
        webview.httpDisabledProofPassed &&
        browser.httpDisabledProofPassed,
      bothProtocolProofsPassed:
        webview.protocolEvidencePassed &&
        browser.protocolEvidencePassed,
      bothBehaviorProofsPassed:
        webview.behaviorEvidencePassed &&
        browser.behaviorEvidencePassed,
      bothReportsRedacted:
        webview.secretsRedacted && browser.secretsRedacted,
    },
    children: {
      webview,
      mobileBrowser: browser,
    },
    secretsRedacted: true,
  }
}

function summarizeChild({
  id,
  sourceReport,
  expectedLane,
  expectedPathCategories,
  readResult,
}) {
  const report = isRecord(readResult.report)
    ? readResult.report
    : {}
  const protocol = isRecord(report.protocolInteropEvidence)
    ? report.protocolInteropEvidence
    : {}
  const assertions = isRecord(report.assertions)
    ? report.assertions
    : {}
  const httpDisabledProof = isRecord(report.httpDisabledProof)
    ? report.httpDisabledProof
    : {}
  const observedLane = safeEnum(report.lane, [
    'direct',
    'stun',
    'turn',
  ])
  const observedPathCategory = safeEnum(report.pathCategory, [
    'host',
    'srflx',
    'prflx',
    'relay',
    'unknown',
  ])
  const protocolEvidencePassed = requiredProtocolEvidence.every(
    (key) => protocol[key] === true,
  )
  const behaviorEvidencePassed =
    assertions.authorizedPeerCountAfterRevocation === 0 &&
    requiredPositiveAssertions.every(
      (key) => assertions[key] === true,
    ) &&
    requiredNegativeAssertions.every(
      (key) => assertions[key] === false,
    )
  const schemaValid =
    report.schema === 'aurora.webrtc_interop.report.v1'
  const statusPassed = report.status === 'passed'
  const laneMatched = observedLane === expectedLane
  const pathCategoryAccepted =
    report.pathCategoryAccepted === true
  const categoryMatched = expectedPathCategories.includes(
    observedPathCategory,
  )
  const httpDisabledProofPassed =
    httpDisabledProof.requiredEvidencePassed === true
  const secretsRedacted = report.secretsRedacted === true
  const passed =
    readResult.present === true &&
    readResult.parsed === true &&
    schemaValid &&
    statusPassed &&
    laneMatched &&
    pathCategoryAccepted &&
    categoryMatched &&
    httpDisabledProofPassed &&
    protocolEvidencePassed &&
    behaviorEvidencePassed &&
    secretsRedacted

  return {
    id,
    sourceReport,
    expectedLane,
    expectedPathCategories,
    observedLane,
    observedPathCategory,
    present: readResult.present === true,
    parsed: readResult.parsed === true,
    reportSha256: safeDigest(readResult.digest),
    schemaValid,
    statusPassed,
    laneMatched,
    pathCategoryAccepted,
    categoryMatched,
    httpDisabledProofPassed,
    protocolEvidencePassed,
    behaviorEvidencePassed,
    secretsRedacted,
    passed,
  }
}

function readChildReport(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        present: false,
        parsed: false,
        digest: null,
      }
    }
    throw error
  }

  const digest = createHash('sha256').update(raw).digest('hex')
  try {
    return {
      present: true,
      parsed: true,
      digest,
      report: JSON.parse(raw),
    }
  } catch {
    return {
      present: true,
      parsed: false,
      digest,
    }
  }
}

function safeDigest(value) {
  return typeof value === 'string' &&
    /^[a-f0-9]{64}$/u.test(value)
    ? value
    : null
}

function safeEnum(value, allowed) {
  return typeof value === 'string' && allowed.includes(value)
    ? value
    : 'unknown'
}

export function resolveMobileBrowserExpectations(value = 'direct') {
  const lane = readLane(value, 'AURORA_ANDROID_MOBILE_WEBRTC_LANE')
  const pathCategories =
    lane === 'turn'
      ? ['relay']
      : lane === 'stun'
        ? ['srflx', 'prflx']
        : ['host', 'prflx']
  return { lane, pathCategories }
}

function readLane(value, source) {
  if (value === undefined) return 'direct'
  if (value === 'direct' || value === 'stun' || value === 'turn') return value
  throw new Error(
    `${source} must be direct, stun, or turn; received ${String(value)}`,
  )
}

function isRecord(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}

function writeAtomicJson(path, value) {
  const temporaryPath = `${path}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temporaryPath, path)
}

function run() {
  mkdirSync(reportRoot, { recursive: true })
  rmSync(aggregateReportPath, { force: true })
  rmSync(webviewReportPath, { force: true })
  rmSync(browserReportPath, { force: true })

  const result = spawnSync(
    'pnpm',
    [
      'exec',
      'vitest',
      'run',
      '--environment',
      'node',
      '--no-file-parallelism',
      ...testFiles,
    ],
    {
      cwd: packageRoot,
      env: process.env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    },
  )
  const commandStatus =
    Number.isInteger(result.status) && result.status !== null
      ? result.status
      : 1
  const aggregate = buildAndroidInteropAggregate({
    commandStatus,
    generatedAt: new Date().toISOString(),
    webview: readChildReport(webviewReportPath),
    browser: readChildReport(browserReportPath),
  })
  writeAtomicJson(aggregateReportPath, aggregate)

  console.log(
    `Android WebRTC interoperability aggregate ${aggregate.status}: ${aggregateReportPath}`,
  )
  return aggregate.status === 'passed' ? 0 : 1
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (isMain) {
  process.exitCode = run()
}
