# V320 bounded next iOS main-gate preparation

2026-10-14 UTC. **Next gate identified in the existing workflow; native offline speech/tool acceptance is still open.** Preserve the successful baseline. Do not dispatch a redundant default baseline or infer native acceptance from skipped step32, linked libraries or source policy checks. This report performs preparation only; no runnable CI ref or new native artifact is created.

Read current workflow, native CI/renderer/control runners and target dependencies, relevant Tauri/voice guides and retained baseline/native failure receipts. Read-only Git/source/hash inspection; no builds/tests/models/downloads/network/GitHub/device operations, source/index/goals/ledger/vault edits, commits or agents. Only this private report is written. Root retains the live main campaign's global lock/resources and original Orca ownership.

## Exact retained baseline

Run38181244730/job114594073207 completed SUCCESS at `2026-10-12T00:05:35Z`. The actual retained head is **c0f4c0013cea5bb11ef81297194d0dc142a47bc4**; the supplied c0f8 abbreviation does not match this receipt. Metadata: `.git/aurora-handoff-import-20261006/delivery-typed-code-v189/ios-final-metadata-v214.json`, SHA256 `8d743df4fdfcd23bef18fbe445505c7be032df7066f82379b1496cf02784b28b`.

Preserved passes include simulator/frontend/client build, Python-free client package/provenance, install/launch/screenshot, MobileSafari and packaged WKWebView direct/STUN/TURN interoperability, aggregate baseline evidence, App Intent and IOS004 payload smokes. **Step32 “Run native iOS speech and Assistant main flow” was SKIPPED.** Sherpa/llama build steps15/18 were cache-hit skips with restore/configure steps successful; these do not mean those runtimes are absent, nor prove runtime execution. iOS target dependencies include ios-sherpa and native-cactus; build_llama_native delegates to the pinned Cactus Apple builder and build.rs checks pinned static metadata. No baseline runtime Sherpa/Cactus inference/tool pass is inferred from compilation/cache reuse.

## Legitimate existing input and artifact/source mapping

Use existing `.github/workflows/tauri-ios.yml` dispatch/call boolean **native_voice_main_flow:true** (defaultfalse). No other dispatch field selects native models/tool scenarios. This activates the existing step236–242, which runs `node apps/aurora-tauri/scripts/ios-voice-main-flow-ci.mjs` on the macOS/Xcode job. No additional workflow, access/credential change or successful-baseline rerun request is introduced here.

That CI wrapper creates a distinct owned debug aarch64-sim app using tauri.ios.conf.json plus tauri.ios-voice-live-test.conf.json/ios-voice-live-test feature and VITE_AURORA_IOS_VOICE_LIVE_TEST/control origin, resolves the built .app, boots/installs through the maintained simulator smoke, starts its owned real Gateway helper with private0600 credential file, and invokes the native main with explicit app path/UDID/config file. The baseline unsigned release client artifact alone is **not** this instrumented native-main app and cannot be substituted. The wrapper rebuild is required for its test capability/bundle; source publication/ref must match the selected CI head.

Retain the baseline artifact roles separately: aurora-ios-client-simulator, aurora-ios-client-build-provenance, aurora-ios-ci-evidence-summary, aurora-ios-simulator-smoke and aurora-ios-python-webrtc-interop. assert-ios-ci-evidence.mjs checks those baseline simulator/interoperability documents; it does not require native speech/main proof. The native runner emits its finite result to the primary job log, so Root must retain the actual opted-in job primary and result/source/artifact hashes, not just an aggregate baseline SUCCESS.

## Current source continuity and current changed seams

Read-only comparison with exact baseline c0f4 shows unchanged workflow, ios-voice-main-flow-ci.mjs, ios-voice-main-flow.mjs, renderer ios-voice-main-flow.ts, native-ios-voice.ts, native Swift/Rust and iOS Cargo/runtime builders. Current changes include shared Assistant foreground/history wiring and Gateway RPC/refresh, which do not themselves establish a corrected STT-selection readiness path. Current HEAD is5782746afba213f6b36907db2f09f0017625e218 with measured WIP source; HEAD alone is not a frozen CI artifact mapping. Before any future dispatch, Root must choose an exact existing-workflow ref containing the intended reviewed integrated source and bind its actual app/native/library provenance; this task does not publish it.

Current SHA256 anchors:

- Workflow: `9ddc4a2dc36a63d9e0face26a1edaa25a91fc4d6f31e00addd4c250062485a00`.
- Native CI wrapper: `235f5021762fc4b32118a26f70e6b032ca91ca950ae46ee15bf044263d10ec3e`.
- Native control runner: `f1ce191a27eff9c678b39cac558e2a75ce5902085c5f40b6fb6b5b4bca207187`.
- Renderer main: `4503c34468cd9d4a09eb2cc93d50094af0d6d3574a4850457e05d872e02a20db`.
- native-ios-voice.ts: `651dbad4d26170d740a438df62e809492ccbf8993ff1e19ec07f4f496763b769`.
- Cargo.toml: `491f2111c51871ed150cda5d5905844f5a5322c591422016c2e41580d2bf6901`.
- Current shared foreground controller: `dae3bdf7ab9baaeffd8d9ae0339b7200e520ec5f0c64e1bdb461d967e85fdcbb`.
- Current Gateway RTC: `d3a5ee5e02c976839d221ba7a4996a30f074b42a53fc25530b987879e7dc58b7`.

## Concrete remaining important gate

Last retained actual native main38170326712/job114561426020 failed speech_setup/speech_readiness_timeout. Same poll recorded observed:true, selected profile:false, availability:false and active-STT-match:false; no PCM/transcript/model/final answer occurred. Architecture/install/launch passed; owned assets removal wasfalse, while profile/preferences/audio restoration passed. Safe receipt `.git/.../ios-current-failure-v165/safe-summary.json`, SHA256 `76de278c364e91319b4080f319b68dff331c3f46452f8ca762c59b2395073b5f`. Exact reason remains UNKNOWN. The later successful default baseline skipped the native step and does not close this failure. No evidence reviewed here justifies an unchanged blind native rerun or an availability/auth gate relaxation.

The existing native main selects the real arm64 Cactus offline model, requires actual pack/profile/readiness, injects bounded synthetic PCM and waits for transcript plus a nonempty sent answer, then enforces cancellation/restoration/owned assets. It has **no explicit native-tool request/result assertion** in renderer or runner result schema. Even a future pass would cover that foreground speech/answer flow, not the requested important offline speech/tool execution boundary. Its CI harness starts an owned Python Gateway for voice preparation; a pass alone also does not establish absence of Python/Gateway dependence for ordinary local/offline inference. Synthetic PCM is real native pipeline input evidence, not physical microphone/background capture evidence.

Root's bounded next handoff is to resolve the demonstrated selected-profile/native-readiness gap from existing source evidence and ensure the same important opted-in foreground flow explicitly exercises/validates its actual native tool boundary before counting offline speech/tool acceptance. Keep one existing main flow, current permission/model/route/cleanup gates and genuine Gateway auth; do not add a model/edge matrix or claim the full normative speech-routing scope from this single gate. No repair is supplied or authorized by this read-only preparation report.

Once the relevant source/readiness correction and exact CI ref/artifact mapping are concrete, Root alone schedules the one existing-workflow native opt-in gate. The120-minute job and existing finite runner budgets remain operational limits, not a guarantee that uncached native preparation fits. Keep all prior baseline/interoperability passes closed, native/Apple runtime and physical-device/background scope separate, and aggregate/Astra/telemetry/story acceptance unpromoted. No CI push/dispatch, campaign interference or new orchestration is performed here.
