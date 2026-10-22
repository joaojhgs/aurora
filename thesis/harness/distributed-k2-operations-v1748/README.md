# K2 prospective requester custody

Status: source prepared and bounded Sol artifact-map review passed; not launched. The original K1 campaign and its copier remain unchanged.

`../custody_k2_mesh_requester_v1748.py` derives from the running K1 requester copier. It binds only the future K2 `distributed-k2-mesh-{cell,launch,requester}-v1748` paths and the new physical repository destination `thesis/campaigns/worker-desktop-k2-p2p-assistant-tts-v1748/`. Root must use those exact paths when admitting this version; a different operational version requires an explicit corresponding map.

The copier retains completed and failed cases, referenced valid audio, frozen inputs, K2 composition, setup-admission timing, native stages, provider bindings, resources, and exact-peer call/route observations. It preserves checksum verification, atomic fsynced writes, immutable contiguous append-log chunks, credential withholding/redaction, the 2 GiB free floor, and the 60-second cadence. Its 58,200-second observation bound covers the existing requester's 57,840-second outer bound plus 360 seconds; neither the experiment nor provider lifetime is extended.

`SOURCE-RECEIPT.json` records the parent and candidate hashes, exact replacements, unchanged custody primitives, and AST validation. `CUSTODY-ONLY.diff` is the complete prospective change. The requester, provider, collector, correctness predicates, model settings, and scientific counts remain their previously reviewed versions. No runtime/model tests ran for this source preparation.

After K1's natural terminal and raw sealing, Root alone admits the next runtime and supplies this copier the actual new `condition-frozen-v1748.json` SHA256. Startup still requires that exact frozen file; source preparation is not launch or measurement admission. Per-host raw prefixes remain explicitly incomplete until the separate terminal sealing procedure proves EOF.

The original Sol monitor closed the one requested artifact-map review. Its complete report and checksum receipt are physically retained under `review/`. This adds no model/runtime test or reopening of the previously closed workload, provider, and collector reviews.
