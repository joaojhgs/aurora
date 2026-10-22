# Distributed K1 exact-peer Mesh TTS source preparation V881

This is an unlaunched, source-only candidate. It keeps the approved V822 requester flow (local accurate STT, local Assistant/LLM, strict full-question and exact Paris predicates, decoded non-silent mono PCM16 WAV) and changes only the final TTS boundary from Gateway HTTP to the typed `TTS.SYNTHESIZE` request over the production `MeshBus`, with passive exact-peer call recording and a mesh-specific receiver proof join.

V881 additionally samples nominated ICE pair(s) immediately before and after the exact TTS `PeerBridge.call`, using the separately reviewed V868 observer. Before observer installation, the bootstrap verifies the frozen CPU environment's `aurora-preserved-backends.pth` hash and ordered site roots, hashes/version metadata for the first-resolved `aiortc 1.14.0` and `aioice 0.10.2` source files, and the actual loaded module paths. The runtime receipt records this as a source/path verification; ordinary 15 warmups must still join actual route rows to actual receiver spans/provider bindings before measured request 1.

Route rows use a bounded asynchronous sink: the call-site writer validates and copies only the finite allowlisted row shape, then performs `put_nowait`; a private daemon writer performs JSON encoding and file I/O. The queue, row and total-byte quotas, explicit loss counters, and three-second bounded drain are finite. Any missing, dropped, invalid, oversized, quota-rejected, or unflushed warmup observation blocks the measured phase. This sink preserves the call's result/exception. Its two samples cover all ICE transports on the mapped PC; there is no pair ID or continuous route-stability evidence. The report may state only the sampled candidate class before and after each correlated request. Different samples are not evidence of the same selected pair.

## Production route and authority

`TTSSynthesizeRequest` has a `mesh_selector: MeshAddressSelector` field. The candidate sets its `peer_id` only from the Root-admitted existing peer binding. `MeshBus.request` resolves that exact selector through `RoutingTable._resolve_explicit_selector`; that path checks negotiation, allowed-provider policy, shared TTS service, speech provider eligibility, and policy binding. `PeerBridge.call` receives the selected peer and correlation, consumes the local routing selector before sending the typed RPC, and correlates its response to `(peer_id, correlation_id)`. An explicit selector has no transparent local or alternate-peer fallback. The adapter refuses to run unless the runtime bus is `MeshBus`; timeout, transport uncertainty, and failed query are terminal with no retry.

Requester-side `bindings.py` passively records the actual `PeerBridge.call` target as a peer-ID hash plus typed topic, correlation, monotonic start/end and outcome; it never records the request text or payload. The remote service's existing V430 envelope observer records the same RPC correlation on the real `tts.model_invoke` span, and existing Piper call wrappers record actual provider arguments. `receiver_proof.py` requires all 15 exact-peer call records, all 15 successful receiver Piper calls, actual receiver PID/provider file hashes, receiver peer-ID hash, matching correlation IDs, and unique completed native TTS spans before the runner accepts measured request 1. It takes separate requester-route, receiver-stage, receiver-provider-binding and receiver-identity inputs. Expected receiver/provider data must come from Root's actual current route/session/runtime receipts, never from configured defaults.

The selected peer identity is reported by hash in campaign outputs. The caller-side selected peer is directly observed at the `PeerBridge.call` boundary and paired with the receiver's envelope-correlated native TTS span. The production call boundary does not expose the selected ICE-pair identifier. The separately pinned observer samples nominated ICE-pair state before and after the call; it cannot establish pair identity or continuous stability, and does not infer route details from config or peer selection.

## Source interface

The future requester launcher uses the same private-file/config/model/resource guards as the approved K1 launcher. Root must supply a new isolated runtime/config and source/model freeze, a regular current product source inventory through `AURORA_K1_SOURCE_INVENTORY`, the existing authorized peer ID through `AURORA_K1_MESH_TTS_PEER_ID`, and a `remoteMeshTtsReceiver` manifest binding with `peer_id_sha256`, receiver identity, source/provider/model/config/hardware hashes, `use_cuda: false`, and `sample_rate: 22050`. The freeze also pins `receiver_proof.py`; the controller checks those helper bytes before launch and the warmup gate checks the digest in the generated proof. Root must obtain the receiver's actual `voice-stages.jsonl`, `actual-provider-bindings.jsonl`, and `receiver-identity.json`; the offline proof command consumes those files plus the requester's `requester-mesh-calls.jsonl` and attempts directory:

```text
python receiver_proof.py \
  --attempts-dir <private-requester-output>/attempts \
  --receiver-stages <private-receiver-output>/voice-stages.jsonl \
  --provider-bindings <private-receiver-output>/actual-provider-bindings.jsonl \
  --requester-mesh-calls <private-requester-output-parent>/requester-mesh-calls.jsonl \
  --requester-route-observations <private-requester-output-parent>/requester-mesh-route-observations.jsonl \
  --route-sink-status <private-requester-output-parent>/requester-mesh-route-sink-status.json \
  --route-runtime-pins <private-requester-output-parent>/requester-mesh-route-runtime-pins.json \
  --frozen-manifest <private-frozen-manifest.json> \
  --frozen-manifest-sha256 <frozen-manifest-sha256> \
  --receiver-identity <private-receiver-output>/receiver-identity.json \
  --candidate-manifest-sha256 <frozen-candidate-sha256> \
  --expected-provider-json <private-frozen-provider-binding.json> \
  --output <private-requester-output>/receiver-warmup-proof.json
```

This command is documentation only and was not run. The controller, runner, mesh adapter and proof-generator hashes in the freeze template must be regenerated together after Root supplies exact source, source-equivalence, config, model, active peer/session/grant, receiver/PID and resource receipts. No listener, pairing, identity, permission, grant, endpoint or security setting is created here. There is no runtime or performance result in this candidate.

## Evidence boundary

Source anchors inspected: `app/shared/contracts/models/tts.py` (`TTSSynthesizeRequest` and `TTSMethods.SYNTHESIZE`); `app/shared/contracts/models/mesh.py` (`MeshAddressSelector`); `app/messaging/mesh_bus.py` (`request`, selector extraction, explicit route and no-selector fallback policy); `app/services/gateway/mesh/routing_table.py` (`_resolve_explicit_selector`); `app/services/gateway/mesh/peer_bridge.py` (`call` and selector stripping); `app/services/tts/service.py` (`synthesize`); and `app/shared/speech_lifecycle_observer.py` plus the already reviewed V430 observer. The production schema supports an exact-peer TTS call and a correlation join without adding a method or changing service code.

The source exposes selected MeshBus peer and correlation, but not a selected ICE-pair identifier at the runner boundary. Actual provider identity and current authority/session remain Root launch prerequisites. V881's warmup proof also requires 15 unique successful observer rows with exact peer/session/PC hashes, matching mesh correlation, and known nominated-pair snapshot fields on both sides of the call; it explicitly carries no pair-identity or continuous-stability claim. AST/syntax checks are the only intended local validation; no Aurora imports, tests, build, service, network, model, device, or runtime action is authorized by this preparation.
