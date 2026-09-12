// @vitest-environment node

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { validateIosCiEvidence } from '../scripts/assert-ios-ci-evidence.mjs'

const evidenceScript = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../scripts/assert-ios-ci-evidence.mjs',
)

describe('iOS CI evidence validator', () => {
  it('requires production simulator rendering, browser direct, and WKWebView direct STUN and TURN evidence', () => {
    const root = createPassingFixture()
    const summaryPath = join(root, 'summary.json')

    const result = validateIosCiEvidence({
      reportRoot: root,
      summaryPath,
    })

    expect(result.summary).toMatchObject({
      status: 'passed',
      checkCount: 19,
      failures: [],
      secretsRedacted: true,
    })
    expect(result.summary.requiredSurfaces).toEqual([
      'production-client-simulator',
      'mobile-safari-direct-webrtc',
      'packaged-wkwebview-direct-webrtc',
      'packaged-wkwebview-stun-webrtc',
      'packaged-wkwebview-turn-webrtc',
    ])
    expect(JSON.parse(readFileSync(summaryPath, 'utf8'))).toMatchObject({
      status: 'passed',
    })
    const cli = runEvidenceCli(root)
    expect(cli.status, cli.stderr).toBe(0)
    expect(cli.stdout).toContain('iOS CI evidence passed')
  })

  it('fails closed when a rendered frame is blank or a surface report is missing', () => {
    const root = createPassingFixture()
    writeJson(join(root, 'ios-simulator-smoke.json'), {
      ...simulatorReport(),
      screenshotEvidence: {
        ...screenshotEvidence(),
        status: 'failed',
        failures: ['luminance range is below threshold'],
      },
    })
    writeFileSync(
      join(
        root,
        'webrtc-interop/ios-wkwebview/ios-wkwebview-browser-report.json',
      ),
      '{not-json',
    )

    const { summary } = validateIosCiEvidence({ reportRoot: root })

    expect(summary.status).toBe('failed')
    expect(summary.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('production-simulator-render'),
        expect.stringContaining('invalid-report'),
        expect.stringContaining('packaged-wkwebview-direct-browser-protocol'),
      ]),
    )
    const cli = runEvidenceCli(root)
    expect(cli.status).not.toBe(0)
    expect(cli.stderr).toContain('iOS CI evidence validation failed')
  })
})

function createPassingFixture() {
  const root = mkdtempSync(join(tmpdir(), 'aurora-ios-ci-evidence-'))
  writeJson(join(root, 'ios-client-simulator-build-provenance.json'), {
    target: 'aarch64-sim',
    pythonSidecarStaged: false,
    secretsRedacted: true,
  })
  writeJson(join(root, 'ios-simulator-smoke.json'), simulatorReport())
  for (const [directory, prefix, lane] of [
    ['ios-mobile-safari', 'ios-mobile-safari', 'direct'],
    ['ios-wkwebview', 'ios-wkwebview', 'direct'],
    ['ios-wkwebview-stun', 'ios-wkwebview-stun', 'stun'],
    ['ios-wkwebview-turn', 'ios-wkwebview-turn', 'turn'],
  ]) {
    const surfaceRoot = join(root, 'webrtc-interop', directory)
    writeJson(join(surfaceRoot, `${prefix}-browser-report.json`), {
      status: 'passed',
      lane,
      noHttpFetchTransportUsed: true,
      consoleErrors: [],
      screenshotEvidence: screenshotEvidence(),
      secretsRedacted: true,
    })
    writeJson(join(surfaceRoot, 'python-gateway-report.json'), {
      gatewayHttpApiEnabled: false,
      rtcStarted: true,
      eventSent: true,
      ttsEventSent: true,
      revoked: true,
      secretsRedacted: true,
    })
    writeJson(join(surfaceRoot, 'report.json'), {
      status: 'passed',
      lane,
      pathCategoryAccepted: true,
      secretsRedacted: true,
    })
  }
  return root
}

function simulatorReport() {
  return {
    status: 'passed',
    appStayedAliveThroughSettleWindow: true,
    pythonSidecarExpected: false,
    screenshotEvidence: screenshotEvidence(),
    secretsRedacted: true,
  }
}

function screenshotEvidence() {
  return {
    status: 'passed',
    width: 390,
    height: 844,
    thresholds: {
      minimumLuminanceRange: 24,
      minimumLuminanceStandardDeviation: 2,
      minimumContrastPixelRatio: 0.003,
      minimumDistinctColorBuckets: 6,
      minimumEdgeContrastRatio: 0.0005,
    },
    luminanceRange: 220,
    luminanceStandardDeviation: 34,
    contrastPixelRatio: 0.42,
    distinctColorBucketCount: 8,
    edgeContrastRatio: 0.015,
    failures: [],
    secretsRedacted: true,
  }
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function runEvidenceCli(reportRoot: string) {
  return spawnSync(process.execPath, [evidenceScript], {
    env: {
      ...process.env,
      AURORA_IOS_CI_REPORT_ROOT: reportRoot,
    },
    encoding: 'utf8',
  })
}
