import { describe, expect, it } from 'vitest'

// @ts-expect-error The Node-executed .mjs runner intentionally has no TS build output.
import { buildAndroidInteropAggregate, resolveAndroidInteropExpectations, resolveMobileBrowserExpectations } from '../scripts/run-android-webrtc-interop.mjs'

const digest = 'a'.repeat(64)

function completeReport(
  lane: 'direct' | 'stun' | 'turn',
  pathCategory: 'host' | 'srflx' | 'prflx' | 'relay',
) {
  return {
    schema: 'aurora.webrtc_interop.report.v1',
    lane,
    status: 'passed',
    pathCategory,
    pathCategoryAccepted: true,
    httpDisabledProof: {
      requiredEvidencePassed: true,
    },
    protocolInteropEvidence: {
      negotiationDirectionPassed: true,
      manifestPassed: true,
      errorPassed: true,
      largeRpcPassed: true,
      rpcStreamPassed: true,
    },
    assertions: {
      rtcStarted: true,
      authorizedPeerCountAfterRevocation: 0,
      registryReadOverDataChannel: true,
      negotiationDirection: true,
      manifestExchange: true,
      errorParity: true,
      fragmented512KiBRpc: true,
      streamCompletionAndCancel: true,
      eventOverDataChannel: true,
      eventSentByPython: true,
      ttsEventOverDataChannel: true,
      ttsEventSentByPython: true,
      reconnectWithoutSas: true,
      revokedCredentialFailsClosed: true,
      mutationAtMostOnce: true,
      mutationUncertainLossWindow: true,
      wrongCorrelationDelivered: false,
      wildcardDelivered: false,
      wildcardInterestedByPython: false,
    },
    secretsRedacted: true,
  }
}

function input() {
  return {
    commandStatus: 0,
    generatedAt: '2026-07-27T00:00:00.000Z',
    webview: {
      present: true,
      parsed: true,
      digest,
      report: completeReport('turn', 'relay'),
    },
    browser: {
      present: true,
      parsed: true,
      digest,
      report: completeReport('direct', 'host'),
    },
  }
}

describe('Android mobile-to-Python WebRTC aggregate', () => {
  it('passes only when both mobile peers carry complete fail-closed evidence', () => {
    const aggregate = buildAndroidInteropAggregate(input())

    expect(aggregate).toMatchObject({
      schema: 'aurora.android_webrtc_interop.aggregate.v1',
      status: 'passed',
      acceptance: {
        testCommandPassed: true,
        bothChildReportsPassed: true,
        bothHttpDisabledProofsPassed: true,
        bothProtocolProofsPassed: true,
        bothBehaviorProofsPassed: true,
        bothReportsRedacted: true,
      },
      children: {
        webview: {
          expectedLane: 'turn',
          observedPathCategory: 'relay',
          passed: true,
        },
        mobileBrowser: {
          expectedLane: 'direct',
          observedPathCategory: 'host',
          passed: true,
        },
      },
      secretsRedacted: true,
    })
  })

  it.each([
    [
      'missing child report',
      (value: ReturnType<typeof input>) => {
        Object.assign(value.webview, {
          present: false,
          parsed: false,
          digest: null,
          report: undefined,
        })
      },
    ],
    [
      'failed scanner status',
      (value: ReturnType<typeof input>) => {
        value.webview.report.status = 'failed'
      },
    ],
    [
      'wrong scanner schema',
      (value: ReturnType<typeof input>) => {
        value.browser.report.schema = 'unexpected'
      },
    ],
    [
      'wrong lane',
      (value: ReturnType<typeof input>) => {
        value.browser.report.lane = 'turn'
      },
    ],
    [
      'wrong candidate category',
      (value: ReturnType<typeof input>) => {
        value.webview.report.pathCategory = 'host'
      },
    ],
    [
      'unaccepted candidate path',
      (value: ReturnType<typeof input>) => {
        value.browser.report.pathCategoryAccepted = false
      },
    ],
    [
      'missing HTTP-disabled proof',
      (value: ReturnType<typeof input>) => {
        value.webview.report.httpDisabledProof.requiredEvidencePassed =
          false
      },
    ],
    [
      'missing protocol proof',
      (value: ReturnType<typeof input>) => {
        value.browser.report.protocolInteropEvidence.largeRpcPassed =
          false
      },
    ],
    [
      'missing behavior proof',
      (value: ReturnType<typeof input>) => {
        value.webview.report.assertions.reconnectWithoutSas = false
      },
    ],
    [
      'peer remains authorized after revocation',
      (value: ReturnType<typeof input>) => {
        value.webview.report.assertions.authorizedPeerCountAfterRevocation =
          1
      },
    ],
    [
      'unredacted child report',
      (value: ReturnType<typeof input>) => {
        value.browser.report.secretsRedacted = false
      },
    ],
  ])('fails closed for %s', (_name, mutate) => {
    const value = input()
    mutate(value)

    const aggregate = buildAndroidInteropAggregate(value)

    expect(aggregate.status).toBe('failed')
    expect(aggregate.acceptance.bothChildReportsPassed).toBe(false)
  })

  it('fails when the combined Vitest command exits unsuccessfully', () => {
    const value = input()
    value.commandStatus = 1

    const aggregate = buildAndroidInteropAggregate(value)

    expect(aggregate.status).toBe('failed')
    expect(aggregate.acceptance).toMatchObject({
      testCommandPassed: false,
      bothChildReportsPassed: true,
    })
  })

  it('accepts explicit TURN mobile-browser lane expectations from CI', () => {
    const value = input()
    value.browser.report = completeReport('turn', 'relay')

    const aggregate = buildAndroidInteropAggregate(
      value,
      {
        webview: resolveAndroidInteropExpectations(
          'turn',
          'AURORA_ANDROID_WEBRTC_LANE',
          'turn',
        ),
        mobileBrowser: resolveMobileBrowserExpectations('turn'),
      },
    )

    expect(aggregate.children.mobileBrowser).toMatchObject({
      expectedLane: 'turn',
      observedLane: 'turn',
      observedPathCategory: 'relay',
      passed: true,
    })
    expect(aggregate.status).toBe('passed')
  })

  it('accepts explicit direct WebView lane expectations from operator reruns', () => {
    const value = input()
    value.webview.report = completeReport('direct', 'host')

    const aggregate = buildAndroidInteropAggregate(value, {
      webview: resolveAndroidInteropExpectations(
        'direct',
        'AURORA_ANDROID_WEBRTC_LANE',
        'turn',
      ),
      mobileBrowser: resolveMobileBrowserExpectations('direct'),
    })

    expect(aggregate.children.webview).toMatchObject({
      expectedLane: 'direct',
      observedLane: 'direct',
      observedPathCategory: 'host',
      passed: true,
    })
    expect(aggregate.status).toBe('passed')
  })

  it('accepts explicit configured-STUN WebView lane expectations from operator reruns', () => {
    const value = input()
    value.webview.report = completeReport('stun', 'srflx')

    const aggregate = buildAndroidInteropAggregate(value, {
      webview: resolveAndroidInteropExpectations(
        'stun',
        'AURORA_ANDROID_WEBRTC_LANE',
        'turn',
      ),
      mobileBrowser: resolveMobileBrowserExpectations('direct'),
    })

    expect(aggregate.children.webview).toMatchObject({
      expectedLane: 'stun',
      observedLane: 'stun',
      observedPathCategory: 'srflx',
      passed: true,
    })
    expect(aggregate.status).toBe('passed')
  })

  it('never copies arbitrary child errors or invalid digest values', () => {
    const sentinel = 'do-not-copy-child-secret'
    const value = input()
    Object.assign(value.webview.report, {
      error: sentinel,
      pathCategory: sentinel,
    })
    value.webview.digest = sentinel

    const serialized = JSON.stringify(
      buildAndroidInteropAggregate(value),
    )

    expect(serialized).not.toContain(sentinel)
  })
})
