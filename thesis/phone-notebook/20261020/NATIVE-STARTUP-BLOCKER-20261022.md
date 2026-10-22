**Current bounded check — falha inicial corrigida; estado final22/10/2026**

O abort de hard-link foi corrigido na cópia isolada com rename atômico e validado por instalação/inicialização e inferência local reais. A responsabilidade de correção permaneceu nesta sessão; Root não é dependência de implementação. A última atualização v8a terminou11:52:55UTC, porém o último piloto remoto encontrou `android_file_audio_route_unavailable` antes de áudio. Não confundir a antiga falha de startup com a causa final, ainda não estabelecida. Janela encerrada11:57:25UTC; confira [resultado final](FINAL-SETUP-20261022.md). O texto abaixo é histórico.

---

**OWNER UPDATE — worker owns production repair, 2026-10-22**

The newer owner instruction supersedes the old Root implementation dependency below. This same session owns diagnose, patch, isolated build/install and real device validation. Root remains the later Git integration/shared-resource coordinator. Actual cause: app-private hard links are denied (v116); a one-file atomic-rename publication patch preserving hashes is prepared in `repairs/android-bundled-model-rename-v1/`.

Historical blocker description:

**Partial feature — actual physical POCO startup abort**

Pinned source `ebde3a8acf6315f920d03593845f17a1fc65a733 + source-closure-overlay-v2383`, package `dev.aurora.desktop.phonenotebook`, APK SHA256`d830acbc44940743c19bab50c2bfecab0f810a3c197a23d5c95e0c980ae1ae6a`, installed and cold-launched on Android16/API36 ARM64. The normal secure installer succeeded. The app then aborted in Tauri setup with `Offline answers are unavailable`, before native file-audio admission or model calls.

Exact code boundary: `apps/aurora-tauri/src-tauri/src/lib.rs:9784` constructs `NativeLocalInferenceState` for every Android role and uses `?` after a generic error mapping at9791. `native_local_inference.rs:40–45` can fail in trusted-catalog construction, bundledNeedle2 installation, or Android backend registration. The public error hides which branch failed; the receipt proves the outer failure, not one guessed internal cause.

Root owns the product fix. Recommended bounded repair: preserve a safe, content-free constructor failure category and identify the failing branch; verify the same frozen model bytes/catalog/storage bootstrap on the real device. Restore normal startup without changing comparison models/settings, suppressing verification, stubbing local inference, changing security, deleting app data, or making HTTP-only clients depend on unavailable optional local inference. Any changed source is a new explicit immutable overlay/cohort and needs the ordinary integration/build/install path. A diagnostic or readiness result must never be relabeled as a successful native audio pilot.

The worker has not modified product sources or re-launched the crashing app in a loop. The actual panic context is in `evidence/read-exact-native-abort-v107/result.json`; the failed CDP result and process absence are retained separately. Native HTTP/P2P correctness, WAV, cancellation and capacity remain unqualified.
