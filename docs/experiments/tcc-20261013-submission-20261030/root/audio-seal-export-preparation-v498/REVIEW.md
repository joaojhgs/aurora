# V498 terminal audio seal source review

Verdict: **REQUEST CHANGES — one demonstrated frozen-interface mismatch blocks legitimate collection.**

- export.py SHA256: `38ff85e35e71085b31aac15aefe2df4ceb730fa1f8df8462f9ab00ad23176541`
- README.md SHA256: `6a7d360f1b277338990fdd40885582f5f56e238322a1de831c9b842e3f57384f`
- Existing archived V481 frozen-manifest-v1.json SHA256: `d34d21d1a9b1a2db03be2ad64c096e77082168b3bcc09c28d442b4a61eaff3d7`

## Required minimal correction

The frozen harness loop in _collect treats a controller as withheld only if its path equals CAMPAIGN/controller.py (V485), then requires omitted_controller not None. But the actual immutable V481 manifest's harnessFiles['controller.py'] binds /home/developer/projects/aurora/.git/aurora-audio-candidate-v481/controller.py, 9502 bytes, SHA256 975c64f83237ff2639a5d943f8af61b863533161b394ab5065dfb5aa66ef2bb0. It contains private fixture literals and is a different source from the running V485 controller. For the real declared input, the code queues that V481 controller as export content and then always raises frozen_controller_binding_missing before producing any output. If the missing-binding assertion were merely deleted, the existing fixture scanner would reject its secret-bearing bytes instead. Neither is a valid terminal seal.

Verify the V481 controller against its OWN frozen entry, withhold its bytes and record exact path/size/SHA as an omission. Independently withhold and metadata-record the actual V485 controller. Root confirms V485 runtime/launch.json already has newHarnessSHA256 for its actual runner/controller/bootstrap/bindings; use that existing source-provenance map where appropriate for the current harness. Do not relabel V485 bytes as a V481 frozen input or change either original manifest/source. No new manifest framework or weight reads are requested.

## Other reviewed source boundaries

The collector checks terminal finishedAt/exitCode, exact recorded controller/Python IDs 2910571/2910591 and their /proc absence, plus presence of the retirement receipt before output. Root retains ownership of writing/verifying the real retirement receipt and confirming natural termination; the collector does not itself parse a retirement status or prove all descendants/threads reaped. It sends no signals and mutates no original inputs. Source/path checks reject symlink components, archive member keys reject absolute/traversal paths, and destination/receipt/archive must be fresh. The declared output size estimate includes uncompressed file sizes, per-member overhead and 100 MB reserve.

Partial/failed conditions can be preserved: summary/progress are optional with omissions, available raw campaign files remain byte-copied and percentile/outcome values are not recomputed. Backend/config/env files are withheld with metadata; the exact prior fixture scanner is reused rather than a new scanner design. The ZIP is exclusive and final archive/receipt hashes and mode0600 are recorded. These are source-supported behaviors, not a claim that an actual runtime tree has been scanned safely or exported completely. Root must inspect the one eventual actual archive/receipt before treating it as a seal or transferring it.

Validation: source read/stdlib AST only; compared declared frozen-harness interface using the CLOSED archived V481 manifest and prior exporter source. No live V485/V491 attempts/logs/resources inspected, no candidate imports/execution/tests/apps/models/builds/devices/network/remote calls or new agents. Only this report written; all source/index/goals/ledger/vault/active campaign files preserved. Stop after the concrete mismatch; no extra criteria or edge matrix requested.
