# V322 retained iOS primary readiness trace

## Result

The retained primary confirms the same bounded failure as its safe summary; it does not reveal a more specific pack-install, picker, credential, or native error. The only relevant voice-main payload is the safe result record at primary line 15230 (no raw credential or user payload copied): `speech_setup` / `speech_readiness` / `speech_readiness_timeout`; readiness was observed and the profile-selected, native-available, and active-STT-match booleans were all false. Chunks/samples were zero; no transcript or assistant answer was produced. The primary is 1,620,750 bytes with SHA-256 `d18c6174263ce2355df9483fb3a7a88cca04bfc06528f01e908290b3d6c089f9`.

The run used failed HEAD `249069e9b12ede417a4b1effb3cc388d5a56db4d`. I compared the current checkout (`5782746afba213f6b36907db2f09f0017625e218`) with that commit for the exact readiness chain. The workflow, CI build/control wrapper, readiness driver, profile/catalog adapter, Swift readiness producer, Settings picker, and Tauri profile updater are byte-identical at the two revisions. The current failure therefore exercises the same relevant source logic as the current checkout; this rules out a recent edit to those files as the explanation. It still does not bind the run to an app/native-library binary hash.

## Source path and why the result is meaningful

The maintained iOS workflow runs this gate only when `native_voice_main_flow` is true. Its wrapper builds a dedicated debug `aarch64-sim` app with the voice-test configuration, installs and launches it on a booted simulator, starts the owned Gateway helper, and invokes the existing native flow with the selected app path and simulator ID.

The existing driver filters the iOS speech catalog for an acknowledged, compatible STT pack with a valid digest/revision. If the owned profile does not already select it, the driver uses the Settings transcription picker. The Settings path persists the selected profile and, for a mesh-node local-speech selection, activates the corresponding native packs before writing the updated profile. The driver then waits for three independent conditions: selected STT is present in the profile, native speech is available, and the active native STT slot equals the chosen STT pack. Each failed condition remains fatal.

The Swift manager reports `available` only when its configured runtime connectivity probe succeeds and at least one active pack is ready. Its status supplies the active slot map used by the TypeScript adapter. Therefore the three false booleans are actionable gate inputs: the selected profile value did not match the chosen STT, native readiness was unavailable, and no matching active STT slot was reported. But the report does not say whether the Settings callback ran, whether profile persistence failed, whether pack activation failed, or whether the manager's connectivity/pack-ready aggregate caused `available=false`. No one source repair follows from this evidence alone.

## Exact source comparison

The following SHA-256 values are identical at failed HEAD and current checkout:

- `.github/workflows/tauri-ios.yml` — `9ddc4a2dc36a63d9e0face26a1edaa25a91fc4d6f31e00addd4c250062485a00`
- `apps/aurora-tauri/scripts/ios-voice-main-flow-ci.mjs` — `235f5021762fc4b32118a26f70e6b032ca91ca950ae46ee15bf044263d10ec3e`
- `apps/aurora-tauri/src/ios-voice-main-flow.ts` — `4503c34468cd9d4a09eb2cc93d50094af0d6d3574a4850457e05d872e02a20db`
- `apps/aurora-tauri/src/native-speech-catalog.ts` — `5b2e996b71cb7856256572fc8f11ced837236d9cf1c0ce73b567c449ebb7777c`
- `apps/aurora-tauri/src-tauri/ios/AuroraNativePlugin/Sources/AuroraNativePlugin/AuroraIOSVoicePackManager.swift` — `e407f158b6de35337dc1cd09b162cb539e86ded620d927a2a0b024225894ca27`
- `packages/aurora-ui/src/voice-settings-view.tsx` — `2d29ffa774d332186eb51c05497dc5a97c12e9ae297cc1847cd6da1fd79b300d`
- `packages/aurora-ui/src/voice-settings-local-speech-model.ts` — `b4a5447ae7b5f6efe318e18d36b7256f4ec85cc01bf51376e36f10d7d3e905a8`
- `apps/aurora-tauri/src/tauri-app.tsx` — `b35e25338879a7499dc6b6cc433e155c65ce8243890c857856905b1a0ec53d78`
- `apps/aurora-tauri/src/aurora-client.ts` — `f315ffc77530a460a73789f707f83c29e903fe9c4845a1da2a1c559160fabe31`

The primary does not contain a safe per-step event for whether picker selection, activation, or profile persistence ran, and the safe result omits the built `.app` and native-library digests. That is the precise remaining attribution gap. Keep the run classified as a genuine readiness failure with cause unknown; do not infer a pack/network defect or relax readiness. This inspection performed no builds, tests, CI/device/network actions, or source edits.
