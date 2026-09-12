#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requiredWebRtcSurfaces = [
  {
    id: 'mobile-safari-direct',
    surface: 'mobile-safari',
    lane: 'direct',
    directory: 'ios-mobile-safari',
    prefix: 'ios-mobile-safari',
  },
  {
    id: 'packaged-wkwebview-direct',
    surface: 'packaged-wkwebview',
    lane: 'direct',
    directory: 'ios-wkwebview',
    prefix: 'ios-wkwebview',
  },
  {
    id: 'packaged-wkwebview-stun',
    surface: 'packaged-wkwebview',
    lane: 'stun',
    directory: 'ios-wkwebview-stun',
    prefix: 'ios-wkwebview-stun',
  },
  {
    id: 'packaged-wkwebview-turn',
    surface: 'packaged-wkwebview',
    lane: 'turn',
    directory: 'ios-wkwebview-turn',
    prefix: 'ios-wkwebview-turn',
  },
]

export function validateIosCiEvidence(options = {}) {
  const reportRoot = resolve(
    options.reportRoot ??
      process.env.AURORA_IOS_CI_REPORT_ROOT ??
      join(packageRoot, 'reports'),
  )
  const summaryPath = resolve(
    options.summaryPath ??
      process.env.AURORA_IOS_CI_SUMMARY ??
      join(reportRoot, 'ios-ci-evidence-summary.json'),
  )
  const failures = []
  const checks = []
  const documents = {
    provenance: readJson(
      reportRoot,
      'ios-client-simulator-build-provenance.json',
      failures,
    ),
    simulator: readJson(
      reportRoot,
      'ios-simulator-smoke.json',
      failures,
    ),
  }
  const webRtcDocuments = requiredWebRtcSurfaces.map((surface) => ({
    ...surface,
    browser: readJson(
      reportRoot,
      `webrtc-interop/${surface.directory}/${surface.prefix}-browser-report.json`,
      failures,
    ),
    python: readJson(
      reportRoot,
      `webrtc-interop/${surface.directory}/python-gateway-report.json`,
      failures,
    ),
    aggregate: readJson(
      reportRoot,
      `webrtc-interop/${surface.directory}/report.json`,
      failures,
    ),
  }))

  check(
    checks,
    failures,
    'client-build-provenance',
    documents.provenance?.target === 'aarch64-sim' &&
      documents.provenance?.pythonSidecarStaged === false &&
      documents.provenance?.secretsRedacted === true,
    'client simulator provenance must prove an aarch64 simulator build without a Python sidecar and with redacted secrets',
  )
  check(
    checks,
    failures,
    'production-simulator-runtime',
    documents.simulator?.status === 'passed' &&
      documents.simulator?.appStayedAliveThroughSettleWindow === true &&
      documents.simulator?.pythonSidecarExpected === false &&
      documents.simulator?.secretsRedacted === true,
    'production client simulator smoke must pass and remain alive without a Python sidecar',
  )
  checkScreenshot(
    checks,
    failures,
    'production-simulator-render',
    documents.simulator?.screenshotEvidence,
  )

  for (const surface of webRtcDocuments) {
    checkWebRtcSurface(checks, failures, surface)
  }

  const summary = {
    schema: 'aurora.ios-ci-evidence-summary.v1',
    status: failures.length === 0 ? 'passed' : 'failed',
    generatedAt: new Date().toISOString(),
    requiredSurfaces: [
      'production-client-simulator',
      ...requiredWebRtcSurfaces.map(
        (surface) => `${surface.id}-webrtc`,
      ),
    ],
    checkCount: checks.length,
    checks,
    failures,
    secretsRedacted: true,
  }
  writeAtomicJson(summaryPath, summary)
  return { summary, summaryPath }
}

function checkWebRtcSurface(
  checks,
  failures,
  surface,
) {
  const { id, lane, browser, python, aggregate } = surface
  check(
    checks,
    failures,
    `${id}-browser-protocol`,
    browser?.status === 'passed' &&
      browser?.lane === lane &&
      browser?.noHttpFetchTransportUsed === true &&
      browser?.secretsRedacted === true &&
      Array.isArray(browser?.consoleErrors) &&
      browser.consoleErrors.length === 0,
    `${id} browser report must pass ${lane} WebRTC without HTTP fallback, console errors, or exposed secrets`,
  )
  checkScreenshot(
    checks,
    failures,
    `${id}-render`,
    browser?.screenshotEvidence,
  )
  check(
    checks,
    failures,
    `${id}-python-peer`,
    python?.gatewayHttpApiEnabled === false &&
      python?.rtcStarted === true &&
      python?.eventSent === true &&
      python?.ttsEventSent === true &&
      python?.revoked === true &&
      python?.secretsRedacted === true,
    `${id} Python peer must prove WebRTC-only event delivery and revoked-credential rejection`,
  )
  check(
    checks,
    failures,
    `${id}-aggregate`,
    aggregate?.status === 'passed' &&
      aggregate?.lane === lane &&
      aggregate?.pathCategoryAccepted === true &&
      aggregate?.secretsRedacted === true,
    `${id} aggregate interoperability report must pass its accepted ${lane} path with redacted secrets`,
  )
}

function checkScreenshot(checks, failures, id, screenshot) {
  const thresholds = screenshot?.thresholds ?? {}
  check(
    checks,
    failures,
    id,
    screenshot?.status === 'passed' &&
      screenshot?.width >= 300 &&
      screenshot?.height >= 500 &&
      screenshot?.luminanceRange >=
        (thresholds.minimumLuminanceRange ?? 24) &&
      screenshot?.luminanceStandardDeviation >=
        (thresholds.minimumLuminanceStandardDeviation ?? 2) &&
      screenshot?.contrastPixelRatio >=
        (thresholds.minimumContrastPixelRatio ?? 0.003) &&
      screenshot?.distinctColorBucketCount >=
        (thresholds.minimumDistinctColorBuckets ?? 6) &&
      screenshot?.edgeContrastRatio >=
        (thresholds.minimumEdgeContrastRatio ?? 0.0005) &&
      Array.isArray(screenshot?.failures) &&
      screenshot.failures.length === 0 &&
      screenshot?.secretsRedacted === true,
    `${id} screenshot must contain analyzer metrics for a visible, valid simulator frame`,
  )
}

function check(checks, failures, id, passed, message) {
  checks.push({ id, status: passed ? 'passed' : 'failed' })
  if (!passed) failures.push(`${id}: ${message}`)
}

function readJson(root, relativePath, failures) {
  const path = join(root, relativePath)
  if (!existsSync(path)) {
    failures.push(`missing-report: ${relativePath}`)
    return null
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    failures.push(
      `invalid-report: ${relativePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return null
  }
}

function writeAtomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temporaryPath, path)
}

const invokedPath = process.argv[1]
if (
  invokedPath &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  const { summary, summaryPath } = validateIosCiEvidence()
  if (summary.status !== 'passed') {
    throw new Error(
      `iOS CI evidence validation failed: ${summary.failures.join('; ')}`,
    )
  }
  console.log(`iOS CI evidence passed: ${summaryPath}`)
}
