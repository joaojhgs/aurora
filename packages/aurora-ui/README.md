# @aurora/ui

Production React shell primitives for Aurora. Components consume normalized SDK state only; they do not call Gateway, Tauri IPC, Python services, or raw WebRTC APIs directly.

This package intentionally keeps domain pages as capability-gated state surfaces until the downstream `UIA-*`, `ADM-*`, and `MESH-*` tasks wire each workflow.
## Canonical docs

- [Frontend and UI architecture](../../docs/FRONTEND_AND_UI_ARCHITECTURE.md)
- [Production UI contracts](../../docs/PRODUCTION_UI_CONTRACTS.md)
- [Accessibility/responsive/visual tests](../../docs/ACCESSIBILITY_RESPONSIVE_VISUAL_TESTS.md)
