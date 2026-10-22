# V894 cumulative K2 mesh source candidate

This is an unlaunched, source-only candidate for the existing K2 main flow:
code-worker typed LocalBus STT, followed by real exact-peer MeshBus
`Orchestrator.ExternalUserInput` and `TTS.Synthesize` calls. It carries forward
the V852 local-STT/Assistant/TTS correctness and outcome flow, the approved
V878 typed mesh stage adapter, and the V890/V891 exact-peer route observer and
receiver lifecycle patterns. It does not change product code, grant authority,
choose peers, retry an ambiguous call, or claim provider identity from response
metadata.

Each remote stage receives a separate Root-admitted peer ID and frozen peer
hash. MeshBus uses the typed request's `mesh_selector`; its existing routing
checks and PeerBridge path remain the authority boundary. Assistant and TTS
remain distinct typed calls. The K2 Assistant configuration must have
`automatic_tts_readback=false`; otherwise the campaign fails closed. Local STT
remains the actual typed bus request and is checked independently from the
remote receiver model/provider identity.

The frozen Assistant binding also requires the exact invoked llama constructor
settings: model path, GPU layers, context/batch/thread counts, sampling values,
seed, token limit, and chat format. The receiver proof compares these frozen
values with the V430 `llm_constructor_return.actualArguments` row; configured
settings or response metadata alone do not satisfy that check.

## Warmup proof before measured request 1

The one-shot `receiver_proof.py` assembles, but does not create, receiver proof
from retained warmup attempts, native V430 spans, actual provider bindings,
requester PeerBridge call rows, route snapshots, independent per-stage
receiver identities, and the route runtime installation receipt. It requires
15 correct warmup flows and 30 remote native stage joins (15 real Assistant
LLM spans and 15 real TTS spans), plus 30 exact-peer route calls and 30
before/after route observations. Assistant preserves the V430 async `span_id`
and keeps `operation_id`/`attempt_id` null with the source-grounded reason;
TTS requires its real operation and attempt IDs. Request hashes bind the
requester typed payload only and do not claim identity with any augmented LLM
input.

The route observer records nominated-pair snapshots for each selected exact
peer call. Evidence is limited to before/after snapshots across peer-connection
ICE transports. It does not establish pair identity or continuous route
stability. Any missing, ambiguous, lossy, or unsuccessful route/native join
blocks measured request 1. The bounded sink allows 1,846 rows (1,830 planned
remote stage calls plus 16 bounded setup rows), 32 KiB per row, and 64 MiB
aggregate output; drops, invalid rows, quota, or incomplete drain are failures.

## Future Root admission and command shape

`freeze-template.json` and `route_runtime_pins.json` are deliberately
non-launchable templates. Root must independently freeze current full source
closure, exact models/settings/config, the existing authorized Assistant and
TTS peer sessions, receiver source/model/config/provider identities, and the
actual coding-worker runtime paths. The route runtime pins must be generated
from that admitted runtime, including the actual `.pth` resolution and loaded
aiortc/aioice source hashes; V890's older runtime values are not asserted as
current admission. Root must also collect real receiver warmup rows and run the
offline proof assembler before allowing measured request 1.

After those gates, a future private invocation is structurally:

```sh
AURORA_FROZEN_MANIFEST=/private/frozen-cohort.json \
AURORA_FROZEN_MANIFEST_SHA256=<sha256> \
AURORA_CANDIDATE_MANIFEST=/private/candidate-manifest.json \
AURORA_CANDIDATE_MANIFEST_SHA256=ce75b965ee5879ebece6ea7dfe133441547d20ccf89ecd5d66ea510bd9645e60 \
AURORA_K2_MESH_ASSISTANT_PEER_ID=<Root-admitted-existing-peer> \
AURORA_K2_MESH_TTS_PEER_ID=<Root-admitted-existing-peer> \
AURORA_K2_REMOTE_WARMUP_PROOF=/private/run/remote-warmup-proof.json \
AURORA_OUTPUT_DIR=/private/run \
python controller.py
```

The placeholders are required frozen/admitted inputs, not defaults. This is
not an approved launch command until Root supplies exact source/model/config,
peer/session, receiver, resource, lock, and retirement admission. The candidate
was not imported or executed; only standard-library source parsing is intended
for this handoff. No live mesh result or K2 acceptance claim is made.

After the 15 warmup flows pause before measured request 1, Root's independent
offline proof invocation must bind the frozen cohort and the actual receiver
artifacts:

```sh
python receiver_proof.py \
  --attempts-dir /private/run/attempts \
  --receiver-stages /private/receiver/voice-stages.jsonl \
  --provider-bindings /private/receiver/actual-provider-bindings.jsonl \
  --assistant-identity /private/receiver/assistant-identity.json \
  --tts-identity /private/receiver/tts-identity.json \
  --mesh-calls /private/run/requester-mesh-calls.jsonl \
  --route-observations /private/run/mesh-route-observations.jsonl \
  --route-sink-status /private/run/mesh-route-sink-status.json \
  --route-runtime-pins /private/run/mesh-route-runtime-pins.json \
  --frozen-manifest /private/frozen-cohort.json \
  --candidate-manifest-sha256 ce75b965ee5879ebece6ea7dfe133441547d20ccf89ecd5d66ea510bd9645e60 \
  --cohort-manifest-sha256 <sha256> \
  --expected-receivers /private/frozen-cohort-remote-receivers.json \
  --output /private/run/remote-warmup-proof.json
```
