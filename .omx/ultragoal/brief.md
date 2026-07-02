Fix all production UI audit gaps from the latest ultrawork report on branch feat/ui-multi-platform-integration.

Scope:
1. Web auth/session: onboarding tokens/session state must actually authorize browser Gateway transport calls without persisting secrets in browser storage. Add regression coverage for the previous false-authenticated state.
2. AdminAction security: remove hardcoded reauthConfirmed:true from admin/native-sensitive UI actions. Require an explicit in-session admin confirmation/unlock path or reasoned AdminAction gate and add tests proving actions cannot silently submit without confirmation.
3. Assistant UX: make chat/composer the primary first-viewport task while preserving route/privacy/tool/voice evidence. Add screenshot/route assertions so the composer remains visible.
4. Platform/admin truthfulness: fix admin overview desktop-thin/tauri-local mode labels and availability semantics with tests.
5. Contracts route distinctness: make /admin/contracts a dedicated contracts registry route, not merely the services page, with route-specific tests/oracles.
6. Layout/mobile/E2E coverage: reduce shell crowding for dense pages, add/adjust web/mobile route evidence and route-specific control assertions where practical.
7. Minor integration gaps: align /settings/native oracle/copy, stabilize browser client identity, clarify partial/disabled voice/model/token/plugin capabilities as truthful production states.

Constraints:
- Preserve Aurora architecture: UI talks through SDK/Gateway/Tauri boundary only; Python services through bus/contracts; Admin mutations use AdminAction; no secrets/tokens/raw audio in logs.
- No placeholder/debug-dashboard UI may return.
- Use existing patterns and dependencies; keep changes reviewable.
- Verify with targeted UI/web/tauri tests, typecheck, route screenshots, ai-slop-cleaner/no-op or changed-file pass, independent code-reviewer and architect final evidence.
