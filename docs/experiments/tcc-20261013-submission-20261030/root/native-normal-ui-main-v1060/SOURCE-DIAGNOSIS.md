# V1062 native normal-UI readiness diagnosis

Disposition: **source-grounded local setup/application gap; no permission or model bypass recommended.** Read-only diagnosis of current source and the retained V1060 primary. No runtime, tests, builds, model calls, or source changes performed.

## Observed boundary

The retained primary records zero normal UI sends and zero file-audio invocations, a 45-second disabled-prompt timeout, a healthy actual Gateway and successful source/PID guard. Its window simultaneously contains “Aurora thin client”, “Starting Aurora on this computer”, Member/Limited access, and configured-model text. V1049 direct mounted-runtime audio success is separate evidence: it does not establish normal React route/profile/session readiness.

The actual V1060 harness creates isolated XDG storage, manually invokes Rust `aurora_sidecar_session` / `aurora_sidecar_start`, waits for real health, and then waits for `#assistant-prompt` to become enabled. It does not complete normal local runtime onboarding. Starting the protected Rust sidecar is not an update of the application's runtime profile or React readiness state.

## Exact disabling chain

1. `apps/aurora-tauri/src/aurora-client.ts:773–840` derives the active runtime profile from the loaded document; absent configuration leaves nodeMode `remote-console`, runtimeTier `none`, and runtimeProfileConfigured false. The desktop-local return at `:1150–1174` uses the real native transport, but independently sets `requiresOnboarding: !runtimeProfileConfigured`. Physical desktop-local transport therefore does not itself select an admitted Python-full runtime role.
2. `apps/aurora-tauri/src/tauri-app.tsx:1116–1126` returns early when requiresOnboarding is true. It copies loadingShellSnapshot (empty routes), marks the shell ready, and sets nodeName to the exact observed “Aurora thin client”. It never reaches `runRuntimeReadinessProbes` or the later `setSidecar`. The normal readiness path at `:1790` starts/checks the sidecar and then waits for actual Gateway readiness.
3. `tauri-app.tsx:3000–3032` maps an absent route to fallbackRoute with `disabled: true` and `routeable: false`. `packages/aurora-ui/src/use-assistant-session-actions.ts:138–149,370–374` requires a non-disabled route, no pending work, a real persisted session when required, and completed session-index loading. `assistant-composer.tsx:340–345` disables the prompt when canSend is false (outside listening).
4. `tauri-app.tsx:418` renders “Starting Aurora on this computer” whenever the React sidecar value is absent in local mode. That label is not the authority which disables canSend. A manual Rust start can leave this label stale while the actual backend is healthy. Member/admin presentation is likewise not a direct canSend predicate; the retained primary does not prove an authorization rejection.

## Concrete first-run product gap

Two current-source conditions make “just finish setup” an insufficient recommendation without a repair:

- The automatic onboarding branch at `tauri-app.tsx:1437` requires requiresOnboarding **and thinPeer and thinProfileController**. The desktop-local return has no thinPeer, so an unconfigured local runtime can fall through to the disabled Assistant shell.
- `applyModePreference` at `tauri-app.tsx:979–984` returns successfully without applying anything when runtime.thinProfile is missing. The desktop-local return also omits thinProfile. `onboarding-view.tsx:327–337` awaits this callback and then marks setup done, so this local path can report completion without creating/selecting a configured profile. Saving only the mode/tier preference is not a replacement for that profile transaction. The mobile-only createOfflineProfile path is not a desktop Python-full remedy.

Confidence: **high** that this is a real source-level first-run gap and the strongest explanation of the exact observed text. The retained primary did not capture runtime.requiresOnboarding, loaded profile document, or route object, so the specific branch taken in V1060 remains a strongly supported inference rather than a directly recorded runtime fact. A persisted-session initialization failure is another independent canSend condition; healthy sidecar alone cannot establish session readiness.

## One smallest meaningful next repair

Repair the **normal desktop-local setup transaction**, rather than the prompt or sidecar label: expose the existing local setup when an unconfigured desktop-local runtime requires onboarding, and make its normal “Run Aurora on this computer” / “Finish setup” selection persist and select a valid local Python-full runtime profile through the existing runtime-profile store/controller, then rebuild the runtime. Keep the existing actual package Python-full capability admission, profile sanitization, real route/auth discovery and persisted-session initialization. An absent local profile must not be treated as successful application by the early return.

This is one connected setup-boundary repair, not a grant/role injection or an instruction to synthesize a profile in the harness. Do not force canSend, grant admin, seed browser/native storage, infer a runtime role from transport, or merely set React sidecar.running. The resulting normal readiness path must establish the real route and session before sending; Root owns any implementation and later actual main-flow verification. Current evidence does not warrant a model change, another 900 run, or a broad permission investigation.

## Reviewed byte pins

- `apps/aurora-tauri/src/tauri-app.tsx`: `edfbf868d97bd1e0257aa88211b95e4bf9af7ddacebc130b3940238ad9156c5a`
- `apps/aurora-tauri/src/aurora-client.ts`: `f315ffc77530a460a73789f707f83c29e903fe9c4845a1da2a1c559160fabe31`
- `packages/aurora-ui/src/assistant-composer.tsx`: `b0671465a423d4607e10a5419bc7a79dd16233b93e5c2d7aae53c71ef26c13aa`
- `packages/aurora-ui/src/use-assistant-session-actions.ts`: `a49613decebf42a09f1eacac522773f4aece228b6edd804e89363c3a0027ddbf`
- `packages/aurora-ui/src/use-assistant-history.ts`: `65b1a09d2157a3e4e0043ac5304c7171e33c0b9069a73c58ecfb03fbb07f0630`
- `packages/aurora-ui/src/onboarding-view.tsx`: `03199bd782770350296485b33b9f65c9a5e2363edeb49256fc7e28c06c3e8135`
- `.git/aurora-handoff-import-20261006/c06-current-source-delivery-v1014/native-ui-main-v1060.py`: `e54743a2483d886f7181d4d93cb76271bf0c0f5ada3160718e029c4cb2c41028`
- `.git/aurora-handoff-import-20261006/v1062-native-ui-main-terminal-RESULT.json`: `3037fb8f02e9ced517de18df5b1fd6bdc9e387cec24a1eb700c9772a75da8b8c`
