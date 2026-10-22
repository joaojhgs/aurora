# V474 exact setup metadata-consumer delta review

2026-10-15 UTC. **APPROVE the bounded setup repair.** Source/diff/hash inspection only; no imports/tests/browser/runtime/models/build/network/device/Orca operations, canonical/index/goals/vault writes or new agents. This private report is the sole owned write. No driver or full-product re-review.

Final hashes independently match every manifest entry:

- Unchanged driver `50a7528c6a310b35bfd0aa0c0431a05abe03d12cb6cdeac24d79a71c64d87e95`.
- Supervisor `09bcbdf2cb0f6de7fed9f5739a33cf2de61d24c4830eee7fdba4939a050417ee`.
- Backend controller `2d5d2db15ae6b097c38274e13613861181ea6c6f4f8c04ad075bbf0774f10fcc`.
- Driver controller `69a398ace923486f9335c77f24e76f1d347d1ea79b5fcb4e4402db8395623912`.
- Guard `c4098fd00f669b6bbfc577a9767af858e49b9713d0ff330a810e6969c011dcde`.

The supervisor no longer reads nonexistent capture/worklet keys from the one-file TTS build receipt. It hashes those actual frozen source files under the build's source root and requires the same cef59aa2/af88cb9a values, additionally requiring the receipt's actual ttsSourceSHA256=e5caa61b value. Recorded web metadata uses those verified hashes and the current build ID; the old unrelated source-packet claim is removed. Existing build-success/controller-retirement prerequisites remain. This corrects the demonstrated KeyError without removing a source guard or rebuilding anything.

Other differences are V473→V474 private runtime/hook/output/temp paths; the approved driver is byte-identical. Existing 90/300-second caps, one case, original fixture recovery, public health, private copied DB, global lock and owned cleanup remain. V473's zero-child setup failure is historical evidence, not an executed audio case or overwritten result.

Prior main-path source approval `df1a7ca87b50cf3a667ccc7cb4f4029eb4426fd8042fdd331c4603447cc8209a` remains scoped to the unchanged retained-answer audio driver. No remaining material blocker in this exact delta. Actual prior PID retirement/lock availability and the first real audio result remain Root's gate; no LLM/STT/new-conversation, acoustic output, measurement or full-acceptance claim follows. Stop.
