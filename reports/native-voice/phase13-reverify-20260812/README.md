# Phase 13 release-gate disposition

Recorded: 2026-08-12T03:56:15Z

Verdict: **static release gates verified; release remains PARTIAL/BLOCKED**.

At current source `e07612f0208a3ae22705d32b90a4cabfc0c18318`, the
release workflow generates a dependency inventory before the trust decision,
uploads both reports even when they fail closed, and binds trust to the exact
current commit and inventory inputs. All 676 npm entries carry exact SHA-512
lockfile digests. Focused release-policy tests, static rollback checks, the
artifact-scanner fixture, documentation validation, Python contracts, and the
locked Rust workspace passed their bounded checks.

The live inventory and trust checks correctly blocked release. The inventory
contains 1,845 entries, of which 224 have unresolved licenses and 242 have a
blocked disposition; the current working tree also contains a user-owned
change to the root `package.json`. Updater placeholders, absent Android/iOS
release artifacts, missing signing/store evidence, runtime rollback, platform
devices, and external legal/security review remain open. Static rollback
reports `runtimeProof: false`.

This receipt is not a signed-release, store, physical-device, runtime rollback,
security-approval, production-pack, or rollout claim. RAC-54 and RAC-56 remain
partial. Production VAD, KWS, STT, and TTS remain false, and no status is
promoted by this receipt.

`summary.json` is the machine-readable disposition. `checksums.sha256` binds
the plan, Phase 12 receipt, release policy sources and tests, and this receipt.
