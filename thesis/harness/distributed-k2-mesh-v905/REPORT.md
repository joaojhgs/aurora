# V894 K2 mesh source preparation

## Result

Prepared a private, unlaunched K2 mesh candidate under this directory. It uses
the existing K2 flow's local typed STT and strict transcript/Paris/valid-WAV
predicates, with the two remote stages routed through the approved
`request_mesh_stage` typed MeshBus adapter. Each stage has an independent
peer binding; neither HTTP nor local fallback is treated as remote mesh.

The new multi-topic route observer records actual PeerBridge calls for
`Orchestrator.ExternalUserInput` and `TTS.Synthesize` in one installation. Its
bounded sink accepts the 1,830 planned warmup/measured remote calls plus 16
explicit setup rows. The receiver proof requires the 15 correct warmup flows,
30 native remote stage spans, 30 requester mesh start/end pairs, and 30
same-call route snapshots before it can authorize measured request 1. Route
evidence remains snapshot-only and does not claim pair identity or continuous
stability.

The frozen Assistant binding also requires the exact effective llama
constructor settings and the offline proof compares them with the receiver's
V430 constructor-return record. A config hash or response metadata alone does
not establish those settings.

## Remaining Root-owned admission

The cohort and route runtime pin files are intentionally template-only. No
current exact-peer sessions, receiver identities, model/config/provider
bindings, full source-equivalence closure, actual `.pth` resolution, resource
admission, or native warmup receipts were supplied to this source task. Root
must construct the new frozen manifest and actual runtime pins from those
independent inputs, then collect and join the actual 15 warmups before launch.
The prior V890 runtime path data is not represented as current.

No tests, imports, models, service startup, request, network, device, build, or
runtime operation was performed. No production source, old bundle, live
campaign, goal, methodology, or Git state was changed.


## V905 narrow V902 closure

Original Root preserved V894 and fixed only the two V902 startup/gate blockers in this new copy: import re for controller peer validation; require60 actual PeerBridge boundary rows for30 warmup calls while route observation/call counts remain30. No measured allocation, correctness, route or proof semantics were weakened. Dependent controller/runner freeze pins were refreshed. AST parsing passed; no candidate/dependency imports, runtime, model, test or network operation. The original V904 failed F821 result is retained.
