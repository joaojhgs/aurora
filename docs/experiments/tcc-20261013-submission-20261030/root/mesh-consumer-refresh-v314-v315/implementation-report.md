# V314 authenticated-consumer refresh candidate

V312 fixed refresh catch-up for generation changes while a refresh is active. This follow-up adds the missing recipient source: `_peer_registry.get_negotiated_peers()` describes peers with negotiated incoming provider state, so an authenticated consumer that has no inbound provider manifest is not necessarily in that list. Registry invalidation therefore failed to reannounce the local provider manifest to that active consumer.

The candidate retains every negotiated peer target and adds stable peers from `_stable_peer_sessions` only when `_can_reannounce_manifest_for_peer` confirms the existing mesh, registry, authenticated stable identity, active session, and send-function conditions. It does not infer authorization from the session map. Existing generation catch-up and task cleanup from V312 remain present in the candidate snapshot.

One lifecycle regression uses the existing identity helper and actual `_has_authenticated_stable_peer` / `_is_peer_session_active` checks, while the negotiated-peer list is empty. It requires the authenticated active recipient to be reannounced and the task map to be cleaned up.

This patch is a delta on the V312 private candidate, whose canonical-origin baseline was `rtc_client.py` SHA256 `e7614c0725cc5e0dfe9d08a7c3b60c6d1dc66dc4450029df9d05b4efd9f293d0` and lifecycle test SHA256 `5b5604dcb2d29a5e4293052ce754e681c4828b3f26ecfec1d5a39e9a8ce6e0df`. Exact V314 delta bases: `rtc_client.py` SHA256 `ecc207cd7a164959e2bec0aa1e0dcd90af7e3790c8eed418563c610e64dcbd40`; test SHA256 `f165e5b7c7ec8d93681e01803390c1bdeda51bd14913da5abbc8ae0456369d0d`.

V314 candidate SHA256s: `rtc_client.py` `d3a5ee5e02c976839d221ba7a4996a30f074b42a53fc25530b987879e7dc58b7`; lifecycle test `a9dfed7df2411d7434df10c17826ea2a9f69964819e0f5a4db48505641079664`.

Patch: `candidate.patch`, SHA256 `b2b4ef775d1f59b16dfe9b3d92d571271802d2798e92adb263f11dee65238900`.

No tests or executable validation were run. After integrating the V312 delta followed by this delta, Root's focused selector is `pytest tests/unit/gateway/test_rtc_client_lifecycle.py -k 'registry_invalidation_during_refresh_runs_latest_trailing_refresh or registry_invalidation_refreshes_authenticated_peer_without_inbound_manifest'`.
