"""DB (Database) service contract models."""

from typing import Any

from pydantic import Field

from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.registry import IOModel


# Module identifier
class DBModule:
    """Module identifier for DB service."""

    NAME = "DB"


# Method identifiers
class DBMethods:
    """Full method identifiers for DB service."""

    SAVE_MESSAGE = f"{DBModule.NAME}.SaveMessage"
    GET_MESSAGES = f"{DBModule.NAME}.GetMessages"
    GET_MESSAGES_FOR_DATE = f"{DBModule.NAME}.GetMessagesForDate"
    DELETE_MESSAGE = f"{DBModule.NAME}.DeleteMessage"
    UPDATE_MESSAGE = f"{DBModule.NAME}.UpdateMessage"
    RAG_SEARCH = f"{DBModule.NAME}.RAGSearch"
    RAG_STORE = f"{DBModule.NAME}.RAGStore"
    RAG_DELETE = f"{DBModule.NAME}.RAGDelete"
    RAG_GET = f"{DBModule.NAME}.RAGGet"
    RAG_LIST = f"{DBModule.NAME}.RAGList"
    RAG_EXPORT_NAMESPACE = f"{DBModule.NAME}.RAGExportNamespace"
    RAG_IMPORT_NAMESPACE = f"{DBModule.NAME}.RAGImportNamespace"
    RAG_LIST_CHANGES = f"{DBModule.NAME}.RAGListChanges"
    SAVE_CRON_JOB = f"{DBModule.NAME}.SaveCronJob"
    GET_CRON_JOBS = f"{DBModule.NAME}.GetCronJobs"
    DELETE_CRON_JOB = f"{DBModule.NAME}.DeleteCronJob"
    HEALTH_CHECK = f"{DBModule.NAME}.HealthCheck"

    # ── Auth-related entity CRUD ─────────────────────────────────────
    CREATE_USER = f"{DBModule.NAME}.CreateUser"
    GET_USER_BY_USERNAME = f"{DBModule.NAME}.GetUserByUsername"
    GET_USER_BY_ID = f"{DBModule.NAME}.GetUserById"
    COUNT_USERS = f"{DBModule.NAME}.CountUsers"
    LIST_USERS = f"{DBModule.NAME}.ListUsers"
    UPDATE_USER = f"{DBModule.NAME}.UpdateUser"
    DELETE_USER = f"{DBModule.NAME}.DeleteUser"

    CREATE_DEVICE = f"{DBModule.NAME}.CreateDevice"
    GET_DEVICE_BY_ID = f"{DBModule.NAME}.GetDeviceById"
    LIST_DEVICES = f"{DBModule.NAME}.ListDevices"
    DELETE_DEVICE = f"{DBModule.NAME}.DeleteDevice"

    CREATE_TOKEN = f"{DBModule.NAME}.CreateToken"
    GET_TOKEN_BY_HASH = f"{DBModule.NAME}.GetTokenByHash"
    GET_TOKEN_BY_ID = f"{DBModule.NAME}.GetTokenById"
    LIST_TOKENS = f"{DBModule.NAME}.ListTokens"
    UPDATE_TOKEN_SCOPES = f"{DBModule.NAME}.UpdateTokenScopes"
    REVOKE_TOKEN = f"{DBModule.NAME}.RevokeToken"

    GET_AUDIT_LOG = f"{DBModule.NAME}.GetAuditLog"
    COUNT_AUDIT_EVENTS = f"{DBModule.NAME}.CountAuditEvents"

    SAVE_MESH_CREDENTIAL = f"{DBModule.NAME}.SaveMeshCredential"
    GET_MESH_CREDENTIAL_BY_ROOM = f"{DBModule.NAME}.GetMeshCredentialByRoom"
    DELETE_MESH_CREDENTIAL = f"{DBModule.NAME}.DeleteMeshCredential"

    # ── Generic SQL execution (internal only) ────────────────────────
    EXECUTE_SQL = f"{DBModule.NAME}.ExecuteSQL"


class DBSaveMessageRequest(IOModel):
    """Request to save a message to the database."""

    content: str
    role: str
    message_type: str = "TEXT"
    metadata: dict[str, Any] | None = None


class DBSaveMessageResponse(IOModel):
    """Response after saving a message."""

    message_id: int
    success: bool = True


class DBGetMessagesRequest(IOModel):
    """Request to retrieve messages from the database."""

    limit: int = 50
    offset: int = 0
    role: str | None = None
    message_type: str | None = None
    mesh_selector: MeshAddressSelector | None = None


class DBGetMessagesResponse(IOModel):
    """Response with retrieved messages."""

    messages: list[dict[str, Any]]
    total: int
    has_more: bool


class DBGetMessagesForDateRequest(IOModel):
    """Request to retrieve messages for a specific date."""

    date: str | None = None  # ISO format YYYY-MM-DD


class DBCronJob(IOModel):
    """Cron job model."""

    id: str | None = None
    name: str
    schedule: str
    action: str
    enabled: bool = True


class DBStoreCronJobRequest(IOModel):
    """Request to store a cron job."""

    name: str
    schedule: str
    action: str
    enabled: bool = True


class DBGetCronJobsRequest(IOModel):
    """Request to get cron jobs."""

    enabled_only: bool = False


class DBGetCronJobsResponse(IOModel):
    """Response with cron jobs."""

    jobs: list[dict[str, Any]]


class DBDeleteCronJobRequest(IOModel):
    """Request to delete a cron job."""

    job_id: str


class DBRAGStoreRequest(IOModel):
    """Request to store an item in RAG."""

    namespace: str
    key: str
    value: Any
    index: bool = True
    mesh_selector: MeshAddressSelector | None = None


class DBRAGDeleteRequest(IOModel):
    """Request to delete an item from RAG."""

    namespace: str
    key: str
    mesh_selector: MeshAddressSelector | None = None


class DBRAGSearchRequest(IOModel):
    """Request to search RAG."""

    namespace: str
    query: str
    limit: int = 10
    offset: int = 0
    mesh_selector: MeshAddressSelector | None = None


class DBRAGGetRequest(IOModel):
    """Request to get a specific RAG item."""

    namespace: str
    key: str
    mesh_selector: MeshAddressSelector | None = None


class DBRAGListRequest(IOModel):
    """Request to list RAG items."""

    namespace: str
    limit: int = 100
    offset: int = 0
    mesh_selector: MeshAddressSelector | None = None


class DBRAGItemResponse(IOModel):
    """RAG item response."""

    key: str
    value: Any
    namespace: str
    search_score: float | None = None


class DBRAGListResponse(IOModel):
    """Response for RAG list/search."""

    items: list[DBRAGItemResponse]


class DBRAGTombstone(IOModel):
    """Deletion marker for replicated RAG data."""

    deleted_at: str
    deleted_by: str
    reason: str = "user_delete"


class DBRAGReplicatedItem(IOModel):
    """RAG item with replication provenance and conflict metadata."""

    namespace: str
    key: str
    value: Any | None = None
    source_peer_id: str
    owner_peer_id: str
    origin_principal_id: str = "unknown"
    created_at: str
    updated_at: str
    schema_version: int = 1
    version: int = 1
    policy_decision_id: str
    correlation_id: str
    sync_operation_id: str
    visibility: str = "private"
    encrypted: bool = False
    redacted: bool = False
    tombstone: DBRAGTombstone | None = None


class DBRAGExportNamespaceRequest(IOModel):
    """Request to export an opt-in RAG namespace snapshot."""

    namespace: str
    source_peer_id: str
    owner_peer_id: str
    origin_principal_id: str = "unknown"
    policy_decision_id: str
    correlation_id: str
    sync_operation_id: str
    limit: int = 100
    offset: int = 0
    include_tombstones: bool = True


class DBRAGSnapshotResponse(IOModel):
    """Namespace-scoped RAG replication snapshot."""

    namespace: str
    owner_peer_id: str
    source_peer_id: str
    schema_version: int = 1
    items: list[DBRAGReplicatedItem]


class DBRAGImportNamespaceRequest(IOModel):
    """Request to import a bounded RAG namespace snapshot."""

    namespace: str
    importing_peer_id: str
    policy_decision_id: str
    correlation_id: str
    sync_operation_id: str
    items: list[DBRAGReplicatedItem]
    conflict_mode: str = "last_writer_wins"


class DBRAGImportNamespaceResponse(IOModel):
    """Result of importing RAG replication items."""

    imported: int = 0
    updated: int = 0
    skipped: int = 0
    tombstoned: int = 0
    conflicts: list[dict[str, Any]] = Field(default_factory=list)


class DBRAGListChangesRequest(IOModel):
    """Request to list namespace-scoped RAG replication changes."""

    namespace: str
    source_peer_id: str
    owner_peer_id: str
    origin_principal_id: str = "unknown"
    policy_decision_id: str
    correlation_id: str
    sync_operation_id: str
    since: str | None = None
    limit: int = 100
    offset: int = 0
    include_tombstones: bool = True


# ── Shared response types ────────────────────────────────────────────────


class DBBoolResponse(IOModel):
    """Generic boolean success response."""

    success: bool = True


class DBCountResponse(IOModel):
    """Generic count response."""

    count: int = 0


# ── User CRUD ────────────────────────────────────────────────────────────


class DBCreateUserRequest(IOModel):
    """Request to create a user."""

    id: str
    username: str
    password_hash: str
    role: str = "user"
    permissions: list[str] | None = None
    is_admin: bool = False
    created_at: str | None = None


class DBGetUserByUsernameRequest(IOModel):
    """Request to get a user by username."""

    username: str


class DBGetUserByIdRequest(IOModel):
    """Request to get a user by ID."""

    user_id: str


class DBCountUsersRequest(IOModel):
    """Request to count users."""

    pass


class DBListUsersRequest(IOModel):
    """Request to list all users."""

    pass


class DBUpdateUserRequest(IOModel):
    """Request to update a user's fields."""

    user_id: str
    fields: dict[str, Any]


class DBDeleteUserRequest(IOModel):
    """Request to delete a user."""

    user_id: str


class DBUserResponse(IOModel):
    """Response containing a single user (as dict), or None."""

    user: dict[str, Any] | None = None


class DBUserListResponse(IOModel):
    """Response containing a list of users."""

    users: list[dict[str, Any]]


# ── Device CRUD ──────────────────────────────────────────────────────────


class DBCreateDeviceRequest(IOModel):
    """Request to create a device."""

    id: str
    user_id: str
    name: str
    public_key: str | None = None
    is_trusted: bool = False
    created_at: str | None = None


class DBGetDeviceByIdRequest(IOModel):
    """Request to get a device by ID."""

    device_id: str


class DBListDevicesRequest(IOModel):
    """Request to list devices, optionally filtered by user."""

    user_id: str | None = None


class DBDeleteDeviceRequest(IOModel):
    """Request to delete a device."""

    device_id: str


class DBDeviceResponse(IOModel):
    """Response containing a single device (as dict), or None."""

    device: dict[str, Any] | None = None


class DBDeviceListResponse(IOModel):
    """Response containing a list of devices."""

    devices: list[dict[str, Any]]


# ── Token CRUD ───────────────────────────────────────────────────────────


class DBCreateTokenRequest(IOModel):
    """Request to create a token."""

    id: str
    token_hash: str
    prefix: str | None = None
    device_id: str | None = None
    user_id: str | None = None
    scopes: list[str] | None = None
    expires_at: str | None = None
    created_at: str | None = None


class DBGetTokenByHashRequest(IOModel):
    """Request to get a token by hash."""

    token_hash: str


class DBGetTokenByIdRequest(IOModel):
    """Request to get a token by ID."""

    token_id: str


class DBListTokensRequest(IOModel):
    """Request to list tokens, optionally filtered."""

    user_id: str | None = None
    device_id: str | None = None


class DBUpdateTokenScopesRequest(IOModel):
    """Request to update token scopes."""

    token_id: str
    scopes: list[str]


class DBRevokeTokenRequest(IOModel):
    """Request to revoke (delete) a token."""

    token_id: str


class DBTokenResponse(IOModel):
    """Response containing a single token (as dict), or None."""

    token: dict[str, Any] | None = None


class DBTokenListResponse(IOModel):
    """Response containing a list of tokens."""

    tokens: list[dict[str, Any]]


# ── Audit Log ────────────────────────────────────────────────────────────


class DBAuditLogRequest(IOModel):
    """Request to query the audit log."""

    limit: int = 50
    offset: int = 0
    principal_id: str | None = None
    event: str | None = None


class DBAuditLogResponse(IOModel):
    """Response with audit log entries and total count."""

    events: list[dict[str, Any]]
    total: int = 0


class DBCountAuditEventsRequest(IOModel):
    """Request to count audit events matching filters."""

    principal_id: str | None = None
    event: str | None = None


# ── Mesh Credentials ────────────────────────────────────────────────────


class DBSaveMeshCredentialRequest(IOModel):
    """Request to save a mesh credential."""

    id: str
    room_name: str
    token: str
    remote_device_id: str | None = None
    remote_user_id: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


class DBGetMeshCredentialByRoomRequest(IOModel):
    """Request to get a mesh credential by room name."""

    room_name: str


class DBDeleteMeshCredentialRequest(IOModel):
    """Request to delete a mesh credential by room name."""

    room_name: str


class DBMeshCredentialResponse(IOModel):
    """Response containing a single mesh credential (as dict), or None."""

    credential: dict[str, Any] | None = None


# ── Generic SQL Execution ────────────────────────────────────────────────


class DBExecuteSQLRequest(IOModel):
    """Request to execute raw SQL (internal use only).

    This contract is used by services that need to execute ad-hoc SQL
    queries against the database.  It is exposed as ``internal`` only.
    """

    sql: str
    params: list[Any] | None = None
    mesh_selector: MeshAddressSelector | None = None


class DBExecuteSQLResponse(IOModel):
    """Response from a raw SQL execution.

    ``rows`` contains the result set for SELECT queries (each row as a dict).
    ``rowcount`` is the number of rows affected by INSERT/UPDATE/DELETE.
    """

    rows: list[dict[str, Any]] = Field(default_factory=list)
    rowcount: int = 0
