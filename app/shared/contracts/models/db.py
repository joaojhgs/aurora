"""DB (Database) service contract models."""

from typing import Any, Literal
from urllib.parse import quote

from pydantic import ConfigDict, Field, field_validator, model_validator

from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.tooling import (
    ToolingExportPolicy,
    ToolingExportRule,
    ToolingExportScopeType,
    ToolingExportState,
    ToolingGetExportCatalogResponse,
    ToolingMeshKillSwitches,
    ToolingProjectionAuthorityRevision,
    ToolingRemoteAvailability,
    ToolingToolInfo,
)
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
    CREATE_SESSION = f"{DBModule.NAME}.CreateSession"
    LIST_SESSIONS = f"{DBModule.NAME}.ListSessions"
    GET_SESSION = f"{DBModule.NAME}.GetSession"
    SET_ACTIVE_SESSION = f"{DBModule.NAME}.SetActiveSession"
    ENSURE_SESSION = f"{DBModule.NAME}.EnsureSession"
    RESOLVE_DAEMON_SESSION = f"{DBModule.NAME}.ResolveDaemonSession"
    RAG_SEARCH = f"{DBModule.NAME}.RAGSearch"
    RAG_STORE = f"{DBModule.NAME}.RAGStore"
    RAG_DELETE = f"{DBModule.NAME}.RAGDelete"
    RAG_GET = f"{DBModule.NAME}.RAGGet"
    RAG_LIST = f"{DBModule.NAME}.RAGList"
    RAG_LIST_NAMESPACES = f"{DBModule.NAME}.RAGListNamespaces"
    RAG_SEARCH_REMOTE = f"{DBModule.NAME}.RAGSearchRemote"
    RAG_GET_PROVENANCE = f"{DBModule.NAME}.RAGGetProvenance"
    RAG_EXPORT_NAMESPACE = f"{DBModule.NAME}.RAGExportNamespace"
    RAG_IMPORT_NAMESPACE = f"{DBModule.NAME}.RAGImportNamespace"
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

    # Keep the mesh trust row and its dedicated auth principal/token in one
    # database transaction.  Auth must not compose this from independent CRUD
    # calls because a mid-flight failure would persist contradictory authority.
    APPROVE_MESH_PEER = f"{DBModule.NAME}.ApproveMeshPeer"
    UPDATE_MESH_PEER_PERMISSIONS = f"{DBModule.NAME}.UpdateMeshPeerPermissions"
    DENY_MESH_PEER = f"{DBModule.NAME}.DenyMeshPeer"
    REMOVE_MESH_PEER = f"{DBModule.NAME}.RemoveMeshPeer"
    PRUNE_ORPHANED_MESH_PEER_ROWS = f"{DBModule.NAME}.PruneOrphanedMeshPeerRows"
    LINK_MESH_PEER_CREDENTIAL = f"{DBModule.NAME}.LinkMeshPeerCredential"
    ISSUE_MESH_PEER_CREDENTIAL = f"{DBModule.NAME}.IssueMeshPeerCredential"
    GET_MESH_PEER_AUTHORITY_SNAPSHOT = f"{DBModule.NAME}.GetMeshPeerAuthoritySnapshot"
    RECONCILE_TOOL_IDENTITY = f"{DBModule.NAME}.ReconcileToolIdentity"
    ALLOCATE_TOOL_IDENTITY = f"{DBModule.NAME}.AllocateToolIdentity"
    RESOLVE_TOOL_IDENTITY_ALIASES = f"{DBModule.NAME}.ResolveToolIdentityAliases"
    GET_TOOLING_EXPORT_POLICY_SNAPSHOT = f"{DBModule.NAME}.GetToolingExportPolicySnapshot"
    MUTATE_TOOLING_EXPORT_POLICY = f"{DBModule.NAME}.MutateToolingExportPolicy"
    GET_TOOLING_MESH_SWITCHES = f"{DBModule.NAME}.GetToolingMeshSwitches"
    SET_TOOLING_MESH_SWITCHES = f"{DBModule.NAME}.SetToolingMeshSwitches"
    BEGIN_TOOLING_REMOTE_CATALOG_SYNC = f"{DBModule.NAME}.BeginToolingRemoteCatalogSync"
    APPEND_TOOLING_REMOTE_CATALOG_PAGE = f"{DBModule.NAME}.AppendToolingRemoteCatalogPage"
    COMMIT_TOOLING_REMOTE_CATALOG_SYNC = f"{DBModule.NAME}.CommitToolingRemoteCatalogSync"
    FINALIZE_TOOLING_REMOTE_CATALOG_POLICY = f"{DBModule.NAME}.FinalizeToolingRemoteCatalogPolicy"
    ABORT_TOOLING_REMOTE_CATALOG_SYNC = f"{DBModule.NAME}.AbortToolingRemoteCatalogSync"
    GET_TOOLING_REMOTE_CATALOG = f"{DBModule.NAME}.GetToolingRemoteCatalog"
    SET_TOOLING_REMOTE_PROVIDER_AVAILABILITY = (
        f"{DBModule.NAME}.SetToolingRemoteProviderAvailability"
    )
    ACCEPT_TOOLING_REMOTE_TOOL_SCHEMA = f"{DBModule.NAME}.AcceptToolingRemoteToolSchema"
    IMPORT_LEGACY_TOOLING_REMOTE_CATALOGS = f"{DBModule.NAME}.ImportLegacyToolingRemoteCatalogs"
    RECOVER_TOOLING_REMOTE_CATALOGS = f"{DBModule.NAME}.RecoverToolingRemoteCatalogs"
    PRUNE_TOOLING_REMOTE_CATALOG_RETENTION = f"{DBModule.NAME}.PruneToolingRemoteCatalogRetention"
    RESOLVE_TOOLING_REMOTE_TOOL_ALIASES = f"{DBModule.NAME}.ResolveToolingRemoteToolAliases"
    GET_TOOLING_MESH_ACTIVATION_STATE = f"{DBModule.NAME}.GetToolingMeshActivationState"
    ACTIVATE_TOOLING_MESH_ENFORCEMENT = f"{DBModule.NAME}.ActivateToolingMeshEnforcement"
    GET_TOOLING_EXPOSURE_LEDGER = f"{DBModule.NAME}.GetToolingExposureLedger"
    RECORD_TOOLING_EXPOSURES = f"{DBModule.NAME}.RecordToolingExposures"
    UPSERT_MESH_PEER = f"{DBModule.NAME}.UpsertMeshPeer"
    SAVE_MESH_INBOUND_CREDENTIAL = f"{DBModule.NAME}.SaveMeshInboundCredential"
    UPDATE_MESH_PEER_CONNECTION = f"{DBModule.NAME}.UpdateMeshPeerConnection"
    MATCH_MESH_OUTBOUND_CREDENTIAL = f"{DBModule.NAME}.MatchMeshOutboundCredential"

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
    session_id: str | None = None
    principal_id: str | None = None
    session_type: str = "chat"


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


class DBSessionRecord(IOModel):
    """Principal-owned persisted session metadata."""

    id: str
    principal_id: str
    type: str
    title: str | None = None
    created_at: str
    updated_at: str
    last_active_at: str
    message_count: int = 0


class DBCreateSessionRequest(IOModel):
    """Create a new local session for the authenticated principal."""

    type: str = Field(min_length=1, max_length=64)
    title: str | None = Field(default=None, max_length=200)


class DBListSessionsRequest(IOModel):
    """List local sessions owned by the authenticated principal."""

    type: str | None = Field(default=None, min_length=1, max_length=64)
    limit: int = Field(default=100, ge=1, le=500)
    offset: int = Field(default=0, ge=0)


class DBListSessionsResponse(IOModel):
    """Principal-scoped session index and its last-opened session."""

    sessions: list[DBSessionRecord] = Field(default_factory=list)
    active_session_id: str | None = None
    total: int = 0


class DBGetSessionRequest(IOModel):
    """Load one principal-owned session and its messages."""

    session_id: str
    activate: bool = False


class DBGetSessionResponse(IOModel):
    """Persisted session metadata plus chronological messages."""

    session: DBSessionRecord
    messages: list[dict[str, Any]] = Field(default_factory=list)


class DBSetActiveSessionRequest(IOModel):
    """Mark a principal-owned session as the last-opened thread."""

    session_id: str


class DBSessionResponse(IOModel):
    """Response containing one persisted session."""

    session: DBSessionRecord


class DBEnsureSessionRequest(IOModel):
    """Internal request to validate or create a principal-owned session."""

    principal_id: str
    type: str = Field(min_length=1, max_length=64)
    session_id: str | None = None
    title: str | None = Field(default=None, max_length=200)
    activate: bool = True


class DBResolveDaemonSessionRequest(IOModel):
    """Resolve the recent active local session for daemon-origin chat."""

    type: str = Field(min_length=1, max_length=64)
    stale_after_seconds: int = Field(default=86_400, gt=0, le=604_800)


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


RAGPolicyDecision = Literal["allowed", "denied", "unavailable", "conflict"]
RAGPrivacyClass = Literal["public", "internal", "personal", "sensitive", "secret"]


class DBRAGNamespacePolicy(IOModel):
    """Policy and capability metadata for a RAG namespace."""

    sharing_mode: Literal["remote_query", "export_import", "one_way_sync", "never"] = "remote_query"
    privacy_class: RAGPrivacyClass = "personal"
    allowed_operations: list[str] = Field(default_factory=list)
    explicit_selector_required: bool = True
    export_supported: bool = False
    import_supported: bool = False
    delete_supported: bool = False
    requires_admin_approval: bool = False
    denial_reason: str | None = None


class DBRAGNamespaceInfo(IOModel):
    """Namespace catalog entry for local or remote RAG data."""

    namespace: str
    source_peer_id: str
    owner_peer_id: str
    provider_peer_id: str | None = None
    availability: Literal["available", "unavailable", "stale", "denied"] = "available"
    policy: DBRAGNamespacePolicy
    record_count: int | None = None
    embedding_model: str | None = None
    schema_version: str = "rag-provenance.v1"
    freshness: str | None = None


class DBRAGListNamespacesRequest(IOModel):
    """Request a policy-aware catalog of RAG namespaces."""

    include_remote: bool = True
    include_unavailable: bool = True
    namespace_prefix: str | None = None
    mesh_selector: MeshAddressSelector | None = None


class DBRAGListNamespacesResponse(IOModel):
    """Policy-aware RAG namespace catalog."""

    namespaces: list[DBRAGNamespaceInfo] = Field(default_factory=list)


class DBRAGProvenance(IOModel):
    """Provenance attached to an exported/imported or remote-search RAG record."""

    source_peer_id: str
    owner_peer_id: str
    namespace: str
    record_id: str
    origin_principal_id: str
    created_at: str
    updated_at: str
    schema_version: str = "rag-provenance.v1"
    policy_decision_id: str
    correlation_id: str
    imported_at: str | None = None
    import_operation_id: str | None = None
    tombstone: bool = False
    deleted_at: str | None = None
    deleted_by: str | None = None
    delete_reason: str | None = None


class DBRAGProvenanceItem(IOModel):
    """RAG item with provenance and redaction status."""

    key: str
    value: Any
    namespace: str
    search_score: float | None = None
    provenance: DBRAGProvenance
    redacted: bool = False
    redaction_reasons: list[str] = Field(default_factory=list)


class DBRAGSearchRemoteRequest(IOModel):
    """Policy-enforced remote-capable RAG search request."""

    namespace: str
    query: str
    limit: int = 10
    offset: int = 0
    mesh_selector: MeshAddressSelector | None = None
    caller_peer_id: str | None = None
    caller_principal_id: str | None = None
    policy_decision_id: str | None = None
    correlation_id: str | None = None


class DBRAGSearchRemoteResponse(IOModel):
    """Remote-capable RAG search response with policy status."""

    decision: RAGPolicyDecision
    items: list[DBRAGProvenanceItem] = Field(default_factory=list)
    denial_reason: str | None = None
    policy_decision_id: str
    correlation_id: str


class DBRAGGetProvenanceRequest(IOModel):
    """Request provenance for one RAG record."""

    namespace: str
    key: str
    mesh_selector: MeshAddressSelector | None = None
    correlation_id: str | None = None


class DBRAGGetProvenanceResponse(IOModel):
    """Response containing provenance for one RAG record."""

    provenance: DBRAGProvenance | None = None
    decision: RAGPolicyDecision = "allowed"
    denial_reason: str | None = None


class DBRAGExportRecord(IOModel):
    """One record in a RAG namespace export snapshot."""

    key: str
    value: Any
    provenance: DBRAGProvenance
    redacted: bool = False
    redaction_reasons: list[str] = Field(default_factory=list)


class DBRAGExportNamespaceRequest(IOModel):
    """Export a bounded RAG namespace snapshot."""

    namespace: str
    limit: int = 100
    offset: int = 0
    include_tombstones: bool = True
    caller_principal_id: str | None = None
    policy_decision_id: str | None = None
    correlation_id: str | None = None
    mesh_selector: MeshAddressSelector | None = None


class DBRAGExportNamespaceResponse(IOModel):
    """Exported RAG namespace snapshot."""

    decision: RAGPolicyDecision
    namespace: str
    source_peer_id: str
    owner_peer_id: str
    schema_version: str = "rag-export.v1"
    records: list[DBRAGExportRecord] = Field(default_factory=list)
    tombstone_count: int = 0
    denial_reason: str | None = None
    policy_decision_id: str
    correlation_id: str


class DBRAGImportNamespaceRequest(IOModel):
    """Import a RAG namespace snapshot into a local namespace."""

    source_namespace: str
    target_namespace: str
    records: list[DBRAGExportRecord]
    source_peer_id: str
    owner_peer_id: str
    allow_owner_overwrite: bool = False
    caller_principal_id: str | None = None
    policy_decision_id: str | None = None
    correlation_id: str | None = None
    mesh_selector: MeshAddressSelector | None = None


class DBRAGImportNamespaceResponse(IOModel):
    """Result of importing a RAG namespace snapshot."""

    decision: RAGPolicyDecision
    imported_count: int = 0
    skipped_count: int = 0
    target_namespace: str
    import_operation_id: str
    denial_reason: str | None = None
    policy_decision_id: str
    correlation_id: str


# ── Shared response types ────────────────────────────────────────────────


class DBBoolResponse(IOModel):
    """Generic boolean success response."""

    success: bool = True


class DBMeshAuthorityChange(IOModel):
    """Committed stable-peer authority generation safe for bus publication."""

    peer_id: str
    auth_grant_revision: int = Field(ge=1)
    disposition: Literal["present", "removed"] = "present"
    state: Literal["active", "pending", "revoked"] = "revoked"
    effective_permissions: tuple[str, ...] = Field(default_factory=tuple)
    reason: Literal[
        "approved",
        "permissions_updated",
        "denied",
        "removed",
        "credential_linked",
        "token_revoked",
    ]

    model_config = ConfigDict(frozen=True)


class DBMeshAuthoritySnapshot(IOModel):
    """Current secret-free authority state for one stable peer."""

    peer_id: str
    auth_grant_revision: int = Field(ge=0)
    disposition: Literal["present", "removed"] = "present"
    state: Literal["active", "pending", "revoked"] = "revoked"
    effective_permissions: tuple[str, ...] = Field(default_factory=tuple)

    model_config = ConfigDict(frozen=True)


class DBGetMeshPeerAuthoritySnapshotRequest(IOModel):
    """Read all stable peers/tombstones, or one exact stable peer."""

    peer_id: str | None = None


class DBGetMeshPeerAuthoritySnapshotResponse(IOModel):
    """Consistent durable authority snapshot ordered by stable peer ID."""

    authorities: tuple[DBMeshAuthoritySnapshot, ...] = Field(default_factory=tuple)


class DBAuthorityMutationResponse(DBBoolResponse):
    """Mutation result with committed peer generations and a stable error code."""

    authority_changes: tuple[DBMeshAuthorityChange, ...] = Field(default_factory=tuple)
    error_code: Literal["mesh_managed_authority"] | None = None


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


class DBApproveMeshPeerRequest(IOModel):
    """Atomically approve stable-peer rows and every linked authority graph."""

    peer_id: str
    permissions: list[str]
    approved_by: str | None = None
    room_name: str | None = None


class DBApproveMeshPeerResponse(IOModel):
    """Result plus the exact room rows committed by a mesh approval."""

    success: bool = False
    approved_rooms: list[str] = Field(default_factory=list)
    authority_changes: tuple[DBMeshAuthorityChange, ...] = Field(default_factory=tuple)


class DBUpdateMeshPeerPermissionsRequest(IOModel):
    """Atomically replace an approved peer's complete outbound authority graph."""

    peer_id: str
    permissions: list[str]


class DBDenyMeshPeerRequest(IOModel):
    """Atomically deny all rows, or one exact pairing room, for a stable peer."""

    peer_id: str
    room_name: str | None = None


class DBRemoveMeshPeerRequest(IOModel):
    """Atomically remove all rows for a stable peer and retain its tombstone."""

    peer_id: str
    revoke_token: bool = True


class DBPrunedMeshPeerRow(IOModel):
    """One exact never-approved mesh peer row removed by bounded garbage collection."""

    row_id: str
    peer_id: str
    room_name: str


class DBPruneOrphanedMeshPeerRowsRequest(IOModel):
    """Prune only old, never-approved, credentialless mesh peer rows."""

    now: float | None = Field(default=None, ge=0)
    retention_seconds: int = Field(default=2592000, ge=3600, le=31536000)
    max_rows: int = Field(default=256, ge=1, le=4096)


class DBPruneOrphanedMeshPeerRowsResponse(IOModel):
    """Result of bounded orphaned mesh peer row pruning."""

    success: bool = True
    pruned_rows: list[DBPrunedMeshPeerRow] = Field(default_factory=list)


class DBLinkMeshPeerCredentialRequest(IOModel):
    """Atomically link one issued credential graph to an approved peer row."""

    peer_id: str
    token_id: str
    device_id: str
    user_id: str
    room_name: str | None = None


class DBIssueMeshPeerCredentialRequest(IOModel):
    """Create, link, and rotate one mesh credential graph atomically."""

    peer_id: str
    room_name: str
    user: DBCreateUserRequest
    device: DBCreateDeviceRequest
    token: DBCreateTokenRequest


class DBUpsertMeshPeerRequest(IOModel):
    """Create/update discovery metadata for one exact mesh peer room."""

    id: str
    peer_id: str
    room_name: str
    node_name: str = ""
    ip: str | None = None
    port: int | None = None

    @property
    def sql(self) -> str:
        """Compatibility shape for older unit mocks that inspected raw SQL."""
        return "INSERT INTO mesh_peers (id, peer_id, room_name, node_name, ip, port) VALUES (?, ?, ?, ?, ?, ?)"


class DBSaveMeshInboundCredentialRequest(IOModel):
    """Persist the encrypted credential a remote peer issued to this node."""

    peer_id: str
    room_name: str
    encrypted_token: str
    token_id: str | None = None
    permissions: list[str] = Field(default_factory=list)
    remote_device_id: str | None = None
    remote_user_id: str | None = None
    remote_node_name: str | None = None

    @property
    def sql(self) -> str:
        """Compatibility shape for older unit assertions that inspected raw SQL."""
        return (
            "UPDATE mesh_peers SET "
            "  inbound_status = 'approved', "
            "  inbound_token = ?, "
            "  inbound_token_id = ?, "
            "  inbound_permissions = ?, "
            "  inbound_device_id = ?, "
            "  inbound_user_id = ?, "
            "  inbound_approved_at = CURRENT_TIMESTAMP, "
            "  node_name = COALESCE(NULLIF(?, ''), node_name), "
            "  last_status_change_at = CURRENT_TIMESTAMP, "
            "  updated_at = CURRENT_TIMESTAMP "
            "WHERE peer_id = ? AND room_name = ?"
        )

    @property
    def params(self) -> list[Any]:
        """Compatibility parameter order for older raw-SQL assertions."""
        return [
            self.encrypted_token,
            self.token_id,
            self.permissions,
            self.remote_device_id,
            self.remote_user_id,
            self.remote_node_name,
            self.peer_id,
            self.room_name,
        ]


class DBUpdateMeshPeerConnectionRequest(IOModel):
    """Update non-authority connection metadata for a stable mesh peer."""

    peer_id: str
    connection_status: str


class DBMatchMeshOutboundCredentialRequest(IOModel):
    """Check exact stable-peer ownership of an issued outbound credential."""

    token_id: str
    device_id: str
    user_id: str
    claimant_peer_id: str
    room_name: str

    @property
    def sql(self) -> str:
        """Compatibility shape for older unit assertions that inspected raw SQL."""
        return (
            "SELECT id FROM mesh_peers "
            "WHERE peer_id = ? AND room_name = ? "
            "  AND outbound_status = 'approved' "
            "  AND outbound_token_id = ? "
            "  AND outbound_device_id = ? "
            "  AND outbound_user_id = ?"
        )

    @property
    def params(self) -> list[str]:
        """Compatibility parameter order for older raw-SQL assertions."""
        return [
            self.claimant_peer_id,
            self.room_name,
            self.token_id,
            self.device_id,
            self.user_id,
        ]


class DBRevokeTokenRequest(IOModel):
    """Request to revoke (delete) a token."""

    token_id: str
    reject_mesh_linked: bool = False


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


# ── Durable Tooling identity ────────────────────────────────────────────


class DBReconcileToolIdentityRequest(IOModel):
    """Atomically persist one canonical tool identity and its legacy aliases."""

    canonical_global_tool_id: str = Field(min_length=1, max_length=1024)
    stable_peer_id: str = Field(min_length=1, max_length=160)
    identity_version: Literal[1] = 1
    tool_contract_id: str = Field(min_length=1, max_length=160)
    source_kind: Literal["core", "plugin", "mcp", "toolkit", "mesh_peer", "unknown"]
    stable_source_id: str = Field(min_length=1, max_length=160)
    provider_tool_id: str = Field(min_length=1, max_length=160)
    share_group_id: str = Field(min_length=1, max_length=160)
    share_group_label: str = Field(min_length=1, max_length=120)
    current_local_name: str = Field(min_length=1, max_length=512)
    legacy_global_tool_ids: list[str] = Field(default_factory=list, max_length=16)
    alias_kind: str = Field(default="legacy_name_derived", min_length=1, max_length=64)

    @model_validator(mode="after")
    def validate_identity(self) -> "DBReconcileToolIdentityRequest":
        authority_components = {
            "stable_peer_id": self.stable_peer_id,
            "tool_contract_id": self.tool_contract_id,
            "stable_source_id": self.stable_source_id,
            "provider_tool_id": self.provider_tool_id,
            "share_group_id": self.share_group_id,
        }
        for label, value in authority_components.items():
            if value != value.strip() or any(
                ord(character) < 0x20 or ord(character) == 0x7F for character in value
            ):
                raise ValueError(f"{label} must be trimmed and contain no control characters")
        expected = (
            f"aurora-tool:v{self.identity_version}:"
            f"{quote(self.stable_peer_id, safe='-._~')}:Tooling:"
            f"{quote(self.tool_contract_id, safe='-._~')}"
        )
        if self.canonical_global_tool_id != expected:
            raise ValueError("canonical_global_tool_id does not match the versioned identity")
        if any(
            not value
            or value != value.strip()
            or len(value) > 512
            or any(ord(character) < 0x20 or ord(character) == 0x7F for character in value)
            for value in self.legacy_global_tool_ids
        ):
            raise ValueError(
                "legacy_global_tool_ids must be trimmed, non-empty, and at most 512 chars"
            )
        if len(set(self.legacy_global_tool_ids)) != len(self.legacy_global_tool_ids):
            raise ValueError("legacy_global_tool_ids must be unique")
        if self.canonical_global_tool_id in self.legacy_global_tool_ids:
            raise ValueError("canonical identity cannot also be a legacy alias")
        return self


class DBToolIdentityRekeyCounts(IOModel):
    """Rows rewritten inside one identity reconciliation transaction."""

    approval_grants: int = 0
    approval_grant_metadata: int = 0
    approval_requests: int = 0
    approval_tokens: int = 0
    remote_catalog_snapshots: int = 0
    remote_catalog_tombstones: int = 0


class DBReconcileToolIdentityResponse(IOModel):
    """Result of fail-closed Tooling identity reconciliation."""

    success: bool
    canonical_global_tool_id: str
    aliases: list[str] = Field(default_factory=list)
    created: bool = False
    idempotent: bool = False
    rekeyed: DBToolIdentityRekeyCounts = Field(default_factory=DBToolIdentityRekeyCounts)
    conflict_id: str | None = None
    error_code: str | None = None
    error: str | None = None


class DBAllocateToolIdentityRequest(IOModel):
    """Allocate one immutable ID for an unstamped/name-only tool identity."""

    stable_peer_id: str = Field(min_length=1, max_length=160)
    legacy_identity_locator: str = Field(min_length=1, max_length=512)
    source_kind: Literal["core", "plugin", "mcp", "toolkit", "mesh_peer", "unknown"]
    stable_source_id: str = Field(min_length=1, max_length=160)
    provider_tool_id: str = Field(min_length=1, max_length=160)
    share_group_id: str = Field(min_length=1, max_length=160)
    share_group_label: str = Field(min_length=1, max_length=120)
    current_local_name: str = Field(min_length=1, max_length=512)
    legacy_global_tool_ids: list[str] = Field(default_factory=list, max_length=16)

    @model_validator(mode="after")
    def validate_locator(self) -> "DBAllocateToolIdentityRequest":
        values = (
            self.stable_peer_id,
            self.legacy_identity_locator,
            self.stable_source_id,
            self.provider_tool_id,
            self.share_group_id,
        )
        if any(
            value != value.strip()
            or any(ord(character) < 0x20 or ord(character) == 0x7F for character in value)
            for value in values
        ):
            raise ValueError("identity allocation keys must be trimmed and contain no controls")
        aliases = [self.legacy_identity_locator, *self.legacy_global_tool_ids]
        if len(set(aliases)) != len(aliases):
            raise ValueError("legacy identity aliases must be unique")
        return self


class DBAllocateToolIdentityResponse(DBReconcileToolIdentityResponse):
    """Allocated identity plus the reconciliation outcome."""

    allocated_tool_contract_id: str


class DBResolveToolIdentityAliasesRequest(IOModel):
    """Resolve durable canonical IDs and aliases after a process restart."""

    global_tool_ids: list[str] = Field(min_length=1, max_length=256)
    stable_peer_id: str | None = Field(default=None, min_length=1, max_length=160)


class DBResolveToolIdentityAliasesResponse(IOModel):
    """Input-ID to canonical-ID mappings; unknown/colliding IDs are omitted."""

    resolved: dict[str, str] = Field(default_factory=dict)


# ── Durable Tooling export policy ───────────────────────────────────────


class DBGetToolingExportPolicySnapshotRequest(IOModel):
    """Read export authority without exposing generic SQL."""

    peer_id: str | None = Field(default=None, min_length=1, max_length=160)
    include_rules: bool = True
    include_stale: bool = True
    known_global_tool_ids: list[str] = Field(default_factory=list, max_length=4096)
    known_share_group_ids: list[str] = Field(default_factory=list, max_length=1024)


class DBToolingExportRecipientScope(IOModel):
    """One durable non-global recipient scope referenced by export rules."""

    peer_id: str = Field(min_length=1, max_length=160)
    rule_count: int = Field(ge=1)
    last_rule_updated_at: float


class DBGetToolingExportPolicySnapshotResponse(IOModel):
    """Atomic policy/rules/switch snapshot for Tooling."""

    policy: ToolingExportPolicy
    rules: list[ToolingExportRule] = Field(default_factory=list)
    stale_tool_ids: list[str] = Field(default_factory=list)
    stale_group_ids: list[str] = Field(default_factory=list)
    recipient_scopes: list[DBToolingExportRecipientScope] = Field(default_factory=list)
    mesh_switches: ToolingMeshKillSwitches
    secrets_redacted: bool = True


class DBToolingExportRuleSeed(IOModel):
    """Preflighted deterministic rule imported by one legacy initialization."""

    rule_id: str = Field(min_length=1, max_length=160)
    peer_id: str | None = Field(default=None, min_length=1, max_length=160)
    scope_type: ToolingExportScopeType
    scope_id: str = Field(min_length=1, max_length=1024)
    state: ToolingExportState
    actor_principal_id: str = Field(min_length=1, max_length=256)
    reason: str = Field(min_length=1, max_length=2048)


class DBMutateToolingExportPolicyRequest(IOModel):
    """One optimistic export mutation and its atomic audit metadata."""

    action: Literal["initialize_legacy", "set_default", "upsert_rule", "clear_rule"]
    expected_revision: int = Field(ge=0)
    state: ToolingExportState | None = None
    peer_id: str | None = Field(default=None, min_length=1, max_length=160)
    scope_type: ToolingExportScopeType | None = None
    scope_id: str | None = Field(default=None, min_length=1, max_length=1024)
    actor_principal_id: str = Field(min_length=1, max_length=256)
    reason: str = Field(min_length=1, max_length=2048)
    correlation_id: str | None = Field(default=None, max_length=256)
    migrated_from_legacy: bool | None = None
    initial_rules: list[DBToolingExportRuleSeed] = Field(default_factory=list, max_length=4096)

    @model_validator(mode="after")
    def validate_mutation_shape(self) -> "DBMutateToolingExportPolicyRequest":
        if self.actor_principal_id != self.actor_principal_id.strip() or (
            not self.reason.strip() or self.reason != self.reason.strip()
        ):
            raise ValueError("export mutation audit values must be trimmed and nonblank")
        if self.peer_id is not None and self.peer_id != self.peer_id.strip():
            raise ValueError("peer_id must be trimmed")
        if self.action == "initialize_legacy":
            if self.state is None or self.scope_type is not None or self.scope_id is not None:
                raise ValueError(
                    "initialize_legacy requires a default state and optional initial_rules"
                )
            if self.migrated_from_legacy is None:
                raise ValueError("initialize_legacy requires migrated_from_legacy")
        elif self.action == "set_default":
            if self.state is None or self.scope_type is not None or self.scope_id is not None:
                raise ValueError("set_default requires only state")
        elif self.action == "upsert_rule":
            if self.state is None or self.scope_type is None or self.scope_id is None:
                raise ValueError("upsert_rule requires state, scope_type, and scope_id")
        elif self.scope_type is None or self.scope_id is None or self.state is not None:
            raise ValueError("clear_rule requires scope_type and scope_id without state")
        if self.action != "initialize_legacy" and (
            self.initial_rules or self.migrated_from_legacy is not None
        ):
            raise ValueError("legacy initialization fields are reserved for initialize_legacy")
        return self


class DBMutateToolingExportPolicyResponse(IOModel):
    """Optimistic mutation result; conflicts never write or audit success."""

    ok: bool
    policy: ToolingExportPolicy
    rule: ToolingExportRule | None = None
    cleared: bool = False
    changed: bool = False
    audit_id: str | None = None
    previous_revision: int = Field(ge=0)
    revision: int = Field(ge=0)
    error: str | None = None
    correlation_id: str | None = None


class DBGetToolingMeshSwitchesRequest(IOModel):
    """Read persisted bilateral switches."""


class DBGetToolingMeshSwitchesResponse(IOModel):
    """Bilateral switches; enforcement remains explicitly inactive in G012."""

    switches: ToolingMeshKillSwitches


class DBSetToolingMeshSwitchesRequest(IOModel):
    """Optimistically update both directional switches as one logical value."""

    provider_mesh_tooling_enabled: bool
    consumer_mesh_tooling_enabled: bool
    expected_revision: int = Field(ge=0)
    actor_principal_id: str = Field(min_length=1, max_length=256)
    reason: str = Field(min_length=1, max_length=2048)
    correlation_id: str | None = Field(default=None, max_length=256)

    @model_validator(mode="after")
    def validate_switch_audit(self) -> "DBSetToolingMeshSwitchesRequest":
        if self.actor_principal_id != self.actor_principal_id.strip() or (
            not self.reason.strip() or self.reason != self.reason.strip()
        ):
            raise ValueError("mesh switch audit values must be trimmed and nonblank")
        return self


class DBSetToolingMeshSwitchesResponse(IOModel):
    """Optimistic bilateral-switch update result."""

    ok: bool
    switches: ToolingMeshKillSwitches
    previous_revision: int = Field(ge=0)
    revision: int = Field(ge=0)
    changed: bool = False
    error: str | None = None
    correlation_id: str | None = None


# ── Recipient-specific normalized Tooling projection retention ─────────


class DBToolingRemoteCatalogHeader(IOModel):
    """Durable provider header; only a committed active generation is bindable."""

    peer_id: str
    provider_id: str
    service_instance_id: str
    protocol_tier: Literal["legacy_unsupported", "projection_v1"]
    projection_revision: str | None = None
    projection_digest: str | None = None
    authority_revision: ToolingProjectionAuthorityRevision
    current_generation: int = Field(ge=0)
    sync_state: Literal["idle", "syncing", "committed", "failed", "legacy_stale"]
    availability: Literal[
        "active",
        "provider_unavailable",
        "stale",
        "protocol_unsupported",
    ]
    last_error_reason: str | None = None
    committed_at: float | None = None
    updated_at: float


class DBToolingRemoteCatalogTool(IOModel):
    """Retained remote tool metadata and its non-authoritative availability."""

    peer_id: str
    provider_id: str
    tool: ToolingToolInfo
    schema_hash: str
    accepted_schema_hash: str
    availability: ToolingRemoteAvailability
    reason_code: str
    missing_permissions: list[str] = Field(default_factory=list)
    active_generation: int | None = Field(default=None, ge=0)
    projection_revision: str | None = None
    authority_revision: ToolingProjectionAuthorityRevision
    review_required: bool = False
    first_seen_at: float
    last_seen_at: float
    updated_at: float


class DBToolingRemoteCatalogTombstone(IOModel):
    """Non-bindable identity stub with optional bounded last-known management metadata."""

    peer_id: str
    provider_id: str
    global_tool_id: str
    management_metadata: dict[str, Any] = Field(default_factory=dict)
    accepted_schema_hash: str
    availability: Literal["unshared", "permission_blocked", "removed", "stale"]
    reason_code: str
    compacted_at: float


class DBBeginToolingRemoteCatalogSyncRequest(IOModel):
    """Open one non-bindable staging generation for an authenticated provider."""

    sync_id: str = Field(min_length=16, max_length=256)
    peer_id: str = Field(min_length=1, max_length=160)
    provider_id: str = Field(min_length=1, max_length=256)
    service_instance_id: str = Field(min_length=1, max_length=256)
    protocol_tier: Literal["projection_v1"] = "projection_v1"
    projection_revision: str = Field(min_length=1, max_length=256)
    projection_digest: str = Field(min_length=64, max_length=64)
    authority_revision: ToolingProjectionAuthorityRevision
    page_size: int = Field(ge=1, le=256)
    expected_base_generation: int = Field(ge=0)


class DBBeginToolingRemoteCatalogSyncResponse(IOModel):
    ok: bool
    sync_id: str
    base_generation: int = Field(ge=0)
    error: str | None = None


class DBAppendToolingRemoteCatalogPageRequest(IOModel):
    """Stage one projection page; staged rows can never be returned as active."""

    sync_id: str = Field(min_length=16, max_length=256)
    page: ToolingGetExportCatalogResponse
    used_cursor_hash: str | None = Field(default=None, min_length=64, max_length=64)

    @field_validator("used_cursor_hash")
    @classmethod
    def _validate_used_cursor_hash(cls, value: str | None) -> str | None:
        if value is not None and (
            value != value.lower() or any(char not in "0123456789abcdef" for char in value)
        ):
            raise ValueError("used_cursor_hash must be lowercase hexadecimal")
        return value


class DBAppendToolingRemoteCatalogPageResponse(IOModel):
    ok: bool
    sync_id: str
    accepted_page_index: int | None = Field(default=None, ge=0)
    complete: bool = False
    error: str | None = None


class DBCommitToolingRemoteCatalogSyncRequest(IOModel):
    """Promote a verified complete staged snapshot with optimistic generation CAS."""

    sync_id: str = Field(min_length=16, max_length=256)
    expected_base_generation: int = Field(ge=0)
    defer_activation_for_policy_reconciliation: bool = False
    correlation_id: str | None = Field(default=None, max_length=256)


class DBCommitToolingRemoteCatalogSyncResponse(IOModel):
    ok: bool
    header: DBToolingRemoteCatalogHeader | None = None
    tools: list[DBToolingRemoteCatalogTool] = Field(default_factory=list)
    previous_generation: int = Field(ge=0)
    generation: int = Field(ge=0)
    error: str | None = None
    correlation_id: str | None = None


class DBFinalizeToolingRemoteCatalogPolicyRequest(IOModel):
    """Activate one pending committed generation after Config policy persistence."""

    peer_id: str = Field(min_length=1, max_length=160)
    provider_id: str = Field(min_length=1, max_length=256)
    expected_generation: int = Field(ge=1)
    expected_projection_revision: str = Field(min_length=1, max_length=256)
    correlation_id: str | None = Field(default=None, max_length=256)


class DBFinalizeToolingRemoteCatalogPolicyResponse(IOModel):
    ok: bool
    changed: bool = False
    header: DBToolingRemoteCatalogHeader | None = None
    error: str | None = None
    correlation_id: str | None = None


class DBAbortToolingRemoteCatalogSyncRequest(IOModel):
    sync_id: str = Field(min_length=16, max_length=256)
    reason_code: str = Field(min_length=1, max_length=128)
    correlation_id: str | None = Field(default=None, max_length=256)


class DBAbortToolingRemoteCatalogSyncResponse(IOModel):
    ok: bool
    aborted: bool


class DBGetToolingRemoteCatalogRequest(IOModel):
    peer_id: str | None = Field(default=None, min_length=1, max_length=160)
    provider_id: str | None = Field(default=None, min_length=1, max_length=256)
    include_inactive: bool = True

    @model_validator(mode="after")
    def _provider_requires_peer(self) -> "DBGetToolingRemoteCatalogRequest":
        if self.provider_id is not None and self.peer_id is None:
            raise ValueError("provider_id requires peer_id")
        return self


class DBGetToolingRemoteCatalogResponse(IOModel):
    headers: list[DBToolingRemoteCatalogHeader] = Field(default_factory=list)
    tools: list[DBToolingRemoteCatalogTool] = Field(default_factory=list)
    retained_tombstones: list[DBToolingRemoteCatalogTombstone] = Field(default_factory=list)
    secrets_redacted: bool = True


class DBSetToolingRemoteProviderAvailabilityRequest(IOModel):
    peer_id: str = Field(min_length=1, max_length=160)
    provider_id: str = Field(min_length=1, max_length=256)
    availability: Literal["provider_unavailable", "stale", "protocol_unsupported"]
    reason_code: str = Field(min_length=1, max_length=128)
    expected_generation: int | None = Field(default=None, ge=0)
    expected_projection_revision: str | None = Field(default=None, min_length=1, max_length=256)
    correlation_id: str | None = Field(default=None, max_length=256)


class DBSetToolingRemoteProviderAvailabilityResponse(IOModel):
    ok: bool
    changed: bool = False
    header: DBToolingRemoteCatalogHeader | None = None
    error: str | None = None
    correlation_id: str | None = None


class DBAcceptToolingRemoteToolSchemaRequest(IOModel):
    """Explicitly accept the current verified schema for one retained remote tool."""

    peer_id: str = Field(min_length=1, max_length=160)
    provider_id: str = Field(min_length=1, max_length=256)
    global_tool_id: str = Field(min_length=1, max_length=1024)
    expected_projection_revision: str = Field(min_length=1, max_length=256)
    expected_schema_hash: str = Field(min_length=64, max_length=64)
    actor_principal_id: str = Field(min_length=1, max_length=256)
    reason: str = Field(min_length=1, max_length=2048)
    correlation_id: str | None = Field(default=None, max_length=256)

    @model_validator(mode="after")
    def _validate_schema_acceptance(self) -> "DBAcceptToolingRemoteToolSchemaRequest":
        if self.actor_principal_id != self.actor_principal_id.strip():
            raise ValueError("actor_principal_id must be trimmed")
        if self.reason != self.reason.strip() or not self.reason:
            raise ValueError("reason must be trimmed and nonblank")
        if self.expected_schema_hash != self.expected_schema_hash.lower() or any(
            char not in "0123456789abcdef" for char in self.expected_schema_hash
        ):
            raise ValueError("expected_schema_hash must be lowercase hexadecimal")
        return self


class DBAcceptToolingRemoteToolSchemaResponse(IOModel):
    ok: bool
    changed: bool = False
    tool: DBToolingRemoteCatalogTool | None = None
    error: str | None = None
    audit_id: str | None = None
    correlation_id: str | None = None


class DBImportLegacyToolingRemoteCatalogsRequest(IOModel):
    """Import old JSON blobs as stale management history, never as a baseline."""

    limit: int = Field(default=4096, ge=1, le=4096)


class DBImportLegacyToolingRemoteCatalogsResponse(IOModel):
    imported_headers: int = Field(ge=0)
    imported_tools: int = Field(ge=0)
    skipped_rows: int = Field(ge=0)


class DBRecoverToolingRemoteCatalogsRequest(IOModel):
    """Fail-closed startup recovery for crashed projection staging."""

    now: float | None = Field(default=None, ge=0)
    recover_all_staging: bool = True
    orphan_staging_ttl_seconds: int = Field(default=900, ge=60, le=86400)
    actor_principal_id: str = Field(default="system", min_length=1, max_length=256)
    correlation_id: str | None = Field(default=None, max_length=256)


class DBRecoverToolingRemoteCatalogsResponse(IOModel):
    ok: bool = True
    recovered_sync_count: int = Field(ge=0)
    imported_legacy_provider_count: int = Field(default=0, ge=0)
    imported_legacy_tool_count: int = Field(default=0, ge=0)
    providers_needing_sync: list[str] = Field(default_factory=list)
    recovered_sync_ids: list[str] = Field(default_factory=list)


class DBToolingRemoteRetentionProviderSummary(IOModel):
    peer_id: str
    provider_id: str
    compacted_tool_count: int = Field(ge=0)
    compacted_management_metadata_count: int = Field(default=0, ge=0)
    pruned_audit_count: int = Field(ge=0)


class DBPruneToolingRemoteCatalogRetentionRequest(IOModel):
    """Bound full inactive rows, rich management tail, and audit independently."""

    now: float | None = Field(default=None, ge=0)
    removed_stale_ttl_seconds: int = Field(default=2592000, ge=3600, le=31536000)
    max_retained_per_provider: int = Field(default=256, ge=16, le=4096)
    management_tombstone_ttl_seconds: int = Field(default=2592000, ge=3600, le=31536000)
    max_management_tombstones_per_provider: int = Field(default=256, ge=16, le=4096)
    max_audit_rows_per_provider: int = Field(default=512, ge=32, le=8192)
    actor_principal_id: str = Field(default="system", min_length=1, max_length=256)
    correlation_id: str | None = Field(default=None, max_length=256)


class DBPruneToolingRemoteCatalogRetentionResponse(IOModel):
    ok: bool = True
    compacted_tool_count: int = Field(ge=0)
    compacted_management_metadata_count: int = Field(default=0, ge=0)
    pruned_audit_count: int = Field(ge=0)
    providers: list[DBToolingRemoteRetentionProviderSummary] = Field(default_factory=list)


class DBResolveToolingRemoteToolAliasesRequest(IOModel):
    peer_id: str = Field(min_length=1, max_length=160)
    provider_id: str = Field(min_length=1, max_length=256)
    global_tool_ids: list[str] = Field(default_factory=list, max_length=256)


class DBResolveToolingRemoteToolAliasesResponse(IOModel):
    canonical_by_requested_id: dict[str, str] = Field(default_factory=dict)


class DBToolingExposureLedgerEntry(IOModel):
    global_tool_id: str = Field(min_length=1, max_length=1024)
    last_schema_hash: str | None = Field(default=None, min_length=64, max_length=64)


class DBGetToolingExposureLedgerRequest(IOModel):
    recipient_peer_id: str = Field(min_length=1, max_length=160)
    provider_id: str = Field(min_length=1, max_length=256)


class DBGetToolingExposureLedgerResponse(IOModel):
    entries: list[DBToolingExposureLedgerEntry] = Field(default_factory=list)


class DBRecordToolingExposuresRequest(IOModel):
    recipient_peer_id: str = Field(min_length=1, max_length=160)
    provider_id: str = Field(min_length=1, max_length=256)
    entries: list[DBToolingExposureLedgerEntry] = Field(min_length=1, max_length=256)


class DBRecordToolingExposuresResponse(IOModel):
    recorded_count: int = Field(ge=0)


class DBToolingMeshActivationComponentVersions(IOModel):
    """Schema versions for every component in the atomic G013 cutover."""

    projection_transport: int = Field(ge=0)
    targeted_invalidation: int = Field(ge=0)
    normalized_catalog: int = Field(ge=0)
    consumer_binding: int = Field(ge=0)
    provider_discovery: int = Field(ge=0)
    prepare_enforcement: int = Field(ge=0)
    execute_enforcement: int = Field(ge=0)
    typed_exposure_ledger: int = Field(default=0, ge=0)
    inbound_sync_bridge: int = Field(default=0, ge=0)
    execution_rpc_evidence: int = Field(default=0, ge=0)
    exact_method_set: int = Field(default=0, ge=0)
    mutation_invalidation: int = Field(default=0, ge=0)
    conditional_legacy_retirement: int = Field(default=0, ge=0)
    startup_downgrade_guard: int = Field(default=0, ge=0)


class DBToolingMeshActivationState(IOModel):
    """Durable singleton proving whether legacy enforcement may be retired."""

    active: bool = False
    legacy_guard_retired: bool = False
    revision: int = Field(ge=0)
    component_schema_versions: DBToolingMeshActivationComponentVersions
    activated_at: float | None = None
    audit_id: str | None = None
    updated_at: float


class DBGetToolingMeshActivationStateRequest(IOModel):
    """Read the durable G013 cutover state."""


class DBGetToolingMeshActivationStateResponse(IOModel):
    state: DBToolingMeshActivationState


class DBActivateToolingMeshEnforcementRequest(IOModel):
    """CAS-activate G013 only when every frozen component reports schema v1."""

    expected_revision: int = Field(ge=0)
    component_schema_versions: DBToolingMeshActivationComponentVersions
    actor_principal_id: str = Field(min_length=1, max_length=256)
    reason: str = Field(min_length=1, max_length=2048)
    correlation_id: str | None = Field(default=None, max_length=256)

    @model_validator(mode="after")
    def _trimmed_activation_audit(self) -> "DBActivateToolingMeshEnforcementRequest":
        if self.actor_principal_id != self.actor_principal_id.strip():
            raise ValueError("actor_principal_id must be trimmed")
        if self.reason != self.reason.strip() or not self.reason:
            raise ValueError("reason must be trimmed and nonblank")
        return self


class DBActivateToolingMeshEnforcementResponse(IOModel):
    ok: bool
    changed: bool = False
    state: DBToolingMeshActivationState
    previous_revision: int = Field(ge=0)
    revision: int = Field(ge=0)
    error: str | None = None
    correlation_id: str | None = None


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
    # Keep defaults for compatibility with older internal callers while
    # allowing security-sensitive services to distinguish an empty result
    # from a statement that failed before commit.
    success: bool = True
    error: str | None = None
