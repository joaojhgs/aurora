# K2 V1748 copier artifact-map review

Observed: 2026-10-20T08:00:39.972601+00:00

Verdict: CLOSED — the prospective mechanical artifact map is sound. This is static source inspection only; candidate not imported/executed and no campaign admission, model call, test, build, device or network probe was performed. Existing workload/provider/collector reviews remain closed.

Request: msg_22432fdd0038. Same Run run_e6054e76e9fc / Task task_d7ea336050cf / Dispatch ctx_37b4d0a3c14f; Root remains sole execution/reservation owner. Monitor native get_goal at07:59:26 returned blocked; no resume/model/account/identity change was performed.

## Mechanical paths and artifacts

- Candidate equals parent after exactly the18 declared mechanical replacement groups/counts; no unlisted delta. now/digest/atomic/encoded/private_values remain AST-identical. Candidate/diff/parent bytes and SHA256 match Root SOURCE-RECEIPT.json.
- New private CELL/OP/STAGE names and physical thesis destination consistently use future v1748, with the three condition-frozen-v1748.json references and actual frozen-SHA requirement. These paths are prospective, not proof that future launch manifests exist.
- Controller uses output=campaign and output.parent=CELL: runtime-versions.json, voice-stages.installed.json, voice-stages.status.json, actual-provider-bindings.jsonl, voice-stages.jsonl and resources.jsonl map correctly.
- K2 controller/bootstrap emit mesh-route-runtime-pins.json, mesh-route-sink-status.json and mesh-route-observations.jsonl at CELL; candidate correctly removes the K1 requester- prefix from those names. requester-mesh-calls.jsonl retains its actual producer name.
- Runner writes campaign/mesh-route-admission.json and campaign/mesh-route-admission-timing.json; both mutable artifacts are versioned as snapshots. Controller expects campaign/remote-warmup-proof.json and saved collector emits remote-warmup-proof.json; candidate retains that actual final proof name instead of K1 receiver-warmup-proof.json.
- Harness source map contains mesh_stage_adapter.py and k2_composition.py with shared telemetry, route observer/sink/pins and proof source. Existing operator/finalizer/provider-warmup custody names remain parent-compatible; no replacement operation launcher is claimed by this source review.
- Retention of complete success/failure request rows, referenced WAVs, append-prefix records, stable snapshot versions, checksums/fsync/secret filtering and 2GiB floor is unchanged. Separate provider custody still requires actual per-host evidence joins; copier readiness alone proves no future raw coverage.
- Copier observation bound58200s covers declared requester outer57840s by360s. It does not extend requester/provider/request caps or authorize overlap with current K1. No new execution gate is introduced.

## Exact source identities

- thesis/harness/custody_k1_mesh_requester_v1719.py — 17363 bytes — SHA256 ce6b06927bcf6f15e2ef43a5a0a54a29e4de43ef73797a37700b52797d97a6bf
- thesis/harness/custody_k2_mesh_requester_v1748.py — 17478 bytes — SHA256 648c97916910c6152a0b07ef7a4a30d73163f470b9238147dff1f2b78c3da164
- thesis/harness/distributed-k2-operations-v1748/CUSTODY-ONLY.diff — 6905 bytes — SHA256 9dcf412a9d09edeb0bb914dd35c089760af47b88dc2cda4ea0adfc01ec64d078
- thesis/harness/distributed-k2-mesh-v1731/controller.py — 19790 bytes — SHA256 573ee21e7e8043c9f76061688f411147d3a1be88ed681bd1024f4ca3126a6b9a
- thesis/harness/distributed-k2-mesh-v1731/runner.py — 69328 bytes — SHA256 8347fc103a11ca6c9d0c3686b442bd2e4236a4122c668a42bcc10944b7408285
- thesis/harness/distributed-k2-mesh-v1731/bindings.py — 5492 bytes — SHA256 79558452e6f61268ad246476ca848e060b8ea808e15091bc53a3c4e0e28b1647
- thesis/harness/distributed-k2-mesh-v1731/bootstrap.py — 12953 bytes — SHA256 b88a8a1aa6769bffc214329cdc219f6effc369b172cd777b3959c69a084866ec
- thesis/harness/k2_mesh_saved_warmup_proof_v1735.py — 9113 bytes — SHA256 5a8c4fdd50edc4c66c2f0e56ef552409b1132b1147c0e3e73075d75e5d2c27dd

## Contemporaneous limited live observation

```json
{
  "observedAt": "2026-10-20T08:00:39.972540+00:00",
  "indexUpdatedAt": "2026-10-20T07:59:56.688584+00:00",
  "progressObservation": {
    "attempted": 272,
    "last_attempt_file": "attempts/attempt-0272-measured.jsonl",
    "last_attempt_status": "completed_correct",
    "measured_attempted": 257,
    "planned_measured": 880,
    "planned_warmups": 15,
    "status": "running",
    "unattempted_measured": 623,
    "warmups_attempted": 15
  },
  "retainedCaseCounts": [
    {
      "phase": "warmup",
      "status": "completed_correct",
      "n": 15
    },
    {
      "phase": "measured",
      "status": "completed_correct",
      "n": 251
    },
    {
      "phase": "measured",
      "status": "failed",
      "n": 6
    }
  ],
  "retainedOldMeasured": 20,
  "retainedOldCorrect": 19,
  "retainedOldFailed": 1
}
```

Old20 and new epoch remain separate and failures retained. This source review changes neither current frozen K1 source nor its settings/counts. K2 remains next serial runtime after Root verifies natural K1 retirement, custody and safe resource release; no extra workload/provider/collector review is requested.
