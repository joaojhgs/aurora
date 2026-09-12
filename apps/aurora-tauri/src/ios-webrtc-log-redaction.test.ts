import { describe, expect, it } from 'vitest'

import { redactIosWebRtcArtifactLog } from './ios-webrtc-log-redaction'

describe('iOS WebRTC artifact log redaction', () => {
  it('removes multiline SDP and ICE candidates while preserving diagnostics', () => {
    const rawLog = [
      "2026-07-27 20:20:44.132 Df MobileSafari: RTCPeerConnection::setRemoteDescription to: 'v=0\\^M",
      'o=- 3994172444 3994172444 IN IP4 0.0.0.0\\^M',
      'a=ice-ufrag:atow\\^M',
      'a=ice-pwd:IRwkRhh67RQWlGM2atmPtW\\^M',
      'a=fingerprint:sha-256 5C:2C:AC:BD\\^M',
      "'",
      '2026-07-27 20:20:44.138 Df MobileSafari: Gathered ice candidate:candidate:2023083735 1 udp 2113937151 peer.local 58780 typ host generation 0',
      '2026-07-27 20:20:44.155 Df MobileSafari: Finished ice candidate gathering',
    ].join('\n')

    const redacted = redactIosWebRtcArtifactLog(rawLog)

    expect(redacted).not.toMatch(
      /v=0|a=(?:fingerprint|ice-ufrag|ice-pwd):|candidate:/iu,
    )
    expect(redacted).toContain('[REDACTED WEBRTC SDP]')
    expect(redacted).toContain('[REDACTED WEBRTC ICE]')
    expect(redacted).toContain('Finished ice candidate gathering')
  })

  it('stops a truncated SDP block at the next timestamped diagnostic', () => {
    const redacted = redactIosWebRtcArtifactLog(
      [
        "2026-07-27 20:20:44.132 Df WebContent: createAnswerSucceeded to: 'v=0\\^M",
        'a=ice-pwd:secret\\^M',
        '2026-07-27 20:20:45.000 E WebContent: EXC_BAD_ACCESS',
      ].join('\n'),
    )

    expect(redacted).not.toContain('a=ice-pwd:')
    expect(redacted).toContain('EXC_BAD_ACCESS')
  })

  it('redacts an artifact excerpt that starts inside an SDP block', () => {
    const redacted = redactIosWebRtcArtifactLog(
      [
        'o=- 3994172444 3994172444 IN IP4 0.0.0.0\\^M',
        'c=IN IP4 192.168.64.3\\^M',
        'a=mid:0\\^M',
        '2026-07-27 20:20:45.000 Df WebContent: connection stable',
      ].join('\n'),
    )

    expect(redacted).not.toMatch(
      /3994172444|192\.168\.64\.3|a=mid:/u,
    )
    expect(redacted).toContain('connection stable')
  })
})
