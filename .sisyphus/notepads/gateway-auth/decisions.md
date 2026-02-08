# Decisions

- Use `AuthService.authenticate_token` to validate incoming WebRTC "auth" messages.
- Trust only the scopes returned by `AuthService`, not the peer's self-reported roles.
- `RTCClient` will maintain a `_peer_acl` based on the validated token.
- `GatewayService` will manage the lifecycle of `AuthService` and pass it to `RTCClient`.
