# WebRTC live interop harness

**Status:** Current bounded check

**Last reviewed:** 2026-07-26

The WebRTC live interop harness verifies the browser SDK (`createBrowserWebRtcAuroraRuntime`/`AuroraClient`) against the Python Gateway `RTCClient` + `RPCHandler` over a real `RTCDataChannel`. The Python Gateway HTTP API is intentionally disabled for the required lanes, so successful RPC/event behavior proves the DataChannel path rather than HTTP fallback.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium firefox webkit

pnpm test:webrtc:interop   # direct ICE lane in Chromium
pnpm test:webrtc:turn      # forced TURN relay lane in Chromium
pnpm test:webrtc:browsers  # Chromium/Firefox/WebKit direct matrix; explicit skips if an engine is unavailable
WEBRTC_INTEROP_REQUIRE_ALL_BROWSERS=1 pnpm test:webrtc:browsers  # CI/release gate: missing engines fail
./scripts/webrtc_interop.sh stun  # explicit STUN/reflexive lane
WEBRTC_INTEROP_BROWSER=webkit WEBRTC_INTEROP_ARTIFACT_DIR=reports/webrtc-interop/webkit-stun ./scripts/webrtc_interop.sh stun
WEBRTC_INTEROP_BROWSER=webkit WEBRTC_INTEROP_ARTIFACT_DIR=reports/webrtc-interop/webkit-turn ./scripts/webrtc_interop.sh turn
WEBRTC_INTEROP_BROWSER=firefox WEBRTC_INTEROP_ARTIFACT_DIR=reports/webrtc-interop/firefox-stun ./scripts/webrtc_interop.sh stun
WEBRTC_INTEROP_BROWSER=firefox WEBRTC_INTEROP_ARTIFACT_DIR=reports/webrtc-interop/firefox-turn ./scripts/webrtc_interop.sh turn
```

On Linux, Playwright's `--with-deps` step installs host libraries in addition
to browser binaries and may require administrator access. The strict matrix
must not treat a downloaded browser whose host libraries are unavailable as
compatibility proof.

`pnpm test:webrtc:interop` starts local Mosquitto WebSocket MQTT and coturn through `scripts/webrtc_interop_services.sh up`, waits until both published TCP listeners accept connections, then runs the direct lane. Required broker/TURN setup lives in `docker-compose.webrtc-interop.yml`; coturn uses long-term TURN credentials for the relay lane.

The STUN lane uses the same local coturn server in STUN mode and applies harness-only ICE policies that suppress outbound `typ host` candidates in both the browser and Python signaling SDP/trickle path. The Python filter is a default-off `RTCClient` injection seam; production behavior is unchanged. This prevents same-host shortcut nomination from satisfying the STUN proof while preserving truthful `RTCPeerConnection.getStats()` evidence. Peer-reflexive (`prflx`) is reported as `prflx`, not normalized to `srflx`; a `prflx` selected pair passes STUN only when candidate stats also prove a configured STUN server gathered a true `srflx` candidate. Firefox requires the locally published non-loopback coturn address and omits the candidate URL from stats, so its scanner proof additionally requires exactly one configured STUN server; a reported URL mismatch or multiple ambiguous configured servers still fails.

## Current report locations

| Lane | Report | Current status | ICE proof |
| --- | --- | --- | --- |
| Chromium direct | `reports/webrtc-interop/direct/report.json` | Passed | Current selected category is raw `prflx`, with a peer-reflexive/host pair and no gathered STUN or relay evidence |
| Chromium STUN/reflexive | `reports/webrtc-interop/stun/report.json` | Passed | Current selected category is `srflx`, with a configured-STUN URL match from `getStats()` |
| TURN relay | `reports/webrtc-interop/turn/report.json` | Passed | `selectedCandidatePair.category=relay` |
| Firefox direct | `reports/webrtc-interop/firefox-direct/report.json` | Passed | `selectedCandidatePair.category=host` |
| Firefox STUN/reflexive | `reports/webrtc-interop/firefox-stun/report.json` | Passed | Selected raw `prflx` plus a gathered `srflx`; one configured STUN server makes the source unambiguous when Firefox omits the candidate URL |
| Firefox TURN relay | `reports/webrtc-interop/firefox-turn/report.json` | Passed | `selectedCandidatePair.category=relay` under relay-only policy |
| WebKit direct | `reports/webrtc-interop/webkit-direct/report.json` | Passed | Current selected category is raw `prflx`; the scanner accepts the peer-reflexive/host pair only without gathered STUN or relay evidence |
| WebKit STUN/reflexive | `reports/webrtc-interop/webkit-stun/report.json` | Passed | Current selected category is `srflx`, with configured-STUN URL-match evidence from `getStats()` |
| WebKit TURN relay | `reports/webrtc-interop/webkit-turn/report.json` | Passed | `selectedCandidatePair.category=relay` |

The current checked reports prove direct, configured-STUN, and forced-TURN lanes in Chromium, Firefox, and Playwright WebKit. On another host, the default developer direct-matrix command preserves an explicit optional-engine skip; CI sets `WEBRTC_INTEROP_REQUIRE_ALL_BROWSERS=1`, so an unavailable required direct engine fails rather than counting as compatibility proof.

## ICE path evidence schema

Each passing lane includes `selectedCandidatePair`, captured from browser `RTCPeerConnection.getStats()` rather than parsed SDP or raw ICE candidate strings. The scanner requires:

- `selectedCandidatePair.selected=true`;
- `statsSource="RTCPeerConnection.getStats"`;
- `rawAddressRedacted=true`;
- direct lane category `host`, or raw `prflx` with one peer candidate reported as `host`, no relay candidate, and no gathered STUN-server evidence; the report retains `pathCategory=prflx` rather than normalizing it;
- STUN lane intent accepted only when the selected pair is raw `srflx`, or raw `prflx` plus independent `stunServerReflexiveCandidate` proof that a configured STUN server gathered a true `srflx` local candidate. When an engine exposes the candidate URL it must match; when Firefox omits it, exactly one configured STUN server is required and the omission is recorded explicitly;
- TURN lane category `relay` with a selected relay candidate type.

Reports may include candidate types/protocols such as `localCandidateType`, `remoteCandidateType`, and `localRelayProtocol`, but must not include raw candidate lines, IP addresses, SDP blobs, ICE passwords, or fingerprints. The artifact scanner explicitly rejects raw `candidate:` lines containing `typ host`, `typ srflx`, `typ prflx`, or `typ relay`.

## Required report assertions

Each passing lane writes `schema=aurora.webrtc_interop.report.v1` and must include:

- `httpDisabledProof.gatewayApiEnabled=false`, `gatewayHttpReachable=false`, and `noHttpFetchTransportUsed=true`;
- `assertions.rtcStarted=true`, `registryReadOverDataChannel=true`, `eventOverDataChannel=true`, and `ttsEventOverDataChannel=true`;
- `assertions.reconnectWithoutSas=true` after canonical peer reconnect HMAC proof;
- `assertions.revokedCredentialFailsClosed=true` after credential revocation;
- `assertions.mutationAtMostOnce=true` and `assertions.mutationUncertainLossWindow=true`;
- `assertions.wildcardDelivered=false`, `wrongCorrelationDelivered=false`, and `wildcardInterestedByPython=false`;
- `redaction.passed=true` and `secretsRedacted=true`.

## Mutation uncertain-loss proof

The mutation proof is intentionally not a normal completed RPC. The browser starts `G009Interop.Mutate`, receives a typed `G009Interop.MutationStarted` event over the scoped event subscription path, then force-disconnects before the mutation response settles. The Python harness records the request once and gates completion until the start event has been observed. This proves at-most-once behavior for the uncertain-loss window only; it is not a broad exactly-once guarantee.

Required report fields:

- `mutationEvidence.mutationStartedEvent.payload.request_id` — opaque WebRTC request id, no payload secrets;
- `mutationEvidence.mutationStartedEvent.payload.timing_category="started_before_response_delay"`;
- `mutationEvidence.uncertainLossWindow.startedAckBeforeDisconnect=true`;
- `mutationEvidence.uncertainLossWindow.responseSettledBeforeDisconnect=false`;
- `mutationEvidence.uncertainLossWindow.disconnectBeforeResponseSettled=true`;
- `mutationEvidence.executionCountAtMostOnce=true` and Python `mutationCounts[mutation_id].execution_count <= 1`;
- `httpDisabledProof.browserHttpFetchCalls=[]`, proving no HTTP fallback or browser reissue.

Scoped authorization in these reports uses public production Auth/Gateway/DataChannel boundaries: SAS-bound pairing/connect/exchange, reconnect proof, and public method authorization. The browser and Python side reports are redacted diagnostics only. They are not production load, long-running reconnect, physical-device, or cross-browser certification.
