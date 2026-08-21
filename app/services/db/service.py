"""Database Service for Aurora's parallel architecture.

This service:
- Handles database persistence commands using DatabaseManager
- Responds to database queries
- Manages message history
- Manages scheduler jobs
"""

from __future__ import annotations

import asyncio
import inspect
import re
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

import aiosqlite

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.messaging import Envelope, QueryResult
from app.services.db.manager import DatabaseManager, MeshManagedAuthorityError
from app.services.db.models import CronJob, JobStatus, Message, MessageType, ScheduleType
from app.services.db.rag_service import RAGService
from app.services.db.scheduler_db_service import SchedulerDatabaseService
from app.services.db.sqlite_connection import database_connection
from app.shared.contracts.models.common import EmptyOutput
from app.shared.contracts.models.db import (
    DBAbortToolingRemoteCatalogSyncRequest,
    DBAbortToolingRemoteCatalogSyncResponse,
    DBAcceptToolingRemoteToolSchemaRequest,
    DBAcceptToolingRemoteToolSchemaResponse,
    DBActivateToolingMeshEnforcementRequest,
    DBActivateToolingMeshEnforcementResponse,
    DBAllocateToolIdentityRequest,
    DBAllocateToolIdentityResponse,
    DBAppendToolingRemoteCatalogPageRequest,
    DBAppendToolingRemoteCatalogPageResponse,
    DBApproveMeshPeerRequest,
    DBApproveMeshPeerResponse,
    DBAuditLogRequest,
    DBAuditLogResponse,
    DBAuthorityMutationResponse,
    DBBeginToolingRemoteCatalogSyncRequest,
    DBBeginToolingRemoteCatalogSyncResponse,
    DBBoolResponse,
    DBCommitToolingRemoteCatalogSyncRequest,
    DBCommitToolingRemoteCatalogSyncResponse,
    DBCountAuditEventsRequest,
    DBCountResponse,
    DBCountUsersRequest,
    DBCreateDeviceRequest,
    DBCreateSessionRequest,
    DBCreateTokenRequest,
    DBCreateUserRequest,
    DBDeleteCronJobRequest,
    DBDeleteDeviceRequest,
    DBDeleteMeshCredentialRequest,
    DBDeleteUserRequest,
    DBDenyMeshPeerRequest,
    DBDeviceListResponse,
    DBDeviceResponse,
    DBEnsureSessionRequest,
    DBExecuteSQLRequest,
    DBExecuteSQLResponse,
    DBFinalizeToolingRemoteCatalogPolicyRequest,
    DBFinalizeToolingRemoteCatalogPolicyResponse,
    DBGetCronJobsRequest,
    DBGetCronJobsResponse,
    DBGetDeviceByIdRequest,
    DBGetMeshCredentialByRoomRequest,
    DBGetMeshPeerAuthoritySnapshotRequest,
    DBGetMeshPeerAuthoritySnapshotResponse,
    DBGetMessagesForDateRequest,
    DBGetMessagesRequest,
    DBGetMessagesResponse,
    DBGetSessionRequest,
    DBGetSessionResponse,
    DBGetTokenByHashRequest,
    DBGetTokenByIdRequest,
    DBGetToolingExportPolicySnapshotRequest,
    DBGetToolingExportPolicySnapshotResponse,
    DBGetToolingExposureLedgerRequest,
    DBGetToolingExposureLedgerResponse,
    DBGetToolingMeshActivationStateRequest,
    DBGetToolingMeshActivationStateResponse,
    DBGetToolingMeshSwitchesRequest,
    DBGetToolingMeshSwitchesResponse,
    DBGetToolingRemoteCatalogRequest,
    DBGetToolingRemoteCatalogResponse,
    DBGetUserByIdRequest,
    DBGetUserByUsernameRequest,
    DBImportLegacyToolingRemoteCatalogsRequest,
    DBImportLegacyToolingRemoteCatalogsResponse,
    DBIssueMeshPeerCredentialRequest,
    DBLinkMeshPeerCredentialRequest,
    DBListDevicesRequest,
    DBListSessionsRequest,
    DBListSessionsResponse,
    DBListTokensRequest,
    DBListUsersRequest,
    DBMatchMeshOutboundCredentialRequest,
    DBMeshCredentialResponse,
    DBMethods,
    DBModule,
    DBMutateToolingExportPolicyRequest,
    DBMutateToolingExportPolicyResponse,
    DBPruneOrphanedMeshPeerRowsRequest,
    DBPruneOrphanedMeshPeerRowsResponse,
    DBPruneToolingRemoteCatalogRetentionRequest,
    DBPruneToolingRemoteCatalogRetentionResponse,
    DBRAGDeleteRequest,
    DBRAGExportNamespaceRequest,
    DBRAGExportNamespaceResponse,
    DBRAGExportRecord,
    DBRAGGetProvenanceRequest,
    DBRAGGetProvenanceResponse,
    DBRAGGetRequest,
    DBRAGImportNamespaceRequest,
    DBRAGImportNamespaceResponse,
    DBRAGItemResponse,
    DBRAGListNamespacesRequest,
    DBRAGListNamespacesResponse,
    DBRAGListRequest,
    DBRAGListResponse,
    DBRAGNamespaceInfo,
    DBRAGNamespacePolicy,
    DBRAGProvenance,
    DBRAGProvenanceItem,
    DBRAGSearchRemoteRequest,
    DBRAGSearchRemoteResponse,
    DBRAGSearchRequest,
    DBRAGStoreRequest,
    DBReconcileToolIdentityRequest,
    DBReconcileToolIdentityResponse,
    DBRecordToolingExposuresRequest,
    DBRecordToolingExposuresResponse,
    DBRecoverToolingRemoteCatalogsRequest,
    DBRecoverToolingRemoteCatalogsResponse,
    DBRemoveMeshPeerRequest,
    DBResolveDaemonSessionRequest,
    DBResolveToolIdentityAliasesRequest,
    DBResolveToolIdentityAliasesResponse,
    DBResolveToolingRemoteToolAliasesRequest,
    DBResolveToolingRemoteToolAliasesResponse,
    DBRevokeTokenRequest,
    DBSaveMeshCredentialRequest,
    DBSaveMeshInboundCredentialRequest,
    DBSaveMessageRequest,
    DBSaveMessageResponse,
    DBSessionRecord,
    DBSessionResponse,
    DBSetActiveSessionRequest,
    DBSetToolingMeshSwitchesRequest,
    DBSetToolingMeshSwitchesResponse,
    DBSetToolingRemoteProviderAvailabilityRequest,
    DBSetToolingRemoteProviderAvailabilityResponse,
    DBStoreCronJobRequest,
    DBTokenListResponse,
    DBTokenResponse,
    DBUpdateMeshPeerConnectionRequest,
    DBUpdateMeshPeerPermissionsRequest,
    DBUpdateTokenScopesRequest,
    DBUpdateUserRequest,
    DBUpsertMeshPeerRequest,
    DBUserListResponse,
    DBUserResponse,
)
from app.shared.contracts.registry import method_contract
from app.shared.models.db import Device, MeshCredential, Token, User
from app.shared.services.base_service import BaseService

_PROTECTED_AUTHORITY_TABLES = frozenset(
    {
        "mesh_peers",
        "mesh_peer_auth_grant_revisions",
        "users",
        "devices",
        "tokens",
        "tooling_tool_identities",
        "tooling_tool_identity_allocations",
        "tooling_tool_identity_aliases",
        "tooling_tool_identity_conflicts",
        "tooling_export_policy",
        "tooling_export_rules",
        "tooling_export_policy_audit",
        "tooling_mesh_switches",
        "tooling_mesh_switch_audit",
        "tooling_remote_catalog_headers",
        "tooling_remote_catalog_tools",
        "tooling_remote_catalog_syncs",
        "tooling_remote_catalog_stage_pages",
        "tooling_remote_catalog_stage_tools",
        "tooling_remote_catalog_stage_retirements",
        "tooling_tool_exposure_ledger",
        "tooling_remote_catalog_audit",
        "tooling_remote_tool_aliases",
        "tooling_remote_tool_identity_conflicts",
        "tooling_remote_catalog_retention_tombstones",
        "tooling_mesh_activation_state",
        "tooling_mesh_activation_audit",
    }
)
_SQL_TOKEN_RE = re.compile(
    r'"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*)',
    re.ASCII,
)


def _mask_sql_non_code(sql: str) -> str:
    """Mask SQL string/comment bodies while preserving lexical order.

    Quoted identifiers and SQLite double-quoted string tokens remain intact for
    protected-table matching. Single-quoted literals, line comments, and block
    comments are blanked only when their delimiters are reached in normal SQL
    code.
    """

    chars = list(sql)
    i = 0
    while i < len(chars):
        char = chars[i]
        next_char = chars[i + 1] if i + 1 < len(chars) else ""
        if char == '"':
            i += 1
            while i < len(chars):
                if chars[i] == '"':
                    if i + 1 < len(chars) and chars[i + 1] == '"':
                        i += 2
                        continue
                    i += 1
                    break
                i += 1
            continue
        if char == "`":
            i += 1
            while i < len(chars):
                if chars[i] == "`":
                    if i + 1 < len(chars) and chars[i + 1] == "`":
                        i += 2
                        continue
                    i += 1
                    break
                i += 1
            continue
        if char == "[":
            i += 1
            while i < len(chars):
                if chars[i] == "]":
                    if i + 1 < len(chars) and chars[i + 1] == "]":
                        i += 2
                        continue
                    i += 1
                    break
                i += 1
            continue
        if char == "'":
            chars[i] = " "
            i += 1
            while i < len(chars):
                if chars[i] == "'":
                    chars[i] = " "
                    if i + 1 < len(chars) and chars[i + 1] == "'":
                        chars[i + 1] = " "
                        i += 2
                        continue
                    i += 1
                    break
                chars[i] = "\n" if chars[i] in "\r\n" else " "
                i += 1
            continue
        if char == "-" and next_char == "-":
            chars[i] = " "
            chars[i + 1] = " "
            i += 2
            while i < len(chars) and chars[i] not in "\r\n":
                chars[i] = " "
                i += 1
            continue
        if char == "/" and next_char == "*":
            chars[i] = " "
            chars[i + 1] = " "
            i += 2
            while i < len(chars):
                if chars[i] == "*" and i + 1 < len(chars) and chars[i + 1] == "/":
                    chars[i] = " "
                    chars[i + 1] = " "
                    i += 2
                    break
                chars[i] = "\n" if chars[i] in "\r\n" else " "
                i += 1
            continue
        i += 1
    return "".join(chars)


def _sql_tokens(sql: str) -> list[str]:
    cleaned = _mask_sql_non_code(sql)
    return [
        next(group for group in match.groups() if group is not None).lower()
        for match in _SQL_TOKEN_RE.finditer(cleaned)
    ]


def _is_read_only_sql(sql: str) -> bool:
    tokens = _sql_tokens(sql)
    if not tokens:
        return True
    if tokens[0] in {"select", "pragma", "explain"}:
        return True
    if tokens[0] == "with":
        return not any(
            token in {"insert", "update", "delete", "replace", "create", "drop", "alter"}
            for token in tokens
        )
    return False


def _protected_authority_write_error(sql: str) -> str | None:
    if _is_read_only_sql(sql):
        return None
    mentioned = sorted(_PROTECTED_AUTHORITY_TABLES.intersection(_sql_tokens(sql)))
    if not mentioned:
        return None
    return "DB.ExecuteSQL cannot mutate protected authority tables: " + ", ".join(mentioned)


# Service implementation
class DBService(BaseService):
    """Database service.

    Responsibilities:
    - Process database commands
    - Respond to queries
    - Manage data persistence
    - Ensure data integrity
    """

    def __init__(self, db_path: str | None = None):
        """Initialize DB service with DatabaseManager.

        Args:
            db_path: Optional path to database file
        """
        super().__init__(
            module=DBModule.NAME,
            summary="Database persistence and retrieval service",
            capabilities=["message_persistence", "cron_jobs", "rag_storage", "vector_search"],
        )
        self.db_manager = DatabaseManager(db_path)
        self.scheduler_db = SchedulerDatabaseService(db_path)
        self.rag_service = RAGService()
        self._contract_write_lock = asyncio.Lock()

    async def on_start(self) -> None:
        """Start the DB service."""
        log_info("Starting DB service...")

        # Initialize databases
        await self.db_manager.initialize()
        await self.scheduler_db.initialize()

        # Initialize RAG stores (requires config service to be ready)
        await self.rag_service.async_initialize()

        self._set_started(True)
        log_info("DB service started")

    async def on_stop(self) -> None:
        """Stop the DB service."""
        log_info("Stopping DB service...")

        # Close database connections
        await self.db_manager.close()
        # Scheduler DB uses aiosqlite which auto-closes connections
        # No explicit close needed

        log_info("DB service stopped")

    async def reload(self, config_section: str | None = None) -> None:
        """Reload service configuration.

        Args:
            config_section: The configuration section that changed (None = full reload)
        """
        log_info(f"Reloading DB service configuration (section: {config_section})")

        # For DB service, most config changes don't require action
        # Database path changes would require restart, but that's handled by supervisor
        # Just log the reload event
        log_debug(f"DB service reloaded for section: {config_section}")

    async def _invoke_contract_method(
        self,
        method: Any,
        data: Any,
        *,
        envelope: Any,
        pass_envelope: bool,
        topic: str | None,
        method_name: str,
        method_type: str | None,
    ) -> Any:
        """Serialize SQLite writers across independently subscribed DB topics."""

        invoke = super()._invoke_contract_method
        if self._contract_call_is_read_only(method_name, data):
            return await invoke(
                method,
                data,
                envelope=envelope,
                pass_envelope=pass_envelope,
                topic=topic,
                method_name=method_name,
                method_type=method_type,
            )
        async with self._contract_write_lock:
            return await invoke(
                method,
                data,
                envelope=envelope,
                pass_envelope=pass_envelope,
                topic=topic,
                method_name=method_name,
                method_type=method_type,
            )

    @staticmethod
    def _contract_call_is_read_only(method_name: str, data: Any) -> bool:
        """Classify only operations proven not to acquire SQLite's writer slot."""

        if method_name == "execute_sql":
            return _is_read_only_sql(str(getattr(data, "sql", "")))
        if method_name == "get_session":
            return not bool(getattr(data, "activate", False))
        return method_name.startswith(
            (
                "get_",
                "list_",
                "count_",
                "rag_get",
                "rag_list",
                "rag_search",
                "rag_export",
                "match_",
                "resolve_tool_identity_",
                "resolve_tooling_remote_tool_",
            )
        )

    def _namespace_to_tuple(self, namespace: str | tuple[str, ...]) -> tuple[str, ...]:
        """Normalize dotted or legacy pipe-delimited namespace strings."""
        if isinstance(namespace, tuple):
            return namespace
        separator = "|" if "|" in namespace else "."
        return tuple(part for part in namespace.split(separator) if part)

    def _namespace_to_string(self, namespace: str | tuple[str, ...]) -> str:
        """Normalize namespace values to the public dotted representation."""
        if isinstance(namespace, tuple):
            return ".".join(namespace)
        return namespace.replace("|", ".")

    def _now_iso(self) -> str:
        return datetime.now(UTC).isoformat()

    def _new_policy_decision_id(self, supplied: str | None = None) -> str:
        return supplied or f"rag-policy-{uuid4()}"

    def _new_correlation_id(self, supplied: str | None = None) -> str:
        return supplied or f"rag-correlation-{uuid4()}"

    def _namespace_policy(self, namespace: str) -> DBRAGNamespacePolicy:
        """Return conservative policy metadata for a namespace."""
        namespace = self._namespace_to_string(namespace)
        if namespace.startswith(("auth", "mesh.credentials", "trust", "secrets")):
            return DBRAGNamespacePolicy(
                sharing_mode="never",
                privacy_class="secret",
                allowed_operations=[],
                explicit_selector_required=True,
                denial_reason="namespace is local-authoritative and cannot be shared",
            )
        if namespace.startswith("tools"):
            return DBRAGNamespacePolicy(
                sharing_mode="remote_query",
                privacy_class="internal",
                allowed_operations=["list", "search"],
                explicit_selector_required=True,
                export_supported=False,
                import_supported=False,
                delete_supported=False,
            )
        return DBRAGNamespacePolicy(
            sharing_mode="export_import",
            privacy_class="personal",
            allowed_operations=["list", "search", "provenance", "export", "import"],
            explicit_selector_required=True,
            export_supported=True,
            import_supported=True,
            delete_supported=False,
            requires_admin_approval=True,
        )

    def _selector_matches_namespace(self, namespace: str, selector: Any | None) -> bool:
        if selector is None:
            return False
        expected = self._namespace_to_string(namespace)
        resource_namespace = getattr(selector, "resource_namespace", None)
        data_scope = getattr(selector, "data_scope", None)
        return expected in {resource_namespace, data_scope}

    def _is_remote_selector(self, selector: Any | None) -> bool:
        if selector is None:
            return False
        return bool(getattr(selector, "peer_id", None) or getattr(selector, "provider_id", None))

    def _validate_rag_access(
        self,
        namespace: str,
        selector: Any | None,
        *,
        operation: str,
        require_explicit_selector: bool = False,
    ) -> tuple[bool, str | None, DBRAGNamespacePolicy]:
        policy = self._namespace_policy(namespace)
        if policy.sharing_mode == "never":
            return False, policy.denial_reason, policy
        if operation not in policy.allowed_operations:
            return False, f"operation {operation} is not allowed for namespace {namespace}", policy
        if (
            (require_explicit_selector or self._is_remote_selector(selector))
            and policy.explicit_selector_required
            and not self._selector_matches_namespace(namespace, selector)
        ):
            return (
                False,
                "remote RAG access requires explicit mesh_selector.resource_namespace "
                "or mesh_selector.data_scope matching the requested namespace",
                policy,
            )
        return True, None, policy

    def _extract_stored_provenance(self, value: Any) -> DBRAGProvenance | None:
        if not isinstance(value, dict):
            return None
        raw = value.get("_aurora_provenance")
        if not isinstance(raw, dict):
            return None
        try:
            return DBRAGProvenance.model_validate(raw)
        except Exception:
            log_debug("Ignoring malformed stored RAG provenance metadata")
            return None

    def _build_provenance(
        self,
        *,
        namespace: str,
        key: str,
        value: Any,
        item: Any | None = None,
        source_peer_id: str = "local",
        owner_peer_id: str = "local",
        origin_principal_id: str | None = None,
        policy_decision_id: str,
        correlation_id: str,
    ) -> DBRAGProvenance:
        stored = self._extract_stored_provenance(value)
        if stored is not None:
            return stored.model_copy(
                update={
                    "namespace": self._namespace_to_string(namespace),
                    "record_id": key,
                    "policy_decision_id": policy_decision_id,
                    "correlation_id": correlation_id,
                }
            )

        now = self._now_iso()
        created_at = getattr(item, "created_at", None)
        updated_at = getattr(item, "updated_at", None)
        return DBRAGProvenance(
            source_peer_id=source_peer_id,
            owner_peer_id=owner_peer_id,
            namespace=self._namespace_to_string(namespace),
            record_id=key,
            origin_principal_id=origin_principal_id or "redacted",
            created_at=created_at.isoformat() if hasattr(created_at, "isoformat") else now,
            updated_at=updated_at.isoformat() if hasattr(updated_at, "isoformat") else now,
            policy_decision_id=policy_decision_id,
            correlation_id=correlation_id,
            tombstone=bool(value.get("_aurora_tombstone")) if isinstance(value, dict) else False,
            deleted_at=value.get("_aurora_deleted_at") if isinstance(value, dict) else None,
            deleted_by=value.get("_aurora_deleted_by") if isinstance(value, dict) else None,
            delete_reason=value.get("_aurora_delete_reason") if isinstance(value, dict) else None,
        )

    def _redact_value(self, value: Any) -> tuple[Any, bool, list[str]]:
        reasons: list[str] = []

        def redact(obj: Any) -> Any:
            if isinstance(obj, dict):
                redacted: dict[str, Any] = {}
                for key, child in obj.items():
                    lowered = key.lower()
                    if lowered.startswith("_aurora_"):
                        reasons.append("internal_metadata")
                        continue
                    if any(
                        marker in lowered
                        for marker in (
                            "embedding",
                            "vector",
                            "token",
                            "password",
                            "secret",
                            "credential",
                            "private_key",
                        )
                    ):
                        redacted[key] = "[redacted]"
                        reasons.append(key)
                        continue
                    if lowered in {"path", "file_path", "source_path"} and isinstance(child, str):
                        redacted[key] = "[redacted]"
                        reasons.append(key)
                        continue
                    redacted[key] = redact(child)
                return redacted
            if isinstance(obj, list):
                return [redact(item) for item in obj]
            return obj

        safe_value = redact(deepcopy(value))
        return safe_value, bool(reasons), sorted(set(reasons))

    def _to_provenance_item(
        self,
        item: Any,
        *,
        policy_decision_id: str,
        correlation_id: str,
        origin_principal_id: str | None = None,
    ) -> DBRAGProvenanceItem:
        value = item.value
        search_score = None
        if isinstance(value, dict) and "_search_score" in value:
            value = deepcopy(value)
            search_score = value.pop("_search_score")
        namespace = self._namespace_to_string(item.namespace)
        safe_value, redacted, reasons = self._redact_value(value)
        provenance = self._build_provenance(
            namespace=namespace,
            key=item.key,
            value=value,
            item=item,
            origin_principal_id=origin_principal_id,
            policy_decision_id=policy_decision_id,
            correlation_id=correlation_id,
        )
        return DBRAGProvenanceItem(
            key=item.key,
            value=safe_value,
            namespace=namespace,
            search_score=search_score,
            provenance=provenance,
            redacted=redacted,
            redaction_reasons=reasons,
        )

    def _value_for_import(
        self,
        record: DBRAGExportRecord,
        *,
        target_namespace: str,
        import_operation_id: str,
    ) -> Any:
        value = deepcopy(record.value)
        if not isinstance(value, dict):
            value = {"value": value}
        provenance = record.provenance.model_copy(
            update={
                "namespace": target_namespace,
                "imported_at": self._now_iso(),
                "import_operation_id": import_operation_id,
            }
        )
        value["_aurora_provenance"] = provenance.model_dump()
        if provenance.tombstone:
            value["_aurora_tombstone"] = True
            value["_aurora_deleted_at"] = provenance.deleted_at
            value["_aurora_deleted_by"] = provenance.deleted_by
            value["_aurora_delete_reason"] = provenance.delete_reason
        return value

    @staticmethod
    def _session_record(session: Any) -> DBSessionRecord:
        """Serialize one principal-owned session for the public contract."""

        return DBSessionRecord.model_validate(session.to_dict())

    @staticmethod
    def _session_message(message: Message) -> dict[str, Any]:
        """Serialize a stored message with a stable UI role."""

        if message.message_type in {MessageType.USER_TEXT, MessageType.USER_VOICE}:
            role = "user"
        elif message.message_type == MessageType.ASSISTANT:
            role = "assistant"
        else:
            role = "system"
        return {
            "id": message.id,
            "role": role,
            "content": message.content,
            "message_type": message.message_type.value,
            "timestamp": message.timestamp.isoformat(),
            "session_id": message.session_id,
            "metadata": message.metadata,
            "source_type": message.source_type,
        }

    @staticmethod
    def _local_session_principal(envelope: Envelope | None) -> str:
        """Resolve the caller principal while keeping sessions off peer transports."""

        if envelope is None:
            return "system"

        identity_source = getattr(envelope, "identity_source", None)
        caller_peer_id = getattr(envelope, "caller_peer_id", None)
        if identity_source in {"webrtc_rpc", "mesh_peer", "remote_peer"} or caller_peer_id:
            raise PermissionError("chat sessions are local-only and are not available to peers")

        principal_id = str(getattr(envelope, "principal_id", None) or "").strip()
        if principal_id:
            return principal_id
        if getattr(envelope, "origin", "internal") in {"internal", "system"}:
            return "system"
        raise PermissionError("an authenticated principal is required for chat sessions")

    @method_contract(
        method_id=DBMethods.CREATE_SESSION,
        input_model=DBCreateSessionRequest,
        output_model=DBSessionResponse,
        summary="Create a principal-owned local session",
        exposure="external",
        method_type="use",
        required_perms=["DB.use"],
        callable_feature_ids=["session_management"],
    )
    async def create_session(
        self,
        cmd: DBCreateSessionRequest,
        envelope: Envelope | None = None,
    ) -> DBSessionResponse:
        """Create and activate a session for the authenticated principal."""

        principal_id = self._local_session_principal(envelope)
        session = await self.db_manager.ensure_session(
            principal_id=principal_id,
            session_type=cmd.type,
            title=cmd.title,
            activate=True,
        )
        return DBSessionResponse(session=self._session_record(session))

    @method_contract(
        method_id=DBMethods.LIST_SESSIONS,
        input_model=DBListSessionsRequest,
        output_model=DBListSessionsResponse,
        summary="List sessions owned by the authenticated principal",
        exposure="external",
        method_type="use",
        required_perms=["DB.use"],
        callable_feature_ids=["session_management"],
    )
    async def list_sessions(
        self,
        query: DBListSessionsRequest,
        envelope: Envelope | None = None,
    ) -> DBListSessionsResponse:
        """Return only the authenticated principal's local sessions."""

        principal_id = self._local_session_principal(envelope)
        sessions = await self.db_manager.list_sessions_for_principal(
            principal_id,
            session_type=query.type,
            limit=query.limit,
            offset=query.offset,
        )
        total = await self.db_manager.count_sessions_for_principal(
            principal_id,
            session_type=query.type,
        )
        active_session_id = sessions[0].id if query.offset == 0 and sessions else None
        if query.offset > 0 and total > 0:
            active_sessions = await self.db_manager.list_sessions_for_principal(
                principal_id,
                session_type=query.type,
                limit=1,
                offset=0,
            )
            active_session_id = active_sessions[0].id if active_sessions else None
        return DBListSessionsResponse(
            sessions=[self._session_record(session) for session in sessions],
            active_session_id=active_session_id,
            total=total,
        )

    @method_contract(
        method_id=DBMethods.GET_SESSION,
        input_model=DBGetSessionRequest,
        output_model=DBGetSessionResponse,
        summary="Load one session owned by the authenticated principal",
        exposure="external",
        method_type="use",
        required_perms=["DB.use"],
        callable_feature_ids=["session_management"],
    )
    async def get_session(
        self,
        query: DBGetSessionRequest,
        envelope: Envelope | None = None,
    ) -> DBGetSessionResponse:
        """Load one principal-owned session and its chronological messages."""

        principal_id = self._local_session_principal(envelope)
        session = await self.db_manager.get_session_for_principal(
            query.session_id,
            principal_id,
        )
        if session is None:
            raise LookupError("session was not found for the authenticated principal")
        if query.activate:
            session = await self.db_manager.set_active_session(query.session_id, principal_id)
            if session is None:
                raise LookupError("session was not found for the authenticated principal")
        messages = await self.db_manager.get_session_messages_for_principal(
            query.session_id,
            principal_id,
        )
        return DBGetSessionResponse(
            session=self._session_record(session),
            messages=[self._session_message(message) for message in messages],
        )

    @method_contract(
        method_id=DBMethods.SET_ACTIVE_SESSION,
        input_model=DBSetActiveSessionRequest,
        output_model=DBSessionResponse,
        summary="Mark a principal-owned session as the last-opened thread",
        exposure="external",
        method_type="use",
        required_perms=["DB.use"],
        callable_feature_ids=["session_management"],
    )
    async def set_active_session(
        self,
        cmd: DBSetActiveSessionRequest,
        envelope: Envelope | None = None,
    ) -> DBSessionResponse:
        """Persist the authenticated principal's last-opened session."""

        principal_id = self._local_session_principal(envelope)
        session = await self.db_manager.set_active_session(cmd.session_id, principal_id)
        if session is None:
            raise LookupError("session was not found for the authenticated principal")
        return DBSessionResponse(session=self._session_record(session))

    @method_contract(
        method_id=DBMethods.ENSURE_SESSION,
        input_model=DBEnsureSessionRequest,
        output_model=DBSessionResponse,
        summary="Validate or create an internal principal-owned session",
        exposure="internal",
        method_type="use",
    )
    async def ensure_session(self, cmd: DBEnsureSessionRequest) -> DBSessionResponse:
        """Validate session ownership before an internal producer writes messages."""

        session = await self.db_manager.ensure_session(
            principal_id=cmd.principal_id,
            session_type=cmd.type,
            session_id=cmd.session_id,
            title=cmd.title,
            activate=cmd.activate,
        )
        return DBSessionResponse(session=self._session_record(session))

    @method_contract(
        method_id=DBMethods.RESOLVE_DAEMON_SESSION,
        input_model=DBResolveDaemonSessionRequest,
        output_model=DBSessionResponse,
        summary="Resolve the recent active session for local daemon chat",
        exposure="internal",
        method_type="use",
    )
    async def resolve_daemon_session(
        self,
        query: DBResolveDaemonSessionRequest,
    ) -> DBSessionResponse:
        """Reuse the last-opened thread or create a typed session after staleness."""

        session = await self.db_manager.resolve_daemon_session(
            session_type=query.type,
            stale_after_seconds=query.stale_after_seconds,
        )
        return DBSessionResponse(session=self._session_record(session))

    @method_contract(
        method_id=DBMethods.SAVE_MESSAGE,
        input_model=DBSaveMessageRequest,
        output_model=DBSaveMessageResponse,
        summary="Store a chat message",
        exposure="internal",
        method_type="use",
    )
    async def store_message(self, cmd: DBSaveMessageRequest) -> DBSaveMessageResponse:
        """Handle store message command."""
        try:
            log_debug(f"Storing message: {cmd.role} - {cmd.content[:50]}...")

            metadata = dict(cmd.metadata or {})
            session_id = cmd.session_id or metadata.get("session_id") or "default"
            principal_id = cmd.principal_id or "system"
            ensure_result = self.db_manager.ensure_session(
                principal_id=principal_id,
                session_type=cmd.session_type,
                session_id=session_id,
                activate=True,
            )
            if inspect.isawaitable(ensure_result):
                await ensure_result

            # Map role to MessageType
            if cmd.role == "user":
                # Determine if it's text or voice based on metadata
                source_type = metadata.get("source_type", "Text")

                if source_type == "STT":
                    message = Message.create_user_voice_message(cmd.content, session_id)
                else:
                    message = Message.create_user_text_message(cmd.content, session_id)
            elif cmd.role == "assistant":
                message = Message.create_assistant_message(cmd.content, session_id)
            else:
                # Default to user text if role is unknown
                message = Message.create_user_text_message(cmd.content, session_id)

            # Set metadata if provided
            if metadata:
                message.metadata = metadata

            # Store in database
            success = await self.db_manager.store_message(message)

            if success:
                log_debug("Message stored successfully")
                # We don't have the ID easily available from store_message currently, returning 0
                return DBSaveMessageResponse(message_id=0, success=True)
            else:
                log_warning("Failed to store message")
                return DBSaveMessageResponse(message_id=0, success=False)

        except Exception as e:
            log_error(f"Error storing message: {e}", exc_info=True)
            return DBSaveMessageResponse(message_id=0, success=False)

    @method_contract(
        method_id=DBMethods.GET_MESSAGES,
        input_model=DBGetMessagesRequest,
        output_model=DBGetMessagesResponse,
        summary="Get recent chat messages",
        exposure="both",
        method_type="use",
        required_perms=[DBMethods.GET_MESSAGES],
        callable_feature_ids=["message_history_read"],
    )
    async def get_messages(
        self,
        query: DBGetMessagesRequest,
        envelope: Envelope | None = None,
    ) -> DBGetMessagesResponse:
        """Handle get recent messages query."""
        try:
            log_debug(f"Retrieving {query.limit} recent messages")

            if envelope is None:
                messages = await self.db_manager.get_recent_messages(limit=query.limit)
            else:
                principal_id = self._local_session_principal(envelope)
                messages = await self.db_manager.get_recent_messages_for_principal(
                    principal_id,
                    limit=query.limit,
                    offset=query.offset,
                )

            messages_data = [
                self._session_message(msg)
                if isinstance(getattr(msg, "message_type", None), MessageType)
                else {
                    "role": msg.role,
                    "content": msg.content,
                    "timestamp": msg.timestamp,
                    "metadata": msg.metadata,
                }
                for msg in messages
            ]

            return DBGetMessagesResponse(
                messages=messages_data, total=len(messages_data), has_more=False
            )  # Simplified for now

        except Exception as e:
            log_error(f"Error retrieving messages: {e}", exc_info=True)
            return DBGetMessagesResponse(messages=[], total=0, has_more=False)

    @method_contract(
        method_id=DBMethods.GET_MESSAGES_FOR_DATE,
        input_model=DBGetMessagesForDateRequest,
        output_model=DBGetMessagesResponse,
        summary="Get messages for a specific date",
        exposure="both",
        method_type="use",
        required_perms=[DBMethods.GET_MESSAGES_FOR_DATE],
        callable_feature_ids=["message_history_read"],
    )
    async def get_messages_for_date(
        self,
        query: DBGetMessagesForDateRequest,
        envelope: Envelope | None = None,
    ) -> DBGetMessagesResponse:
        """Handle get messages for date query."""
        try:
            from datetime import date, datetime

            # Parse date if provided, otherwise use today
            target_date = date.today()
            if query.date:
                target_date = datetime.fromisoformat(query.date).date()

            log_debug(f"Retrieving messages for date: {target_date}")

            if envelope is None:
                messages = await self.db_manager.get_messages_for_date(target_date=target_date)
            else:
                principal_id = self._local_session_principal(envelope)
                messages = await self.db_manager.get_messages_for_date_for_principal(
                    principal_id,
                    target_date,
                )

            messages_data = [
                self._session_message(msg)
                if isinstance(getattr(msg, "message_type", None), MessageType)
                else {
                    "role": msg.role,
                    "content": msg.content,
                    "timestamp": msg.timestamp.isoformat()
                    if hasattr(msg.timestamp, "isoformat")
                    else str(msg.timestamp),
                    "metadata": msg.metadata,
                }
                for msg in messages
            ]

            log_info(f"Retrieved {len(messages_data)} messages for date {target_date}")

            return DBGetMessagesResponse(
                messages=messages_data, total=len(messages_data), has_more=False
            )

        except Exception as e:
            log_error(f"Error retrieving messages for date: {e}", exc_info=True)
            return DBGetMessagesResponse(messages=[], total=0, has_more=False)

    @method_contract(
        method_id=DBMethods.SAVE_CRON_JOB,
        input_model=DBStoreCronJobRequest,
        output_model=EmptyOutput,
        summary="Store a cron job",
        exposure="internal",
        method_type="manage",
    )
    async def store_cron_job(self, cmd: DBStoreCronJobRequest) -> EmptyOutput:
        """Handle store cron job command."""
        try:
            log_info(f"Storing cron job: {cmd.name} ({cmd.schedule})")

            # Create CronJob object from command
            import uuid

            job = CronJob(
                id=str(uuid.uuid4()),
                name=cmd.name,
                schedule_type=ScheduleType.CRON,  # Assuming cron format
                schedule_value=cmd.schedule,
                next_run_time=None,  # Will be calculated by scheduler
                callback_module="",  # Will be set from action
                callback_function=cmd.action,
                is_active=cmd.enabled,
                status=JobStatus.PENDING,
            )

            # Store in scheduler database
            success = await self.scheduler_db.add_job(job)

            if success:
                log_debug(f"Cron job '{cmd.name}' stored successfully")
            else:
                log_warning(f"Failed to store cron job '{cmd.name}'")

            return EmptyOutput()

        except Exception as e:
            log_error(f"Error storing cron job: {e}", exc_info=True)
            return EmptyOutput()

    @method_contract(
        method_id=DBMethods.GET_CRON_JOBS,
        input_model=DBGetCronJobsRequest,
        output_model=DBGetCronJobsResponse,
        summary="Get cron jobs",
        exposure="internal",
        method_type="use",
    )
    async def get_cron_jobs(self, query: DBGetCronJobsRequest) -> DBGetCronJobsResponse:
        """Handle get cron jobs query."""
        try:
            log_debug("Retrieving cron jobs")

            # Get jobs from scheduler database
            if query.enabled_only:
                jobs = await self.scheduler_db.get_active_jobs()
            else:
                jobs = await self.scheduler_db.get_all_jobs()

            # Convert to dict format for serialization
            jobs_data = [job.to_dict() for job in jobs]

            log_debug(f"Retrieved {len(jobs_data)} cron jobs")
            return DBGetCronJobsResponse(jobs=jobs_data)

        except Exception as e:
            log_error(f"Error retrieving cron jobs: {e}", exc_info=True)
            return DBGetCronJobsResponse(jobs=[])

    @method_contract(
        method_id=DBMethods.DELETE_CRON_JOB,
        input_model=DBDeleteCronJobRequest,
        output_model=EmptyOutput,
        summary="Delete a cron job",
        exposure="internal",
        method_type="manage",
    )
    async def delete_cron_job(self, cmd: DBDeleteCronJobRequest) -> EmptyOutput:
        """Handle delete cron job command."""
        try:
            log_info(f"Deleting cron job: {cmd.job_id}")

            # Delete from scheduler database
            success = await self.scheduler_db.delete_job(str(cmd.job_id))

            if success:
                log_debug(f"Cron job {cmd.job_id} deleted successfully")
            else:
                log_warning(f"Failed to delete cron job {cmd.job_id}")

            return EmptyOutput()

        except Exception as e:
            log_error(f"Error deleting cron job: {e}", exc_info=True)
            return EmptyOutput()

    @method_contract(
        method_id=DBMethods.RAG_STORE,
        input_model=DBRAGStoreRequest,
        output_model=EmptyOutput,
        summary="Store item in RAG",
        exposure="internal",
        method_type="use",
    )
    async def rag_store(self, cmd: DBRAGStoreRequest) -> EmptyOutput:
        """Handle RAG store command."""
        try:
            log_debug(f"Storing RAG item: {cmd.namespace}/{cmd.key}")
            if not self.rag_service.is_initialized:
                log_debug("Skipping RAG store because RAG stores are disabled or unavailable")
                return EmptyOutput()

            namespace_tuple = self._namespace_to_tuple(cmd.namespace)

            # Get the appropriate store based on namespace
            store = self.rag_service.combined_store
            store.put(namespace_tuple, cmd.key, cmd.value, cmd.index)

            log_debug(f"RAG item stored successfully: {cmd.namespace}/{cmd.key}")
            return EmptyOutput()

        except Exception as e:
            log_error(f"Error storing RAG item: {e}", exc_info=True)
            return EmptyOutput()

    @method_contract(
        method_id=DBMethods.RAG_DELETE,
        input_model=DBRAGDeleteRequest,
        output_model=EmptyOutput,
        summary="Delete item from RAG",
        exposure="internal",
        method_type="manage",
    )
    async def rag_delete(self, cmd: DBRAGDeleteRequest) -> EmptyOutput:
        """Handle RAG delete command."""
        try:
            log_debug(f"Deleting RAG item: {cmd.namespace}/{cmd.key}")
            if not self.rag_service.is_initialized:
                log_debug("Skipping RAG delete because RAG stores are disabled or unavailable")
                return EmptyOutput()

            namespace_tuple = self._namespace_to_tuple(cmd.namespace)

            # Get the appropriate store based on namespace
            store = self.rag_service.combined_store
            store.delete(namespace_tuple, cmd.key)

            log_debug(f"RAG item deleted successfully: {cmd.namespace}/{cmd.key}")
            return EmptyOutput()

        except Exception as e:
            log_error(f"Error deleting RAG item: {e}", exc_info=True)
            return EmptyOutput()

    @method_contract(
        method_id=DBMethods.RAG_SEARCH,
        input_model=DBRAGSearchRequest,
        output_model=DBRAGListResponse,
        summary="Search RAG store",
        exposure="internal",
        method_type="use",
    )
    async def rag_search(self, query: DBRAGSearchRequest) -> DBRAGListResponse:
        """Handle RAG search query."""
        try:
            log_debug(
                f"Searching RAG store: namespace={query.namespace}, query='{query.query}', limit={query.limit}"
            )
            if not self.rag_service.is_initialized:
                log_debug(
                    "Returning empty RAG search because RAG stores are disabled or unavailable"
                )
                return DBRAGListResponse(items=[])

            namespace_tuple = self._namespace_to_tuple(query.namespace)

            # Get the appropriate store based on namespace
            store = self.rag_service.combined_store
            items = store.search(
                namespace_tuple, query=query.query, limit=query.limit, offset=query.offset
            )

            # Convert items to response format
            rag_items = []
            for item in items:
                search_score = None
                if isinstance(item.value, dict) and "_search_score" in item.value:
                    search_score = item.value.pop("_search_score")
                # Convert tuple namespace to string (contract expects string)
                namespace_str = (
                    ".".join(item.namespace)
                    if isinstance(item.namespace, tuple)
                    else item.namespace
                )
                rag_items.append(
                    DBRAGItemResponse(
                        value=item.value,
                        key=item.key,
                        namespace=namespace_str,
                        search_score=search_score,
                    )
                )

            return DBRAGListResponse(items=rag_items)

        except Exception as e:
            log_error(f"Error searching RAG store: {e}", exc_info=True)
            return DBRAGListResponse(items=[])

    @method_contract(
        method_id=DBMethods.RAG_GET,
        input_model=DBRAGGetRequest,
        output_model=DBRAGItemResponse,
        summary="Get RAG item",
        exposure="internal",
        method_type="use",
    )
    async def rag_get(self, query: DBRAGGetRequest) -> DBRAGItemResponse | None:
        """Handle RAG get query."""
        try:
            log_debug(f"Getting RAG item: {query.namespace}/{query.key}")
            if not self.rag_service.is_initialized:
                log_debug("Returning no RAG item because RAG stores are disabled or unavailable")
                return None

            namespace_tuple = self._namespace_to_tuple(query.namespace)

            # Get the appropriate store based on namespace
            store = self.rag_service.combined_store
            item = store.get(namespace_tuple, query.key)

            if item:
                # Convert tuple namespace to string (contract expects string)
                namespace_str = (
                    ".".join(item.namespace)
                    if isinstance(item.namespace, tuple)
                    else item.namespace
                )
                return DBRAGItemResponse(
                    value=item.value, key=item.key, namespace=namespace_str, search_score=None
                )
            return None

        except Exception as e:
            log_error(f"Error getting RAG item: {e}", exc_info=True)
            return None

    @method_contract(
        method_id=DBMethods.RAG_LIST,
        input_model=DBRAGListRequest,
        output_model=DBRAGListResponse,
        summary="List RAG items",
        exposure="internal",
        method_type="use",
    )
    async def rag_list(self, query: DBRAGListRequest) -> DBRAGListResponse:
        """Handle RAG list query."""
        try:
            log_debug(
                f"Listing RAG items: namespace={query.namespace}, limit={query.limit}, offset={query.offset}"
            )
            if not self.rag_service.is_initialized:
                log_debug("Returning empty RAG list because RAG stores are disabled or unavailable")
                return DBRAGListResponse(items=[])

            namespace_tuple = self._namespace_to_tuple(query.namespace)

            # Get the appropriate store based on namespace
            store = self.rag_service.combined_store
            items = store.retrieve_items(namespace_tuple, limit=query.limit, offset=query.offset)

            # Convert items to response format
            rag_items = []
            for item in items:
                # Convert tuple namespace to string (contract expects string)
                namespace_str = (
                    ".".join(item.namespace)
                    if isinstance(item.namespace, tuple)
                    else item.namespace
                )
                rag_items.append(
                    DBRAGItemResponse(
                        value=item.value, key=item.key, namespace=namespace_str, search_score=None
                    )
                )

            return DBRAGListResponse(items=rag_items)

        except Exception as e:
            log_error(f"Error listing RAG items: {e}", exc_info=True)
            return DBRAGListResponse(items=[])

    @method_contract(
        method_id=DBMethods.RAG_LIST_NAMESPACES,
        input_model=DBRAGListNamespacesRequest,
        output_model=DBRAGListNamespacesResponse,
        summary="List policy-aware RAG namespaces",
        exposure="both",
        method_type="use",
        required_perms=["DB.RAGSearch"],
        callable_feature_ids=["rag_discovery"],
    )
    async def rag_list_namespaces(
        self, query: DBRAGListNamespacesRequest
    ) -> DBRAGListNamespacesResponse:
        """Return local RAG namespace catalog entries with sharing policy metadata."""
        try:
            known_namespaces = ["main.memories", "tools"]
            namespaces: list[DBRAGNamespaceInfo] = []
            for namespace in known_namespaces:
                if query.namespace_prefix and not namespace.startswith(query.namespace_prefix):
                    continue
                policy = self._namespace_policy(namespace)
                record_count: int | None = None
                availability = "available" if self.rag_service.is_initialized else "unavailable"
                if self.rag_service.is_initialized:
                    try:
                        items = self.rag_service.combined_store.retrieve_items(
                            self._namespace_to_tuple(namespace), limit=1_000, offset=0
                        )
                        record_count = len(items)
                    except Exception:
                        availability = "unavailable"
                namespaces.append(
                    DBRAGNamespaceInfo(
                        namespace=namespace,
                        source_peer_id="local",
                        owner_peer_id="local",
                        provider_peer_id="local",
                        availability=availability,
                        policy=policy,
                        record_count=record_count,
                    )
                )
            return DBRAGListNamespacesResponse(namespaces=namespaces)
        except Exception as e:
            log_error(f"Error listing RAG namespaces: {e}", exc_info=True)
            return DBRAGListNamespacesResponse(namespaces=[])

    @method_contract(
        method_id=DBMethods.RAG_SEARCH_REMOTE,
        input_model=DBRAGSearchRemoteRequest,
        output_model=DBRAGSearchRemoteResponse,
        summary="Policy-enforced remote RAG search",
        exposure="both",
        method_type="use",
        required_perms=["DB.RAGSearch"],
        callable_feature_ids=["rag_discovery"],
    )
    async def rag_search_remote(self, query: DBRAGSearchRemoteRequest) -> DBRAGSearchRemoteResponse:
        """Search RAG with explicit remote namespace policy and provenance."""
        policy_decision_id = self._new_policy_decision_id(query.policy_decision_id)
        correlation_id = self._new_correlation_id(query.correlation_id)
        allowed, denial_reason, _policy = self._validate_rag_access(
            query.namespace,
            query.mesh_selector,
            operation="search",
            require_explicit_selector=True,
        )
        if not allowed:
            return DBRAGSearchRemoteResponse(
                decision="denied",
                items=[],
                denial_reason=denial_reason,
                policy_decision_id=policy_decision_id,
                correlation_id=correlation_id,
            )
        if not self.rag_service.is_initialized:
            return DBRAGSearchRemoteResponse(
                decision="unavailable",
                items=[],
                denial_reason="RAG stores are disabled or unavailable",
                policy_decision_id=policy_decision_id,
                correlation_id=correlation_id,
            )

        try:
            namespace_tuple = self._namespace_to_tuple(query.namespace)
            store = self.rag_service.combined_store
            items = store.search(
                namespace_tuple, query=query.query, limit=query.limit, offset=query.offset
            )
            provenance_items = [
                self._to_provenance_item(
                    item,
                    policy_decision_id=policy_decision_id,
                    correlation_id=correlation_id,
                    origin_principal_id=query.caller_principal_id,
                )
                for item in items
            ]
            return DBRAGSearchRemoteResponse(
                decision="allowed",
                items=provenance_items,
                policy_decision_id=policy_decision_id,
                correlation_id=correlation_id,
            )
        except Exception as e:
            log_error(f"Error in remote RAG search: {e}", exc_info=True)
            return DBRAGSearchRemoteResponse(
                decision="unavailable",
                items=[],
                denial_reason="RAG search failed",
                policy_decision_id=policy_decision_id,
                correlation_id=correlation_id,
            )

    @method_contract(
        method_id=DBMethods.RAG_GET_PROVENANCE,
        input_model=DBRAGGetProvenanceRequest,
        output_model=DBRAGGetProvenanceResponse,
        summary="Get RAG item provenance",
        exposure="both",
        method_type="use",
        required_perms=["DB.RAGSearch"],
        callable_feature_ids=["rag_discovery"],
    )
    async def rag_get_provenance(
        self, query: DBRAGGetProvenanceRequest
    ) -> DBRAGGetProvenanceResponse:
        """Return provenance for one RAG item without exposing raw internal metadata."""
        allowed, denial_reason, _policy = self._validate_rag_access(
            query.namespace, query.mesh_selector, operation="provenance"
        )
        if not allowed:
            return DBRAGGetProvenanceResponse(
                provenance=None, decision="denied", denial_reason=denial_reason
            )
        if not self.rag_service.is_initialized:
            return DBRAGGetProvenanceResponse(
                provenance=None,
                decision="unavailable",
                denial_reason="RAG stores are disabled or unavailable",
            )

        try:
            namespace_tuple = self._namespace_to_tuple(query.namespace)
            item = self.rag_service.combined_store.get(namespace_tuple, query.key)
            if item is None:
                return DBRAGGetProvenanceResponse(
                    provenance=None, decision="unavailable", denial_reason="record not found"
                )
            policy_decision_id = self._new_policy_decision_id()
            correlation_id = self._new_correlation_id(query.correlation_id)
            provenance = self._build_provenance(
                namespace=query.namespace,
                key=query.key,
                value=item.value,
                item=item,
                policy_decision_id=policy_decision_id,
                correlation_id=correlation_id,
            )
            return DBRAGGetProvenanceResponse(provenance=provenance)
        except Exception as e:
            log_error(f"Error getting RAG provenance: {e}", exc_info=True)
            return DBRAGGetProvenanceResponse(
                provenance=None, decision="unavailable", denial_reason="provenance lookup failed"
            )

    @method_contract(
        method_id=DBMethods.RAG_EXPORT_NAMESPACE,
        input_model=DBRAGExportNamespaceRequest,
        output_model=DBRAGExportNamespaceResponse,
        summary="Export a RAG namespace snapshot with provenance",
        exposure="both",
        method_type="manage",
        required_perms=["DB.manage"],
        callable_feature_ids=["rag_transfer"],
    )
    async def rag_export_namespace(
        self, query: DBRAGExportNamespaceRequest
    ) -> DBRAGExportNamespaceResponse:
        """Export a bounded, redacted RAG namespace snapshot."""
        policy_decision_id = self._new_policy_decision_id(query.policy_decision_id)
        correlation_id = self._new_correlation_id(query.correlation_id)
        namespace = self._namespace_to_string(query.namespace)
        allowed, denial_reason, _policy = self._validate_rag_access(
            namespace, query.mesh_selector, operation="export"
        )
        if not allowed:
            return DBRAGExportNamespaceResponse(
                decision="denied",
                namespace=namespace,
                source_peer_id="local",
                owner_peer_id="local",
                records=[],
                denial_reason=denial_reason,
                policy_decision_id=policy_decision_id,
                correlation_id=correlation_id,
            )
        if not self.rag_service.is_initialized:
            return DBRAGExportNamespaceResponse(
                decision="unavailable",
                namespace=namespace,
                source_peer_id="local",
                owner_peer_id="local",
                records=[],
                denial_reason="RAG stores are disabled or unavailable",
                policy_decision_id=policy_decision_id,
                correlation_id=correlation_id,
            )

        try:
            items = self.rag_service.combined_store.retrieve_items(
                self._namespace_to_tuple(namespace), limit=query.limit, offset=query.offset
            )
            records: list[DBRAGExportRecord] = []
            tombstone_count = 0
            for item in items:
                provenance_item = self._to_provenance_item(
                    item,
                    policy_decision_id=policy_decision_id,
                    correlation_id=correlation_id,
                    origin_principal_id=query.caller_principal_id,
                )
                if provenance_item.provenance.tombstone:
                    tombstone_count += 1
                    if not query.include_tombstones:
                        continue
                records.append(
                    DBRAGExportRecord(
                        key=provenance_item.key,
                        value=provenance_item.value,
                        provenance=provenance_item.provenance,
                        redacted=provenance_item.redacted,
                        redaction_reasons=provenance_item.redaction_reasons,
                    )
                )
            return DBRAGExportNamespaceResponse(
                decision="allowed",
                namespace=namespace,
                source_peer_id="local",
                owner_peer_id="local",
                records=records,
                tombstone_count=tombstone_count,
                policy_decision_id=policy_decision_id,
                correlation_id=correlation_id,
            )
        except Exception as e:
            log_error(f"Error exporting RAG namespace: {e}", exc_info=True)
            return DBRAGExportNamespaceResponse(
                decision="unavailable",
                namespace=namespace,
                source_peer_id="local",
                owner_peer_id="local",
                records=[],
                denial_reason="RAG namespace export failed",
                policy_decision_id=policy_decision_id,
                correlation_id=correlation_id,
            )

    @method_contract(
        method_id=DBMethods.RAG_IMPORT_NAMESPACE,
        input_model=DBRAGImportNamespaceRequest,
        output_model=DBRAGImportNamespaceResponse,
        summary="Import a RAG namespace snapshot with provenance",
        exposure="both",
        method_type="manage",
        required_perms=["DB.manage"],
        callable_feature_ids=["rag_transfer"],
    )
    async def rag_import_namespace(
        self, cmd: DBRAGImportNamespaceRequest
    ) -> DBRAGImportNamespaceResponse:
        """Import a provenance-preserving RAG namespace snapshot."""
        policy_decision_id = self._new_policy_decision_id(cmd.policy_decision_id)
        correlation_id = self._new_correlation_id(cmd.correlation_id)
        import_operation_id = f"rag-import-{uuid4()}"
        target_namespace = self._namespace_to_string(cmd.target_namespace)
        allowed, denial_reason, _policy = self._validate_rag_access(
            target_namespace, cmd.mesh_selector, operation="import"
        )
        if not allowed:
            return DBRAGImportNamespaceResponse(
                decision="denied",
                imported_count=0,
                skipped_count=len(cmd.records),
                target_namespace=target_namespace,
                import_operation_id=import_operation_id,
                denial_reason=denial_reason,
                policy_decision_id=policy_decision_id,
                correlation_id=correlation_id,
            )
        if not self.rag_service.is_initialized:
            return DBRAGImportNamespaceResponse(
                decision="unavailable",
                imported_count=0,
                skipped_count=len(cmd.records),
                target_namespace=target_namespace,
                import_operation_id=import_operation_id,
                denial_reason="RAG stores are disabled or unavailable",
                policy_decision_id=policy_decision_id,
                correlation_id=correlation_id,
            )

        try:
            target_tuple = self._namespace_to_tuple(target_namespace)
            existing = self.rag_service.combined_store.retrieve_items(
                target_tuple, limit=1, offset=0
            )
            if existing and not cmd.allow_owner_overwrite:
                return DBRAGImportNamespaceResponse(
                    decision="conflict",
                    imported_count=0,
                    skipped_count=len(cmd.records),
                    target_namespace=target_namespace,
                    import_operation_id=import_operation_id,
                    denial_reason=(
                        "target namespace already has records; set allow_owner_overwrite "
                        "to import intentionally"
                    ),
                    policy_decision_id=policy_decision_id,
                    correlation_id=correlation_id,
                )

            imported = 0
            skipped = 0
            store = self.rag_service.combined_store
            for record in cmd.records:
                if record.provenance.owner_peer_id != cmd.owner_peer_id:
                    skipped += 1
                    continue
                value = self._value_for_import(
                    record,
                    target_namespace=target_namespace,
                    import_operation_id=import_operation_id,
                )
                store.put(target_tuple, record.key, value, index=True)
                imported += 1
            return DBRAGImportNamespaceResponse(
                decision="allowed",
                imported_count=imported,
                skipped_count=skipped,
                target_namespace=target_namespace,
                import_operation_id=import_operation_id,
                policy_decision_id=policy_decision_id,
                correlation_id=correlation_id,
            )
        except Exception as e:
            log_error(f"Error importing RAG namespace: {e}", exc_info=True)
            return DBRAGImportNamespaceResponse(
                decision="unavailable",
                imported_count=0,
                skipped_count=len(cmd.records),
                target_namespace=target_namespace,
                import_operation_id=import_operation_id,
                denial_reason="RAG namespace import failed",
                policy_decision_id=policy_decision_id,
                correlation_id=correlation_id,
            )

    # ── User CRUD ────────────────────────────────────────────────────────

    @method_contract(
        method_id=DBMethods.CREATE_USER,
        input_model=DBCreateUserRequest,
        output_model=DBBoolResponse,
        summary="Create a user",
        exposure="internal",
        method_type="manage",
    )
    async def create_user(self, cmd: DBCreateUserRequest) -> DBBoolResponse:
        """Create a new user."""
        try:
            from datetime import datetime

            user = User(
                id=cmd.id,
                username=cmd.username,
                password_hash=cmd.password_hash,
                role=cmd.role,
                permissions=cmd.permissions or [],
                is_admin=cmd.is_admin,
                created_at=datetime.fromisoformat(cmd.created_at) if cmd.created_at else None,
            )
            success = await self.db_manager.create_user(user)
            return DBBoolResponse(success=success)
        except Exception as e:
            log_error(f"Error creating user: {e}", exc_info=True)
            return DBBoolResponse(success=False)

    @method_contract(
        method_id=DBMethods.GET_USER_BY_USERNAME,
        input_model=DBGetUserByUsernameRequest,
        output_model=DBUserResponse,
        summary="Get a user by username",
        exposure="internal",
        method_type="use",
    )
    async def get_user_by_username(self, query: DBGetUserByUsernameRequest) -> DBUserResponse:
        """Get a user by username."""
        try:
            user = await self.db_manager.get_user_by_username(query.username)
            return DBUserResponse(user=user.to_dict() if user else None)
        except Exception as e:
            log_error(f"Error getting user by username: {e}", exc_info=True)
            return DBUserResponse(user=None)

    @method_contract(
        method_id=DBMethods.GET_USER_BY_ID,
        input_model=DBGetUserByIdRequest,
        output_model=DBUserResponse,
        summary="Get a user by ID",
        exposure="internal",
        method_type="use",
    )
    async def get_user_by_id(self, query: DBGetUserByIdRequest) -> DBUserResponse:
        """Get a user by ID."""
        try:
            user = await self.db_manager.get_user_by_id(query.user_id)
            return DBUserResponse(user=user.to_dict() if user else None)
        except Exception as e:
            log_error(f"Error getting user by ID: {e}", exc_info=True)
            return DBUserResponse(user=None)

    @method_contract(
        method_id=DBMethods.COUNT_USERS,
        input_model=DBCountUsersRequest,
        output_model=DBCountResponse,
        summary="Count total users",
        exposure="internal",
        method_type="use",
    )
    async def count_users(self, query: DBCountUsersRequest) -> DBCountResponse:
        """Count total users."""
        try:
            count = await self.db_manager.count_users()
            return DBCountResponse(count=count)
        except Exception as e:
            log_error(f"Error counting users: {e}", exc_info=True)
            return DBCountResponse(count=0)

    @method_contract(
        method_id=DBMethods.LIST_USERS,
        input_model=DBListUsersRequest,
        output_model=DBUserListResponse,
        summary="List all users",
        exposure="internal",
        method_type="use",
    )
    async def list_users(self, query: DBListUsersRequest) -> DBUserListResponse:
        """List all users."""
        try:
            users = await self.db_manager.list_users()
            return DBUserListResponse(users=[u.to_dict() for u in users])
        except Exception as e:
            log_error(f"Error listing users: {e}", exc_info=True)
            return DBUserListResponse(users=[])

    @method_contract(
        method_id=DBMethods.UPDATE_USER,
        input_model=DBUpdateUserRequest,
        output_model=DBAuthorityMutationResponse,
        summary="Update a user's fields",
        exposure="internal",
        method_type="manage",
    )
    async def update_user(self, cmd: DBUpdateUserRequest) -> DBAuthorityMutationResponse:
        """Update a user's fields."""
        try:
            success = await self.db_manager.update_user(cmd.user_id, **cmd.fields)
            return DBAuthorityMutationResponse(success=success)
        except MeshManagedAuthorityError:
            return DBAuthorityMutationResponse(
                success=False,
                error_code="mesh_managed_authority",
            )
        except Exception as e:
            log_error(f"Error updating user: {e}", exc_info=True)
            return DBAuthorityMutationResponse(success=False)

    @method_contract(
        method_id=DBMethods.DELETE_USER,
        input_model=DBDeleteUserRequest,
        output_model=DBAuthorityMutationResponse,
        summary="Delete a user",
        exposure="internal",
        method_type="manage",
    )
    async def delete_user(self, cmd: DBDeleteUserRequest) -> DBAuthorityMutationResponse:
        """Delete a user."""
        try:
            success = await self.db_manager.delete_user(cmd.user_id)
            return DBAuthorityMutationResponse(success=success)
        except MeshManagedAuthorityError:
            return DBAuthorityMutationResponse(
                success=False,
                error_code="mesh_managed_authority",
            )
        except Exception as e:
            log_error(f"Error deleting user: {e}", exc_info=True)
            return DBAuthorityMutationResponse(success=False)

    # ── Device CRUD ──────────────────────────────────────────────────────

    @method_contract(
        method_id=DBMethods.CREATE_DEVICE,
        input_model=DBCreateDeviceRequest,
        output_model=DBBoolResponse,
        summary="Create a device",
        exposure="internal",
        method_type="manage",
    )
    async def create_device(self, cmd: DBCreateDeviceRequest) -> DBBoolResponse:
        """Create a new device."""
        try:
            device = Device(
                id=cmd.id,
                user_id=cmd.user_id,
                name=cmd.name,
                public_key=cmd.public_key,
                is_trusted=cmd.is_trusted,
            )
            success = await self.db_manager.create_device(device)
            return DBBoolResponse(success=success)
        except Exception as e:
            log_error(f"Error creating device: {e}", exc_info=True)
            return DBBoolResponse(success=False)

    @method_contract(
        method_id=DBMethods.GET_DEVICE_BY_ID,
        input_model=DBGetDeviceByIdRequest,
        output_model=DBDeviceResponse,
        summary="Get a device by ID",
        exposure="internal",
        method_type="use",
    )
    async def get_device_by_id(self, query: DBGetDeviceByIdRequest) -> DBDeviceResponse:
        """Get a device by ID."""
        try:
            device = await self.db_manager.get_device_by_id(query.device_id)
            return DBDeviceResponse(device=device.to_dict() if device else None)
        except Exception as e:
            log_error(f"Error getting device by ID: {e}", exc_info=True)
            return DBDeviceResponse(device=None)

    @method_contract(
        method_id=DBMethods.LIST_DEVICES,
        input_model=DBListDevicesRequest,
        output_model=DBDeviceListResponse,
        summary="List devices, optionally filtered by user",
        exposure="internal",
        method_type="use",
    )
    async def list_devices(self, query: DBListDevicesRequest) -> DBDeviceListResponse:
        """List devices, optionally filtered by user."""
        try:
            if query.user_id:
                devices = await self.db_manager.get_devices_by_user(query.user_id)
            else:
                devices = await self.db_manager.list_devices()
            return DBDeviceListResponse(devices=[d.to_dict() for d in devices])
        except Exception as e:
            log_error(f"Error listing devices: {e}", exc_info=True)
            return DBDeviceListResponse(devices=[])

    @method_contract(
        method_id=DBMethods.DELETE_DEVICE,
        input_model=DBDeleteDeviceRequest,
        output_model=DBAuthorityMutationResponse,
        summary="Delete a device",
        exposure="internal",
        method_type="manage",
    )
    async def delete_device(self, cmd: DBDeleteDeviceRequest) -> DBAuthorityMutationResponse:
        """Delete a device."""
        try:
            success = await self.db_manager.delete_device(cmd.device_id)
            return DBAuthorityMutationResponse(success=success)
        except MeshManagedAuthorityError:
            return DBAuthorityMutationResponse(
                success=False,
                error_code="mesh_managed_authority",
            )
        except Exception as e:
            log_error(f"Error deleting device: {e}", exc_info=True)
            return DBAuthorityMutationResponse(success=False)

    # ── Token CRUD ───────────────────────────────────────────────────────

    @method_contract(
        method_id=DBMethods.CREATE_TOKEN,
        input_model=DBCreateTokenRequest,
        output_model=DBAuthorityMutationResponse,
        summary="Create a token",
        exposure="internal",
        method_type="manage",
    )
    async def create_token(self, cmd: DBCreateTokenRequest) -> DBAuthorityMutationResponse:
        """Create a new token."""
        try:
            from datetime import datetime

            token = Token(
                id=cmd.id,
                token_hash=cmd.token_hash,
                prefix=cmd.prefix,
                device_id=cmd.device_id,
                user_id=cmd.user_id,
                scopes=cmd.scopes or [],
                expires_at=datetime.fromisoformat(cmd.expires_at) if cmd.expires_at else None,
            )
            success = await self.db_manager.create_token(token)
            return DBAuthorityMutationResponse(success=success)
        except MeshManagedAuthorityError:
            return DBAuthorityMutationResponse(
                success=False,
                error_code="mesh_managed_authority",
            )
        except Exception as e:
            log_error(f"Error creating token: {e}", exc_info=True)
            return DBAuthorityMutationResponse(success=False)

    @method_contract(
        method_id=DBMethods.GET_TOKEN_BY_HASH,
        input_model=DBGetTokenByHashRequest,
        output_model=DBTokenResponse,
        summary="Get a token by hash",
        exposure="internal",
        method_type="use",
    )
    async def get_token_by_hash(self, query: DBGetTokenByHashRequest) -> DBTokenResponse:
        """Get a token by hash."""
        try:
            token = await self.db_manager.get_token_by_hash(query.token_hash)
            return DBTokenResponse(token=token.to_dict() if token else None)
        except Exception as e:
            log_error(f"Error getting token by hash: {e}", exc_info=True)
            return DBTokenResponse(token=None)

    @method_contract(
        method_id=DBMethods.GET_TOKEN_BY_ID,
        input_model=DBGetTokenByIdRequest,
        output_model=DBTokenResponse,
        summary="Get a token by ID",
        exposure="internal",
        method_type="use",
    )
    async def get_token_by_id(self, query: DBGetTokenByIdRequest) -> DBTokenResponse:
        """Get a token by ID."""
        try:
            token = await self.db_manager.get_token_by_id(query.token_id)
            return DBTokenResponse(token=token.to_dict() if token else None)
        except Exception as e:
            log_error(f"Error getting token by ID: {e}", exc_info=True)
            return DBTokenResponse(token=None)

    @method_contract(
        method_id=DBMethods.LIST_TOKENS,
        input_model=DBListTokensRequest,
        output_model=DBTokenListResponse,
        summary="List tokens, optionally filtered",
        exposure="internal",
        method_type="use",
    )
    async def list_tokens(self, query: DBListTokensRequest) -> DBTokenListResponse:
        """List tokens, optionally filtered by user and/or device."""
        try:
            tokens = await self.db_manager.list_tokens(
                user_id=query.user_id, device_id=query.device_id
            )
            return DBTokenListResponse(tokens=[t.to_dict() for t in tokens])
        except Exception as e:
            log_error(f"Error listing tokens: {e}", exc_info=True)
            return DBTokenListResponse(tokens=[])

    @method_contract(
        method_id=DBMethods.UPDATE_TOKEN_SCOPES,
        input_model=DBUpdateTokenScopesRequest,
        output_model=DBAuthorityMutationResponse,
        summary="Update token scopes",
        exposure="internal",
        method_type="manage",
    )
    async def update_token_scopes(
        self, cmd: DBUpdateTokenScopesRequest
    ) -> DBAuthorityMutationResponse:
        """Update the scopes of a token."""
        try:
            success = await self.db_manager.update_token_scopes(cmd.token_id, cmd.scopes)
            return DBAuthorityMutationResponse(success=success)
        except MeshManagedAuthorityError:
            return DBAuthorityMutationResponse(
                success=False,
                error_code="mesh_managed_authority",
            )
        except Exception as e:
            log_error(f"Error updating token scopes: {e}", exc_info=True)
            return DBAuthorityMutationResponse(success=False)

    @method_contract(
        method_id=DBMethods.APPROVE_MESH_PEER,
        input_model=DBApproveMeshPeerRequest,
        output_model=DBApproveMeshPeerResponse,
        summary="Atomically approve mesh peer trust rows and linked authority",
        exposure="internal",
        method_type="manage",
    )
    async def approve_mesh_peer(self, cmd: DBApproveMeshPeerRequest) -> DBApproveMeshPeerResponse:
        """Approve selected peer rows and their linked principals in one transaction."""
        try:
            (
                success,
                approved_rooms,
                authority_change,
            ) = await self.db_manager.approve_mesh_peer_with_authority(
                peer_id=cmd.peer_id,
                permissions=cmd.permissions,
                approved_by=cmd.approved_by,
                room_name=cmd.room_name,
            )
            return DBApproveMeshPeerResponse(
                success=success,
                approved_rooms=approved_rooms,
                authority_changes=(authority_change,) if authority_change else (),
            )
        except Exception as e:
            log_error(f"Error approving mesh peer: {e}", exc_info=True)
            return DBApproveMeshPeerResponse(success=False)

    @method_contract(
        method_id=DBMethods.UPDATE_MESH_PEER_PERMISSIONS,
        input_model=DBUpdateMeshPeerPermissionsRequest,
        output_model=DBAuthorityMutationResponse,
        summary="Atomically update an approved mesh peer's authority graph",
        exposure="internal",
        method_type="manage",
    )
    async def update_mesh_peer_permissions(
        self, cmd: DBUpdateMeshPeerPermissionsRequest
    ) -> DBAuthorityMutationResponse:
        """Update mesh peer, user, and token permissions in one transaction."""
        try:
            (
                success,
                authority_change,
            ) = await self.db_manager.update_mesh_peer_permissions_with_authority(
                cmd.peer_id, cmd.permissions
            )
            return DBAuthorityMutationResponse(
                success=success,
                authority_changes=(authority_change,) if authority_change else (),
            )
        except Exception as e:
            log_error(f"Error updating mesh peer permissions: {e}", exc_info=True)
            return DBAuthorityMutationResponse(success=False)

    @method_contract(
        method_id=DBMethods.DENY_MESH_PEER,
        input_model=DBDenyMeshPeerRequest,
        output_model=DBAuthorityMutationResponse,
        summary="Atomically deny mesh peer authority",
        exposure="internal",
        method_type="manage",
    )
    async def deny_mesh_peer(self, cmd: DBDenyMeshPeerRequest) -> DBAuthorityMutationResponse:
        try:
            success, change = await self.db_manager.deny_mesh_peer_with_authority(
                cmd.peer_id,
                room_name=cmd.room_name,
            )
            return DBAuthorityMutationResponse(
                success=success,
                authority_changes=(change,) if change else (),
            )
        except Exception as exc:
            log_error(f"Error denying mesh peer: {exc}", exc_info=True)
            return DBAuthorityMutationResponse(success=False)

    @method_contract(
        method_id=DBMethods.REMOVE_MESH_PEER,
        input_model=DBRemoveMeshPeerRequest,
        output_model=DBAuthorityMutationResponse,
        summary="Atomically remove mesh peer authority",
        exposure="internal",
        method_type="manage",
    )
    async def remove_mesh_peer(self, cmd: DBRemoveMeshPeerRequest) -> DBAuthorityMutationResponse:
        try:
            success, change = await self.db_manager.remove_mesh_peer_with_authority(
                cmd.peer_id,
                revoke_token=cmd.revoke_token,
            )
            return DBAuthorityMutationResponse(
                success=success,
                authority_changes=(change,) if change else (),
            )
        except Exception as exc:
            log_error(f"Error removing mesh peer: {exc}", exc_info=True)
            return DBAuthorityMutationResponse(success=False)

    @method_contract(
        method_id=DBMethods.PRUNE_ORPHANED_MESH_PEER_ROWS,
        input_model=DBPruneOrphanedMeshPeerRowsRequest,
        output_model=DBPruneOrphanedMeshPeerRowsResponse,
        summary="Prune old never-approved credentialless mesh peer rows",
        exposure="internal",
        method_type="manage",
    )
    async def prune_orphaned_mesh_peer_rows(
        self,
        cmd: DBPruneOrphanedMeshPeerRowsRequest,
    ) -> DBPruneOrphanedMeshPeerRowsResponse:
        return await self.db_manager.prune_orphaned_mesh_peer_rows(cmd)

    @method_contract(
        method_id=DBMethods.LINK_MESH_PEER_CREDENTIAL,
        input_model=DBLinkMeshPeerCredentialRequest,
        output_model=DBAuthorityMutationResponse,
        summary="Atomically link an issued mesh credential",
        exposure="internal",
        method_type="manage",
    )
    async def link_mesh_peer_credential(
        self, cmd: DBLinkMeshPeerCredentialRequest
    ) -> DBAuthorityMutationResponse:
        try:
            success, change = await self.db_manager.link_mesh_peer_credential_with_authority(
                peer_id=cmd.peer_id,
                token_id=cmd.token_id,
                device_id=cmd.device_id,
                user_id=cmd.user_id,
                room_name=cmd.room_name,
            )
            return DBAuthorityMutationResponse(
                success=success,
                authority_changes=(change,) if change else (),
            )
        except Exception as exc:
            log_error(f"Error linking mesh peer credential: {exc}", exc_info=True)
            return DBAuthorityMutationResponse(success=False)

    @method_contract(
        method_id=DBMethods.ISSUE_MESH_PEER_CREDENTIAL,
        input_model=DBIssueMeshPeerCredentialRequest,
        output_model=DBAuthorityMutationResponse,
        summary="Atomically issue and rotate an outbound mesh credential",
        exposure="internal",
        method_type="manage",
    )
    async def issue_mesh_peer_credential(
        self, cmd: DBIssueMeshPeerCredentialRequest
    ) -> DBAuthorityMutationResponse:
        try:
            from datetime import datetime

            user = User(
                id=cmd.user.id,
                username=cmd.user.username,
                password_hash=cmd.user.password_hash,
                role=cmd.user.role,
                permissions=cmd.user.permissions or [],
                is_admin=cmd.user.is_admin,
                created_at=datetime.fromisoformat(cmd.user.created_at)
                if cmd.user.created_at
                else None,
            )
            device = Device(
                id=cmd.device.id,
                user_id=cmd.device.user_id,
                name=cmd.device.name,
                public_key=cmd.device.public_key,
                is_trusted=cmd.device.is_trusted,
                created_at=datetime.fromisoformat(cmd.device.created_at)
                if cmd.device.created_at
                else None,
            )
            token = Token(
                id=cmd.token.id,
                token_hash=cmd.token.token_hash,
                prefix=cmd.token.prefix or "",
                device_id=cmd.token.device_id,
                user_id=cmd.token.user_id,
                scopes=cmd.token.scopes or [],
                expires_at=datetime.fromisoformat(cmd.token.expires_at)
                if cmd.token.expires_at
                else None,
                created_at=datetime.fromisoformat(cmd.token.created_at)
                if cmd.token.created_at
                else None,
            )
            success, change = await self.db_manager.issue_mesh_peer_credential_with_authority(
                peer_id=cmd.peer_id,
                room_name=cmd.room_name,
                user=user,
                device=device,
                token=token,
            )
            return DBAuthorityMutationResponse(
                success=success,
                authority_changes=(change,) if change else (),
            )
        except Exception as exc:
            log_error(f"Error issuing mesh peer credential: {exc}", exc_info=True)
            return DBAuthorityMutationResponse(success=False)

    @method_contract(
        method_id=DBMethods.GET_MESH_PEER_AUTHORITY_SNAPSHOT,
        input_model=DBGetMeshPeerAuthoritySnapshotRequest,
        output_model=DBGetMeshPeerAuthoritySnapshotResponse,
        summary="Read a stable secret-free mesh authority snapshot",
        exposure="internal",
        method_type="use",
    )
    async def get_mesh_peer_authority_snapshot(
        self, query: DBGetMeshPeerAuthoritySnapshotRequest
    ) -> DBGetMeshPeerAuthoritySnapshotResponse:
        try:
            authorities = await self.db_manager.get_mesh_peer_authority_snapshot(
                peer_id=query.peer_id
            )
            return DBGetMeshPeerAuthoritySnapshotResponse(authorities=authorities)
        except Exception as exc:
            log_error(f"Error reading mesh peer authority snapshot: {exc}", exc_info=True)
            raise

    @method_contract(
        method_id=DBMethods.UPSERT_MESH_PEER,
        input_model=DBUpsertMeshPeerRequest,
        output_model=DBBoolResponse,
        summary="Create or update mesh peer discovery metadata",
        exposure="internal",
        method_type="use",
    )
    async def upsert_mesh_peer(self, cmd: DBUpsertMeshPeerRequest) -> DBBoolResponse:
        success = await self.db_manager.upsert_mesh_peer(
            row_id=cmd.id,
            peer_id=cmd.peer_id,
            room_name=cmd.room_name,
            node_name=cmd.node_name,
            ip=cmd.ip,
            port=cmd.port,
        )
        return DBBoolResponse(success=success)

    @method_contract(
        method_id=DBMethods.SAVE_MESH_INBOUND_CREDENTIAL,
        input_model=DBSaveMeshInboundCredentialRequest,
        output_model=DBBoolResponse,
        summary="Save encrypted inbound mesh credential fields",
        exposure="internal",
        method_type="use",
    )
    async def save_mesh_inbound_credential(
        self, cmd: DBSaveMeshInboundCredentialRequest
    ) -> DBBoolResponse:
        success = await self.db_manager.save_mesh_inbound_credential(
            peer_id=cmd.peer_id,
            room_name=cmd.room_name,
            encrypted_token=cmd.encrypted_token,
            token_id=cmd.token_id,
            permissions=cmd.permissions,
            remote_device_id=cmd.remote_device_id,
            remote_user_id=cmd.remote_user_id,
            remote_node_name=cmd.remote_node_name,
        )
        return DBBoolResponse(success=success)

    @method_contract(
        method_id=DBMethods.UPDATE_MESH_PEER_CONNECTION,
        input_model=DBUpdateMeshPeerConnectionRequest,
        output_model=DBBoolResponse,
        summary="Update mesh peer connection metadata",
        exposure="internal",
        method_type="use",
    )
    async def update_mesh_peer_connection(
        self, cmd: DBUpdateMeshPeerConnectionRequest
    ) -> DBBoolResponse:
        success = await self.db_manager.update_mesh_peer_connection_status(
            cmd.peer_id,
            cmd.connection_status,
        )
        return DBBoolResponse(success=success)

    @method_contract(
        method_id=DBMethods.MATCH_MESH_OUTBOUND_CREDENTIAL,
        input_model=DBMatchMeshOutboundCredentialRequest,
        output_model=DBBoolResponse,
        summary="Match exact outbound mesh credential ownership",
        exposure="internal",
        method_type="use",
    )
    async def match_mesh_outbound_credential(
        self, query: DBMatchMeshOutboundCredentialRequest
    ) -> DBBoolResponse:
        matched = await self.db_manager.mesh_outbound_credential_matches(
            token_id=query.token_id,
            device_id=query.device_id,
            user_id=query.user_id,
            claimant_peer_id=query.claimant_peer_id,
            room_name=query.room_name,
        )
        return DBBoolResponse(success=matched)

    @method_contract(
        method_id=DBMethods.REVOKE_TOKEN,
        input_model=DBRevokeTokenRequest,
        output_model=DBAuthorityMutationResponse,
        summary="Revoke a token",
        exposure="internal",
        method_type="manage",
    )
    async def revoke_token(self, cmd: DBRevokeTokenRequest) -> DBAuthorityMutationResponse:
        """Revoke (delete) a token."""
        try:
            success, changes = await self.db_manager.revoke_token_with_authority(
                cmd.token_id,
                reject_mesh_linked=cmd.reject_mesh_linked,
            )
            return DBAuthorityMutationResponse(
                success=success,
                authority_changes=changes,
            )
        except MeshManagedAuthorityError:
            return DBAuthorityMutationResponse(
                success=False,
                error_code="mesh_managed_authority",
            )
        except Exception as e:
            log_error(f"Error revoking token: {e}", exc_info=True)
            return DBAuthorityMutationResponse(success=False)

    # ── Audit Log ────────────────────────────────────────────────────────

    @method_contract(
        method_id=DBMethods.GET_AUDIT_LOG,
        input_model=DBAuditLogRequest,
        output_model=DBAuditLogResponse,
        summary="Query the audit log",
        exposure="internal",
        method_type="use",
    )
    async def get_audit_log(self, query: DBAuditLogRequest) -> DBAuditLogResponse:
        """Query the audit log with optional filters."""
        try:
            events = await self.db_manager.get_audit_log(
                limit=query.limit,
                offset=query.offset,
                principal_id=query.principal_id,
                event=query.event,
            )
            # Count total matching events for pagination
            total = await self._count_audit_events(
                principal_id=query.principal_id, event=query.event
            )
            return DBAuditLogResponse(events=events, total=total)
        except Exception as e:
            log_error(f"Error getting audit log: {e}", exc_info=True)
            return DBAuditLogResponse(events=[], total=0)

    @method_contract(
        method_id=DBMethods.COUNT_AUDIT_EVENTS,
        input_model=DBCountAuditEventsRequest,
        output_model=DBCountResponse,
        summary="Count audit events matching filters",
        exposure="internal",
        method_type="use",
    )
    async def count_audit_events(self, query: DBCountAuditEventsRequest) -> DBCountResponse:
        """Count audit events matching filters."""
        try:
            count = await self._count_audit_events(
                principal_id=query.principal_id, event=query.event
            )
            return DBCountResponse(count=count)
        except Exception as e:
            log_error(f"Error counting audit events: {e}", exc_info=True)
            return DBCountResponse(count=0)

    async def _count_audit_events(
        self,
        principal_id: str | None = None,
        event: str | None = None,
    ) -> int:
        """Internal helper to count audit events matching filters."""
        try:
            async with database_connection(self.db_manager.db_path) as db:
                query_str = "SELECT COUNT(*) FROM audit_log WHERE 1=1"
                params: list[object] = []
                if event:
                    query_str += " AND event = ?"
                    params.append(event)
                if principal_id:
                    query_str += " AND principal_id = ?"
                    params.append(principal_id)
                cursor = await db.execute(query_str, params)
                result = await cursor.fetchone()
                return result[0] if result else 0
        except Exception as e:
            log_error(f"Error counting audit events: {e}")
            return 0

    # ── Mesh Credentials ─────────────────────────────────────────────────

    @method_contract(
        method_id=DBMethods.SAVE_MESH_CREDENTIAL,
        input_model=DBSaveMeshCredentialRequest,
        output_model=DBBoolResponse,
        summary="Save a mesh credential",
        exposure="internal",
        method_type="use",
    )
    async def save_mesh_credential(self, cmd: DBSaveMeshCredentialRequest) -> DBBoolResponse:
        """Save a mesh credential."""
        try:
            credential = MeshCredential(
                id=cmd.id,
                room_name=cmd.room_name,
                token=cmd.token,
                remote_device_id=cmd.remote_device_id,
                remote_user_id=cmd.remote_user_id,
            )
            success = await self.db_manager.save_mesh_credential(credential)
            return DBBoolResponse(success=success)
        except Exception as e:
            log_error(f"Error saving mesh credential: {e}", exc_info=True)
            return DBBoolResponse(success=False)

    @method_contract(
        method_id=DBMethods.GET_MESH_CREDENTIAL_BY_ROOM,
        input_model=DBGetMeshCredentialByRoomRequest,
        output_model=DBMeshCredentialResponse,
        summary="Get a mesh credential by room name",
        exposure="internal",
        method_type="use",
    )
    async def get_mesh_credential_by_room(
        self, query: DBGetMeshCredentialByRoomRequest
    ) -> DBMeshCredentialResponse:
        """Get a mesh credential by room name."""
        try:
            credential = await self.db_manager.get_mesh_credential_by_room(query.room_name)
            return DBMeshCredentialResponse(credential=credential.to_dict() if credential else None)
        except Exception as e:
            log_error(f"Error getting mesh credential: {e}", exc_info=True)
            return DBMeshCredentialResponse(credential=None)

    @method_contract(
        method_id=DBMethods.DELETE_MESH_CREDENTIAL,
        input_model=DBDeleteMeshCredentialRequest,
        output_model=DBBoolResponse,
        summary="Delete a mesh credential by room name",
        exposure="internal",
        method_type="manage",
    )
    async def delete_mesh_credential(self, cmd: DBDeleteMeshCredentialRequest) -> DBBoolResponse:
        """Delete a mesh credential by room name."""
        try:
            success = await self.db_manager.delete_mesh_credential(cmd.room_name)
            return DBBoolResponse(success=success)
        except Exception as e:
            log_error(f"Error deleting mesh credential: {e}", exc_info=True)
            return DBBoolResponse(success=False)

    # ── Durable Tooling identity ────────────────────────────────────────

    @method_contract(
        method_id=DBMethods.RECONCILE_TOOL_IDENTITY,
        input_model=DBReconcileToolIdentityRequest,
        output_model=DBReconcileToolIdentityResponse,
        summary="Atomically reconcile one Tooling identity and legacy aliases",
        exposure="internal",
        method_type="manage",
    )
    async def reconcile_tool_identity(
        self,
        cmd: DBReconcileToolIdentityRequest,
    ) -> DBReconcileToolIdentityResponse:
        """Persist identity and re-key dependent Tooling authority/cache state."""

        return await self.db_manager.reconcile_tool_identity(cmd)

    @method_contract(
        method_id=DBMethods.ALLOCATE_TOOL_IDENTITY,
        input_model=DBAllocateToolIdentityRequest,
        output_model=DBAllocateToolIdentityResponse,
        summary="Allocate/reuse one immutable legacy Tooling identity",
        exposure="internal",
        method_type="manage",
    )
    async def allocate_tool_identity(
        self, cmd: DBAllocateToolIdentityRequest
    ) -> DBAllocateToolIdentityResponse:
        """Persist a one-time ID for an unstamped local or legacy remote tool."""

        return await self.db_manager.allocate_tool_identity(cmd)

    @method_contract(
        method_id=DBMethods.RESOLVE_TOOL_IDENTITY_ALIASES,
        input_model=DBResolveToolIdentityAliasesRequest,
        output_model=DBResolveToolIdentityAliasesResponse,
        summary="Resolve durable Tooling aliases after restart",
        exposure="internal",
        method_type="use",
    )
    async def resolve_tool_identity_aliases(
        self, cmd: DBResolveToolIdentityAliasesRequest
    ) -> DBResolveToolIdentityAliasesResponse:
        """Map canonical and legacy IDs, omitting unknown/colliding identities."""

        return await self.db_manager.resolve_tool_identity_aliases(
            cmd.global_tool_ids, stable_peer_id=cmd.stable_peer_id
        )

    @method_contract(
        method_id=DBMethods.GET_TOOLING_EXPORT_POLICY_SNAPSHOT,
        input_model=DBGetToolingExportPolicySnapshotRequest,
        output_model=DBGetToolingExportPolicySnapshotResponse,
        summary="Read the atomic Tooling export authority snapshot",
        exposure="internal",
        method_type="manage",
    )
    async def get_tooling_export_policy_snapshot(
        self, cmd: DBGetToolingExportPolicySnapshotRequest
    ) -> DBGetToolingExportPolicySnapshotResponse:
        return await self.db_manager.get_tooling_export_policy_snapshot(cmd)

    @method_contract(
        method_id=DBMethods.MUTATE_TOOLING_EXPORT_POLICY,
        input_model=DBMutateToolingExportPolicyRequest,
        output_model=DBMutateToolingExportPolicyResponse,
        summary="Atomically mutate and audit Tooling export authority",
        exposure="internal",
        method_type="manage",
    )
    async def mutate_tooling_export_policy(
        self, cmd: DBMutateToolingExportPolicyRequest
    ) -> DBMutateToolingExportPolicyResponse:
        return await self.db_manager.mutate_tooling_export_policy(cmd)

    @method_contract(
        method_id=DBMethods.GET_TOOLING_MESH_SWITCHES,
        input_model=DBGetToolingMeshSwitchesRequest,
        output_model=DBGetToolingMeshSwitchesResponse,
        summary="Read persisted provider and consumer Tooling switches",
        exposure="internal",
        method_type="manage",
    )
    async def get_tooling_mesh_switches(
        self, _cmd: DBGetToolingMeshSwitchesRequest
    ) -> DBGetToolingMeshSwitchesResponse:
        return DBGetToolingMeshSwitchesResponse(
            switches=await self.db_manager.get_tooling_mesh_switches()
        )

    @method_contract(
        method_id=DBMethods.SET_TOOLING_MESH_SWITCHES,
        input_model=DBSetToolingMeshSwitchesRequest,
        output_model=DBSetToolingMeshSwitchesResponse,
        summary="Atomically persist bilateral Tooling switches",
        exposure="internal",
        method_type="manage",
    )
    async def set_tooling_mesh_switches(
        self, cmd: DBSetToolingMeshSwitchesRequest
    ) -> DBSetToolingMeshSwitchesResponse:
        return await self.db_manager.set_tooling_mesh_switches(cmd)

    @method_contract(
        method_id=DBMethods.BEGIN_TOOLING_REMOTE_CATALOG_SYNC,
        input_model=DBBeginToolingRemoteCatalogSyncRequest,
        output_model=DBBeginToolingRemoteCatalogSyncResponse,
        summary="Begin a non-bindable Tooling projection staging generation",
        exposure="internal",
        method_type="manage",
    )
    async def begin_tooling_remote_catalog_sync(
        self, cmd: DBBeginToolingRemoteCatalogSyncRequest
    ) -> DBBeginToolingRemoteCatalogSyncResponse:
        return await self.db_manager.begin_tooling_remote_catalog_sync(cmd)

    @method_contract(
        method_id=DBMethods.APPEND_TOOLING_REMOTE_CATALOG_PAGE,
        input_model=DBAppendToolingRemoteCatalogPageRequest,
        output_model=DBAppendToolingRemoteCatalogPageResponse,
        summary="Stage one bound Tooling projection page",
        exposure="internal",
        method_type="manage",
    )
    async def append_tooling_remote_catalog_page(
        self, cmd: DBAppendToolingRemoteCatalogPageRequest
    ) -> DBAppendToolingRemoteCatalogPageResponse:
        return await self.db_manager.append_tooling_remote_catalog_page(cmd)

    @method_contract(
        method_id=DBMethods.COMMIT_TOOLING_REMOTE_CATALOG_SYNC,
        input_model=DBCommitToolingRemoteCatalogSyncRequest,
        output_model=DBCommitToolingRemoteCatalogSyncResponse,
        summary="Verify and atomically promote a complete Tooling projection",
        exposure="internal",
        method_type="manage",
    )
    async def commit_tooling_remote_catalog_sync(
        self, cmd: DBCommitToolingRemoteCatalogSyncRequest
    ) -> DBCommitToolingRemoteCatalogSyncResponse:
        return await self.db_manager.commit_tooling_remote_catalog_sync(cmd)

    @method_contract(
        method_id=DBMethods.FINALIZE_TOOLING_REMOTE_CATALOG_POLICY,
        input_model=DBFinalizeToolingRemoteCatalogPolicyRequest,
        output_model=DBFinalizeToolingRemoteCatalogPolicyResponse,
        summary="Activate a committed Tooling catalog after durable policy reconciliation",
        exposure="internal",
        method_type="manage",
    )
    async def finalize_tooling_remote_catalog_policy(
        self, cmd: DBFinalizeToolingRemoteCatalogPolicyRequest
    ) -> DBFinalizeToolingRemoteCatalogPolicyResponse:
        return await self.db_manager.finalize_tooling_remote_catalog_policy(cmd)

    @method_contract(
        method_id=DBMethods.ABORT_TOOLING_REMOTE_CATALOG_SYNC,
        input_model=DBAbortToolingRemoteCatalogSyncRequest,
        output_model=DBAbortToolingRemoteCatalogSyncResponse,
        summary="Discard a non-bindable Tooling projection staging generation",
        exposure="internal",
        method_type="manage",
    )
    async def abort_tooling_remote_catalog_sync(
        self, cmd: DBAbortToolingRemoteCatalogSyncRequest
    ) -> DBAbortToolingRemoteCatalogSyncResponse:
        return await self.db_manager.abort_tooling_remote_catalog_sync(cmd)

    @method_contract(
        method_id=DBMethods.GET_TOOLING_REMOTE_CATALOG,
        input_model=DBGetToolingRemoteCatalogRequest,
        output_model=DBGetToolingRemoteCatalogResponse,
        summary="Read normalized committed Tooling projection state",
        exposure="internal",
        method_type="use",
    )
    async def get_tooling_remote_catalog(
        self, cmd: DBGetToolingRemoteCatalogRequest
    ) -> DBGetToolingRemoteCatalogResponse:
        return await self.db_manager.get_tooling_remote_catalog(cmd)

    @method_contract(
        method_id=DBMethods.SET_TOOLING_REMOTE_PROVIDER_AVAILABILITY,
        input_model=DBSetToolingRemoteProviderAvailabilityRequest,
        output_model=DBSetToolingRemoteProviderAvailabilityResponse,
        summary="Fail closed retained Tooling tools when provider authority is unavailable",
        exposure="internal",
        method_type="manage",
    )
    async def set_tooling_remote_provider_availability(
        self, cmd: DBSetToolingRemoteProviderAvailabilityRequest
    ) -> DBSetToolingRemoteProviderAvailabilityResponse:
        return await self.db_manager.set_tooling_remote_provider_availability(cmd)

    @method_contract(
        method_id=DBMethods.ACCEPT_TOOLING_REMOTE_TOOL_SCHEMA,
        input_model=DBAcceptToolingRemoteToolSchemaRequest,
        output_model=DBAcceptToolingRemoteToolSchemaResponse,
        summary="Accept one current verified remote Tooling schema after explicit review",
        exposure="internal",
        method_type="manage",
    )
    async def accept_tooling_remote_tool_schema(
        self, cmd: DBAcceptToolingRemoteToolSchemaRequest
    ) -> DBAcceptToolingRemoteToolSchemaResponse:
        return await self.db_manager.accept_tooling_remote_tool_schema(cmd)

    @method_contract(
        method_id=DBMethods.IMPORT_LEGACY_TOOLING_REMOTE_CATALOGS,
        input_model=DBImportLegacyToolingRemoteCatalogsRequest,
        output_model=DBImportLegacyToolingRemoteCatalogsResponse,
        summary="Import legacy Tooling JSON catalogs as stale management history",
        exposure="internal",
        method_type="manage",
    )
    async def import_legacy_tooling_remote_catalogs(
        self, cmd: DBImportLegacyToolingRemoteCatalogsRequest
    ) -> DBImportLegacyToolingRemoteCatalogsResponse:
        return await self.db_manager.import_legacy_tooling_remote_catalogs(cmd)

    @method_contract(
        method_id=DBMethods.RECOVER_TOOLING_REMOTE_CATALOGS,
        input_model=DBRecoverToolingRemoteCatalogsRequest,
        output_model=DBRecoverToolingRemoteCatalogsResponse,
        exposure="internal",
    )
    async def recover_tooling_remote_catalogs(
        self, cmd: DBRecoverToolingRemoteCatalogsRequest
    ) -> DBRecoverToolingRemoteCatalogsResponse:
        return await self.db_manager.recover_tooling_remote_catalogs(cmd)

    @method_contract(
        method_id=DBMethods.PRUNE_TOOLING_REMOTE_CATALOG_RETENTION,
        input_model=DBPruneToolingRemoteCatalogRetentionRequest,
        output_model=DBPruneToolingRemoteCatalogRetentionResponse,
        exposure="internal",
    )
    async def prune_tooling_remote_catalog_retention(
        self, cmd: DBPruneToolingRemoteCatalogRetentionRequest
    ) -> DBPruneToolingRemoteCatalogRetentionResponse:
        return await self.db_manager.prune_tooling_remote_catalog_retention(cmd)

    @method_contract(
        method_id=DBMethods.RESOLVE_TOOLING_REMOTE_TOOL_ALIASES,
        input_model=DBResolveToolingRemoteToolAliasesRequest,
        output_model=DBResolveToolingRemoteToolAliasesResponse,
        exposure="internal",
    )
    async def resolve_tooling_remote_tool_aliases(
        self, cmd: DBResolveToolingRemoteToolAliasesRequest
    ) -> DBResolveToolingRemoteToolAliasesResponse:
        return await self.db_manager.resolve_tooling_remote_tool_aliases(cmd)

    @method_contract(
        method_id=DBMethods.GET_TOOLING_MESH_ACTIVATION_STATE,
        input_model=DBGetToolingMeshActivationStateRequest,
        output_model=DBGetToolingMeshActivationStateResponse,
        summary="Read the durable atomic Tooling mesh activation state",
        exposure="internal",
        method_type="use",
    )
    async def get_tooling_mesh_activation_state(
        self, _query: DBGetToolingMeshActivationStateRequest
    ) -> DBGetToolingMeshActivationStateResponse:
        return await self.db_manager.get_tooling_mesh_activation_state()

    @method_contract(
        method_id=DBMethods.ACTIVATE_TOOLING_MESH_ENFORCEMENT,
        input_model=DBActivateToolingMeshEnforcementRequest,
        output_model=DBActivateToolingMeshEnforcementResponse,
        summary="Atomically activate G013 Tooling enforcement and retire the legacy guard",
        exposure="internal",
        method_type="manage",
    )
    async def activate_tooling_mesh_enforcement(
        self, cmd: DBActivateToolingMeshEnforcementRequest
    ) -> DBActivateToolingMeshEnforcementResponse:
        return await self.db_manager.activate_tooling_mesh_enforcement(cmd)

    @method_contract(
        method_id=DBMethods.GET_TOOLING_EXPOSURE_LEDGER,
        input_model=DBGetToolingExposureLedgerRequest,
        output_model=DBGetToolingExposureLedgerResponse,
        summary="Read recipient-scoped Tooling provider exposure history",
        exposure="internal",
        method_type="use",
    )
    async def get_tooling_exposure_ledger(
        self, query: DBGetToolingExposureLedgerRequest
    ) -> DBGetToolingExposureLedgerResponse:
        return await self.db_manager.get_tooling_exposure_ledger(query)

    @method_contract(
        method_id=DBMethods.RECORD_TOOLING_EXPOSURES,
        input_model=DBRecordToolingExposuresRequest,
        output_model=DBRecordToolingExposuresResponse,
        summary="Record tools actually serialized to one projection recipient",
        exposure="internal",
        method_type="manage",
    )
    async def record_tooling_exposures(
        self, cmd: DBRecordToolingExposuresRequest
    ) -> DBRecordToolingExposuresResponse:
        return await self.db_manager.record_tooling_exposures(cmd)

    # ── Generic SQL Execution ────────────────────────────────────────────

    @method_contract(
        method_id=DBMethods.EXECUTE_SQL,
        input_model=DBExecuteSQLRequest,
        output_model=DBExecuteSQLResponse,
        summary="Execute raw SQL (internal use only)",
        exposure="internal",
        method_type="manage",
    )
    async def execute_sql(self, cmd: DBExecuteSQLRequest) -> DBExecuteSQLResponse:
        """Execute arbitrary SQL for internal services (e.g. auth_manager).

        Supports both read (SELECT) and write (INSERT/UPDATE/DELETE) queries.
        Returns rows for SELECTs and rowcount for writes.
        """
        try:
            protected_error = _protected_authority_write_error(cmd.sql)
            if protected_error is not None:
                return DBExecuteSQLResponse(
                    rows=[],
                    rowcount=0,
                    success=False,
                    error=protected_error,
                )

            params = tuple(cmd.params) if cmd.params else ()
            async with database_connection(
                self.db_manager.db_path, row_factory=aiosqlite.Row
            ) as db:
                cursor = await db.execute(cmd.sql, params)

                # Detect if this is a SELECT (returns rows)
                sql_stripped = cmd.sql.strip().upper()
                if sql_stripped.startswith("SELECT"):
                    rows = await cursor.fetchall()
                    return DBExecuteSQLResponse(
                        rows=[dict(row) for row in rows],
                        rowcount=len(rows),
                        success=True,
                    )
                else:
                    await db.commit()
                    return DBExecuteSQLResponse(
                        rows=[],
                        rowcount=cursor.rowcount,
                        success=True,
                    )
        except Exception as e:
            log_error(f"Error executing SQL: {e}", exc_info=True)
            return DBExecuteSQLResponse(rows=[], rowcount=0, success=False, error=str(e))
