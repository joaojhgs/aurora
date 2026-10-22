# V312 generation-aware provider refresh candidate

The registry invalidation callback can run again while a peer's existing refresh task is awaiting tombstone delivery or manifest reannouncement. The scheduler correctly coalesces overlapping tasks, but the task previously performed only one refresh, so the later generation change could be left without a final reannouncement.

The private candidate loops one peer refresh until both the global provider-export generation and that peer's generation remain unchanged across unavailable-drain and reannouncement awaits. It preserves the existing task map and `finally` cleanup. The focused regression blocks the first reannouncement, triggers a second registry invalidation, releases the first call, then requires a trailing reannouncement and an empty task map.

Owned candidate files:

- `rtc_client.py` baseline SHA256 `e7614c0725cc5e0dfe9d08a7c3b60c6d1dc66dc4450029df9d05b4efd9f293d0`; candidate SHA256 `ecc207cd7a164959e2bec0aa1e0dcd90af7e3790c8eed418563c610e64dcbd40`.
- `test_rtc_client_lifecycle.py` baseline SHA256 `5b5604dcb2d29a5e4293052ce754e681c4828b3f26ecfec1d5a39e9a8ce6e0df`; candidate SHA256 `f165e5b7c7ec8d93681e01803390c1bdeda51bd14913da5abbc8ae0456369d0d`.

Patch: `candidate.patch`, SHA256 `3fa0d59956ea98adae23ca6fcf815a0a2c1624f4287be715a02978d4e61f0c0b`.

No tests or executable validation were run. Root's targeted follow-up is `pytest tests/unit/gateway/test_rtc_client_lifecycle.py -k registry_invalidation_during_refresh_runs_latest_trailing_refresh` after integration.
