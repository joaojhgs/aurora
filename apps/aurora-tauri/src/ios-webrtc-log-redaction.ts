const IOS_LOG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}\s/u
const SDP_BLOCK_START =
  /\b(?:setRemoteDescription|setLocalDescription|createAnswerSucceeded|createOfferSucceeded)\b.*\bto:\s*['"]?v=0/iu
const STANDALONE_SDP_START = /^\s*v=0(?:\\\^M)?\s*$/iu
const SDP_BLOCK_END = /^\s*['"]\s*$/u
const SENSITIVE_SDP_LINE =
  /(?:^|[\s'"])v=0(?:\\\^M)?|a=(?:fingerprint|ice-ufrag|ice-pwd):/iu
const ORPHANED_SDP_LINE =
  /^\s*(?:[a-z]=).*(?:\\\^M)?\s*$/iu
const RAW_ICE_CANDIDATE =
  /candidate:[0-9a-zA-Z]+\s+\d+\s+(?:udp|tcp)\s+\d+\s+\S+\s+\d+\s+typ\s+(?:host|srflx|prflx|relay)/iu

/**
 * Removes SDP credentials and ICE addresses emitted by Apple WebKit from
 * simulator diagnostics before those diagnostics become CI artifacts.
 */
export function redactIosWebRtcArtifactLog(value: string): string {
  const redacted: string[] = []
  let insideSdpBlock = false

  for (const line of value.split(/\r?\n/u)) {
    if (insideSdpBlock) {
      if (SDP_BLOCK_END.test(line)) {
        insideSdpBlock = false
        continue
      }
      if (!IOS_LOG_TIMESTAMP.test(line)) continue
      // A truncated SDP block can be followed by a new timestamped entry.
      insideSdpBlock = false
    }

    if (
      SDP_BLOCK_START.test(line) ||
      STANDALONE_SDP_START.test(line)
    ) {
      redacted.push('[REDACTED WEBRTC SDP]')
      const sdpStart = line.search(/v=0/iu)
      const suffix = sdpStart >= 0 ? line.slice(sdpStart + 3) : ''
      insideSdpBlock = !/['"]\s*$/u.test(suffix)
      continue
    }

    if (RAW_ICE_CANDIDATE.test(line)) {
      redacted.push('[REDACTED WEBRTC ICE]')
      continue
    }

    if (SENSITIVE_SDP_LINE.test(line)) {
      redacted.push('[REDACTED WEBRTC SDP]')
      continue
    }

    // Unified-log truncation can begin in the middle of an SDP block, before
    // the timestamped v=0 entry is available to establish block state.
    if (ORPHANED_SDP_LINE.test(line)) {
      redacted.push('[REDACTED WEBRTC SDP]')
      continue
    }

    redacted.push(line)
  }

  return redacted.join('\n')
}
