# Frozen product-source custody

**Historical/provenance data.** This directory physically retains the400 exact inventory-bound product-source files used by the worker audio runtime:6,708,922bytes, with per-file source/destination/size/SHA256 records in [CUSTODY.json](CUSTODY.json). The copied [source inventory](source-inventory.json) is SHA256 `96ec8e3e14233520d4cd469c4177264a193d05cf26b4b512d91d98f16bbb7dee`.

The running K2 process continues to use its original frozen source location; this retained tree is not a new checkout, project, runtime or validation result. Models and private runtime configuration are outside this source copy. The copy withheld no files and copied no credential values. The initial extension guard stopped after six files; its retained failure record and successful continuation preserve those verified bytes rather than overwriting them.

Preserve these files as immutable input data. The parent ignore rule excludes the copied code from ordinary repository indexing/formatting while leaving custody metadata visible. Do not run the copied app or use it as the current implementation. Reproducibility uses the recorded source, model, environment and condition manifests together.

The bounded2MiB/s copy completed2026-10-18T00:09:20UTC. Its IO/checksum window remains a possible confound for the concurrent measured K2 condition; every affected measured request is retained. No SUT source, setting, process or active path changed.
