# Existing custom harness inventory for thesis migration (V756)

Read-only, bounded inventory. Scope is limited to the five named harness families and their small source/admission files. No archives, model binaries, raw case records, logs, or credential values were read. Hashes below identify files currently present in this coding-worker checkout unless explicitly labeled “report-only.” This inventory does not claim migration, portability, or reproducibility.

## Migration-index coverage

`thesis/inventory/migration-index-v734.json` is 14,252 bytes, SHA-256 `f4d741e8954ab56ebbd50dacc70915936ac1c475cb29bd4cfa2ee97449f0a152`; it declares schema `aurora.thesis-migration-index.v1`, 19 entries, and `inventoryComplete=false`. Its entries cover V732 padded CPU sources, V689/V719 LocalBus preparation and two production-source sentinels. The only HTTP-related entry is `.git/aurora-handoff-import-20261006/http-full-audio-v497/source` with no byte/hash pin and an instruction to keep production source in normal locations. It does **not** inventory the V485/V497 custom controllers, V692 condition harness, V745 segmented runner/controller, or V704 browser driver/controller. The V745 post-terminal finalizer exists under `thesis/harness/desktop-local-v745/`, but it is not a complete runner/controller migration.

Current Root routing confirms the package is partial and full source/license/fixture inventory and custody remain open (`docs/experiments/tcc-20261013-submission-20261030/root/CURRENT.md:53`). Current conditions and product scope are separately summarized in that file; this report does not inspect their raw archives.

## Family inventory

### Original desktop LocalBus V485 / private V481 harness lineage

Current local source copies under `.git/aurora-handoff-import-20261006/audio-candidate-v481/`:

| File | Bytes | SHA-256 | Role / reader |
|---|---:|---|---|
| `pilot.py` | 21,602 | `7079b8fb2f3e74815fb0d7e1a26823270b05b0dbb8ea418437b979e4149e676d` | Full LocalBus STT→Assistant→TTS caller; `bootstrap.py` dispatches to this pilot in the personal desktop checkout. |
| `controller.py` | 9,502 | `975c64f83237ff2639a5d943f8af61b863533161b394ab5065dfb5aa66ef2bb0` | Owns the pilot process and injects observer/output paths. **Contains private fixture key/token literals; values intentionally withheld.** Do not copy its body into a public thesis package. |
| `bootstrap.py` | 840 | `31dc5ca950bf07ff21a066dd0dc522dc5c35608ad6cedc9edfd845b62f2ddc94` | Installs voice observer and `runpy` dispatches the fixed pilot path `/home/developer/projects/aurora/.git/aurora-audio-candidate-v481/pilot.py`. |
| `bindings.py` | 3,230 | `52182f956b34788ecbfbbb241c8243ff88baebe2874e3605791793777ed0dc91` | Provider bindings used by the candidate. |
| `freeze.py` | 10,062 | `87abee01557a3208a018bd04e1c3aed483244c91497eb0c2cafec57034d23181` | Frozen-input/manifest preparation helper. |
| `prepare.py` | 44,048 | `28c11e0870ce8fef820a6df5552d4f3fe46e22f1fabb531cf7541c8a48911882` | Local preparation and pinning helper. |

The candidate’s `REPORT.md` says the desktop exporter expects a separate personal path, `/home/developer/projects/aurora/.git/aurora-audio-candidate-v481`, and that path is absent from this worker checkout; it therefore does not claim local export or runtime custody (`.git/.../audio-candidate-v481/REPORT.md:3-7`). The frozen manifest and candidate inputs are not present in this local candidate directory. The pilot references `aurora_voice_telemetry_v430` and an observer at `/tmp/aurora-root-voice-primary-v426/telemetry-v436/hook/observer.py`; that observer path is absent here. The telemetry source is present at `.git/aurora-handoff-import-20261006/production-voice-telemetry-v434/aurora_voice_telemetry_v430.py` (11,584 bytes; SHA-256 `8129ffe7591a47a0107ede53b101aead9fc1f58b92f0c0c4203176cc7608325d`).

The V485 outcome report records the actual run’s frozen manifest SHA `d34d21d1a9b1a2db03be2ad64c096e77082168b3bcc09c28d442b4a61eaff3d7`, 900 measured requests plus 15 excluded warmups, and a desktop-only raw archive (`desktop-gpu-full-audio-local900-v485/REPORT.md:3-23`). That report/archive identity is not yet joined here to hashes for every local candidate source copy; preserve the actual frozen manifest as the authority for that mapping.

### Original authenticated HTTP V497 / V493 runner

Current local preparation sources under `.git/aurora-handoff-import-20261006/http-full-audio-v497/` and its declared runner dependency:

| File | Bytes | SHA-256 | Role / reader |
|---|---:|---|---|
| `controller.py` | 21,489 | `a2337af9265073aaf1353b6c990e8bbd52457bc02e65fc1d056b0b9fd1eb5b8b` | Pins input/source/hook and launches bootstrap. Local source uses the existing authenticated fixture environment; no fixture key value is reproduced here. |
| `bootstrap.py` | 1,443 | `7a3b4434d9cfaa3ea0ba157e6363c331895c1d40140d8062f136c97204a0cf00` | Installs the telemetry hook and `runpy` dispatches to the V493 runner. |
| `prepare-inputs.py` | 19,662 | `e50459a8a245dc774d7ebb0df21705c94f6992d7c1a81862bd5994776001c8b3` | Declared source/input/hook preparer. It reads V481 bindings, the V430 telemetry source, and an observer at `/tmp/aurora-root-voice-primary-v426/telemetry-v436/hook/observer.py`; that observer is absent in this checkout. |
| `http-full-audio-v493/runner.py` | 52,055 | `43cc4f3152f1675e14641fedcc30a4071f1185ce8ae7edfd211271bc0fbffd51` | Fixed HTTP request sequence, called by V497 bootstrap. |
| `STATIC-ADMISSION.json` | 703 | `f450857712529cab7d1e6b7b516fd9faf0ef9f1c10a9310d331054ff6abf75a6` | Static preparation admission metadata; not the actual frozen condition manifest. |
| `README.md` | 7,592 | `a05202663a1b63437cf8368eb49f0861bc034c99033cad7f16a60a0316b52080` | Documents exact fixed roots, external V493 runner, hook files, and required private frozen inputs. |
| `PREPARE.md` | 5,273 | `8906e3beb870265938ea1721e93f6b17b8ea6e1b94b956420000964ab983162f` | Source-only handoff instructions. |

The local V497 preparation directory has no `hook/` or `frozen-manifest.json`. Its README says the rich manifest, hook copy, three-key input, launch config, source snapshot, environment and existing gateway-key binding are unprovided placeholders, and the candidate itself has not been executed (`README.md:29-39`; `PREPARE.md:3`). The actual V497 result report records frozen manifest SHA `886d2fade5b14da2fccf272d272c6164479a86e81371ad1afdb738b7d0de1eea`, matched weights/settings, and 900 measured plus 15 warmups (`desktop-gpu-full-audio-http900-v497/REPORT.md:26-32`), but the present migration index does not map that run manifest to all current V497 candidate files.

### Padded authenticated HTTP V692

The current retained result is `docs/experiments/tcc-20261013-submission-20261030/root/desktop-gpu-padded-http900-v692/REPORT.md`. It records the condition-specific frozen manifest SHA `81c25bd59323b1d515d20f9ea154868640e0f0d55b04cb39e77e88fb414aa78f`, padded input hash, result/metrics, and references an archive manifest and saved ZIP (`REPORT.md:35-47`). The report is an outcome/custody summary, not the exact source inventory. This bounded worker-local lookup found no V692-named controller/runner/frozen-manifest source directory, and the migration index has no V692 harness entries. The raw ZIP was intentionally not opened, so actual controller/runner/hook file names, byte counts, hashes, and fixture-literal status remain **unknown here**. Do not infer V497 source identity solely from the similar HTTP route.

`thesis/analysis/native_span_metrics.py` is a retained post-run analyzer referenced by the V692 report, not the request runner/controller. The V692 archive and native case data were not inspected.

### Segmented padded desktop LocalBus V745

`desktop-gpu-padded-local900-v745/REPORT.md:5-13` records a 626-request continuation of the same 900-attempt condition, separate from the original 274 outcomes. It gives the condition manifest SHA `31dea74bf4587e7bef60c44ef28c2b3f7a2da73a69891df27bc318b9819d505d` (149,858 bytes), controller SHA `86579a6ad37a7e372c365db9c92fb871f5613b7ff0ce387ce8e91d7f078415ca`, and runner SHA `34401b281b69f981be95da513bf56e2ee134654802af56a70e4d2f651fb995ab`. The reported raw root is `/tmp/aurora-root-padded-local900-v745`; those controller/runner files are not present under the correspondingly named worker handoff path. Their byte counts and fixture-literal status cannot be verified from this checkout without retrieving the exact source snapshot.

The only corresponding canonical source found is `thesis/harness/desktop-local-v745/post_terminal.py` (17,823 bytes; SHA-256 `e8cd114aaac7521d6332d9d67c126a99efcb50023e2579d3498eb576060178b8`), a post-terminal segment finalizer, not the main execution controller or runner. The V745 report says V735’s outside-SUT collector repair is the only code delta and that the runner, production sources and conditions stayed pinned (`REPORT.md:7-11`). Main V745 harness custody is therefore incomplete in the canonical thesis index; preserve the original V735/V745 source and segment relationship rather than treating the finalizer as a complete harness.

### Browser UI prep V704

Source preparation exists in `.git/aurora-handoff-import-20261006/browser900-prep-v704/` and `.git/aurora-handoff-import-20261006/browser900-runtime-prep-v704/`. The current source report gives the exact driver/controller/gate pins and says this is source-ready only, not launched (`browser900-source-preparation-v713/REPORT.md:7-21`).

| File | Bytes | SHA-256 | Role / reader |
|---|---:|---|---|
| `browser900-prep-v704/voice-flow.mjs` | 53,996 | `f1a9f9cf71dc4d2a775f657cd5b1cb9193800ba75d7e0e8fda3cdcfc4cddc456` | Normal browser UI/audio driver; Root controller launches it. |
| `browser900-prep-v704/admission.json` | 3,384 | `70c60168939934afc872b7096ac9c50ca0ae1f3aaefdb15ad35a6a97bb352224` | Source/admission pin, not a runtime frozen manifest. |
| `browser900-prep-v704/PREP.md` | 10,459 | `c9a151aa28043621d8c9dc78c26d396c48dfd9cf66786c850e91c48a6a96aa94` | Driver contract and unexecuted launch instructions. |
| `browser900-runtime-prep-v704/controller.py` | 28,383 | `bc0b3f8d136de611a2a4ae78f9d2edef1d654cd3173a196974297a1109c78ec1` | Owns setup/launch and later invokes driver; fixture is supplied through a file, not embedded literal in this controller. |
| `browser900-runtime-prep-v704/bootstrap.py` | 2,219 | `9920c1d8ddc358d7e28a19b4c2ace882552f5a1ac39a14e933467521017dbec9` | Loads pinned source and observer, then production `main.py`. |
| `browser900-runtime-prep-v704/gate.py` | 6,853 | `cd5f7b4897bbc5181906031c51c1cabce93f957c253a59e86ee324df358ec44a` | Requires actual warmup/native/provider readiness before measured flow. |
| `browser900-runtime-prep-v704/resource-admission.json` | 3,231 | `5f80f64dc53b384a56eccbbc97c2e15f8acb2b0a52b232cafd5861c11162c8f9` | Source-time resource admission data. |
| `browser900-runtime-prep-v704/CONTROLLER-PREP.json` | 1,777 | `3c8685c1cf6044e5eb7fc1e4132a882e7e89b521fb4b4f25c9d3ac0aa6fb817e` | Controller preparation metadata. |
| `browser900-runtime-prep-v704/expected-provider-identity.json` | 735 | `6a73785e32a79c0d82296e7f05e2f9a44d2a727bfc73cb99f15ddbcde5d34f77` | Expected provider identity, not proof of measured runtime identity. |
| `browser900-runtime-prep-v704/hook/bindings.py` | 3,596 | `d4a2ee4b9419b3be9713c55c5ffbdb3cdf29847f7a4be44e22ae64458d2471e0` | Binding hook. |
| `browser900-runtime-prep-v704/hook/observer.py` | 12,656 | `ce614d6e00bfd425a966eb3165f8b75e3269b956ef288c15f0cf31fd96e4e51a` | Observer hook. |
| `browser900-runtime-prep-v704/hook/aurora_voice_telemetry_v430.py` | 15,228 | `cce47c11775101194cff6eb8fded2140bfba84a41a6dc39dca33efa8a7d5df98` | Voice telemetry hook. |

The exact frozen runtime manifest is absent from both local V704 preparation directories; V704 remains unlaunched/source-ready. Its expected fixture is an external private file. No test case, fixture, browser profile, or runtime record was read.

## Readers, portability and exact gaps

- **Readers:** V485 `controller.py` → `bootstrap.py` → fixed-path `pilot.py`, with external observer/telemetry hooks; V497 `controller.py` → `bootstrap.py` → `http-full-audio-v493/runner.py`, after a preparer constructs hook/source/input roots; V704 Root controller → bootstrap/normal `main.py` plus the separate Node `voice-flow.mjs`, with the warmup gate. V692 and V745 reader relationships are only as named in their outcome reports; their complete controller/runner source is not available in this checkout for a safe exact join.
- **Fixture literals:** V485 candidate controller has private fixture key/token literals (withheld). V497 local candidate controller has no embedded fixture value observed; it requires an existing authenticated environment binding. V704 controller receives an explicit private fixture-file path and no embedded value was identified. V692 and V745 actual controller bodies are unavailable here, so literal status is unknown; do not infer from their sibling families.
- **Manifests:** V485’s frozen manifest is represented by a hash in its report but absent from the local candidate; V497’s actual rich run manifest is likewise reported by hash while the prep directory has only static admission and placeholder inputs; V692 has a reported condition manifest and archive-manifest reference, but the manifest body was not opened; V745 reports manifest hash/bytes but its body/source is absent locally; V704 has source/admission metadata but no actual frozen runtime manifest because no condition was launched.
- **Portable migration gap:** current paths are `.git` handoff/private roots, a personal-desktop absolute `.git` runner path, `/tmp` observer/runtime paths, and one private fixture-bearing controller. Canonical migration needs an exact versioned source/harness manifest and safe custody plan per family, explicit external dependency pins (runner, hooks, source, fixture binding), and non-secret provenance for withheld fixture material. V745 also needs both segment source identities and its post-terminal finalizer kept distinct. Do not copy secrets, source-dump fixture values, or large raw archives merely to fill this inventory.

No source was moved or modified, and no claim is made that any source-ready family was launched or that private handoff copies equal the actual historical runner without frozen-manifest verification.
