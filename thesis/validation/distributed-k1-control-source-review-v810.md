# V810 narrow source closure — APPROVE

2026-10-16 UTC. Both V808 findings are closed in the reviewed source delta; the original REQUEST_CHANGES report remains preserved.

R1: bootstrap now invokes the imported runpy.run_path binding, removing the deterministic pre-request NameError.

R2: receiver_proof now requires Root's independently collected actual_provider_files model/config canonical paths, file hashes matching the frozen receiver provider hashes, and a source-receipt SHA. Every actual CLI start row and every selected per-case start is compared to those admitted paths. The previous comparison against the last loop row is removed. Proof output retains file hashes and the identity evidence digest; no model files are reread and no content is added. README explicitly assigns actual canonicalization/file-hash/source-receipt collection and trust to Root. The helper validates this supplied binding, not the truth/custody of an external receipt by itself; Root must independently authenticate and pin that identity/receipt before use.

Scope remains the private control-source slice, not launch acceptance. Existing controller/config/source/model/env/endpoint/auth and receiver-evidence admission, actual 15 correlated completed warmups, resources/retirement/locks and the eventual measured gate remain Root responsibilities. No endpoint, receiver or distributed runtime is established here. Prior positive source boundaries are reused, not re-audited.

Validation: only the two changed-source diffs, README interface, exact hashes and Python AST parsing without import. No runtime, tests, models, network, archives, service/device/Orca or source edits performed.

Reviewed SHA-256:

- `bootstrap.py`: `05303915a1617a3fbc163017902fa084e687257d7b0af9bc692877d08a6a3b7e`
- `receiver_proof.py`: `aed9bd0f6109f8ab97c8b4eba8c3809bf1d865c9cba05999b52769f2862d857d`
- `README.md`: `f76f067f5ef8cee0c3be7d950cfb3259fb54e569148472fe9d759e3a94826b1a`

## Controller binary resource-write closure — APPROVE

2026-10-16 UTC. The resources stream is opened with xb, and its JSON line is now encoded as UTF-8 bytes before resources.write. This fixes the deterministic first-sample str-to-binary-stream TypeError without altering the sample, flush, resource guard or lifecycle semantics. Exact reviewed controller SHA-256: 66a81f0f32d142a037fc090ba9c201d7600d38e7fd668de7bf4bcdc8e1911a3a. Read/hash/AST only; no imports, runtime or tests. Existing source-only scope and future actual launch/receiver admission limits remain unchanged.
