APPROVE — integrated PER-288/289/290 source architecture and PER-291 conditional PLAN ONLY.
Actual native Sol child: /root/sol_mobile_bootstrap_review; thread 01a1246f-19fe-7033-8afe-af7c4921bfd7. No Orca Dispatch/terminal binding.
No material main-flow architecture blocker found. This does not accept the parent issues or claim packaged capture works.

Reviewed identity and boundary
- Branch codex/aurora-native-speech-routing-20261007; initial source HEAD 4bee143350d586969fc605112c878ccab5133504.
- During review Root committed diagnostics/evidence as 532f1c739837fd454498fb6240862f6037c6f128; final inspected HEAD matches, working tree clean.
- Between those HEADs the sole product-source delta is native_node_config.rs, 107 additions/22 deletions; exact git diff SHA256 2812622a87067edb0d3b2c5a9bf8674922ec8cdfbcaab36bb7b57d50276b7fb6.
- Read applicable AGENTS/configuration/ambient-transcription guidance, four authoritative intakes, accepted checkpoints and connected source. No product/index/aggregate/ledger changes, executable checks, downloads or recursive agents.

Main-flow architecture evidence
- OS-local account boundary: local_data_native.rs:3110 resolves the OS-user application configuration directory, not a remote account store. Rows and operations bind profileId/localNodeId (134, 1955, 1977, 2002); one app-local database may hold multiple profiles without making them one authorization scope. AuroraNativeLocalData.kt:33/154/180/210 uses Android-private profile storage, scope-derived Keystore keys and record/profile/node AAD. This is source evidence, not a live OS-user isolation test.
- Configuration and ownership: node_config.rs:64 and node_config_file.rs scope the policy namespace to canonical profile and stable node; disabled defaults remain. native_node_config.rs:389/409/496 preserves profile-transition admission locking, confirmed profile/generation and coordinator policy. Diagnostics add static labels without replacing these gates.
- STT-only recording: native_transcription_archive.rs:67/184 admits the confirmed profile and selected STT policy; android_audio.rs:1269/1330 creates the separate transcription bridge. android_session.rs:2459/2568/2803/2920 consumes finite PCM through the selected STT route with policy/consent checks; the capture path does not run assistant orchestration, TTS or playback.
- Durable archive: native_transcription_archive.rs:255/355 checks the admitted session/generation and ordered segment bounds before persistence/finalization. Android encrypts text before the JNI append; local_data_native.rs:134/1860/1914 commits typed scoped operations, retention and once-per-process interrupted-session recovery. No raw audio is stored. Null model provenance and not_requested diarization remain truthful missing evidence.
- Android notification/background ownership: AuroraRuntimeForegroundService.kt:1325/1545/2222/2532/2795/3863/3911 adds transcription to the existing foreground-service reason ledger and notification, guards microphone/permissions, admits native scope, saves encrypted finite intervals, and finalizes Stop. Policy/profile settings persist; native executor/capture/archive ownership does not depend on a running WebView. Release preserves other service reasons. These source connections do not prove actual background survival or restart.
- Settings/capability: native-speech-policy.ts:225/603 saves scoped policy and synchronizes typed Android status; background-transcription.ts:33 separates saved choices from actual capability/capture state. voice-settings-local-speech-section.tsx:472 permits configuration from supported capability rather than requiring an already active capture. Unsupported iOS continuous capture stays explicitly labeled in native-speech-policy.ts:42; no iOS 24/7 support claim.
- PER-291 implementation-plan.md:8/18/27/31/43/66/80 maps ambient day grouping versus notification intervals to real scope, session/segment records and repository cursors. Speaker/model data require stored evidence; decryption, readable per-session export, annotations and active-session association are named follow-ups. No screen or recording controls are implemented/authorized. The accepted search checkpoint supersedes the plan's historical first-500/missing-sessionId premise; complete library filtering/budget continuation remains a distinct follow-up. Stage 2 acceptance is still an explicit prerequisite.

Existing validation and actual limits
- Accepted PER289/PER290 checkpoints record Root's prior SDK/repository/export/migration, native storage, UI/adapters, finite STT/rearm and Android-service source checks. PER289 search records its targeted main-flow test and SDK build/typecheck. These are prior evidence, not fresh checks by this reviewer.
- Latest Root V13 evidence supersedes the V8 profile-failure location: Rust/Gradle package PASS in 48.61 seconds; production profile get succeeds, set fails in 6.79 seconds with profile_canonical_validation_failed before storage/capture; Android user 0 restored. No transcription acceptance follows from the compile/install results.
- Packaged Android notification Start/Stop, suspended-WebView encrypted persistence, ambient continuation and restart/recovery remain unproven. Current Apple-host/iOS acceptance and final visual acceptance remain open. Original aggregate stays active; PER-291 remains conditional plan only.
- Smallest existing main-flow continuation, owned by Root: after canonical profile save/readback succeeds, save notification mode with ambient off and selected STT, Start from the existing notification, background the WebView, Stop, then read the completed scoped session and ordered encrypted segments through typed repositories. Report the device/build and actual persisted result; retain the already required ambient/restart and Apple-host acceptance gaps until evidenced.

Exact SHA256 evidence artifacts (receiving-session-20261006 directory unless stated)
- PER289-ARCHIVE-FOUNDATION-CHECKPOINT-V1.json: de4b19828217ec7104cdd698e270672d38e32545839e6e1463e311ac5a544b78
- PER290-CONNECTED-RECORDING-CHECKPOINT-V1.json: 89eadab5dac821cc5395344defba0212213189ab1d5fd9da90c6f9d0d0227583
- PER289-SEARCH-CHECKPOINT-V1.json: 0a9d7430cc91df36ee881b0ce02ecf29d87218c0efe950647b54ef4cc61c1761
- PER291-PLAN-CHECKPOINT-V1.json: eaa931da698af53b3dc094e193561caef0659359374190a2d0e4b6c6f44a555f
- IMPORTANT-MAIN-FLOW-STATUS-20261010.md: 2ea3c6b9b2816491b637ebeb5e236489ad1243fb73298cec1cdb8b2a405faa9d
- ANDROID-PROFILE-PUBLICATION-V1.json: 456ece6aa49cbf335ce3ee44254c2cf888aa875948f5c388354c9cdf59f19004
- .omx/plans/transcript-library-20261010/implementation-plan.md: 7eaf5ef7568684d104fafe4a34b0b05894abb65e0af7feade288c6e58678355a
- .omx/task-intake/PER-288.md: c7eecf02128ccbc0ddaad8eef42730192831ac4a6d5770e826f4729af9bdaa67
- .omx/task-intake/PER-289.md: 25cddc5d54b6ac3f92f2178d04acef55fd3cf27ba042b6651a902672b1f64eda
- .omx/task-intake/PER-290.md: be0e730d867860f03d1b44934a236c57fcfdae75d036d4ce511e7d9065d8fa30
- .omx/task-intake/PER-291.md: 0070fab1323899d0de89504115b0f4c1a55f80e202368e244d47d25946433349

Exact SHA256 connected-source anchors (remaining source fixed by reviewed HEAD)
- native_node_config.rs: 12d84d50ce97d103b43b315da99e7756bef76adafa3a9e3c0ccfa08f13b9818e
- native_transcription_archive.rs: dff90b6bd4a6a9b00a67b258fdd76e86603a21b847d22e0a8623cff3340b66b7
- local_data_native.rs: b71744948f26adb59158312410fa4254a16e8eaaead2d4618581e59b5ef41f64
- AuroraNativeLocalData.kt: 91d7bdb35d59760e65f72f6d47e8c8d1c264b07d5bcceb1c0381ef41ade5aeac
- AuroraRuntimeForegroundService.kt: 480d4f82a09cb8fc565c95580eee88f6d570623dfb34fcce02f59b97669d327f
- android_audio.rs: 6a86ea3dd24ac8ec2b3586d87bc54e302dc5f9f938eb9daaa6e42a8915e20458
- aurora-voice-native/src/android_session.rs: 84c48add6c48d6274ea4f949543a87b6ce326c84b8273e93b7fb544e5d827968
- aurora-sdk/src/local-data/search.ts: 13cf66e1e2a457d67a6238d409bf7fe0c87a899ad2e18568987ab6f4d29162c0
