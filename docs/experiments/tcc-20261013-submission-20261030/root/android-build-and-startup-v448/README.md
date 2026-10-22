# Android artifact and startup check — 2026-10-14

**Status:** Current bounded check. Build and installation passed; rendered UI failed. The full individual GPU speech/surface campaign remains unsealed and measured cross-device traffic remains held.

**Artifact provenance correction, 2026-10-15:** this directory's V448 label groups retained build/startup material. The primary black-screen capture is V445 and the unsuccessful WebView inspection is V446; the separate `web-product-build-v448` record is a web build, not Android runtime evidence. That inspector timed out before returning DOM, resource-tree or exception observations. No new Android launch, diagnosed cause or source fix follows from its empty result. Later campaign scheduling is recorded in the [current results index](../CURRENT.md).

| Boundary | Actual result |
| --- | --- |
| Native prerequisites, WASM, shared UI | Passed once and retained; not rebuilt for the packaging retry |
| APK | Third bounded APK attempt passed after the original linker SIGBUS and data-scratch execution failure |
| Approved Waydroid route / ABI | Existing personal desktop Orca/ADB route verified, x86_64 |
| Existing app update | `adb install -r -t` succeeded with app data preserved |
| Cold launch | Status ok, one observation: 1633 ms TotalTime / 1653 ms WaitTime; app process present |
| Product UI | Failed: blank content and WebView accessibility node with no children |
| Runtime inspection | No WebView Runtime.enable response through the maintained connector; temporary owned loopback mapping removed |
| Speech / history / full pipeline | Not executed by this Android startup case; zero measured voice requests |

The APK is 194,968,469 bytes, SHA-256 `e031b391a29740d00e4e6177d56e0e8ea34dc1abf5f9f01e60d2d572265f791e`. The reduced-debug build profile and NDK version difference are explicit in [artifact.json](artifact.json); this is not an exact CI-toolchain equivalence claim.

[Build history](build-case-history.json), [app commands and outcomes](app-case-history.json), [startup observations](startup-observations.json), [selected startup log](startup-selected-primary.log) and the [actual screen](blank-startup.png) retain the important main-flow result. The native profile validation log has not been shown to cause the blank UI. Source analysis found a detached refresh and a caught frontend profile bootstrap failure. No speculative profile change or data reset was applied. Full raw private logs and exact host/route mapping remain preserved in the existing repository handoff artifacts; this projection excludes credentials, private user capture and network identifiers.

The next desktop condition has [verified pinned speech assets](next-desktop-asset-admission.json), not a loaded model or admitted voice run. All six prior Tiny logical flows remain excluded task failures with zero accepted voice samples. No new voice attempt, percentile estimate, CPU/GPU pooling, physical-phone claim, final aesthetic approval, or aggregate acceptance follows from these checks. The accepted [typed GPU local/API results](../desktop-gpu-typed-primary-v426/README.md) remain separate and unchanged.
