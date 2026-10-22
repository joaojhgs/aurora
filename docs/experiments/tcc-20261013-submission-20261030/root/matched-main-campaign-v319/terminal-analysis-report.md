# V325 matched-input gate correction

Private source-only analyzer candidate. Baseline `analyze.base.py` SHA256: `4fcba3fc81f88c35aeebb538c16134d7ee5a3badfa696576c404a60a155dda57`. Candidate `analyze.py` SHA256: `8910de00b1f4918a2cd925681a83c4d8967839b6c716d42028b82c0d25284408`. Patch SHA256: `b5a3759ba5c612cc5008f672ee2a73f6a739d05f3bf213b6b6a6ee5ae372ec05`.

The prior gate could not accept a valid campaign: its parent export intentionally has no parent config/workload hash, while each new cell has a different private config hash. The corrected gate does not compare those random config hashes or complete generation-settings objects across cells. It preserves each cell's config hash and observed generation settings as provenance, with absent parent config/workload values remaining `null`/unknown.

Matching now requires the pinned model SHA256 `57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf` and source head `5782746afba213f6b36907db2f09f0017625e218`, the exact archived provider fingerprints, and all 105 ordered provider captures per cell validated by the archived `campaign_runner.py` implementation. The archived runner is loaded only after its digest matches `campaign_driver_sha256`. Local/API raw records must carry workload ID `public-exact-answer-orbit-v1`, workload SHA256 `0f3b83f8fbf0e55e7b7faf8a75e99f42fdad42128b908e7f7c18cd4d8faeed86`, and the same model/source pins. Mesh captures are validated through the same ordered capture validator; their fixed task is anchored by the captured messages/provider-input fingerprints, without inventing a parent workload hash.

The result now calls the gate `matched_inputs_ready` and preserves safe per-cell match provenance, including config hashes and explicit `null` parent config/workload values. Complete 300-measured-row eligibility still requires the existing terminal status, all nine complete cohorts, unchanged source/protected inputs, and hard-cap conditions. This change adds no data, samples, or runtime evidence.

No analyzer, campaign, test, service, model, network, browser, or device command was run. Root owns any later review and post-terminal invocation; the live campaign remains untouched.
