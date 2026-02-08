# Decisions - Refactor Gateway Auth

## Architecture
- Use FastAPI dependency injection for `AuthService`.
- Map `scopes` from token to required permissions.
- Support "admin" role or "*" scope for root access.
