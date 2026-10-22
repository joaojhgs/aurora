# V498 private post-terminal V485 audio seal

This is future source wiring only. It has not been run. Root may invoke it only after the V485 condition has naturally written `runtime/terminal.json`, Root has recorded `runtime/retirement.json`, and both recorded owners are absent. The collector never terminates processes, retries collection, or requires a successful 900-request result.

## Fixed roots and output

- V485 campaign: `/home/developer/projects/aurora/.git/aurora-audio-campaign-v485`
- V481 frozen candidate/input: `/home/developer/projects/aurora/.git/aurora-audio-candidate-v481`
- Output directory, which must already exist: `/home/developer/projects/aurora/docs/experiments/tcc-20261013-submission-20261030/root/desktop-gpu-full-audio-local900-v485`
- One exclusive ZIP: `aurora-desktop-gpu-full-audio-local900-v485.zip`
- Private receipt: `.git/aurora-handoff-import-20261006/audio-seal-export-v498/export-receipt.json`

Before creating any output, the script requires terminal and retirement receipts, the exact controller/Python PIDs recorded by this V485 source (`2910571` and `2910591`) absent from `/proc`, the existing destination directory, and no preexisting archive/receipt. It estimates the full uncompressed input size plus ZIP overhead and the required 100 MB destination reserve. All collected filesystem inputs must be regular non-symlink files rooted in the fixed project/campaign/candidate roots.

## Sealed contents

The allowlist includes candidate/frozen manifests and registry inputs, the original WAV selected by `candidate-manifest.json`, exact frozen source/harness files, the V485 launch/terminal/retirement/resource/provider/runtime-version records, voice-stage records, and the complete `runtime/campaign` tree, including existing attempts, progress, summary, and generated WAV files. Existing summary/progress counts are copied into the archive manifest without recalculation; absent records remain absent and are listed as omissions. Failed and partial terminal outcomes are sealable.

Both controller sources are withheld independently. The V481 controller path is taken from the V481 frozen `harnessFiles` entry; its bytes and SHA-256 must match that entry before only its exact path/size/SHA and omission reason are retained. The actual V485 controller is separately hashed and must match `runtime/launch.json`'s existing `newHarnessSHA256["controller.py"]`; only its path/size/SHA and omission reason are retained. This does not relabel V485 source as a V481 frozen input. Raw backend logs and every `config.json`/`.env` file are withheld; backend-log path, size, and SHA-256 are retained only. The existing V481 fixture-secret scanner checks all archive contents before ZIP creation. No weights, environment, full source trees, config, credentials, or raw backend-log contents are copied.

The ZIP includes a per-file byte-count/SHA-256 manifest, terminal state, copied attempt counts, explicit omissions, and a flag that success was not required for sealing. The private receipt records archive path, size, SHA-256, manifest hash, file count, scan status, and omission count. Both ZIP and receipt use mode 0600. No existing raw evidence is changed or deleted.

This seal is evidence preservation only. It does not recompute outcomes or percentiles, claim all attempts succeeded, establish cleanup beyond the recorded process checks, or publish a cross-device comparison. Root owns natural-terminal verification, retirement, invocation, outcome analysis, and any later transfer.
