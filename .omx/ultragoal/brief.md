Establish documentation taxonomy and maintenance rules by adding docs/DOCS_INDEX.md and docs/DOC_MAINTENANCE.md, with current, partial, historical, and archive status conventions and ownership rules.

Move docs/plans into .omx/plans with clear provenance labeling, and remove docs/plans from the user-facing docs tree without deleting the plan content.

Consolidate dependency-analysis sprawl into docs/DEPENDENCIES.md, extracting durable dependency, uv, service-extra, sidecar-profile, and docker-image guidance, and removing generated or task-journal artifacts from docs.

Update readme.md, docs/ARCHITECTURE.md, docs/TECHSTACK.md, docs/INSTALL.md, docs/CONTRIBUTE.md, docs/TESTING_PROCESS_MODE.md, README.process-mode.md, docs/CI_CD.md, and tests/README.md to reflect the current repo architecture, CI lanes, process-mode topology, and Tauri/SDK/frontend state.

Create docs/FRONTEND_AND_UI_ARCHITECTURE.md and consolidate UI_INTEGRATION, UIBRIDGE_TAURI_MIGRATION, PRODUCTION_UI_CONTRACTS, package-local UI/Tauri READMEs, and Tauri desktop build references around the SDK-first UI model.

Create docs/AUTH_AND_PERMISSIONS.md and docs/API_AND_CONTRACTS.md, consolidating current auth, RBAC, principal, topic-permission, contract-registry, Gateway, and API explanations and updating related links from Gateway, Messaging, and service reference docs.

Create docs/BACKUP_SERVICE.md and docs/FEATURE_MATRIX.md, documenting backup and restore limitations, current feature status, partial features like ambient transcription, and production readiness boundaries.

Clean or archive stale docs and broken references, including handoff and task-report-style docs and outdated monolith or PyQt-only references, while preserving useful historical content in docs/archive or .omx/plans as appropriate.

Add lightweight docs validation tooling and wire it into a practical local or CI check: relative markdown link validation, stale workflow/gate reference scan, no generated reports in docs, and no task-specific PER/QA docs outside archive/provenance locations.

Run final docs validation, stale reference scans, formatting/static checks relevant to changed scripts/config, ai-slop-cleaner, post-cleaner verification, architecture invariant audit, and independent code-reviewer plus architect review before final Codex goal completion.
