# V874 typed mesh stage adapter

This private candidate adds one exact-peer adapter for the existing cumulative K2/K3 compositions. It is not integrated, launched, or evidence of a successful mesh call.

## Supported production boundary

The repository already defines typed exact-peer fields on all required requests:

- STT uses `TranscriptionMethods.TRANSCRIBE` and `TranscribeAudioRequest.mesh_selector` (`app/shared/contracts/models/stt.py:102-109,624-642`).
- Assistant uses `OrchestratorMethods.EXTERNAL_USER_INPUT` and `OrchestratorProcessRequest.mesh_selector` (`app/shared/contracts/models/orchestrator.py:24-29,63-78`). Its response is the typed `OrchestratorResponse`, not a delivery acknowledgement.
- TTS uses `TTSMethods.SYNTHESIZE` and `TTSSynthesizeRequest.mesh_selector` (`app/shared/contracts/models/tts.py:95-100,174-189`).

`MeshBus.request` extracts the typed selector from the request and resolves it through the explicit routing path. The routing table checks that the selected peer is present and negotiated, allowed by current provider policy, and shares the selected service. An explicit selector prevents transparent alternate-peer reroute and local fallback (`app/messaging/mesh_bus.py:602-684,755-795,1278-1289,1612-1637`; `app/services/gateway/mesh/routing_table.py:267-335`). The adapter requires the actual production `MeshBus`, an independently admitted peer ID/hash for the stage, a typed request with no conflicting selector, and matching request correlation when that model carries one.

The adapter makes one typed bus request with the existing correlation and bounded remaining deadline. It accepts a response only when the existing `PeerBridge.call` observer has exactly one matching start/end for that topic, correlation, and selected peer hash, with a consistent PID/monotonic interval and successful outcome. It recognizes the exact finite `PeerBridge`-generated returned timeout before the generic route-failure branch; uncertain/timeout calls stop without retry. Raw QueryResult errors, payloads, transcripts, replies, and audio are never returned or logged by this adapter. Returned responses are validated against the supplied response model.

For cumulative K2, the existing local typed-bus STT stage remains unchanged; call this adapter for remote ExternalUserInput and remote TTS. For cumulative K3, use it for all three stages. K2/K3 callers must still preserve their existing transcript/Paris predicates, partial failure records, automatic-TTS suppression check, WAV profile checks, and separate receiver native-stage/provider proof. The adapter does not claim remote provider/model identity from response metadata. Each stage can receive its own independently admitted exact peer; no peer or endpoint is selected from configuration here.

The current V861 binding observer supplies actual caller peer/topic/correlation/start/end rows. Selected ICE pair remains unavailable in this adapter; the pending V868 route observer was not integrated, and no selected route is inferred from signaling or configured ICE. Requester and receiver clocks remain separate; the adapter records its requester interval and the actual local PeerBridge interval only.

## Files and provenance

| File | SHA-256 |
|---|---|
| `mesh_stage_adapter.py` | `56d93a93f29ad074fb8fcf3cbf36101010d2a80bfdcfd47757b0692f4c379a05` |
| production `stt.py` contracts | `3c56b2d5a5435a971465ac5b132d8b5d78d18cfe02506813631a4b67e401c703` |
| production `orchestrator.py` contracts | `cf7f048c0678f298141a59b031be420772b83e649ec2910053d4f372cfaf2df9` |
| production `tts.py` contracts | `e6ca2ebe21b928506be0bf8c3bf88eb9ad3f582b0aae80bba361c326b2bde744` |
| production `mesh.py` contracts | `27074b7e4bea970736f98ce30aa0906e3b6006d01bd184a07af22607a33836bf` |
| production `mesh_bus.py` | `faf9c452022ded30967aed6cc6bbcb583d3c93fb2f3328abb20e3076b71a2ef2` |
| production `routing_table.py` | `994080417103df68ebde8b0c5f58cdf1431531c11a1d611f3a3166e2f3208127` |
| production `peer_bridge.py` | `3a0748a6fd8093f4b8f616a578af94f8a86ae0700cd0099ab5847f9235f2330d` |
| accepted K1 mesh adapter V869 | `1db8cb386a37c680bec6e03135ee007f6b76a850a85c4e1eedda6562c0895ceb` |
| K2 composition V834 | `164e85998de0c963fcce15141e2a0a525d95882c97fcfef1a2cdb39df444ce60` |
| K3 composition V857 | `a62e5a036eb127657e1f81c503c08a272a7ef603c53c5e03991c17f4daa1a9e6` |
| reviewed HTTP stage adapter used by K2/K3 | `204ea4d6b48571ab7ba0add0310a3dadd87b5e1e2afdc172634185755c9bb02c` |

The new adapter passed a standard-library AST parse (9,389 bytes). No Aurora imports, tests, service, model, runtime, network, device, build, or RTC call was performed. Root must integrate this adapter into the versioned K2/K3 compositions, pin exact source/model/config and per-stage peer authority, collect the independent receiver proof, and validate the existing 15-warmup gate before measured request 1. No live route, cumulative K2/K3 result, selected ICE pair, or acceptance claim is made here.


## V878 narrow source correction

Original Root copied V874 without altering it and added the actual typed MeshAddressSelector import inside _topic_for, closing the sole V877 first-call NameError. No behavior, selector, response, retry, route, correctness or proof policy changed. Standard-library AST parse only; no Aurora/RTC imports, runtime or tests. Corrected adapter SHA256: ec25e4e6db568241d0af03f88573a37d3a0775d4e52bf703bfa0bb5a039e38a9. Original V874/report and V877 finding remain retained.
