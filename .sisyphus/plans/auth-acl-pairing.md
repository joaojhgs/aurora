# Gateway Authentication & Peer Pairing Implementation Plan

## 1. Overview
This plan outlines the implementation of a robust, unified Authentication and Authorization system for Aurora. It replaces the current placeholder mechanisms with a database-backed RBAC (Role-Based Access Control) system, secure token management, and a user-friendly "Peer Pairing" protocol for connecting devices.

**Goals:**
-   **Unified Auth**: Secure both HTTP API and WebRTC P2P signaling.
-   **Device-as-a-Peer**: Enable trusted devices to access specific capabilities of other devices.
-   **User-Friendly Pairing**: Simple code-based pairing flow (like Bluetooth/TV pairing) over LAN.

## 2. Database Schema (SQLite)

We will introduce 3 new tables via a new migration file (e.g., `app/services/db/migrations/002_auth_tables.sql`).

### `users`
Represents human owners/admins of the system.
| Column | Type | Notes |
| :--- | :--- | :--- |
| `id` | TEXT (UUID) | PK |
| `username` | TEXT | Unique (e.g., "admin") |
| `password_hash` | TEXT | Argon2/BCrypt hash |
| `role` | TEXT | Default "admin" |
| `created_at` | TIMESTAMP | |

### `devices`
Represents physical devices (Peers) connected to the mesh.
| Column | Type | Notes |
| :--- | :--- | :--- |
| `id` | TEXT (UUID) | PK |
| `user_id` | TEXT (UUID) | FK -> users.id (Owner) |
| `name` | TEXT | Display name (e.g., "Kitchen Pi") |
| `public_key` | TEXT | For future mTLS/E2EE usage |
| `is_trusted` | BOOLEAN | If false, device is pending approval |
| `last_seen` | TIMESTAMP | |

### `tokens`
Long-lived API keys/Tokens for devices and users.
| Column | Type | Notes |
| :--- | :--- | :--- |
| `id` | TEXT (UUID) | PK |
| `device_id` | TEXT (UUID) | FK -> devices.id (nullable) |
| `user_id` | TEXT (UUID) | FK -> users.id (nullable) |
| `token_hash` | TEXT | Hashed version of the token |
| `prefix` | TEXT | First 8 chars for lookup (e.g., "aur_...") |
| `scopes` | TEXT | JSON list of permissions |
| `expires_at` | TIMESTAMP | Null = never expires |
| `created_at` | TIMESTAMP | |

## 3. Roles & Permissions Model

### Roles
-   **`admin`**: Full access to all permissions.
-   **`user`**: Standard access (Speech, Tools, basic Config).
-   **`viewer`**: Read-only access to logs/status.
-   **`device`**: Role assigned to paired peers (customizable per device).

### Permissions (Scopes)
Permissions are mapped 1:1 to the **Method ID** (Bus Topic) of the service method. This ensures consistency across Bus, HTTP, and WebRTC layers.

Examples:
-   `TTS.Request`: Permission to request speech synthesis.
-   `STT.Listen`: Permission to trigger listening.
-   `Config.Get`: Permission to read configuration.
-   `System.Control`: Permission to shutdown/restart.

Wildcards are supported for broader access:
-   `TTS.*`: Access to all TTS methods.
-   `*`: Full admin access.

## 4. Pairing Protocol (HTTP LAN)

This flow allows a new device (Client) to pair with an existing Hub (Host) securely.

1.  **Start Pairing (Host)**:
    -   User clicks "Add Device" on Host UI.
    -   Host calls `POST /api/auth/pairing/start`.
    -   Host generates a 6-digit `code` (e.g., "123456") valid for 5 mins.
    -   Host displays code.

2.  **Connect (Client)**:
    -   User enters `code` on Client device.
    -   Client calls `POST /api/auth/pairing/connect` on Host with `{ code, device_name, public_key }`.
    -   Host validates code. If valid, stores "Pending Pairing Request" in memory.
    -   Host returns `202 Accepted` ("Waiting for approval").

3.  **Approval (Host)**:
    -   Host UI polls `GET /api/auth/pairing/status` (or receives WebSocket event).
    -   User sees "Kitchen Pi wants to connect". Clicks "Approve".
    -   Host calls `POST /api/auth/pairing/approve` with `{ request_id, role }`.
    -   Host creates `Device` entry and generates a long-lived `access_token`.

4.  **Exchange (Client)**:
    -   Client polls `POST /api/auth/pairing/exchange` with `{ request_id }`.
    -   Once approved, Host returns `{ access_token, device_id }`.
    -   Client saves token securely.

## 5. Implementation Plan

### Phase 0: Prerequisites
1.  **Dependencies**:
    -   Update `pyproject.toml` (optional-dependencies.gateway): Add `passlib[argon2]`.
    -   Run `pip install -e .[gateway]`.

### Phase 1: Database & Models
1.  **Migration**: Create `app/services/db/migrations/003_auth_tables.sql` (Note: `002` is taken).
2.  **Models**: Update `app/services/db/models.py` with `User`, `Device`, `Token` dataclasses.
3.  **Manager**: Update `app/services/db/manager.py` with CRUD methods:
    -   `create_user`, `get_user_by_username`
    -   `create_device`, `get_device_by_token`
    -   `create_token`, `revoke_token`

### Phase 2: Auth Service Logic
1.  **Service**: Create `app/services/gateway/auth_service.py` (or within `service.py`).
2.  **Logic**:
    -   Token hashing (Argon2/SHA256).
    -   Pairing session manager (in-memory dictionary for codes/requests).
    -   `authenticate_token(token)` -> `Identity`.
    -   **Bootstrapping**: On startup, check if any users exist. If not, generate a "setup token" and print to log.
    -   **Rate Limiting**: Implement a simple token bucket for pairing endpoints.
3.  **API**: Add `AuthRouter` to `fastapi_app.py`.

### Phase 3: HTTP API Enforcement
1.  **Refactor**: Update `app/services/gateway/auth.py` to use `AuthService` logic instead of current placeholder checks.
2.  **Middleware**: Update `app/services/gateway/fastapi_app.py` to use `Security` dependencies pointing to refactored `auth.py`.
3.  **Route Generator**: Update `RouteGenerator` to read `required_perms` from contracts and inject `Security(check_perms, scopes=[method_id])` into generated routes.
    -   **Critical**: The scope must match the `bus_topic` (Method ID) of the contract (e.g., `TTS.Request`).
4.  **Endpoints**: Implement `/api/auth/*` (Login, Pairing).

### Phase 4: WebRTC Enforcement
1.  **Handshake**: Update `RTCClient` (`app/services/gateway/webrtc/rtc_client.py`).
    -   Modify `_peer_acl` to default to EMPTY (no access).
    -   Implement a mandatory "Auth" message type on the DataChannel.
    -   When Client connects, it must send `{"type": "auth", "token": "..."}` immediately.
2.  **Verification**:
    -   `RTCClient` verifies token against DB (via `AuthService` logic).
    -   If valid, loads permissions into `_peer_acl`.
    -   If invalid/timeout, closes connection.

## 6. API Endpoints

### Management
-   `POST /api/auth/login` (Username/Password -> Token)
-   `POST /api/auth/logout`
-   `GET /api/auth/me`
-   `GET /api/auth/devices` (List paired devices)
-   `DELETE /api/auth/devices/{id}` (Revoke access)

### Pairing
-   `POST /api/auth/pairing/start` -> `{ code, expires_in }`
-   `POST /api/auth/pairing/connect` -> `{ request_id }`
-   `POST /api/auth/pairing/approve` -> `{ success }`
-   `POST /api/auth/pairing/exchange` -> `{ access_token }`

## 7. Testing Strategy
1.  **Unit Tests**:
    -   Test Token generation and hashing.
    -   Test DB CRUD operations for Users/Devices.
    -   Test Pairing State Machine (Start -> Connect -> Approve -> Exchange).
2.  **Integration Tests**:
    -   Simulate the full pairing flow using `httpx` in a test script.
    -   Mock the DB to avoid persistence during unit tests.
    -   Verify `RPCHandler` rejects requests without a valid token.
