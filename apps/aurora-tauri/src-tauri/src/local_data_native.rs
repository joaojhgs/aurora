use crate::{generated, AuroraCommandError};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Number, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_double, c_int, c_void};
use std::path::PathBuf;
use std::ptr;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MAX_JSON_DEPTH: usize = 32;
const MAX_JSON_STRING_BYTES: usize = 64 * 1024;
const MAX_JSON_ARRAY_ITEMS: usize = 1024;
const MAX_JSON_OBJECT_KEYS: usize = 256;
const MAX_CONVERSATIONS: usize = 10_000;
const MAX_MESSAGES: usize = 100_000;
const MAX_MEMORY_ITEMS: usize = 50_000;
const MAX_LOCAL_TOOL_STATES: usize = 10_000;
const MAX_PEER_GRANT_METADATA: usize = 50_000;
const MAX_LOCAL_AUDIT: usize = 100_000;
const MAX_TRANSCRIPT_SESSIONS: usize = 5_000;
const MAX_TRANSCRIPT_SEGMENTS: usize = 100_000;
const MAX_TRANSCRIPT_SESSION_QUERY: usize = 500;
const MAX_TRANSCRIPT_SEGMENT_QUERY: usize = 2_000;
const MAX_TRANSCRIPT_DELETE_LIMIT: usize = 1_000;

const SQLITE_OK: c_int = 0;
const SQLITE_ROW: c_int = 100;
const SQLITE_DONE: c_int = 101;
const SQLITE_INTEGER: c_int = 1;
const SQLITE_FLOAT: c_int = 2;
const SQLITE_TEXT: c_int = 3;
const SQLITE_NULL: c_int = 5;
const SQLITE_OPEN_READONLY: c_int = 0x0000_0001;
const SQLITE_OPEN_READWRITE: c_int = 0x0000_0002;
const SQLITE_OPEN_CREATE: c_int = 0x0000_0004;
const SQLITE_OPEN_FULLMUTEX: c_int = 0x0001_0000;

#[repr(C)]
struct sqlite3 {
    _private: [u8; 0],
}

#[repr(C)]
struct sqlite3_stmt {
    _private: [u8; 0],
}

extern "C" {
    fn sqlite3_open_v2(
        filename: *const c_char,
        pp_db: *mut *mut sqlite3,
        flags: c_int,
        z_vfs: *const c_char,
    ) -> c_int;
    fn sqlite3_close(db: *mut sqlite3) -> c_int;
    fn sqlite3_exec(
        db: *mut sqlite3,
        sql: *const c_char,
        callback: Option<
            unsafe extern "C" fn(*mut c_void, c_int, *mut *mut c_char, *mut *mut c_char) -> c_int,
        >,
        arg: *mut c_void,
        errmsg: *mut *mut c_char,
    ) -> c_int;
    fn sqlite3_free(ptr: *mut c_void);
    fn sqlite3_errmsg(db: *mut sqlite3) -> *const c_char;
    fn sqlite3_prepare_v2(
        db: *mut sqlite3,
        sql: *const c_char,
        n_byte: c_int,
        pp_stmt: *mut *mut sqlite3_stmt,
        pz_tail: *mut *const c_char,
    ) -> c_int;
    fn sqlite3_step(stmt: *mut sqlite3_stmt) -> c_int;
    fn sqlite3_finalize(stmt: *mut sqlite3_stmt) -> c_int;
    fn sqlite3_bind_null(stmt: *mut sqlite3_stmt, index: c_int) -> c_int;
    fn sqlite3_bind_int64(stmt: *mut sqlite3_stmt, index: c_int, value: i64) -> c_int;
    fn sqlite3_bind_double(stmt: *mut sqlite3_stmt, index: c_int, value: c_double) -> c_int;
    fn sqlite3_bind_text(
        stmt: *mut sqlite3_stmt,
        index: c_int,
        value: *const c_char,
        n: c_int,
        destructor: unsafe extern "C" fn(*mut c_void),
    ) -> c_int;
    fn sqlite3_column_count(stmt: *mut sqlite3_stmt) -> c_int;
    fn sqlite3_column_name(stmt: *mut sqlite3_stmt, index: c_int) -> *const c_char;
    fn sqlite3_column_type(stmt: *mut sqlite3_stmt, index: c_int) -> c_int;
    fn sqlite3_column_int64(stmt: *mut sqlite3_stmt, index: c_int) -> i64;
    fn sqlite3_column_double(stmt: *mut sqlite3_stmt, index: c_int) -> c_double;
    fn sqlite3_column_text(stmt: *mut sqlite3_stmt, index: c_int) -> *const c_char;
}

#[derive(Default, Clone)]
pub(crate) struct LocalDataCommandState {
    inner: Arc<Mutex<LocalDataState>>,
}

#[derive(Default)]
struct LocalDataState {
    profile_id: Option<String>,
    local_node_id: Option<String>,
    schema_version: Option<u32>,
    active_transaction: Option<ActiveTransaction>,
    recovered_transcript_scopes: HashSet<String>,
    scope_generation: u64,
}

impl LocalDataCommandState {
    /// Native recording owns its selected-profile lease independently of a
    /// renderer's open/close lifecycle. The caller supplies only identities
    /// captured by the native policy owner and a typed archive write.
    pub(crate) fn native_transcript_write(
        &self,
        app: &AppHandle,
        profile_id: &str,
        local_node_id: &str,
        write: NativeTranscriptArchiveWrite,
    ) -> Result<Value, AuroraCommandError> {
        self.native_transcript_write_at_path(
            local_data_db_path_without_create(app)?,
            profile_id,
            local_node_id,
            write,
        )
    }

    fn native_transcript_write_at_path(
        &self,
        db_path: PathBuf,
        profile_id: &str,
        local_node_id: &str,
        write: NativeTranscriptArchiveWrite,
    ) -> Result<Value, AuroraCommandError> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| local_data_error("local data state lock failed"))?;
        if state.active_transaction.is_some() {
            return Err(transaction_scope_error("transaction_active"));
        }
        let creating = matches!(&write, NativeTranscriptArchiveWrite::CreateSession { .. });
        if creating {
            open_local_data_at_path(db_path.clone(), profile_id, local_node_id)?;
        } else if !db_path.is_file() {
            return Err(local_data_error("transcript_archive_unavailable"));
        }
        let operation = match write {
            NativeTranscriptArchiveWrite::CreateSession { record } => {
                LocalDataRepositoryOperation::TranscriptsCreateSession { record }
            }
            NativeTranscriptArchiveWrite::AppendSegment { record } => {
                LocalDataRepositoryOperation::TranscriptsAppendSegment { record }
            }
            NativeTranscriptArchiveWrite::FinalizeSession { input } => {
                LocalDataRepositoryOperation::TranscriptsFinalizeSession {
                    profile_id: profile_id.to_owned(),
                    local_node_id: local_node_id.to_owned(),
                    input,
                }
            }
        };
        let scope = format!("{profile_id}\0{local_node_id}");
        let recover = creating && !state.recovered_transcript_scopes.contains(&scope);
        let conn = SqliteConnection::open(db_path)?;
        conn.exec("BEGIN IMMEDIATE;")?;
        let result = (|| {
            if recover {
                recover_transcript_sessions(
                    &conn,
                    profile_id,
                    local_node_id,
                    now_ms() as i64,
                    "process_restart",
                )?;
            }
            if creating {
                run_repository_operation(
                    &conn,
                    profile_id,
                    local_node_id,
                    LocalDataRepositoryOperation::TranscriptsDeleteExpiredSessions {
                        profile_id: profile_id.to_owned(),
                        local_node_id: local_node_id.to_owned(),
                        now_ms: now_ms() as i64,
                        limit: MAX_TRANSCRIPT_DELETE_LIMIT,
                    },
                )?;
            }
            run_repository_operation(&conn, profile_id, local_node_id, operation)
        })();
        match result {
            Ok(value) => {
                conn.exec("COMMIT;")?;
                if recover {
                    state.recovered_transcript_scopes.insert(scope);
                }
                Ok(value)
            }
            Err(error) => {
                let _ = conn.exec("ROLLBACK;");
                Err(error)
            }
        }
    }

    /// Bind a native producer to the profile selected by the native admission
    /// path. Callers must pass the coordinator-confirmed identity, never a
    /// renderer-supplied identity.
    pub(crate) fn native_transcript_archive(
        &self,
        app: &AppHandle,
        selected_profile_id: &str,
        selected_local_node_id: &str,
    ) -> Result<NativeTranscriptArchiveHandle, AuroraCommandError> {
        let state = Arc::clone(&self.inner);
        let state_guard = state
            .lock()
            .map_err(|_| local_data_error("local data state lock failed"))?;
        let (profile_id, local_node_id) = ensure_open_state(&state_guard)?;
        ensure_scope(
            &profile_id,
            &local_node_id,
            selected_profile_id,
            selected_local_node_id,
        )?;
        let scope_generation = state_guard.scope_generation;
        drop(state_guard);
        Ok(NativeTranscriptArchiveHandle {
            state,
            db_path: local_data_db_path(app)?,
            profile_id,
            local_node_id,
            scope_generation,
        })
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum NativeTranscriptArchiveWrite {
    CreateSession {
        record: TranscriptSessionRecord,
    },
    AppendSegment {
        record: TranscriptSegmentRecord,
    },
    FinalizeSession {
        input: FinalizeTranscriptSessionInput,
    },
}

impl NativeTranscriptArchiveHandle {
    pub(crate) fn create_session(
        &self,
        input: NativeTranscriptSessionInput,
    ) -> Result<TranscriptSessionRecord, AuroraCommandError> {
        let record = TranscriptSessionRecord {
            id: input.id,
            profile_id: self.profile_id.clone(),
            local_node_id: self.local_node_id.clone(),
            capture_mode: input.capture_mode,
            created_at_ms: input.created_at_ms,
            started_at_ms: input.started_at_ms,
            ended_at_ms: None,
            lifecycle: "active".to_owned(),
            terminal_reason: None,
            expires_at_ms: input.expires_at_ms,
            language: input.language,
            model_provenance: TranscriptModelProvenance {
                provider: input.model_provenance.provider,
                model_id: input.model_provenance.model_id,
                version: input.model_provenance.version,
            },
            diarization_state: input.diarization_state,
        };
        let value =
            self.write(LocalDataRepositoryOperation::TranscriptsCreateSession { record })?;
        serde_json::from_value(value).map_err(|error| local_data_error(error.to_string()))
    }

    pub(crate) fn append_segment(
        &self,
        input: NativeTranscriptSegmentInput,
    ) -> Result<bool, AuroraCommandError> {
        let record = TranscriptSegmentRecord {
            id: input.id,
            session_id: input.session_id,
            sequence: input.sequence,
            start_at_ms: input.start_at_ms,
            end_at_ms: input.end_at_ms,
            text_envelope: input.text_envelope,
            confidence: input.confidence,
            speaker_id: input.speaker_id,
            speaker_label: input.speaker_label,
            created_at_ms: input.created_at_ms,
        };
        let value =
            self.write(LocalDataRepositoryOperation::TranscriptsAppendSegment { record })?;
        let appended = value
            .get("appended")
            .and_then(Value::as_bool)
            .ok_or_else(|| local_data_error("invalid transcript append result"))?;
        Ok(appended)
    }

    pub(crate) fn finalize_session(
        &self,
        session_id: String,
        lifecycle: String,
        ended_at_ms: i64,
        terminal_reason: String,
    ) -> Result<(), AuroraCommandError> {
        self.write(LocalDataRepositoryOperation::TranscriptsFinalizeSession {
            profile_id: self.profile_id.clone(),
            local_node_id: self.local_node_id.clone(),
            input: FinalizeTranscriptSessionInput {
                session_id,
                lifecycle,
                ended_at_ms,
                terminal_reason,
            },
        })
        .map(|_| ())
    }

    fn write(&self, operation: LocalDataRepositoryOperation) -> Result<Value, AuroraCommandError> {
        let state = self
            .state
            .lock()
            .map_err(|_| local_data_error("local data state lock failed"))?;
        let (profile_id, local_node_id) = ensure_open_state(&state)?;
        if state.scope_generation != self.scope_generation
            || profile_id != self.profile_id
            || local_node_id != self.local_node_id
        {
            return Err(local_data_error("transcript_archive_scope_expired"));
        }
        if state.active_transaction.is_some() {
            return Err(transaction_scope_error("transaction_active"));
        }
        let conn = SqliteConnection::open(self.db_path.clone())?;
        conn.exec("BEGIN IMMEDIATE;")?;
        match run_repository_operation(&conn, &self.profile_id, &self.local_node_id, operation) {
            Ok(result) => {
                conn.exec("COMMIT;")?;
                Ok(result)
            }
            Err(error) => {
                let _ = conn.exec("ROLLBACK;");
                Err(error)
            }
        }
    }
}

struct ActiveTransaction {
    tx_id: String,
    conn: SqliteConnection,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalDataOpenRequest {
    profile_id: String,
    local_node_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalDataTransactionRequest {
    tx_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalDataTransactionBeginRequest {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalDataRepositoryRequest {
    tx_id: Option<String>,
    operation: LocalDataRepositoryOperation,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalDataImportRequest {
    document: Value,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalDataExportDocument {
    version: u32,
    source_backend: String,
    schema_version: u32,
    profile_id: String,
    local_node_id: String,
    exported_at_ms: i64,
    encryption_envelope_versions: Vec<u32>,
    record_counts: LocalDataRecordCounts,
    collection_hashes: LocalDataCollectionHashes,
    records: LocalDataRecordCollections,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalDataRecordCounts {
    conversations: usize,
    messages: usize,
    memory_items: usize,
    local_tool_states: usize,
    peer_grant_metadata: usize,
    local_audit: usize,
    #[serde(default)]
    transcript_sessions: usize,
    #[serde(default)]
    transcript_segments: usize,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalDataCollectionHashes {
    conversations: String,
    messages: String,
    memory_items: String,
    local_tool_states: String,
    peer_grant_metadata: String,
    local_audit: String,
    #[serde(default = "empty_collection_hash")]
    transcript_sessions: String,
    #[serde(default = "empty_collection_hash")]
    transcript_segments: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalDataRecordCollections {
    conversations: Vec<ConversationRecord>,
    messages: Vec<ConversationMessageRecord>,
    memory_items: Vec<LightweightMemoryRecord>,
    local_tool_states: Vec<LocalToolStateRecord>,
    peer_grant_metadata: Vec<PeerGrantMetadataRecord>,
    local_audit: Vec<LocalAuditRecord>,
    #[serde(default)]
    transcript_sessions: Vec<TranscriptSessionRecord>,
    #[serde(default)]
    transcript_segments: Vec<TranscriptSegmentRecord>,
}

#[derive(Deserialize)]
#[serde(tag = "kind")]
#[serde(deny_unknown_fields)]
#[serde(rename_all_fields = "camelCase")]
enum LocalDataRepositoryOperation {
    #[serde(rename = "conversations.upsertConversation")]
    ConversationsUpsertConversation { record: ConversationRecord },
    #[serde(rename = "conversations.appendMessage")]
    ConversationsAppendMessage { record: ConversationMessageRecord },
    #[serde(rename = "conversations.deleteConversation")]
    ConversationsDeleteConversation { conversation_id: String },
    #[serde(rename = "conversations.getConversation")]
    ConversationsGetConversation {
        profile_id: String,
        local_node_id: String,
        conversation_id: String,
    },
    #[serde(rename = "conversations.getMessage")]
    ConversationsGetMessage {
        profile_id: String,
        local_node_id: String,
        conversation_id: String,
        message_id: String,
    },
    #[serde(rename = "conversations.listConversations")]
    ConversationsListConversations {
        profile_id: String,
        local_node_id: String,
        options: Option<ConversationListQuery>,
    },
    #[serde(rename = "conversations.listMessageCounts")]
    ConversationsListMessageCounts {
        profile_id: String,
        local_node_id: String,
        conversation_ids: Option<Vec<String>>,
    },
    #[serde(rename = "conversations.listFirstUserMessages")]
    ConversationsListFirstUserMessages {
        profile_id: String,
        local_node_id: String,
        conversation_ids: Option<Vec<String>>,
    },
    #[serde(rename = "conversations.listMessages")]
    ConversationsListMessages {
        profile_id: String,
        local_node_id: String,
        conversation_id: String,
        options: Option<MessageListQuery>,
    },
    #[serde(rename = "conversations.getLatestMessageSequence")]
    ConversationsGetLatestMessageSequence {
        profile_id: String,
        local_node_id: String,
        conversation_id: String,
    },
    #[serde(rename = "memory.upsertMemoryItem")]
    MemoryUpsertMemoryItem { record: LightweightMemoryRecord },
    #[serde(rename = "memory.deleteMemoryItem")]
    MemoryDeleteMemoryItem { memory_item_id: String },
    #[serde(rename = "memory.deleteExpiredMemoryItems")]
    MemoryDeleteExpiredMemoryItems {
        profile_id: String,
        local_node_id: String,
        now_ms: i64,
        limit: i64,
    },
    #[serde(rename = "memory.listMemoryItems")]
    MemoryListMemoryItems {
        profile_id: String,
        local_node_id: String,
        namespace: Option<String>,
    },
    #[serde(rename = "localTools.upsertLocalToolState")]
    LocalToolsUpsertLocalToolState { record: LocalToolStateRecord },
    #[serde(rename = "localTools.listLocalToolStates")]
    LocalToolsListLocalToolStates {
        profile_id: String,
        local_node_id: String,
    },
    #[serde(rename = "peerGrants.upsertPeerGrant")]
    PeerGrantsUpsertPeerGrant { record: PeerGrantMetadataRecord },
    #[serde(rename = "peerGrants.listPeerGrants")]
    PeerGrantsListPeerGrants {
        profile_id: String,
        local_node_id: String,
    },
    #[serde(rename = "localAudit.appendAudit")]
    LocalAuditAppendAudit { record: LocalAuditRecord },
    #[serde(rename = "localAudit.listAudit")]
    LocalAuditListAudit {
        profile_id: String,
        local_node_id: String,
    },
    #[serde(rename = "transcripts.createSession")]
    TranscriptsCreateSession { record: TranscriptSessionRecord },
    #[serde(rename = "transcripts.startSession")]
    TranscriptsStartSession {
        profile_id: String,
        local_node_id: String,
        session_id: String,
        started_at_ms: i64,
    },
    #[serde(rename = "transcripts.appendSegment")]
    TranscriptsAppendSegment { record: TranscriptSegmentRecord },
    #[serde(rename = "transcripts.getSession")]
    TranscriptsGetSession {
        profile_id: String,
        local_node_id: String,
        session_id: String,
    },
    #[serde(rename = "transcripts.listSessions")]
    TranscriptsListSessions {
        profile_id: String,
        local_node_id: String,
        options: Option<TranscriptSessionListQuery>,
    },
    #[serde(rename = "transcripts.listSegments")]
    TranscriptsListSegments {
        profile_id: String,
        local_node_id: String,
        session_id: String,
        options: Option<TranscriptSegmentListQuery>,
    },
    #[serde(rename = "transcripts.finalizeSession")]
    TranscriptsFinalizeSession {
        profile_id: String,
        local_node_id: String,
        input: FinalizeTranscriptSessionInput,
    },
    #[serde(rename = "transcripts.recoverActiveSessions")]
    TranscriptsRecoverActiveSessions {
        profile_id: String,
        local_node_id: String,
        now_ms: i64,
        terminal_reason: Option<String>,
    },
    #[serde(rename = "transcripts.deleteSession")]
    TranscriptsDeleteSession {
        profile_id: String,
        local_node_id: String,
        session_id: String,
    },
    #[serde(rename = "transcripts.deleteExpiredSessions")]
    TranscriptsDeleteExpiredSessions {
        profile_id: String,
        local_node_id: String,
        now_ms: i64,
        limit: usize,
    },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TranscriptSessionRecord {
    id: String,
    profile_id: String,
    local_node_id: String,
    capture_mode: String,
    created_at_ms: i64,
    started_at_ms: i64,
    ended_at_ms: Option<i64>,
    lifecycle: String,
    terminal_reason: Option<String>,
    expires_at_ms: Option<i64>,
    language: Option<String>,
    model_provenance: TranscriptModelProvenance,
    diarization_state: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TranscriptModelProvenance {
    provider: Option<String>,
    model_id: Option<String>,
    version: Option<String>,
}

/// Metadata for a native-owned archive session. The selected identity is
/// intentionally omitted; the archive handle supplies it from native state.
pub(crate) struct NativeTranscriptSessionInput {
    pub(crate) id: String,
    pub(crate) capture_mode: String,
    pub(crate) created_at_ms: i64,
    pub(crate) started_at_ms: i64,
    pub(crate) expires_at_ms: Option<i64>,
    pub(crate) language: Option<String>,
    pub(crate) model_provenance: NativeTranscriptModelProvenance,
    pub(crate) diarization_state: String,
}

pub(crate) struct NativeTranscriptModelProvenance {
    pub(crate) provider: Option<String>,
    pub(crate) model_id: Option<String>,
    pub(crate) version: Option<String>,
}

pub(crate) struct NativeTranscriptSegmentInput {
    pub(crate) id: String,
    pub(crate) session_id: String,
    pub(crate) sequence: i64,
    pub(crate) start_at_ms: i64,
    pub(crate) end_at_ms: i64,
    pub(crate) text_envelope: Value,
    pub(crate) confidence: Option<f64>,
    pub(crate) speaker_id: Option<String>,
    pub(crate) speaker_label: Option<String>,
    pub(crate) created_at_ms: i64,
}

/// Handle for native capture code. Construct only from the selected native
/// profile receipt; never from WebView command fields. Scope generation makes
/// a handle unusable after the local-data scope is closed/replaced.
#[derive(Clone)]
pub(crate) struct NativeTranscriptArchiveHandle {
    state: Arc<Mutex<LocalDataState>>,
    db_path: PathBuf,
    profile_id: String,
    local_node_id: String,
    scope_generation: u64,
}

#[derive(Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TranscriptSegmentRecord {
    id: String,
    session_id: String,
    sequence: i64,
    start_at_ms: i64,
    end_at_ms: i64,
    text_envelope: Value,
    confidence: Option<f64>,
    speaker_id: Option<String>,
    speaker_label: Option<String>,
    created_at_ms: i64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TranscriptSessionListQuery {
    limit: Option<usize>,
    cursor: Option<TranscriptSessionCursor>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TranscriptSessionCursor {
    created_at_ms: i64,
    id: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TranscriptSegmentListQuery {
    limit: Option<usize>,
    after_sequence: Option<i64>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FinalizeTranscriptSessionInput {
    session_id: String,
    lifecycle: String,
    ended_at_ms: i64,
    terminal_reason: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct ConversationRecord {
    id: String,
    profile_id: String,
    local_node_id: String,
    title_envelope: Option<Value>,
    created_at_ms: i64,
    updated_at_ms: i64,
    archived_at_ms: Option<i64>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct ConversationMessageRecord {
    id: String,
    conversation_id: String,
    sequence: i64,
    role: String,
    content_envelope: Option<Value>,
    tool_envelope: Option<Value>,
    status: String,
    created_at_ms: i64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConversationListQuery {
    limit: Option<usize>,
    include_archived: Option<bool>,
    cursor: Option<ConversationCursor>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConversationCursor {
    updated_at_ms: i64,
    id: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MessageListQuery {
    limit: Option<usize>,
    before_sequence: Option<i64>,
    after_sequence: Option<i64>,
    direction: Option<String>,
}

#[derive(Clone)]
pub(crate) struct NativeVoiceTurnPersistenceRequest {
    pub(crate) profile_id: String,
    pub(crate) local_node_id: String,
    pub(crate) new_conversation_id: String,
    pub(crate) user_message_id: String,
    pub(crate) user_content_envelope: Value,
    pub(crate) assistant_message_id: Option<String>,
    pub(crate) assistant_content_envelope: Option<Value>,
    pub(crate) created_at_ms: i64,
    pub(crate) completed_at_ms: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeVoiceTurnPersistenceResult {
    pub(crate) conversation_id: String,
    pub(crate) user_message_id: String,
    pub(crate) assistant_message_id: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct LightweightMemoryRecord {
    id: String,
    profile_id: String,
    local_node_id: String,
    namespace: String,
    payload_envelope: Value,
    source_type: Option<String>,
    source_id: Option<String>,
    created_at_ms: i64,
    updated_at_ms: i64,
    expires_at_ms: Option<i64>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct LocalToolStateRecord {
    profile_id: String,
    local_node_id: String,
    tool_contract_id: String,
    descriptor_json: Value,
    descriptor_hash: String,
    enabled: bool,
    settings_envelope: Option<Value>,
    revision: i64,
    updated_at_ms: i64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct PeerGrantMetadataRecord {
    grant_id: String,
    profile_id: String,
    local_node_id: String,
    claimant_peer_id: String,
    token_id: String,
    scope_envelope: Value,
    revision: i64,
    created_at_ms: i64,
    expires_at_ms: Option<i64>,
    revoked_at_ms: Option<i64>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct LocalAuditRecord {
    id: String,
    profile_id: String,
    local_node_id: String,
    peer_id: Option<String>,
    action: String,
    decision: String,
    result_status: String,
    connection_epoch: Option<String>,
    method_id: Option<String>,
    tool_contract_id: Option<String>,
    correlation_id: Option<String>,
    redacted_detail_json: Value,
    created_at_ms: i64,
}

struct SqliteConnection {
    raw: *mut sqlite3,
}

// SQLite is opened with SQLITE_OPEN_FULLMUTEX for every connection, and all
// active transaction access is serialized through LocalDataCommandState.
unsafe impl Send for SqliteConnection {}

impl Drop for SqliteConnection {
    fn drop(&mut self) {
        if !self.raw.is_null() {
            unsafe {
                let _ = sqlite3_close(self.raw);
            }
            self.raw = ptr::null_mut();
        }
    }
}

impl SqliteConnection {
    fn open(path: PathBuf) -> Result<Self, AuroraCommandError> {
        Self::open_with_flags(
            path,
            SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
        )
    }

    fn open_readonly(path: PathBuf) -> Result<Self, AuroraCommandError> {
        Self::open_with_flags(path, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX)
    }

    fn open_with_flags(path: PathBuf, flags: c_int) -> Result<Self, AuroraCommandError> {
        let path = CString::new(path.to_string_lossy().as_bytes())
            .map_err(|_| local_data_error("database path contains a nul byte"))?;
        let mut raw = ptr::null_mut();
        let rc = unsafe { sqlite3_open_v2(path.as_ptr(), &mut raw, flags, ptr::null()) };
        if rc != SQLITE_OK {
            let message = sqlite_error(raw);
            if !raw.is_null() {
                unsafe {
                    let _ = sqlite3_close(raw);
                }
            }
            return Err(local_data_error(message));
        }
        let conn = Self { raw };
        conn.exec("PRAGMA foreign_keys = ON;")?;
        Ok(conn)
    }

    fn exec(&self, sql: &str) -> Result<(), AuroraCommandError> {
        let sql = CString::new(sql).map_err(|_| local_data_error("sql contains a nul byte"))?;
        let mut errmsg = ptr::null_mut();
        let rc =
            unsafe { sqlite3_exec(self.raw, sql.as_ptr(), None, ptr::null_mut(), &mut errmsg) };
        if rc == SQLITE_OK {
            return Ok(());
        }
        let message = if errmsg.is_null() {
            sqlite_error(self.raw)
        } else {
            let message = unsafe { CStr::from_ptr(errmsg).to_string_lossy().into_owned() };
            unsafe {
                sqlite3_free(errmsg.cast());
            }
            message
        };
        Err(local_data_error(message))
    }

    fn execute(&self, sql: &str, params: &[Value]) -> Result<(), AuroraCommandError> {
        let mut statement = Statement::prepare(self.raw, sql)?;
        statement.bind(params)?;
        match unsafe { sqlite3_step(statement.raw) } {
            SQLITE_DONE => Ok(()),
            _ => Err(local_data_error(sqlite_error(self.raw))),
        }
    }

    fn query(&self, sql: &str, params: &[Value]) -> Result<Vec<Value>, AuroraCommandError> {
        let mut statement = Statement::prepare(self.raw, sql)?;
        statement.bind(params)?;
        let mut rows = Vec::new();
        loop {
            match unsafe { sqlite3_step(statement.raw) } {
                SQLITE_ROW => rows.push(statement.row()?),
                SQLITE_DONE => return Ok(rows),
                _ => return Err(local_data_error(sqlite_error(self.raw))),
            }
        }
    }
}

struct Statement {
    db: *mut sqlite3,
    raw: *mut sqlite3_stmt,
}

impl Drop for Statement {
    fn drop(&mut self) {
        if !self.raw.is_null() {
            unsafe {
                let _ = sqlite3_finalize(self.raw);
            }
            self.raw = ptr::null_mut();
        }
    }
}

impl Statement {
    fn prepare(db: *mut sqlite3, sql: &str) -> Result<Self, AuroraCommandError> {
        let sql = CString::new(sql).map_err(|_| local_data_error("sql contains a nul byte"))?;
        let mut raw = ptr::null_mut();
        let rc = unsafe { sqlite3_prepare_v2(db, sql.as_ptr(), -1, &mut raw, ptr::null_mut()) };
        if rc != SQLITE_OK {
            return Err(local_data_error(sqlite_error(db)));
        }
        Ok(Self { db, raw })
    }

    fn bind(&mut self, params: &[Value]) -> Result<(), AuroraCommandError> {
        for (index, value) in params.iter().enumerate() {
            let index = c_int::try_from(index + 1)
                .map_err(|_| local_data_error("too many bound parameters"))?;
            let rc = match value {
                Value::Null => unsafe { sqlite3_bind_null(self.raw, index) },
                Value::Bool(value) => unsafe {
                    sqlite3_bind_int64(self.raw, index, i64::from(*value))
                },
                Value::Number(value) => bind_number(self.raw, index, value),
                Value::String(value) => {
                    let value = CString::new(value.as_str())
                        .map_err(|_| local_data_error("bound text contains a nul byte"))?;
                    unsafe {
                        sqlite3_bind_text(self.raw, index, value.as_ptr(), -1, sqlite_transient())
                    }
                }
                Value::Array(_) | Value::Object(_) => {
                    let value = CString::new(canonical_json(value)?)
                        .map_err(|_| local_data_error("bound JSON contains a nul byte"))?;
                    unsafe {
                        sqlite3_bind_text(self.raw, index, value.as_ptr(), -1, sqlite_transient())
                    }
                }
            };
            if rc != SQLITE_OK {
                return Err(local_data_error(sqlite_error(self.db)));
            }
        }
        Ok(())
    }

    fn row(&self) -> Result<Value, AuroraCommandError> {
        let mut row = Map::new();
        let count = unsafe { sqlite3_column_count(self.raw) };
        for index in 0..count {
            let name = unsafe { sqlite3_column_name(self.raw, index) };
            if name.is_null() {
                return Err(local_data_error("sqlite column name is null"));
            }
            let name = unsafe { CStr::from_ptr(name).to_string_lossy().into_owned() };
            let value = match unsafe { sqlite3_column_type(self.raw, index) } {
                SQLITE_NULL => Value::Null,
                SQLITE_INTEGER => Value::Number(Number::from(unsafe {
                    sqlite3_column_int64(self.raw, index)
                })),
                SQLITE_FLOAT => Number::from_f64(unsafe { sqlite3_column_double(self.raw, index) })
                    .map(Value::Number)
                    .unwrap_or(Value::Null),
                SQLITE_TEXT => {
                    let text = unsafe { sqlite3_column_text(self.raw, index) };
                    if text.is_null() {
                        Value::Null
                    } else {
                        Value::String(unsafe {
                            CStr::from_ptr(text.cast()).to_string_lossy().into_owned()
                        })
                    }
                }
                _ => Value::Null,
            };
            row.insert(name, value);
        }
        Ok(Value::Object(row))
    }
}

#[tauri::command]
pub(crate) async fn aurora_local_data_open(
    app: AppHandle,
    state: State<'_, LocalDataCommandState>,
    request: LocalDataOpenRequest,
) -> Result<Value, AuroraCommandError> {
    let state = Arc::clone(&state.inner);
    run_local_data_blocking(move || {
        let mut state = state
            .lock()
            .map_err(|_| local_data_error("local data state lock failed"))?;
        if let (Some(open_profile), Some(open_node)) = (&state.profile_id, &state.local_node_id) {
            if open_profile != &request.profile_id || open_node != &request.local_node_id {
                return Err(local_data_error("identity_mismatch"));
            }
        }
        if state.profile_id.is_none() && state.local_node_id.is_none() {
            state.scope_generation = state
                .scope_generation
                .checked_add(1)
                .ok_or_else(|| local_data_error("transcript_archive_generation_exhausted"))?;
        }
        let schema_version = open_local_data_at_path(
            local_data_db_path_without_create(&app)?,
            &request.profile_id,
            &request.local_node_id,
        )?;
        let recovery_scope = format!("{}\0{}", request.profile_id, request.local_node_id);
        if !state.recovered_transcript_scopes.contains(&recovery_scope) {
            let conn = SqliteConnection::open(local_data_db_path(&app)?)?;
            conn.exec("BEGIN IMMEDIATE;")?;
            match recover_transcript_sessions(
                &conn,
                &request.profile_id,
                &request.local_node_id,
                now_ms() as i64,
                "process_restart",
            ) {
                Ok(_) => conn.exec("COMMIT;")?,
                Err(error) => {
                    let _ = conn.exec("ROLLBACK;");
                    return Err(error);
                }
            }
            state.recovered_transcript_scopes.insert(recovery_scope);
        }
        state.profile_id = Some(request.profile_id.clone());
        state.local_node_id = Some(request.local_node_id.clone());
        state.schema_version = Some(schema_version);
        Ok(status_value(
            Some(request.profile_id),
            Some(request.local_node_id),
            Some(schema_version),
            "applied",
        ))
    })
    .await
}

#[tauri::command]
pub(crate) async fn aurora_local_data_status(
    state: State<'_, LocalDataCommandState>,
) -> Result<Value, AuroraCommandError> {
    let state = Arc::clone(&state.inner);
    run_local_data_blocking(move || {
        let state = state
            .lock()
            .map_err(|_| local_data_error("local data state lock failed"))?;
        Ok(status_value(
            state.profile_id.clone(),
            state.local_node_id.clone(),
            state.schema_version,
            if state.profile_id.is_some() {
                "applied"
            } else {
                "idle"
            },
        ))
    })
    .await
}

/// Inspect the persisted database identity without opening a mutable app session.
#[tauri::command]
pub(crate) async fn aurora_local_data_inspect_identity(
    app: AppHandle,
) -> Result<Value, AuroraCommandError> {
    run_local_data_blocking(move || {
        inspect_local_data_identity_at_path(local_data_db_path_without_create(&app)?)
    })
    .await
}

#[tauri::command]
pub(crate) async fn aurora_local_data_close(
    state: State<'_, LocalDataCommandState>,
) -> Result<Value, AuroraCommandError> {
    let state = Arc::clone(&state.inner);
    run_local_data_blocking(move || {
        let mut state = state
            .lock()
            .map_err(|_| local_data_error("local data state lock failed"))?;
        if let Some(active) = state.active_transaction.take() {
            let _ = active.conn.exec("ROLLBACK;");
        }
        state.profile_id = None;
        state.local_node_id = None;
        state.schema_version = None;
        state.scope_generation = state
            .scope_generation
            .checked_add(1)
            .ok_or_else(|| local_data_error("transcript_archive_generation_exhausted"))?;
        Ok(status_value(None, None, None, "idle"))
    })
    .await
}

#[tauri::command]
pub(crate) async fn aurora_local_data_transaction_begin(
    app: AppHandle,
    state: State<'_, LocalDataCommandState>,
    request: LocalDataTransactionBeginRequest,
) -> Result<Value, AuroraCommandError> {
    let state = Arc::clone(&state.inner);
    run_local_data_blocking(move || {
        let mut state = state
            .lock()
            .map_err(|_| local_data_error("local data state lock failed"))?;
        ensure_open_state(&state)?;
        let _ = request;
        if state.active_transaction.is_some() {
            return Err(transaction_scope_error("nested_transaction"));
        }
        let conn = SqliteConnection::open(local_data_db_path(&app)?)?;
        conn.exec("BEGIN IMMEDIATE;")?;
        let tx_id = new_transaction_id()?;
        state.active_transaction = Some(ActiveTransaction {
            tx_id: tx_id.clone(),
            conn,
        });
        Ok(json!({ "txId": tx_id, "begun": true }))
    })
    .await
}

#[tauri::command]
pub(crate) async fn aurora_local_data_transaction_commit(
    state: State<'_, LocalDataCommandState>,
    request: LocalDataTransactionRequest,
) -> Result<Value, AuroraCommandError> {
    let state = Arc::clone(&state.inner);
    run_local_data_blocking(move || {
        let mut state = state
            .lock()
            .map_err(|_| local_data_error("local data state lock failed"))?;
        let active = take_active_transaction(&mut state, &request.tx_id)?;
        active.conn.exec("COMMIT;")?;
        Ok(json!({ "txId": request.tx_id, "committed": true }))
    })
    .await
}

#[tauri::command]
pub(crate) async fn aurora_local_data_transaction_rollback(
    state: State<'_, LocalDataCommandState>,
    request: LocalDataTransactionRequest,
) -> Result<Value, AuroraCommandError> {
    let state = Arc::clone(&state.inner);
    run_local_data_blocking(move || {
        let mut state = state
            .lock()
            .map_err(|_| local_data_error("local data state lock failed"))?;
        let active = take_active_transaction(&mut state, &request.tx_id)?;
        let _ = active.conn.exec("ROLLBACK;");
        Ok(json!({ "txId": request.tx_id, "rolledBack": true }))
    })
    .await
}

#[tauri::command]
pub(crate) async fn aurora_local_data_repository_operation(
    app: AppHandle,
    state: State<'_, LocalDataCommandState>,
    request: LocalDataRepositoryRequest,
) -> Result<Value, AuroraCommandError> {
    let state = Arc::clone(&state.inner);
    run_local_data_blocking(move || {
        let state_guard = state
            .lock()
            .map_err(|_| local_data_error("local data state lock failed"))?;
        let (profile_id, local_node_id) = ensure_open_state(&state_guard)?;
        if let Some(tx_id) = request.tx_id {
            let active = state_guard
                .active_transaction
                .as_ref()
                .ok_or_else(|| transaction_scope_error("transaction_not_found"))?;
            if active.tx_id != tx_id {
                return Err(transaction_scope_error("forged_transaction"));
            }
            return run_repository_operation(
                &active.conn,
                &profile_id,
                &local_node_id,
                request.operation,
            );
        }
        if state_guard.active_transaction.is_some() {
            return Err(transaction_scope_error("transaction_active"));
        }
        let conn = SqliteConnection::open(local_data_db_path(&app)?)?;
        run_repository_operation(&conn, &profile_id, &local_node_id, request.operation)
    })
    .await
}

#[tauri::command]
pub(crate) async fn aurora_local_data_export_v1(
    app: AppHandle,
    state: State<'_, LocalDataCommandState>,
) -> Result<Value, AuroraCommandError> {
    let state = Arc::clone(&state.inner);
    run_local_data_blocking(move || {
        let state = state
            .lock()
            .map_err(|_| local_data_error("local data state lock failed"))?;
        let (profile_id, local_node_id) = ensure_open_state(&state)?;
        let schema_version = state.schema_version.unwrap_or(0);
        drop(state);

        let conn = SqliteConnection::open(local_data_db_path(&app)?)?;
        conn.exec("BEGIN;")?;
        let result = (|| {
            let records = export_records(&conn, &profile_id, &local_node_id)?;
            let record_counts = record_counts(&records);
            let collection_hashes = collection_hashes(&records)?;
            Ok(json!({
                "version": 1,
                "sourceBackend": "sqlite-tauri",
                "schemaVersion": schema_version,
                "profileId": profile_id,
                "localNodeId": local_node_id,
                "exportedAtMs": now_ms(),
                "encryptionEnvelopeVersions": [1],
                "recordCounts": record_counts,
                "collectionHashes": collection_hashes,
                "records": records
            }))
        })();
        let _ = conn.exec("ROLLBACK;");
        result
    })
    .await
}

#[tauri::command]
pub(crate) async fn aurora_local_data_import_v1(
    app: AppHandle,
    state: State<'_, LocalDataCommandState>,
    request: LocalDataImportRequest,
) -> Result<Value, AuroraCommandError> {
    let state = Arc::clone(&state.inner);
    run_local_data_blocking(move || {
        let state = state
            .lock()
            .map_err(|_| local_data_error("local data state lock failed"))?;
        let (profile_id, local_node_id) = ensure_open_state(&state)?;
        let schema_version = state.schema_version.unwrap_or(0);
        if state.active_transaction.is_some() {
            return Err(transaction_scope_error("transaction_active"));
        }
        drop(state);
        let document = validate_import_document(
            request.document,
            &profile_id,
            &local_node_id,
            schema_version,
        )?;
        let conn = SqliteConnection::open(local_data_db_path(&app)?)?;
        conn.exec("BEGIN IMMEDIATE;")?;
        let result = import_records(&conn, &profile_id, &local_node_id, &document);
        match result {
            Ok(response) => {
                conn.exec("COMMIT;")?;
                Ok(response)
            }
            Err(error) => {
                let _ = conn.exec("ROLLBACK;");
                Err(error)
            }
        }
    })
    .await
}

async fn run_local_data_blocking<T>(
    operation: impl FnOnce() -> Result<T, AuroraCommandError> + Send + 'static,
) -> Result<T, AuroraCommandError>
where
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| local_data_error(format!("local data task failed: {error}")))?
}

fn run_repository_operation(
    conn: &SqliteConnection,
    profile_id: &str,
    local_node_id: &str,
    operation: LocalDataRepositoryOperation,
) -> Result<Value, AuroraCommandError> {
    match operation {
        LocalDataRepositoryOperation::ConversationsUpsertConversation { record } => {
            validate_conversation_record(&record)?;
            ensure_scope(
                profile_id,
                local_node_id,
                &record.profile_id,
                &record.local_node_id,
            )?;
            ensure_scoped_global_key_available(
                conn,
                "aurora_conversations",
                "id",
                &record.id,
                profile_id,
                local_node_id,
            )?;
            conn.execute(
                "INSERT INTO aurora_conversations (id, profile_id, local_node_id, title_envelope_json, created_at_ms, updated_at_ms, archived_at_ms)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET title_envelope_json = excluded.title_envelope_json, updated_at_ms = excluded.updated_at_ms, archived_at_ms = excluded.archived_at_ms",
                &[
                    json!(record.id),
                    json!(record.profile_id),
                    json!(record.local_node_id),
                    json_or_null(record.title_envelope)?,
                    json!(record.created_at_ms),
                    json!(record.updated_at_ms),
                    option_i64(record.archived_at_ms),
                ],
            )?;
            Ok(Value::Null)
        }
        LocalDataRepositoryOperation::ConversationsAppendMessage { record } => {
            validate_message_record(&record, profile_id, local_node_id)?;
            let rows = conn.query(
                "SELECT id FROM aurora_conversations WHERE id = ? AND profile_id = ? AND local_node_id = ? LIMIT 1",
                &[json!(record.conversation_id), json!(profile_id), json!(local_node_id)],
            )?;
            if rows.is_empty() {
                return Err(local_data_error("conversation not found for identity"));
            }
            ensure_message_id_available(conn, &record.id, profile_id, local_node_id)?;
            let existing_message = conn.query(
                "SELECT conversation_id FROM aurora_messages WHERE id = ? LIMIT 1",
                &[json!(record.id)],
            )?;
            if let Some(row) = existing_message.first() {
                if row_string(row, "conversation_id")? != record.conversation_id {
                    return Err(local_data_error_reason(
                        "message ID belongs to another conversation",
                        crate::LocalDataReasonCode::DuplicateMessageId,
                    ));
                }
            }
            let duplicate_sequence = conn.query(
                "SELECT id FROM aurora_messages WHERE conversation_id = ? AND sequence = ? LIMIT 1",
                &[json!(record.conversation_id), json!(record.sequence)],
            )?;
            if duplicate_sequence
                .first()
                .map(|row| row_string(row, "id"))
                .transpose()?
                != Some(record.id.clone())
                && !duplicate_sequence.is_empty()
            {
                return Err(local_data_error_reason(
                    "message sequence already exists",
                    crate::LocalDataReasonCode::DuplicateMessageSequence,
                ));
            }
            conn.execute(
                "INSERT INTO aurora_messages (id, conversation_id, sequence, role, content_envelope_json, tool_envelope_json, status, created_at_ms)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET sequence = excluded.sequence, role = excluded.role, content_envelope_json = excluded.content_envelope_json, tool_envelope_json = excluded.tool_envelope_json, status = excluded.status",
                &[
                    json!(record.id),
                    json!(record.conversation_id),
                    json!(record.sequence),
                    json!(record.role),
                    json_or_null(record.content_envelope)?,
                    json_or_null(record.tool_envelope)?,
                    json!(record.status),
                    json!(record.created_at_ms),
                ],
            )?;
            Ok(Value::Null)
        }
        LocalDataRepositoryOperation::ConversationsGetConversation {
            profile_id: requested_profile,
            local_node_id: requested_node,
            conversation_id,
        } => {
            ensure_scope(
                profile_id,
                local_node_id,
                &requested_profile,
                &requested_node,
            )?;
            validate_id(&conversation_id, "conversation.id")?;
            Ok(conn.query("SELECT id, profile_id, local_node_id, title_envelope_json, created_at_ms, updated_at_ms, archived_at_ms FROM aurora_conversations WHERE id = ? AND profile_id = ? AND local_node_id = ? LIMIT 1", &[json!(conversation_id), json!(profile_id), json!(local_node_id)])?.first().map(|row| conversation_from_row(row.clone())).transpose()?.unwrap_or(Value::Null))
        }
        LocalDataRepositoryOperation::ConversationsGetMessage {
            profile_id: requested_profile,
            local_node_id: requested_node,
            conversation_id,
            message_id,
        } => {
            ensure_scope(
                profile_id,
                local_node_id,
                &requested_profile,
                &requested_node,
            )?;
            validate_id(&conversation_id, "conversation.id")?;
            validate_id(&message_id, "message.id")?;
            Ok(conn.query("SELECT m.id, m.conversation_id, m.sequence, m.role, m.content_envelope_json, m.tool_envelope_json, m.status, m.created_at_ms FROM aurora_messages m INNER JOIN aurora_conversations c ON c.id = m.conversation_id WHERE m.id = ? AND m.conversation_id = ? AND c.profile_id = ? AND c.local_node_id = ? LIMIT 1", &[json!(message_id), json!(conversation_id), json!(profile_id), json!(local_node_id)])?.first().map(|row| message_from_row(row.clone())).transpose()?.unwrap_or(Value::Null))
        }
        LocalDataRepositoryOperation::ConversationsListConversations {
            profile_id: requested_profile,
            local_node_id: requested_node,
            options,
        } => {
            ensure_scope(
                profile_id,
                local_node_id,
                &requested_profile,
                &requested_node,
            )?;
            let (sql, params) = conversation_list_sql(profile_id, local_node_id, options)?;
            Ok(Value::Array(
                conn.query(&sql, &params)?
                    .into_iter()
                    .map(conversation_from_row)
                    .collect::<Result<Vec<_>, _>>()?,
            ))
        }
        LocalDataRepositoryOperation::ConversationsListMessageCounts {
            profile_id: requested_profile,
            local_node_id: requested_node,
            conversation_ids,
        } => {
            ensure_scope(
                profile_id,
                local_node_id,
                &requested_profile,
                &requested_node,
            )?;
            let (id_sql, id_params) = match validate_id_set(conversation_ids, "conversationIds")? {
                None => (String::new(), Vec::new()),
                Some(ids) if ids.is_empty() => return Ok(json!({})),
                Some(ids) => id_filter(&ids, "m.conversation_id"),
            };
            let rows = conn.query(
                &format!(
                    "SELECT m.conversation_id, COUNT(*) AS count
                 FROM aurora_messages m
                 INNER JOIN aurora_conversations c ON c.id = m.conversation_id
                 WHERE c.profile_id = ? AND c.local_node_id = ?{}
                 GROUP BY m.conversation_id",
                    id_sql
                ),
                &[vec![json!(profile_id), json!(local_node_id)], id_params].concat(),
            )?;
            let mut result = serde_json::Map::new();
            for row in rows {
                result.insert(
                    row_string(&row, "conversation_id")?,
                    json!(row_i64(&row, "count")?),
                );
            }
            Ok(Value::Object(result))
        }
        LocalDataRepositoryOperation::ConversationsListFirstUserMessages {
            profile_id: requested_profile,
            local_node_id: requested_node,
            conversation_ids,
        } => {
            ensure_scope(
                profile_id,
                local_node_id,
                &requested_profile,
                &requested_node,
            )?;
            let (id_sql, id_params) = match validate_id_set(conversation_ids, "conversationIds")? {
                None => (String::new(), Vec::new()),
                Some(ids) if ids.is_empty() => return Ok(json!({})),
                Some(ids) => id_filter(&ids, "m.conversation_id"),
            };
            let rows = conn.query(
                &format!("SELECT m.id, m.conversation_id, m.sequence, m.role, m.content_envelope_json, m.tool_envelope_json, m.status, m.created_at_ms
                 FROM aurora_messages m
                 INNER JOIN aurora_conversations c ON c.id = m.conversation_id
                 WHERE c.profile_id = ? AND c.local_node_id = ? AND m.role = ?{}
                   AND NOT EXISTS (
                     SELECT 1 FROM aurora_messages earlier
                     WHERE earlier.conversation_id = m.conversation_id
                       AND earlier.role = ?
                       AND (earlier.sequence < m.sequence OR (earlier.sequence = m.sequence AND earlier.id < m.id))
                   )
                ORDER BY m.conversation_id ASC, m.sequence ASC, m.id ASC", id_sql),
                &[
                    vec![json!(profile_id), json!(local_node_id), json!("user")],
                    id_params,
                    vec![json!("user")],
                ].concat(),
            )?;
            let mut result = serde_json::Map::new();
            for row in rows {
                let message = message_from_row(row)?;
                let conversation_id = message
                    .get("conversationId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        local_data_error("conversation message is missing conversationId")
                    })?;
                result.insert(conversation_id.to_string(), message);
            }
            Ok(Value::Object(result))
        }
        LocalDataRepositoryOperation::ConversationsDeleteConversation { conversation_id } => {
            validate_id(&conversation_id, "conversation.id")?;
            let rows = conn.query(
                "SELECT id FROM aurora_conversations WHERE id = ? AND profile_id = ? AND local_node_id = ? LIMIT 1",
                &[json!(conversation_id), json!(profile_id), json!(local_node_id)],
            )?;
            if rows.is_empty() {
                return Ok(json!({ "deleted": false, "deletedMessages": 0 }));
            }
            let message_count = select_count(
                conn,
                "SELECT COUNT(*) AS count FROM aurora_messages WHERE conversation_id = ?",
                &[json!(conversation_id)],
            )?;
            conn.execute(
                "DELETE FROM aurora_conversations WHERE id = ? AND profile_id = ? AND local_node_id = ?",
                &[json!(conversation_id), json!(profile_id), json!(local_node_id)],
            )?;
            Ok(json!({ "deleted": true, "deletedMessages": message_count }))
        }
        LocalDataRepositoryOperation::ConversationsListMessages {
            profile_id: requested_profile,
            local_node_id: requested_node,
            conversation_id,
            options,
        } => {
            ensure_scope(
                profile_id,
                local_node_id,
                &requested_profile,
                &requested_node,
            )?;
            validate_id(&conversation_id, "conversation.id")?;
            let (sql, params) =
                message_list_sql(profile_id, local_node_id, &conversation_id, options)?;
            Ok(Value::Array(
                conn.query(&sql, &params)?
                    .into_iter()
                    .map(message_from_row)
                    .collect::<Result<Vec<_>, _>>()?,
            ))
        }
        LocalDataRepositoryOperation::ConversationsGetLatestMessageSequence {
            profile_id: requested_profile,
            local_node_id: requested_node,
            conversation_id,
        } => {
            ensure_scope(
                profile_id,
                local_node_id,
                &requested_profile,
                &requested_node,
            )?;
            validate_id(&conversation_id, "conversation.id")?;
            let rows = conn.query("SELECT MAX(m.sequence) AS latest_sequence FROM aurora_messages m INNER JOIN aurora_conversations c ON c.id = m.conversation_id WHERE m.conversation_id = ? AND c.profile_id = ? AND c.local_node_id = ?", &[json!(conversation_id), json!(profile_id), json!(local_node_id)])?;
            Ok(rows
                .first()
                .and_then(|row| row.get("latest_sequence"))
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or(Value::Null))
        }
        LocalDataRepositoryOperation::MemoryUpsertMemoryItem { record } => {
            validate_memory_record(&record)?;
            ensure_scope(
                profile_id,
                local_node_id,
                &record.profile_id,
                &record.local_node_id,
            )?;
            ensure_scoped_global_key_available(
                conn,
                "aurora_memory_items",
                "id",
                &record.id,
                profile_id,
                local_node_id,
            )?;
            conn.execute(
                "INSERT INTO aurora_memory_items (id, profile_id, local_node_id, namespace, payload_envelope_json, source_type, source_id, created_at_ms, updated_at_ms, expires_at_ms)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET namespace = excluded.namespace, payload_envelope_json = excluded.payload_envelope_json, source_type = excluded.source_type, source_id = excluded.source_id, updated_at_ms = excluded.updated_at_ms, expires_at_ms = excluded.expires_at_ms",
                &[json!(record.id), json!(record.profile_id), json!(record.local_node_id), json!(record.namespace), json_or_null(Some(record.payload_envelope))?, option_string(record.source_type), option_string(record.source_id), json!(record.created_at_ms), json!(record.updated_at_ms), option_i64(record.expires_at_ms)],
            )?;
            Ok(Value::Null)
        }
        LocalDataRepositoryOperation::MemoryDeleteMemoryItem { memory_item_id } => {
            validate_id(&memory_item_id, "memory.id")?;
            let rows = conn.query(
                "SELECT id FROM aurora_memory_items WHERE id = ? AND profile_id = ? AND local_node_id = ? LIMIT 1",
                &[json!(memory_item_id), json!(profile_id), json!(local_node_id)],
            )?;
            if rows.is_empty() {
                return Ok(json!({ "deleted": false }));
            }
            conn.execute(
                "DELETE FROM aurora_memory_items WHERE id = ? AND profile_id = ? AND local_node_id = ?",
                &[json!(memory_item_id), json!(profile_id), json!(local_node_id)],
            )?;
            Ok(json!({ "deleted": true }))
        }
        LocalDataRepositoryOperation::MemoryDeleteExpiredMemoryItems {
            profile_id: requested_profile,
            local_node_id: requested_node,
            now_ms,
            limit,
        } => {
            ensure_scope(
                profile_id,
                local_node_id,
                &requested_profile,
                &requested_node,
            )?;
            validate_delete_now_ms(now_ms)?;
            let normalized_limit = validate_delete_limit(limit)?;
            conn.execute(
                "DELETE FROM aurora_memory_items
                 WHERE profile_id = ? AND local_node_id = ? AND id IN (
                    SELECT id FROM aurora_memory_items
                    WHERE profile_id = ? AND local_node_id = ? AND expires_at_ms IS NOT NULL AND expires_at_ms <= ?
                    ORDER BY expires_at_ms ASC, id ASC
                    LIMIT ?
                 )",
                &[
                    json!(profile_id),
                    json!(local_node_id),
                    json!(profile_id),
                    json!(local_node_id),
                    json!(now_ms),
                    json!(normalized_limit),
                ],
            )?;
            Ok(json!({ "deleted": sqlite_changes(conn)? }))
        }
        LocalDataRepositoryOperation::MemoryListMemoryItems {
            profile_id: requested_profile,
            local_node_id: requested_node,
            namespace,
        } => {
            ensure_scope(
                profile_id,
                local_node_id,
                &requested_profile,
                &requested_node,
            )?;
            let rows = if let Some(namespace) = namespace {
                conn.query(
                    "SELECT id, profile_id, local_node_id, namespace, payload_envelope_json, source_type, source_id, created_at_ms, updated_at_ms, expires_at_ms
                     FROM aurora_memory_items WHERE profile_id = ? AND local_node_id = ? AND namespace = ?
                     ORDER BY updated_at_ms DESC, id ASC",
                    &[json!(profile_id), json!(local_node_id), json!(namespace)],
                )?
            } else {
                conn.query(
                    "SELECT id, profile_id, local_node_id, namespace, payload_envelope_json, source_type, source_id, created_at_ms, updated_at_ms, expires_at_ms
                     FROM aurora_memory_items WHERE profile_id = ? AND local_node_id = ?
                     ORDER BY updated_at_ms DESC, id ASC",
                    &[json!(profile_id), json!(local_node_id)],
                )?
            };
            Ok(Value::Array(
                rows.into_iter()
                    .map(memory_from_row)
                    .collect::<Result<Vec<_>, _>>()?,
            ))
        }
        LocalDataRepositoryOperation::LocalToolsUpsertLocalToolState { record } => {
            validate_tool_record(&record)?;
            ensure_scope(
                profile_id,
                local_node_id,
                &record.profile_id,
                &record.local_node_id,
            )?;
            conn.execute(
                "INSERT INTO aurora_local_tool_state (profile_id, local_node_id, tool_contract_id, descriptor_json, descriptor_hash, enabled, settings_envelope_json, revision, updated_at_ms)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(profile_id, local_node_id, tool_contract_id) DO UPDATE SET descriptor_json = excluded.descriptor_json, descriptor_hash = excluded.descriptor_hash, enabled = excluded.enabled, settings_envelope_json = excluded.settings_envelope_json, revision = excluded.revision, updated_at_ms = excluded.updated_at_ms",
                &[json!(record.profile_id), json!(record.local_node_id), json!(record.tool_contract_id), json_or_null(Some(record.descriptor_json))?, json!(record.descriptor_hash), json!(record.enabled), json_or_null(record.settings_envelope)?, json!(record.revision), json!(record.updated_at_ms)],
            )?;
            Ok(Value::Null)
        }
        LocalDataRepositoryOperation::LocalToolsListLocalToolStates {
            profile_id: requested_profile,
            local_node_id: requested_node,
        } => {
            ensure_scope(
                profile_id,
                local_node_id,
                &requested_profile,
                &requested_node,
            )?;
            Ok(Value::Array(conn.query(
                "SELECT profile_id, local_node_id, tool_contract_id, descriptor_json, descriptor_hash, enabled, settings_envelope_json, revision, updated_at_ms
                 FROM aurora_local_tool_state WHERE profile_id = ? AND local_node_id = ?
                 ORDER BY tool_contract_id ASC",
                &[json!(profile_id), json!(local_node_id)],
            )?.into_iter().map(tool_from_row).collect::<Result<Vec<_>, _>>()?))
        }
        LocalDataRepositoryOperation::PeerGrantsUpsertPeerGrant { record } => {
            validate_grant_record(&record)?;
            ensure_scope(
                profile_id,
                local_node_id,
                &record.profile_id,
                &record.local_node_id,
            )?;
            ensure_scoped_global_key_available(
                conn,
                "aurora_peer_grant_metadata",
                "grant_id",
                &record.grant_id,
                profile_id,
                local_node_id,
            )?;
            conn.execute(
                "INSERT INTO aurora_peer_grant_metadata (grant_id, profile_id, local_node_id, claimant_peer_id, token_id, scope_envelope_json, revision, created_at_ms, expires_at_ms, revoked_at_ms)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(grant_id) DO UPDATE SET claimant_peer_id = excluded.claimant_peer_id, token_id = excluded.token_id, scope_envelope_json = excluded.scope_envelope_json, revision = excluded.revision, expires_at_ms = excluded.expires_at_ms, revoked_at_ms = excluded.revoked_at_ms",
                &[json!(record.grant_id), json!(record.profile_id), json!(record.local_node_id), json!(record.claimant_peer_id), json!(record.token_id), json_or_null(Some(record.scope_envelope))?, json!(record.revision), json!(record.created_at_ms), option_i64(record.expires_at_ms), option_i64(record.revoked_at_ms)],
            )?;
            Ok(Value::Null)
        }
        LocalDataRepositoryOperation::PeerGrantsListPeerGrants {
            profile_id: requested_profile,
            local_node_id: requested_node,
        } => {
            ensure_scope(
                profile_id,
                local_node_id,
                &requested_profile,
                &requested_node,
            )?;
            Ok(Value::Array(conn.query(
                "SELECT grant_id, profile_id, local_node_id, claimant_peer_id, token_id, scope_envelope_json, revision, created_at_ms, expires_at_ms, revoked_at_ms
                 FROM aurora_peer_grant_metadata WHERE profile_id = ? AND local_node_id = ?
                 ORDER BY created_at_ms DESC, grant_id ASC",
                &[json!(profile_id), json!(local_node_id)],
            )?.into_iter().map(grant_from_row).collect::<Result<Vec<_>, _>>()?))
        }
        LocalDataRepositoryOperation::LocalAuditAppendAudit { record } => {
            validate_audit_record(&record)?;
            ensure_scope(
                profile_id,
                local_node_id,
                &record.profile_id,
                &record.local_node_id,
            )?;
            ensure_scoped_global_key_available(
                conn,
                "aurora_local_audit",
                "id",
                &record.id,
                profile_id,
                local_node_id,
            )?;
            conn.execute(
                "INSERT INTO aurora_local_audit (id, profile_id, local_node_id, peer_id, action, decision, result_status, connection_epoch, method_id, tool_contract_id, correlation_id, redacted_detail_json, created_at_ms)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                &[json!(record.id), json!(record.profile_id), json!(record.local_node_id), option_string(record.peer_id), json!(record.action), json!(record.decision), json!(record.result_status), option_string(record.connection_epoch), option_string(record.method_id), option_string(record.tool_contract_id), option_string(record.correlation_id), json_or_null(Some(record.redacted_detail_json))?, json!(record.created_at_ms)],
            )?;
            Ok(Value::Null)
        }
        LocalDataRepositoryOperation::LocalAuditListAudit {
            profile_id: requested_profile,
            local_node_id: requested_node,
        } => {
            ensure_scope(
                profile_id,
                local_node_id,
                &requested_profile,
                &requested_node,
            )?;
            Ok(Value::Array(conn.query(
                "SELECT id, profile_id, local_node_id, peer_id, action, decision, result_status, connection_epoch, method_id, tool_contract_id, correlation_id, redacted_detail_json, created_at_ms
                 FROM aurora_local_audit WHERE profile_id = ? AND local_node_id = ?
                 ORDER BY created_at_ms DESC, id ASC",
                &[json!(profile_id), json!(local_node_id)],
            )?.into_iter().map(audit_from_row).collect::<Result<Vec<_>, _>>()?))
        }
        LocalDataRepositoryOperation::TranscriptsCreateSession { record } => {
            validate_transcript_session(&record)?;
            ensure_scope(
                profile_id,
                local_node_id,
                &record.profile_id,
                &record.local_node_id,
            )?;
            if record.lifecycle != "active" {
                return Err(local_data_error("transcript_session_must_start_active"));
            }
            if select_count(conn, "SELECT COUNT(*) AS count FROM aurora_transcript_sessions WHERE profile_id = ? AND local_node_id = ?", &[json!(profile_id), json!(local_node_id)])? >= MAX_TRANSCRIPT_SESSIONS as i64 {
                return Err(local_data_error("transcript_session_limit"));
            }
            let existing = conn.query(
                "SELECT id FROM aurora_transcript_sessions WHERE id = ? LIMIT 1",
                &[json!(record.id)],
            )?;
            if !existing.is_empty() {
                return Err(local_data_error("transcript_session_id_conflict"));
            }
            insert_transcript_session(conn, &record)?;
            serde_json::to_value(record).map_err(|error| local_data_error(error.to_string()))
        }
        LocalDataRepositoryOperation::TranscriptsStartSession {
            profile_id: requested_profile,
            local_node_id: requested_node,
            session_id,
            started_at_ms,
        } => {
            ensure_scope(
                profile_id,
                local_node_id,
                &requested_profile,
                &requested_node,
            )?;
            validate_id(&session_id, "transcript.sessionId")?;
            validate_safe_int(started_at_ms, "transcript.startedAtMs")?;
            let rows = conn.query(
                "SELECT * FROM aurora_transcript_sessions WHERE id = ? AND profile_id = ? AND local_node_id = ? LIMIT 1",
                &[json!(session_id), json!(profile_id), json!(local_node_id)],
            )?;
            let mut record = transcript_session_from_row(
                rows.first()
                    .ok_or_else(|| local_data_error("transcript_session_not_found"))?,
            )?;
            if record.lifecycle != "active" {
                return Err(local_data_error("transcript_session_terminal"));
            }
            record.started_at_ms = record.started_at_ms.min(started_at_ms);
            validate_transcript_session(&record)?;
            insert_transcript_session_replace(conn, &record)?;
            serde_json::to_value(record).map_err(|error| local_data_error(error.to_string()))
        }
        LocalDataRepositoryOperation::TranscriptsAppendSegment { record } => {
            validate_transcript_segment(&record, profile_id, local_node_id)?;
            let sessions = conn.query(
                "SELECT * FROM aurora_transcript_sessions WHERE id = ? AND profile_id = ? AND local_node_id = ? LIMIT 1",
                &[json!(record.session_id), json!(profile_id), json!(local_node_id)],
            )?;
            let session = sessions
                .first()
                .ok_or_else(|| local_data_error("transcript_session_not_found"))?;
            let parent = transcript_session_from_row(session)?;
            let existing = conn.query(
                "SELECT * FROM aurora_transcript_segments WHERE id = ? LIMIT 1",
                &[json!(record.id)],
            )?;
            if let Some(row) = existing.first() {
                let prior = transcript_segment_from_row(row)?;
                if prior == record {
                    return Ok(json!({"appended": false, "record": prior}));
                }
                return Err(local_data_error("transcript_segment_id_conflict"));
            }
            if parent.lifecycle != "active" {
                return Err(local_data_error("transcript_session_terminal"));
            }
            if record.start_at_ms < parent.started_at_ms {
                return Err(local_data_error("transcript_segment_before_session"));
            }
            let duplicate_sequence = conn.query(
                "SELECT id FROM aurora_transcript_segments WHERE session_id = ? AND sequence = ? LIMIT 1",
                &[json!(record.session_id), json!(record.sequence)],
            )?;
            if !duplicate_sequence.is_empty() {
                return Err(local_data_error("transcript_segment_sequence_conflict"));
            }
            let count = select_count(conn, "SELECT COUNT(*) AS count FROM aurora_transcript_segments segments INNER JOIN aurora_transcript_sessions sessions ON sessions.id = segments.session_id WHERE sessions.profile_id = ? AND sessions.local_node_id = ?", &[json!(profile_id), json!(local_node_id)])?;
            if count >= MAX_TRANSCRIPT_SEGMENTS as i64 {
                return Err(local_data_error("transcript_segment_limit"));
            }
            insert_transcript_segment(conn, &record)?;
            Ok(json!({"appended": true, "record": record}))
        }
        LocalDataRepositoryOperation::TranscriptsGetSession {
            profile_id: requested_profile,
            local_node_id: requested_node,
            session_id,
        } => {
            ensure_scope(
                profile_id,
                local_node_id,
                &requested_profile,
                &requested_node,
            )?;
            validate_id(&session_id, "transcript.sessionId")?;
            let rows = conn.query(
                "SELECT * FROM aurora_transcript_sessions WHERE id = ? AND profile_id = ? AND local_node_id = ? LIMIT 1",
                &[json!(session_id), json!(profile_id), json!(local_node_id)],
            )?;
            match rows.first() {
                Some(row) => serde_json::to_value(transcript_session_from_row(row)?)
                    .map_err(|error| local_data_error(error.to_string())),
                None => Ok(Value::Null),
            }
        }
        LocalDataRepositoryOperation::TranscriptsListSessions {
            profile_id: requested_profile,
            local_node_id: requested_node,
            options,
        } => {
            ensure_scope(
                profile_id,
                local_node_id,
                &requested_profile,
                &requested_node,
            )?;
            let (limit, cursor) = transcript_session_query(options)?;
            let rows = if let Some((created_at_ms, id)) = cursor {
                conn.query("SELECT * FROM aurora_transcript_sessions WHERE profile_id = ? AND local_node_id = ? AND (created_at_ms < ? OR (created_at_ms = ? AND id > ?)) ORDER BY created_at_ms DESC, id ASC LIMIT ?", &[json!(profile_id), json!(local_node_id), json!(created_at_ms), json!(created_at_ms), json!(id), json!(limit)])?
            } else {
                conn.query("SELECT * FROM aurora_transcript_sessions WHERE profile_id = ? AND local_node_id = ? ORDER BY created_at_ms DESC, id ASC LIMIT ?", &[json!(profile_id), json!(local_node_id), json!(limit)])?
            };
            rows.iter()
                .map(transcript_session_from_row)
                .collect::<Result<Vec<_>, _>>()
                .and_then(|records| {
                    serde_json::to_value(records)
                        .map_err(|error| local_data_error(error.to_string()))
                })
        }
        LocalDataRepositoryOperation::TranscriptsListSegments {
            profile_id: requested_profile,
            local_node_id: requested_node,
            session_id,
            options,
        } => {
            ensure_scope(
                profile_id,
                local_node_id,
                &requested_profile,
                &requested_node,
            )?;
            validate_id(&session_id, "transcript.sessionId")?;
            let (limit, after) = transcript_segment_query(options)?;
            let params = if let Some(after) = after {
                vec![
                    json!(session_id),
                    json!(profile_id),
                    json!(local_node_id),
                    json!(after),
                    json!(limit),
                ]
            } else {
                vec![
                    json!(session_id),
                    json!(profile_id),
                    json!(local_node_id),
                    json!(limit),
                ]
            };
            let sql = if after.is_some() {
                "SELECT s.* FROM aurora_transcript_segments s INNER JOIN aurora_transcript_sessions a ON a.id = s.session_id WHERE s.session_id = ? AND a.profile_id = ? AND a.local_node_id = ? AND s.sequence > ? ORDER BY s.sequence ASC, s.id ASC LIMIT ?"
            } else {
                "SELECT s.* FROM aurora_transcript_segments s INNER JOIN aurora_transcript_sessions a ON a.id = s.session_id WHERE s.session_id = ? AND a.profile_id = ? AND a.local_node_id = ? ORDER BY s.sequence ASC, s.id ASC LIMIT ?"
            };
            let rows = conn.query(sql, &params)?;
            rows.iter()
                .map(transcript_segment_from_row)
                .collect::<Result<Vec<_>, _>>()
                .and_then(|records| {
                    serde_json::to_value(records)
                        .map_err(|error| local_data_error(error.to_string()))
                })
        }
        LocalDataRepositoryOperation::TranscriptsFinalizeSession {
            profile_id: requested_profile,
            local_node_id: requested_node,
            input,
        } => {
            ensure_scope(
                profile_id,
                local_node_id,
                &requested_profile,
                &requested_node,
            )?;
            validate_id(&input.session_id, "transcript.sessionId")?;
            validate_safe_int(input.ended_at_ms, "transcript.endedAtMs")?;
            validate_optional_text(
                Some(&input.terminal_reason),
                512,
                "transcript.terminalReason",
            )?;
            if input.terminal_reason.trim().is_empty()
                || !matches!(
                    input.lifecycle.as_str(),
                    "completed" | "interrupted" | "failed"
                )
            {
                return Err(local_data_error("invalid_transcript_terminal"));
            }
            let rows = conn.query("SELECT * FROM aurora_transcript_sessions WHERE id = ? AND profile_id = ? AND local_node_id = ? LIMIT 1", &[json!(input.session_id), json!(profile_id), json!(local_node_id)])?;
            let mut record = transcript_session_from_row(
                rows.first()
                    .ok_or_else(|| local_data_error("transcript_session_not_found"))?,
            )?;
            if record.lifecycle == input.lifecycle
                && record.ended_at_ms == Some(input.ended_at_ms)
                && record.terminal_reason.as_deref() == Some(input.terminal_reason.as_str())
            {
                return serde_json::to_value(record)
                    .map_err(|error| local_data_error(error.to_string()));
            }
            if record.lifecycle != "active" {
                return Err(local_data_error("transcript_session_terminal_conflict"));
            }
            if input.ended_at_ms < record.started_at_ms {
                return Err(local_data_error("transcript_terminal_before_start"));
            }
            record.lifecycle = input.lifecycle;
            record.ended_at_ms = Some(input.ended_at_ms);
            record.terminal_reason = Some(input.terminal_reason);
            validate_transcript_session(&record)?;
            insert_transcript_session_replace(conn, &record)?;
            serde_json::to_value(record).map_err(|error| local_data_error(error.to_string()))
        }
        LocalDataRepositoryOperation::TranscriptsRecoverActiveSessions {
            profile_id: requested_profile,
            local_node_id: requested_node,
            now_ms,
            terminal_reason,
        } => {
            ensure_scope(
                profile_id,
                local_node_id,
                &requested_profile,
                &requested_node,
            )?;
            let reason = terminal_reason.as_deref().unwrap_or("process_restart");
            Ok(
                json!({"interrupted": recover_transcript_sessions(conn, profile_id, local_node_id, now_ms, reason)?}),
            )
        }
        LocalDataRepositoryOperation::TranscriptsDeleteSession {
            profile_id: requested_profile,
            local_node_id: requested_node,
            session_id,
        } => {
            ensure_scope(
                profile_id,
                local_node_id,
                &requested_profile,
                &requested_node,
            )?;
            validate_id(&session_id, "transcript.sessionId")?;
            let rows = conn.query("SELECT id FROM aurora_transcript_sessions WHERE id = ? AND profile_id = ? AND local_node_id = ? LIMIT 1", &[json!(session_id), json!(profile_id), json!(local_node_id)])?;
            if rows.is_empty() {
                return Ok(json!({"deleted": false, "deletedSegments": 0}));
            }
            let deleted_segments = select_count(
                conn,
                "SELECT COUNT(*) AS count FROM aurora_transcript_segments WHERE session_id = ?",
                &[json!(session_id)],
            )?;
            conn.execute("DELETE FROM aurora_transcript_sessions WHERE id = ? AND profile_id = ? AND local_node_id = ?", &[json!(session_id), json!(profile_id), json!(local_node_id)])?;
            Ok(json!({"deleted": true, "deletedSegments": deleted_segments}))
        }
        LocalDataRepositoryOperation::TranscriptsDeleteExpiredSessions {
            profile_id: requested_profile,
            local_node_id: requested_node,
            now_ms,
            limit,
        } => {
            ensure_scope(
                profile_id,
                local_node_id,
                &requested_profile,
                &requested_node,
            )?;
            validate_delete_now_ms(now_ms)?;
            if !(1..=MAX_TRANSCRIPT_DELETE_LIMIT).contains(&limit) {
                return Err(local_data_error("transcript_delete_limit"));
            }
            conn.exec("SAVEPOINT transcript_expiry_delete;")?;
            let result = (|| {
                let rows = conn.query("SELECT id FROM aurora_transcript_sessions WHERE profile_id = ? AND local_node_id = ? AND expires_at_ms IS NOT NULL AND expires_at_ms <= ? ORDER BY expires_at_ms ASC, id ASC LIMIT ?", &[json!(profile_id), json!(local_node_id), json!(now_ms), json!(limit)])?;
                let ids = rows
                    .iter()
                    .map(|row| row_string(row, "id"))
                    .collect::<Result<Vec<_>, _>>()?;
                let mut deleted_segments = 0i64;
                for id in &ids {
                    deleted_segments += select_count(conn, "SELECT COUNT(*) AS count FROM aurora_transcript_segments WHERE session_id = ?", &[json!(id)])?;
                    conn.execute("DELETE FROM aurora_transcript_sessions WHERE id = ? AND profile_id = ? AND local_node_id = ?", &[json!(id), json!(profile_id), json!(local_node_id)])?;
                }
                Ok(json!({"deletedSessions": ids.len(), "deletedSegments": deleted_segments}))
            })();
            match result {
                Ok(value) => {
                    conn.exec("RELEASE transcript_expiry_delete;")?;
                    Ok(value)
                }
                Err(error) => {
                    let _ = conn.exec("ROLLBACK TO transcript_expiry_delete;");
                    let _ = conn.exec("RELEASE transcript_expiry_delete;");
                    Err(error)
                }
            }
        }
    }
}

fn validate_transcript_session(record: &TranscriptSessionRecord) -> Result<(), AuroraCommandError> {
    validate_id(&record.id, "transcript.id")?;
    validate_id(&record.profile_id, "transcript.profileId")?;
    validate_id(&record.local_node_id, "transcript.localNodeId")?;
    if !matches!(record.capture_mode.as_str(), "ambient" | "notification") {
        return Err(local_data_error("invalid_transcript_capture_mode"));
    }
    validate_safe_int(record.created_at_ms, "transcript.createdAtMs")?;
    validate_safe_int(record.started_at_ms, "transcript.startedAtMs")?;
    validate_optional_safe_int(record.ended_at_ms, "transcript.endedAtMs")?;
    validate_optional_safe_int(record.expires_at_ms, "transcript.expiresAtMs")?;
    if record.started_at_ms < record.created_at_ms
        || record
            .ended_at_ms
            .is_some_and(|ended| ended < record.started_at_ms)
        || record
            .expires_at_ms
            .is_some_and(|expires| expires < record.created_at_ms)
    {
        return Err(local_data_error("invalid_transcript_session_timestamps"));
    }
    match (
        record.lifecycle.as_str(),
        record.ended_at_ms,
        record.terminal_reason.as_deref(),
    ) {
        ("active", None, None) => {}
        ("completed" | "interrupted" | "failed", Some(_), Some(reason))
            if !reason.trim().is_empty() =>
        {
            validate_optional_text(Some(reason), 512, "transcript.terminalReason")?;
        }
        _ => return Err(local_data_error("invalid_transcript_lifecycle")),
    }
    validate_optional_text(record.language.as_deref(), 64, "transcript.language")?;
    validate_optional_text(
        record.model_provenance.provider.as_deref(),
        256,
        "transcript.modelProvenance.provider",
    )?;
    validate_optional_text(
        record.model_provenance.model_id.as_deref(),
        256,
        "transcript.modelProvenance.modelId",
    )?;
    validate_optional_text(
        record.model_provenance.version.as_deref(),
        256,
        "transcript.modelProvenance.version",
    )?;
    if !matches!(
        record.diarization_state.as_str(),
        "not_requested" | "pending" | "partial" | "available" | "unavailable"
    ) {
        return Err(local_data_error("invalid_transcript_diarization_state"));
    }
    Ok(())
}

fn validate_transcript_segment(
    record: &TranscriptSegmentRecord,
    profile_id: &str,
    local_node_id: &str,
) -> Result<(), AuroraCommandError> {
    validate_id(&record.id, "transcriptSegment.id")?;
    validate_id(&record.session_id, "transcriptSegment.sessionId")?;
    validate_safe_int(record.sequence, "transcriptSegment.sequence")?;
    validate_safe_int(record.start_at_ms, "transcriptSegment.startAtMs")?;
    validate_safe_int(record.end_at_ms, "transcriptSegment.endAtMs")?;
    validate_safe_int(record.created_at_ms, "transcriptSegment.createdAtMs")?;
    if record.end_at_ms < record.start_at_ms {
        return Err(local_data_error("transcript_segment_end_before_start"));
    }
    if let Some(confidence) = record.confidence {
        if !confidence.is_finite()
            || !(0.0..=1.0).contains(&confidence)
            || (confidence == 0.0 && confidence.is_sign_negative())
        {
            return Err(local_data_error("invalid_transcript_confidence"));
        }
    }
    validate_optional_text(
        record.speaker_id.as_deref(),
        256,
        "transcriptSegment.speakerId",
    )?;
    validate_optional_text(
        record.speaker_label.as_deref(),
        256,
        "transcriptSegment.speakerLabel",
    )?;
    validate_envelope(
        &record.text_envelope,
        profile_id,
        local_node_id,
        "transcriptSegment.textEnvelope",
    )
}

fn transcript_session_query(
    query: Option<TranscriptSessionListQuery>,
) -> Result<(usize, Option<(i64, String)>), AuroraCommandError> {
    let limit = query.as_ref().and_then(|value| value.limit).unwrap_or(100);
    if !(1..=MAX_TRANSCRIPT_SESSION_QUERY).contains(&limit) {
        return Err(local_data_error("transcript_session_query_limit"));
    }
    let cursor = query
        .and_then(|value| value.cursor)
        .map(|cursor| {
            validate_safe_int(cursor.created_at_ms, "transcript.cursor.createdAtMs")?;
            validate_id(&cursor.id, "transcript.cursor.id")?;
            Ok((cursor.created_at_ms, cursor.id))
        })
        .transpose()?;
    Ok((limit, cursor))
}

fn transcript_segment_query(
    query: Option<TranscriptSegmentListQuery>,
) -> Result<(usize, Option<i64>), AuroraCommandError> {
    let limit = query.as_ref().and_then(|value| value.limit).unwrap_or(500);
    if !(1..=MAX_TRANSCRIPT_SEGMENT_QUERY).contains(&limit) {
        return Err(local_data_error("transcript_segment_query_limit"));
    }
    let after = query.and_then(|value| value.after_sequence);
    validate_optional_safe_int(after, "transcript.afterSequence")?;
    Ok((limit, after))
}

fn transcript_session_from_row(row: &Value) -> Result<TranscriptSessionRecord, AuroraCommandError> {
    let value = json!({
        "id": row_string(row, "id")?,
        "profileId": row_string(row, "profile_id")?,
        "localNodeId": row_string(row, "local_node_id")?,
        "captureMode": row_string(row, "capture_mode")?,
        "createdAtMs": row_i64(row, "created_at_ms")?,
        "startedAtMs": row_i64(row, "started_at_ms")?,
        "endedAtMs": row.get("ended_at_ms").and_then(Value::as_i64),
        "lifecycle": row_string(row, "lifecycle")?,
        "terminalReason": row.get("terminal_reason").and_then(Value::as_str),
        "expiresAtMs": row.get("expires_at_ms").and_then(Value::as_i64),
        "language": row.get("language").and_then(Value::as_str),
        "modelProvenance": parse_json_column(row, "model_provenance_json")?,
        "diarizationState": row_string(row, "diarization_state")?,
    });
    serde_json::from_value(value).map_err(|error| local_data_error(error.to_string()))
}

fn transcript_segment_from_row(row: &Value) -> Result<TranscriptSegmentRecord, AuroraCommandError> {
    let value = json!({
        "id": row_string(row, "id")?,
        "sessionId": row_string(row, "session_id")?,
        "sequence": row_i64(row, "sequence")?,
        "startAtMs": row_i64(row, "start_at_ms")?,
        "endAtMs": row_i64(row, "end_at_ms")?,
        "textEnvelope": parse_json_column(row, "text_envelope_json")?,
        "confidence": row.get("confidence").and_then(Value::as_f64),
        "speakerId": row.get("speaker_id").and_then(Value::as_str),
        "speakerLabel": row.get("speaker_label").and_then(Value::as_str),
        "createdAtMs": row_i64(row, "created_at_ms")?,
    });
    serde_json::from_value(value).map_err(|error| local_data_error(error.to_string()))
}

fn insert_transcript_session(
    conn: &SqliteConnection,
    record: &TranscriptSessionRecord,
) -> Result<(), AuroraCommandError> {
    conn.execute("INSERT INTO aurora_transcript_sessions (id, profile_id, local_node_id, capture_mode, created_at_ms, started_at_ms, ended_at_ms, lifecycle, terminal_reason, expires_at_ms, language, model_provenance_json, diarization_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", &[
        json!(record.id), json!(record.profile_id), json!(record.local_node_id), json!(record.capture_mode), json!(record.created_at_ms), json!(record.started_at_ms), option_i64(record.ended_at_ms), json!(record.lifecycle), optional_str_value(record.terminal_reason.as_deref()), option_i64(record.expires_at_ms), optional_str_value(record.language.as_deref()), json!(serde_json::to_string(&record.model_provenance).map_err(|error| local_data_error(error.to_string()))?), json!(record.diarization_state),
    ])
}

fn insert_transcript_session_replace(
    conn: &SqliteConnection,
    record: &TranscriptSessionRecord,
) -> Result<(), AuroraCommandError> {
    conn.execute("UPDATE aurora_transcript_sessions SET started_at_ms = ?, ended_at_ms = ?, lifecycle = ?, terminal_reason = ?, expires_at_ms = ?, language = ?, model_provenance_json = ?, diarization_state = ? WHERE id = ? AND profile_id = ? AND local_node_id = ?", &[
        json!(record.started_at_ms), option_i64(record.ended_at_ms), json!(record.lifecycle), optional_str_value(record.terminal_reason.as_deref()), option_i64(record.expires_at_ms), optional_str_value(record.language.as_deref()), json!(serde_json::to_string(&record.model_provenance).map_err(|error| local_data_error(error.to_string()))?), json!(record.diarization_state), json!(record.id), json!(record.profile_id), json!(record.local_node_id),
    ])?;
    if sqlite_changes(conn)? == 0 {
        return Err(local_data_error("transcript_session_not_found"));
    }
    Ok(())
}

fn insert_transcript_segment(
    conn: &SqliteConnection,
    record: &TranscriptSegmentRecord,
) -> Result<(), AuroraCommandError> {
    conn.execute("INSERT INTO aurora_transcript_segments (id, session_id, sequence, start_at_ms, end_at_ms, text_envelope_json, confidence, speaker_id, speaker_label, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", &[
        json!(record.id), json!(record.session_id), json!(record.sequence), json!(record.start_at_ms), json!(record.end_at_ms), json!(serde_json::to_string(&record.text_envelope).map_err(|error| local_data_error(error.to_string()))?), option_f64(record.confidence), optional_str_value(record.speaker_id.as_deref()), optional_str_value(record.speaker_label.as_deref()), json!(record.created_at_ms),
    ])
}

fn recover_transcript_sessions(
    conn: &SqliteConnection,
    profile_id: &str,
    local_node_id: &str,
    now_ms: i64,
    reason: &str,
) -> Result<i64, AuroraCommandError> {
    validate_safe_int(now_ms, "transcript.recovery.nowMs")?;
    validate_optional_text(Some(reason), 512, "transcript.recovery.reason")?;
    if reason.trim().is_empty() {
        return Err(local_data_error("transcript_recovery_reason"));
    }
    conn.execute("UPDATE aurora_transcript_sessions SET lifecycle = 'interrupted', ended_at_ms = MAX(started_at_ms, ?), terminal_reason = ? WHERE profile_id = ? AND local_node_id = ? AND lifecycle = 'active'", &[json!(now_ms), json!(reason), json!(profile_id), json!(local_node_id)])?;
    sqlite_changes(conn)
}

fn optional_str_value(value: Option<&str>) -> Value {
    value.map_or(Value::Null, |value| json!(value))
}
fn option_f64(value: Option<f64>) -> Value {
    value.map_or(Value::Null, |value| json!(value))
}

pub(crate) fn persist_native_voice_turn_at_path(
    db_path: PathBuf,
    request: NativeVoiceTurnPersistenceRequest,
) -> Result<NativeVoiceTurnPersistenceResult, AuroraCommandError> {
    validate_safe_int(request.created_at_ms, "voice.createdAtMs")?;
    validate_safe_int(request.completed_at_ms, "voice.completedAtMs")?;
    if request.completed_at_ms < request.created_at_ms {
        return Err(local_data_error("voice completedAtMs before createdAtMs"));
    }
    validate_id(&request.new_conversation_id, "voice.newConversationId")?;
    validate_id(&request.user_message_id, "voice.userMessageId")?;
    match (
        request.assistant_message_id.as_deref(),
        request.assistant_content_envelope.as_ref(),
    ) {
        (Some(message_id), Some(_)) => validate_id(message_id, "voice.assistantMessageId")?,
        (None, None) => {}
        _ => return Err(local_data_error("voice assistant message is incomplete")),
    }

    open_local_data_at_path(db_path.clone(), &request.profile_id, &request.local_node_id)?;
    let conn = SqliteConnection::open(db_path)?;
    conn.exec("BEGIN IMMEDIATE;")?;
    let result = persist_native_voice_turn(&conn, request);
    match result {
        Ok(response) => {
            conn.exec("COMMIT;")?;
            Ok(response)
        }
        Err(error) => {
            let _ = conn.exec("ROLLBACK;");
            Err(error)
        }
    }
}

fn persist_native_voice_turn(
    conn: &SqliteConnection,
    request: NativeVoiceTurnPersistenceRequest,
) -> Result<NativeVoiceTurnPersistenceResult, AuroraCommandError> {
    let duplicate = conn.query(
        "SELECT m.conversation_id
         FROM aurora_messages m
         INNER JOIN aurora_conversations c ON c.id = m.conversation_id
         WHERE m.id = ? AND c.profile_id = ? AND c.local_node_id = ?
         LIMIT 1",
        &[
            json!(request.user_message_id),
            json!(request.profile_id),
            json!(request.local_node_id),
        ],
    )?;
    if let Some(row) = duplicate.first() {
        return Ok(NativeVoiceTurnPersistenceResult {
            conversation_id: row_string(row, "conversation_id")?,
            user_message_id: request.user_message_id,
            assistant_message_id: request.assistant_message_id,
        });
    }

    let existing = conn
        .query(
            "SELECT id, created_at_ms, updated_at_ms
             FROM aurora_conversations
             WHERE profile_id = ? AND local_node_id = ? AND archived_at_ms IS NULL
             ORDER BY updated_at_ms DESC, id ASC
             LIMIT 1",
            &[json!(request.profile_id), json!(request.local_node_id)],
        )?
        .into_iter()
        .next();
    let (conversation_id, conversation_created_at_ms, conversation_updated_at_ms) = match existing {
        Some(row) => (
            row_string(&row, "id")?,
            row_i64(&row, "created_at_ms")?,
            row_i64(&row, "updated_at_ms")?,
        ),
        None => (
            request.new_conversation_id.clone(),
            request.created_at_ms,
            request.completed_at_ms,
        ),
    };

    run_repository_operation(
        conn,
        &request.profile_id,
        &request.local_node_id,
        LocalDataRepositoryOperation::ConversationsUpsertConversation {
            record: ConversationRecord {
                id: conversation_id.clone(),
                profile_id: request.profile_id.clone(),
                local_node_id: request.local_node_id.clone(),
                title_envelope: None,
                created_at_ms: conversation_created_at_ms,
                updated_at_ms: request.completed_at_ms.max(conversation_updated_at_ms),
                archived_at_ms: None,
            },
        },
    )?;

    let latest = conn.query(
        "SELECT MAX(m.sequence) AS latest_sequence FROM aurora_messages m INNER JOIN aurora_conversations c ON c.id = m.conversation_id WHERE m.conversation_id = ? AND c.profile_id = ? AND c.local_node_id = ?",
        &[json!(conversation_id), json!(&request.profile_id), json!(&request.local_node_id)],
    )?;
    let next_sequence = match latest
        .first()
        .and_then(|row| row.get("latest_sequence"))
        .and_then(Value::as_i64)
    {
        Some(value) => value
            .checked_add(1)
            .ok_or_else(|| local_data_error("message sequence exhausted"))?,
        None => 0,
    };
    if next_sequence > MAX_SAFE_INTEGER {
        return Err(local_data_error("message sequence exhausted"));
    }
    let mut next_sequence = next_sequence;
    run_repository_operation(
        conn,
        &request.profile_id,
        &request.local_node_id,
        LocalDataRepositoryOperation::ConversationsAppendMessage {
            record: ConversationMessageRecord {
                id: request.user_message_id.clone(),
                conversation_id: conversation_id.clone(),
                sequence: next_sequence,
                role: "user".to_string(),
                content_envelope: Some(request.user_content_envelope),
                tool_envelope: None,
                status: "complete".to_string(),
                created_at_ms: request.created_at_ms,
            },
        },
    )?;
    next_sequence += 1;

    if let (Some(message_id), Some(content_envelope)) = (
        request.assistant_message_id.clone(),
        request.assistant_content_envelope,
    ) {
        run_repository_operation(
            conn,
            &request.profile_id,
            &request.local_node_id,
            LocalDataRepositoryOperation::ConversationsAppendMessage {
                record: ConversationMessageRecord {
                    id: message_id,
                    conversation_id: conversation_id.clone(),
                    sequence: next_sequence,
                    role: "assistant".to_string(),
                    content_envelope: Some(content_envelope),
                    tool_envelope: None,
                    status: "complete".to_string(),
                    created_at_ms: request.completed_at_ms,
                },
            },
        )?;
    }

    Ok(NativeVoiceTurnPersistenceResult {
        conversation_id,
        user_message_id: request.user_message_id,
        assistant_message_id: request.assistant_message_id,
    })
}

fn import_records(
    conn: &SqliteConnection,
    profile_id: &str,
    local_node_id: &str,
    document: &LocalDataExportDocument,
) -> Result<Value, AuroraCommandError> {
    ensure_import_global_keys_available(conn, profile_id, local_node_id, document)?;
    conn.execute(
        "DELETE FROM aurora_local_audit WHERE profile_id = ? AND local_node_id = ?",
        &[json!(profile_id), json!(local_node_id)],
    )?;
    conn.execute(
        "DELETE FROM aurora_peer_grant_metadata WHERE profile_id = ? AND local_node_id = ?",
        &[json!(profile_id), json!(local_node_id)],
    )?;
    conn.execute(
        "DELETE FROM aurora_local_tool_state WHERE profile_id = ? AND local_node_id = ?",
        &[json!(profile_id), json!(local_node_id)],
    )?;
    conn.execute(
        "DELETE FROM aurora_memory_items WHERE profile_id = ? AND local_node_id = ?",
        &[json!(profile_id), json!(local_node_id)],
    )?;
    conn.execute(
        "DELETE FROM aurora_conversations WHERE profile_id = ? AND local_node_id = ?",
        &[json!(profile_id), json!(local_node_id)],
    )?;
    conn.execute(
        "DELETE FROM aurora_transcript_sessions WHERE profile_id = ? AND local_node_id = ?",
        &[json!(profile_id), json!(local_node_id)],
    )?;

    for record in &document.records.conversations {
        run_repository_operation(
            conn,
            profile_id,
            local_node_id,
            LocalDataRepositoryOperation::ConversationsUpsertConversation {
                record: record.clone(),
            },
        )?;
    }
    for record in &document.records.messages {
        run_repository_operation(
            conn,
            profile_id,
            local_node_id,
            LocalDataRepositoryOperation::ConversationsAppendMessage {
                record: record.clone(),
            },
        )?;
    }
    for record in &document.records.memory_items {
        run_repository_operation(
            conn,
            profile_id,
            local_node_id,
            LocalDataRepositoryOperation::MemoryUpsertMemoryItem {
                record: record.clone(),
            },
        )?;
    }
    for record in &document.records.local_tool_states {
        run_repository_operation(
            conn,
            profile_id,
            local_node_id,
            LocalDataRepositoryOperation::LocalToolsUpsertLocalToolState {
                record: record.clone(),
            },
        )?;
    }
    for record in &document.records.peer_grant_metadata {
        run_repository_operation(
            conn,
            profile_id,
            local_node_id,
            LocalDataRepositoryOperation::PeerGrantsUpsertPeerGrant {
                record: record.clone(),
            },
        )?;
    }
    for record in &document.records.local_audit {
        run_repository_operation(
            conn,
            profile_id,
            local_node_id,
            LocalDataRepositoryOperation::LocalAuditAppendAudit {
                record: record.clone(),
            },
        )?;
    }
    for record in &document.records.transcript_sessions {
        validate_transcript_session(record)?;
        ensure_scope(
            profile_id,
            local_node_id,
            &record.profile_id,
            &record.local_node_id,
        )?;
        insert_transcript_session(conn, record)?;
    }
    for record in &document.records.transcript_segments {
        validate_transcript_segment(record, profile_id, local_node_id)?;
        let parent = conn.query("SELECT id FROM aurora_transcript_sessions WHERE id = ? AND profile_id = ? AND local_node_id = ? LIMIT 1", &[json!(record.session_id), json!(profile_id), json!(local_node_id)])?;
        if parent.is_empty() {
            return Err(local_data_error("transcript_segment_session_missing"));
        }
        insert_transcript_segment(conn, record)?;
    }

    let imported = export_records(conn, profile_id, local_node_id)?;
    Ok(json!({
        "imported": true,
        "recordCounts": record_counts(&imported),
        "collectionHashes": collection_hashes(&imported)?,
    }))
}

fn export_records(
    conn: &SqliteConnection,
    profile_id: &str,
    local_node_id: &str,
) -> Result<Value, AuroraCommandError> {
    Ok(json!({
        "conversations": run_repository_operation(conn, profile_id, local_node_id, LocalDataRepositoryOperation::ConversationsListConversations { profile_id: profile_id.to_string(), local_node_id: local_node_id.to_string(), options: None })?,
        "messages": export_messages(conn, profile_id, local_node_id)?,
        "memoryItems": run_repository_operation(conn, profile_id, local_node_id, LocalDataRepositoryOperation::MemoryListMemoryItems { profile_id: profile_id.to_string(), local_node_id: local_node_id.to_string(), namespace: None })?,
        "localToolStates": run_repository_operation(conn, profile_id, local_node_id, LocalDataRepositoryOperation::LocalToolsListLocalToolStates { profile_id: profile_id.to_string(), local_node_id: local_node_id.to_string() })?,
        "peerGrantMetadata": run_repository_operation(conn, profile_id, local_node_id, LocalDataRepositoryOperation::PeerGrantsListPeerGrants { profile_id: profile_id.to_string(), local_node_id: local_node_id.to_string() })?,
        "localAudit": run_repository_operation(conn, profile_id, local_node_id, LocalDataRepositoryOperation::LocalAuditListAudit { profile_id: profile_id.to_string(), local_node_id: local_node_id.to_string() })?,
        "transcriptSessions": export_transcript_sessions(conn, profile_id, local_node_id)?,
        "transcriptSegments": export_transcript_segments(conn, profile_id, local_node_id)?,
    }))
}

fn export_transcript_sessions(
    conn: &SqliteConnection,
    profile_id: &str,
    local_node_id: &str,
) -> Result<Value, AuroraCommandError> {
    let rows = conn.query("SELECT * FROM aurora_transcript_sessions WHERE profile_id = ? AND local_node_id = ? ORDER BY id ASC", &[json!(profile_id), json!(local_node_id)])?;
    let records = rows
        .iter()
        .map(transcript_session_from_row)
        .collect::<Result<Vec<_>, _>>()?;
    serde_json::to_value(records).map_err(|error| local_data_error(error.to_string()))
}

fn export_transcript_segments(
    conn: &SqliteConnection,
    profile_id: &str,
    local_node_id: &str,
) -> Result<Value, AuroraCommandError> {
    let rows = conn.query("SELECT s.* FROM aurora_transcript_segments s INNER JOIN aurora_transcript_sessions a ON a.id = s.session_id WHERE a.profile_id = ? AND a.local_node_id = ? ORDER BY s.session_id ASC, s.sequence ASC, s.id ASC", &[json!(profile_id), json!(local_node_id)])?;
    let records = rows
        .iter()
        .map(transcript_segment_from_row)
        .collect::<Result<Vec<_>, _>>()?;
    serde_json::to_value(records).map_err(|error| local_data_error(error.to_string()))
}

fn ensure_import_global_keys_available(
    conn: &SqliteConnection,
    profile_id: &str,
    local_node_id: &str,
    document: &LocalDataExportDocument,
) -> Result<(), AuroraCommandError> {
    for record in &document.records.conversations {
        ensure_scoped_global_key_available(
            conn,
            "aurora_conversations",
            "id",
            &record.id,
            profile_id,
            local_node_id,
        )?;
    }
    for record in &document.records.messages {
        ensure_message_id_available(conn, &record.id, profile_id, local_node_id)?;
    }
    for record in &document.records.memory_items {
        ensure_scoped_global_key_available(
            conn,
            "aurora_memory_items",
            "id",
            &record.id,
            profile_id,
            local_node_id,
        )?;
    }
    for record in &document.records.peer_grant_metadata {
        ensure_scoped_global_key_available(
            conn,
            "aurora_peer_grant_metadata",
            "grant_id",
            &record.grant_id,
            profile_id,
            local_node_id,
        )?;
    }
    for record in &document.records.local_audit {
        ensure_scoped_global_key_available(
            conn,
            "aurora_local_audit",
            "id",
            &record.id,
            profile_id,
            local_node_id,
        )?;
    }
    for record in &document.records.transcript_sessions {
        ensure_scoped_global_key_available(
            conn,
            "aurora_transcript_sessions",
            "id",
            &record.id,
            profile_id,
            local_node_id,
        )?;
    }
    for record in &document.records.transcript_segments {
        let rows = conn.query("SELECT sessions.profile_id, sessions.local_node_id FROM aurora_transcript_segments segments INNER JOIN aurora_transcript_sessions sessions ON sessions.id = segments.session_id WHERE segments.id = ? LIMIT 1", &[json!(record.id)])?;
        ensure_existing_row_scope(rows.first(), profile_id, local_node_id)?;
    }
    Ok(())
}

fn ensure_scoped_global_key_available(
    conn: &SqliteConnection,
    table: &str,
    id_column: &str,
    id: &str,
    profile_id: &str,
    local_node_id: &str,
) -> Result<(), AuroraCommandError> {
    let sql =
        format!("SELECT profile_id, local_node_id FROM {table} WHERE {id_column} = ? LIMIT 1");
    let rows = conn.query(&sql, &[json!(id)])?;
    ensure_existing_row_scope(rows.first(), profile_id, local_node_id)
}

fn ensure_message_id_available(
    conn: &SqliteConnection,
    id: &str,
    profile_id: &str,
    local_node_id: &str,
) -> Result<(), AuroraCommandError> {
    let rows = conn.query(
        "SELECT c.profile_id, c.local_node_id
         FROM aurora_messages m
         INNER JOIN aurora_conversations c ON c.id = m.conversation_id
         WHERE m.id = ?
         LIMIT 1",
        &[json!(id)],
    )?;
    ensure_existing_row_scope(rows.first(), profile_id, local_node_id)
}

fn ensure_existing_row_scope(
    row: Option<&Value>,
    profile_id: &str,
    local_node_id: &str,
) -> Result<(), AuroraCommandError> {
    if let Some(row) = row {
        ensure_scope(
            profile_id,
            local_node_id,
            &row_string(row, "profile_id")?,
            &row_string(row, "local_node_id")?,
        )?;
    }
    Ok(())
}

fn export_messages(
    conn: &SqliteConnection,
    profile_id: &str,
    local_node_id: &str,
) -> Result<Value, AuroraCommandError> {
    Ok(Value::Array(conn.query(
        "SELECT m.id, m.conversation_id, m.sequence, m.role, m.content_envelope_json, m.tool_envelope_json, m.status, m.created_at_ms
         FROM aurora_messages m
         INNER JOIN aurora_conversations c ON c.id = m.conversation_id
         WHERE c.profile_id = ? AND c.local_node_id = ?
         ORDER BY m.conversation_id ASC, m.sequence ASC, m.id ASC",
        &[json!(profile_id), json!(local_node_id)],
    )?.into_iter().map(message_from_row).collect::<Result<Vec<_>, _>>()?))
}

fn apply_generated_migrations(conn: &SqliteConnection) -> Result<(), AuroraCommandError> {
    debug_assert_eq!(
        generated::local_data_migrations::LOCAL_DATA_LATEST_VERSION,
        generated::local_data_migrations::LOCAL_DATA_MIGRATIONS
            .last()
            .map(|migration| migration.version)
            .unwrap_or(0)
    );
    let current_version = schema_version(conn)?;
    if current_version > generated::local_data_migrations::LOCAL_DATA_LATEST_VERSION {
        return Err(local_data_error(
            "database schema is newer than this application",
        ));
    }
    validate_existing_ledger(conn)?;
    for migration in generated::local_data_migrations::LOCAL_DATA_MIGRATIONS
        .iter()
        .filter(|migration| migration.version > current_version)
    {
        conn.exec("BEGIN IMMEDIATE;")?;
        let result = conn
            .exec(migration.sql)
            .and_then(|_| conn.exec(migration.ledger_sql));
        match result {
            Ok(()) => conn.exec("COMMIT;")?,
            Err(error) => {
                let _ = conn.exec("ROLLBACK;");
                return Err(error);
            }
        }
    }
    validate_existing_ledger(conn)?;
    if !conn.query("PRAGMA foreign_key_check;", &[])?.is_empty() {
        return Err(local_data_error("foreign key check failed"));
    }
    Ok(())
}

fn validate_existing_ledger(conn: &SqliteConnection) -> Result<(), AuroraCommandError> {
    let has_ledger = !conn
        .query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'aurora_schema_migrations'",
            &[],
        )?
        .is_empty();
    if !has_ledger {
        return Ok(());
    }
    let rows = conn.query(
        "SELECT version, checksum FROM aurora_schema_migrations ORDER BY version ASC",
        &[],
    )?;
    for (index, row) in rows.iter().enumerate() {
        let version = row_i64(row, "version")?;
        let expected = generated::local_data_migrations::LOCAL_DATA_MIGRATIONS
            .get(index)
            .ok_or_else(|| local_data_error("unexpected local data migration version"))?;
        if version != i64::from(expected.version)
            || row_string(row, "checksum")? != expected.checksum
        {
            return Err(local_data_error(
                "local data migration ledger checksum mismatch",
            ));
        }
    }
    let current_version = schema_version(conn)?;
    if current_version != u32::try_from(rows.len()).unwrap_or(u32::MAX) {
        return Err(local_data_error(
            "local data migration ledger does not match user_version",
        ));
    }
    Ok(())
}

fn open_local_data_at_path(
    db_path: PathBuf,
    profile_id: &str,
    local_node_id: &str,
) -> Result<u32, AuroraCommandError> {
    validate_id(profile_id, "profileId")?;
    validate_id(local_node_id, "localNodeId")?;
    if db_path.exists()
        && db_path
            .metadata()
            .map(|metadata| metadata.len())
            .unwrap_or(0)
            > 0
    {
        let conn = SqliteConnection::open(db_path.clone())?;
        ensure_existing_identity_before_migration(&conn, local_node_id)?;
    }
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| local_data_error(error.to_string()))?;
    }
    let conn = SqliteConnection::open(db_path)?;
    apply_generated_migrations(&conn)?;
    ensure_identity(&conn, local_node_id)?;
    schema_version(&conn)
}

fn ensure_existing_identity_before_migration(
    conn: &SqliteConnection,
    local_node_id: &str,
) -> Result<(), AuroraCommandError> {
    let object_count = sqlite_object_count(conn)?;
    if object_count == 0 && schema_version(conn)? == 0 {
        return Ok(());
    }
    if !table_exists(conn, "aurora_database_identity")? {
        return Err(local_data_error("identity_missing"));
    }
    let rows = conn.query(
        "SELECT singleton_id, local_node_id FROM aurora_database_identity WHERE singleton_id = 1",
        &[],
    )?;
    if rows.len() != 1 {
        return Err(local_data_error("identity_missing"));
    }
    if row_string(&rows[0], "local_node_id")? != local_node_id {
        return Err(local_data_error("identity_mismatch"));
    }
    Ok(())
}

fn inspect_local_data_identity_at_path(db_path: PathBuf) -> Result<Value, AuroraCommandError> {
    if !db_path.exists()
        || db_path
            .metadata()
            .map(|metadata| metadata.len())
            .unwrap_or(0)
            == 0
    {
        return Ok(json!({
            "databaseExists": false,
            "identityTablePresent": false,
            "databaseLocalNodeId": null,
            "schemaVersion": null,
            "sqliteObjectCount": 0,
            "recordCount": 0,
            "secretsRedacted": true
        }));
    }

    let conn = SqliteConnection::open_readonly(db_path)?;
    let identity_table_present = table_exists(&conn, "aurora_database_identity")?;
    let database_local_node_id = if identity_table_present {
        conn.query(
            "SELECT local_node_id FROM aurora_database_identity WHERE singleton_id = 1",
            &[],
        )?
        .first()
        .map(|row| row_string(row, "local_node_id"))
        .transpose()?
    } else {
        None
    };
    let record_count = [
        "aurora_conversations",
        "aurora_messages",
        "aurora_memory_items",
        "aurora_local_tool_state",
        "aurora_peer_grant_metadata",
        "aurora_local_audit",
    ]
    .into_iter()
    .try_fold(0_i64, |total, table| {
        if !table_exists(&conn, table)? {
            return Ok(total);
        }
        let rows = conn.query(&format!("SELECT COUNT(*) AS row_count FROM {table}"), &[])?;
        let count = row_i64(
            rows.first()
                .ok_or_else(|| local_data_error("unable to inspect local data records"))?,
            "row_count",
        )?;
        total
            .checked_add(count)
            .ok_or_else(|| local_data_error("local data record count overflow"))
    })?;

    Ok(json!({
        "databaseExists": true,
        "identityTablePresent": identity_table_present,
        "databaseLocalNodeId": database_local_node_id,
        "schemaVersion": schema_version(&conn)?,
        "sqliteObjectCount": sqlite_object_count(&conn)?,
        "recordCount": record_count,
        "secretsRedacted": true
    }))
}

fn table_exists(conn: &SqliteConnection, table: &str) -> Result<bool, AuroraCommandError> {
    Ok(!conn
        .query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
            &[json!(table)],
        )?
        .is_empty())
}

fn sqlite_object_count(conn: &SqliteConnection) -> Result<i64, AuroraCommandError> {
    let rows = conn.query(
        "SELECT COUNT(*) AS object_count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
        &[],
    )?;
    row_i64(
        rows.first()
            .ok_or_else(|| local_data_error("unable to inspect local data database"))?,
        "object_count",
    )
}

fn ensure_identity(conn: &SqliteConnection, local_node_id: &str) -> Result<(), AuroraCommandError> {
    let rows = conn.query(
        "SELECT singleton_id, local_node_id FROM aurora_database_identity WHERE singleton_id = 1",
        &[],
    )?;
    if rows.is_empty() {
        conn.execute(
            "INSERT INTO aurora_database_identity (singleton_id, local_node_id, created_at_ms) VALUES (1, ?, ?)",
            &[json!(local_node_id), json!(now_ms())],
        )?;
        return Ok(());
    }
    if row_string(&rows[0], "local_node_id")? != local_node_id {
        return Err(local_data_error("identity_mismatch"));
    }
    Ok(())
}

fn schema_version(conn: &SqliteConnection) -> Result<u32, AuroraCommandError> {
    let rows = conn.query("PRAGMA user_version;", &[])?;
    let version = rows
        .first()
        .and_then(|row| row.get("user_version"))
        .and_then(Value::as_i64)
        .ok_or_else(|| local_data_error("unable to read local data schema version"))?;
    u32::try_from(version).map_err(|_| local_data_error("invalid local data schema version"))
}

fn local_data_db_path(app: &AppHandle) -> Result<PathBuf, AuroraCommandError> {
    let path = local_data_db_path_without_create(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| local_data_error(error.to_string()))?;
    }
    Ok(path)
}

pub(crate) fn local_data_db_path_without_create(
    app: &AppHandle,
) -> Result<PathBuf, AuroraCommandError> {
    let base = app
        .path()
        .app_config_dir()
        .map_err(|error| local_data_error(error.to_string()))?;
    local_data_db_path_from_app_config_dir(base)
}

pub(crate) fn local_data_db_path_from_app_config_dir(
    app_config_dir: PathBuf,
) -> Result<PathBuf, AuroraCommandError> {
    if !app_config_dir.is_absolute() {
        return Err(local_data_error("app config directory must be absolute"));
    }
    Ok(app_config_dir.join(generated::local_data_migrations::LOCAL_DATA_DATABASE_NAME))
}

fn status_value(
    profile_id: Option<String>,
    local_node_id: Option<String>,
    schema_version: Option<u32>,
    migration_state: &str,
) -> Value {
    json!({
        "kind": "sqlite-tauri",
        "persistent": true,
        "sqlite": true,
        "profileId": profile_id,
        "localNodeId": local_node_id,
        "schemaVersion": schema_version,
        "migrationState": migration_state
    })
}

fn ensure_open_state(state: &LocalDataState) -> Result<(String, String), AuroraCommandError> {
    let profile_id = state
        .profile_id
        .clone()
        .ok_or_else(|| local_data_error("local data backend is not open"))?;
    let local_node_id = state
        .local_node_id
        .clone()
        .ok_or_else(|| local_data_error("local data backend is not open"))?;
    Ok((profile_id, local_node_id))
}

fn take_active_transaction(
    state: &mut LocalDataState,
    tx_id: &str,
) -> Result<ActiveTransaction, AuroraCommandError> {
    let active = state
        .active_transaction
        .take()
        .ok_or_else(|| transaction_scope_error("transaction_not_found"))?;
    if active.tx_id != tx_id {
        state.active_transaction = Some(active);
        return Err(transaction_scope_error("forged_transaction"));
    }
    Ok(active)
}

fn new_transaction_id() -> Result<String, AuroraCommandError> {
    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| local_data_error(format!("transaction entropy failed: {error}")))?;
    Ok(format!(
        "tx-{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

fn transaction_scope_error(reason: &str) -> AuroraCommandError {
    local_data_error(format!("transaction.scope:{reason}"))
}

fn ensure_scope(
    expected_profile: &str,
    expected_node: &str,
    profile_id: &str,
    local_node_id: &str,
) -> Result<(), AuroraCommandError> {
    if expected_profile != profile_id || expected_node != local_node_id {
        return Err(local_data_error("identity_mismatch"));
    }
    Ok(())
}

fn validate_import_document(
    value: Value,
    profile_id: &str,
    local_node_id: &str,
    current_schema_version: u32,
) -> Result<LocalDataExportDocument, AuroraCommandError> {
    validate_import_json_safety(&value, 0, ImportJsonSafetyPath::Root)?;
    let document: LocalDataExportDocument =
        serde_json::from_value(value).map_err(|error| local_data_error(error.to_string()))?;
    if document.version != 1 {
        return Err(local_data_error("invalid import version"));
    }
    if !matches!(
        document.source_backend.as_str(),
        "sqlite-wasm-opfs" | "sqlite-tauri" | "indexeddb" | "memory"
    ) {
        return Err(local_data_error("invalid import sourceBackend"));
    }
    validate_safe_int(document.exported_at_ms, "exportedAtMs")?;
    validate_id(&document.profile_id, "profileId")?;
    validate_id(&document.local_node_id, "localNodeId")?;
    ensure_scope(
        profile_id,
        local_node_id,
        &document.profile_id,
        &document.local_node_id,
    )?;
    if document.schema_version > current_schema_version {
        return Err(local_data_error("future_schema"));
    }
    if document.encryption_envelope_versions.as_slice() != [1] {
        return Err(local_data_error("invalid envelope versions"));
    }
    validate_collection_sizes(&document.records)?;
    validate_record_counts(&document)?;
    validate_records(&document.records, profile_id, local_node_id)?;
    validate_collection_hashes(&document)?;
    Ok(document)
}

fn validate_records(
    records: &LocalDataRecordCollections,
    profile_id: &str,
    local_node_id: &str,
) -> Result<(), AuroraCommandError> {
    let conversation_ids = require_unique(
        records
            .conversations
            .iter()
            .map(|record| record.id.as_str()),
        "duplicate_conversation_id",
    )?;
    let _message_ids = require_unique(
        records.messages.iter().map(|record| record.id.as_str()),
        "duplicate_message_id",
    )?;
    let _memory_ids = require_unique(
        records.memory_items.iter().map(|record| record.id.as_str()),
        "duplicate_memory_id",
    )?;
    let _grant_ids = require_unique(
        records
            .peer_grant_metadata
            .iter()
            .map(|record| record.grant_id.as_str()),
        "duplicate_grant_id",
    )?;
    let _audit_ids = require_unique(
        records.local_audit.iter().map(|record| record.id.as_str()),
        "duplicate_audit_id",
    )?;
    let transcript_session_ids = require_unique(
        records
            .transcript_sessions
            .iter()
            .map(|record| record.id.as_str()),
        "duplicate_transcript_session_id",
    )?;
    let _transcript_segment_ids = require_unique(
        records
            .transcript_segments
            .iter()
            .map(|record| record.id.as_str()),
        "duplicate_transcript_segment_id",
    )?;
    let _tool_keys = require_unique(
        records.local_tool_states.iter().map(|record| {
            format!(
                "{}\0{}\0{}",
                record.profile_id, record.local_node_id, record.tool_contract_id
            )
        }),
        "duplicate_tool_state",
    )?;

    for record in &records.conversations {
        validate_conversation_record(record)?;
        ensure_scope(
            profile_id,
            local_node_id,
            &record.profile_id,
            &record.local_node_id,
        )?;
    }
    for record in &records.memory_items {
        validate_memory_record(record)?;
        ensure_scope(
            profile_id,
            local_node_id,
            &record.profile_id,
            &record.local_node_id,
        )?;
    }
    for record in &records.local_tool_states {
        validate_tool_record(record)?;
        ensure_scope(
            profile_id,
            local_node_id,
            &record.profile_id,
            &record.local_node_id,
        )?;
    }
    for record in &records.peer_grant_metadata {
        validate_grant_record(record)?;
        ensure_scope(
            profile_id,
            local_node_id,
            &record.profile_id,
            &record.local_node_id,
        )?;
    }
    for record in &records.local_audit {
        validate_audit_record(record)?;
        ensure_scope(
            profile_id,
            local_node_id,
            &record.profile_id,
            &record.local_node_id,
        )?;
    }

    for record in &records.transcript_sessions {
        validate_transcript_session(record)?;
        ensure_scope(
            profile_id,
            local_node_id,
            &record.profile_id,
            &record.local_node_id,
        )?;
    }

    let mut message_sequences = HashSet::new();
    for record in &records.messages {
        validate_message_record(record, profile_id, local_node_id)?;
        if !conversation_ids.contains(&record.conversation_id) {
            return Err(local_data_error("message_conversation_missing"));
        }
        if !message_sequences.insert(format!("{}\0{}", record.conversation_id, record.sequence)) {
            return Err(local_data_error("duplicate_message_sequence"));
        }
    }
    let mut transcript_sequences = HashSet::new();
    for record in &records.transcript_segments {
        validate_transcript_segment(record, profile_id, local_node_id)?;
        if !transcript_session_ids.contains(&record.session_id) {
            return Err(local_data_error("transcript_segment_session_missing"));
        }
        if !transcript_sequences.insert(format!("{}\0{}", record.session_id, record.sequence)) {
            return Err(local_data_error("duplicate_transcript_segment_sequence"));
        }
    }
    Ok(())
}

fn validate_conversation_record(record: &ConversationRecord) -> Result<(), AuroraCommandError> {
    validate_id(&record.id, "conversation.id")?;
    validate_id(&record.profile_id, "conversation.profileId")?;
    validate_id(&record.local_node_id, "conversation.localNodeId")?;
    validate_safe_int(record.created_at_ms, "conversation.createdAtMs")?;
    validate_safe_int(record.updated_at_ms, "conversation.updatedAtMs")?;
    if record.updated_at_ms < record.created_at_ms {
        return Err(local_data_error(
            "conversation updatedAtMs before createdAtMs",
        ));
    }
    validate_optional_safe_int(record.archived_at_ms, "conversation.archivedAtMs")?;
    validate_optional_envelope(
        record.title_envelope.as_ref(),
        &record.profile_id,
        &record.local_node_id,
        "conversation.titleEnvelope",
    )
}

fn validate_message_record(
    record: &ConversationMessageRecord,
    profile_id: &str,
    local_node_id: &str,
) -> Result<(), AuroraCommandError> {
    validate_id(&record.id, "message.id")?;
    validate_id(&record.conversation_id, "message.conversationId")?;
    validate_safe_int(record.sequence, "message.sequence")?;
    validate_safe_int(record.created_at_ms, "message.createdAtMs")?;
    if !matches!(
        record.role.as_str(),
        "system" | "user" | "assistant" | "tool"
    ) {
        return Err(local_data_error("invalid message role"));
    }
    if !matches!(
        record.status.as_str(),
        "pending" | "complete" | "failed" | "cancelled"
    ) {
        return Err(local_data_error("invalid message status"));
    }
    validate_optional_envelope(
        record.content_envelope.as_ref(),
        profile_id,
        local_node_id,
        "message.contentEnvelope",
    )?;
    validate_optional_envelope(
        record.tool_envelope.as_ref(),
        profile_id,
        local_node_id,
        "message.toolEnvelope",
    )
}

fn validate_memory_record(record: &LightweightMemoryRecord) -> Result<(), AuroraCommandError> {
    validate_id(&record.id, "memory.id")?;
    validate_id(&record.profile_id, "memory.profileId")?;
    validate_id(&record.local_node_id, "memory.localNodeId")?;
    validate_id(&record.namespace, "memory.namespace")?;
    validate_safe_int(record.created_at_ms, "memory.createdAtMs")?;
    validate_safe_int(record.updated_at_ms, "memory.updatedAtMs")?;
    if record.updated_at_ms < record.created_at_ms {
        return Err(local_data_error("memory updatedAtMs before createdAtMs"));
    }
    validate_optional_safe_int(record.expires_at_ms, "memory.expiresAtMs")?;
    validate_optional_text(record.source_type.as_deref(), 256, "memory.sourceType")?;
    validate_optional_text(record.source_id.as_deref(), 256, "memory.sourceId")?;
    validate_envelope(
        &record.payload_envelope,
        &record.profile_id,
        &record.local_node_id,
        "memory.payloadEnvelope",
    )
}

fn validate_tool_record(record: &LocalToolStateRecord) -> Result<(), AuroraCommandError> {
    validate_id(&record.profile_id, "tool.profileId")?;
    validate_id(&record.local_node_id, "tool.localNodeId")?;
    validate_id(&record.tool_contract_id, "tool.toolContractId")?;
    validate_hash(&record.descriptor_hash, "tool.descriptorHash")?;
    validate_safe_int(record.revision, "tool.revision")?;
    validate_safe_int(record.updated_at_ms, "tool.updatedAtMs")?;
    validate_json_object(&record.descriptor_json, "tool.descriptorJson")?;
    validate_optional_envelope(
        record.settings_envelope.as_ref(),
        &record.profile_id,
        &record.local_node_id,
        "tool.settingsEnvelope",
    )
}

fn validate_grant_record(record: &PeerGrantMetadataRecord) -> Result<(), AuroraCommandError> {
    validate_id(&record.grant_id, "grant.grantId")?;
    validate_id(&record.profile_id, "grant.profileId")?;
    validate_id(&record.local_node_id, "grant.localNodeId")?;
    validate_id(&record.claimant_peer_id, "grant.claimantPeerId")?;
    validate_id(&record.token_id, "grant.tokenId")?;
    validate_safe_int(record.revision, "grant.revision")?;
    validate_safe_int(record.created_at_ms, "grant.createdAtMs")?;
    validate_optional_safe_int(record.expires_at_ms, "grant.expiresAtMs")?;
    validate_optional_safe_int(record.revoked_at_ms, "grant.revokedAtMs")?;
    validate_envelope(
        &record.scope_envelope,
        &record.profile_id,
        &record.local_node_id,
        "grant.scopeEnvelope",
    )
}

fn validate_audit_record(record: &LocalAuditRecord) -> Result<(), AuroraCommandError> {
    validate_id(&record.id, "audit.id")?;
    validate_id(&record.profile_id, "audit.profileId")?;
    validate_id(&record.local_node_id, "audit.localNodeId")?;
    validate_id(&record.action, "audit.action")?;
    validate_id(&record.decision, "audit.decision")?;
    validate_id(&record.result_status, "audit.resultStatus")?;
    validate_safe_int(record.created_at_ms, "audit.createdAtMs")?;
    validate_optional_text(record.peer_id.as_deref(), 256, "audit.peerId")?;
    validate_optional_text(
        record.connection_epoch.as_deref(),
        256,
        "audit.connectionEpoch",
    )?;
    validate_optional_text(record.method_id.as_deref(), 256, "audit.methodId")?;
    validate_optional_text(
        record.tool_contract_id.as_deref(),
        256,
        "audit.toolContractId",
    )?;
    validate_optional_text(record.correlation_id.as_deref(), 256, "audit.correlationId")?;
    validate_json_object(&record.redacted_detail_json, "audit.redactedDetailJson")
}

fn validate_record_counts(document: &LocalDataExportDocument) -> Result<(), AuroraCommandError> {
    let counts = &document.record_counts;
    if counts.conversations != document.records.conversations.len()
        || counts.messages != document.records.messages.len()
        || counts.memory_items != document.records.memory_items.len()
        || counts.local_tool_states != document.records.local_tool_states.len()
        || counts.peer_grant_metadata != document.records.peer_grant_metadata.len()
        || counts.local_audit != document.records.local_audit.len()
        || counts.transcript_sessions != document.records.transcript_sessions.len()
        || counts.transcript_segments != document.records.transcript_segments.len()
    {
        return Err(local_data_error("record_count_mismatch"));
    }
    Ok(())
}

fn validate_collection_hashes(
    document: &LocalDataExportDocument,
) -> Result<(), AuroraCommandError> {
    validate_hash(
        &document.collection_hashes.conversations,
        "hash.conversations",
    )?;
    validate_hash(&document.collection_hashes.messages, "hash.messages")?;
    validate_hash(&document.collection_hashes.memory_items, "hash.memoryItems")?;
    validate_hash(
        &document.collection_hashes.local_tool_states,
        "hash.localToolStates",
    )?;
    validate_hash(
        &document.collection_hashes.peer_grant_metadata,
        "hash.peerGrantMetadata",
    )?;
    validate_hash(&document.collection_hashes.local_audit, "hash.localAudit")?;
    validate_hash(
        &document.collection_hashes.transcript_sessions,
        "hash.transcriptSessions",
    )?;
    validate_hash(
        &document.collection_hashes.transcript_segments,
        "hash.transcriptSegments",
    )?;
    let records = serde_json::to_value(&document.records)
        .map_err(|error| local_data_error(error.to_string()))?;
    let hashes = collection_hashes(&records)?;
    if hashes
        != json!({
            "conversations": document.collection_hashes.conversations,
            "messages": document.collection_hashes.messages,
            "memoryItems": document.collection_hashes.memory_items,
            "localToolStates": document.collection_hashes.local_tool_states,
            "peerGrantMetadata": document.collection_hashes.peer_grant_metadata,
            "localAudit": document.collection_hashes.local_audit,
            "transcriptSessions": document.collection_hashes.transcript_sessions,
            "transcriptSegments": document.collection_hashes.transcript_segments,
        })
    {
        return Err(local_data_error("collection_hash_mismatch"));
    }
    Ok(())
}

fn validate_collection_sizes(
    records: &LocalDataRecordCollections,
) -> Result<(), AuroraCommandError> {
    if records.conversations.len() > MAX_CONVERSATIONS
        || records.messages.len() > MAX_MESSAGES
        || records.memory_items.len() > MAX_MEMORY_ITEMS
        || records.local_tool_states.len() > MAX_LOCAL_TOOL_STATES
        || records.peer_grant_metadata.len() > MAX_PEER_GRANT_METADATA
        || records.local_audit.len() > MAX_LOCAL_AUDIT
        || records.transcript_sessions.len() > MAX_TRANSCRIPT_SESSIONS
        || records.transcript_segments.len() > MAX_TRANSCRIPT_SEGMENTS
    {
        return Err(local_data_error("collection_size_limit"));
    }
    Ok(())
}

fn validate_optional_envelope(
    value: Option<&Value>,
    profile_id: &str,
    local_node_id: &str,
    context: &str,
) -> Result<(), AuroraCommandError> {
    if let Some(value) = value {
        validate_envelope(value, profile_id, local_node_id, context)?;
    }
    Ok(())
}

fn validate_envelope(
    value: &Value,
    profile_id: &str,
    local_node_id: &str,
    context: &str,
) -> Result<(), AuroraCommandError> {
    validate_json_safety(value, 0)?;
    let object = value
        .as_object()
        .ok_or_else(|| local_data_error(format!("{context} must be an envelope object")))?;
    let expected = [
        "version",
        "algorithm",
        "keyId",
        "nonceB64Url",
        "ciphertextAndTagB64Url",
        "createdAtMs",
    ];
    if object.len() != expected.len() || expected.iter().any(|key| !object.contains_key(*key)) {
        return Err(local_data_error(format!(
            "{context} has invalid envelope shape"
        )));
    }
    if object.get("version").and_then(Value::as_i64) != Some(1) {
        return Err(local_data_error(format!("{context} has invalid version")));
    }
    if object.get("algorithm").and_then(Value::as_str) != Some("AES-GCM-256") {
        return Err(local_data_error(format!("{context} has invalid algorithm")));
    }
    let key_id = object
        .get("keyId")
        .and_then(Value::as_str)
        .ok_or_else(|| local_data_error(format!("{context} keyId missing")))?;
    validate_envelope_key_id(key_id, profile_id, local_node_id, context)?;
    let nonce = object
        .get("nonceB64Url")
        .and_then(Value::as_str)
        .ok_or_else(|| local_data_error(format!("{context} nonce missing")))?;
    if decode_canonical_base64url(nonce)?.len() != 12 {
        return Err(local_data_error(format!("{context} nonce length invalid")));
    }
    let ciphertext = object
        .get("ciphertextAndTagB64Url")
        .and_then(Value::as_str)
        .ok_or_else(|| local_data_error(format!("{context} ciphertext missing")))?;
    if decode_canonical_base64url(ciphertext)?.len() < 16 {
        return Err(local_data_error(format!("{context} tag length invalid")));
    }
    validate_safe_int(
        object
            .get("createdAtMs")
            .and_then(Value::as_i64)
            .ok_or_else(|| local_data_error(format!("{context} createdAtMs missing")))?,
        context,
    )
}

fn validate_envelope_key_id(
    value: &str,
    profile_id: &str,
    local_node_id: &str,
    context: &str,
) -> Result<(), AuroraCommandError> {
    validate_optional_text(Some(value), 256, context)?;
    let prefix = format!(
        "aurora.local-data-envelope.v1.{}.{}.local-structured-data.k",
        sha256_hex(profile_id.as_bytes()),
        sha256_hex(local_node_id.as_bytes())
    );
    let Some(version) = value.strip_prefix(&prefix) else {
        return Err(local_data_error(format!("{context} keyId scope mismatch")));
    };
    if version.is_empty() || !version.chars().all(|ch| ch.is_ascii_digit()) || version == "0" {
        return Err(local_data_error(format!("{context} keyId version invalid")));
    }
    Ok(())
}

fn sha256_hex(input: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input);
    format!("{:x}", hasher.finalize())
}

fn validate_json_object(value: &Value, context: &str) -> Result<(), AuroraCommandError> {
    if !value.is_object() {
        return Err(local_data_error(format!("{context} must be an object")));
    }
    validate_json_value(value, 0)
}

fn validate_json_safety(value: &Value, depth: usize) -> Result<(), AuroraCommandError> {
    validate_json_safety_at(value, depth, ImportJsonSafetyPath::Other)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ImportJsonSafetyPath {
    Root,
    Records,
    TranscriptSegments,
    TranscriptSegment,
    Confidence,
    Other,
}

fn validate_import_json_safety(
    value: &Value,
    depth: usize,
    path: ImportJsonSafetyPath,
) -> Result<(), AuroraCommandError> {
    validate_json_safety_at(value, depth, path)
}

fn validate_json_safety_at(
    value: &Value,
    depth: usize,
    path: ImportJsonSafetyPath,
) -> Result<(), AuroraCommandError> {
    if depth > MAX_JSON_DEPTH {
        return Err(local_data_error("json max depth"));
    }
    match value {
        Value::Null | Value::Bool(_) => Ok(()),
        Value::Number(number) if path == ImportJsonSafetyPath::Confidence => {
            let confidence = number
                .as_f64()
                .ok_or_else(|| local_data_error("invalid_transcript_confidence"))?;
            if !confidence.is_finite()
                || !(0.0..=1.0).contains(&confidence)
                || (confidence == 0.0 && confidence.is_sign_negative())
            {
                return Err(local_data_error("invalid_transcript_confidence"));
            }
            Ok(())
        }
        Value::Number(number) => validate_json_number(number, "json"),
        Value::String(value) => {
            if value.len() > 2 * 1024 * 1024 {
                return Err(local_data_error("json string too large"));
            }
            Ok(())
        }
        Value::Array(values) => {
            if values.len() > MAX_MESSAGES {
                return Err(local_data_error("json array too large"));
            }
            for value in values {
                let child_path = if path == ImportJsonSafetyPath::TranscriptSegments {
                    ImportJsonSafetyPath::TranscriptSegment
                } else {
                    ImportJsonSafetyPath::Other
                };
                validate_json_safety_at(value, depth + 1, child_path)?;
            }
            Ok(())
        }
        Value::Object(object) => {
            if object.len() > 2048 {
                return Err(local_data_error("json object too large"));
            }
            for (key, value) in object {
                if key.is_empty() || key.len() > 256 {
                    return Err(local_data_error("json key invalid"));
                }
                let child_path = match (path, key.as_str()) {
                    (ImportJsonSafetyPath::Root, "records") => ImportJsonSafetyPath::Records,
                    (ImportJsonSafetyPath::Records, "transcriptSegments") => {
                        ImportJsonSafetyPath::TranscriptSegments
                    }
                    (ImportJsonSafetyPath::TranscriptSegment, "confidence") => {
                        ImportJsonSafetyPath::Confidence
                    }
                    _ => ImportJsonSafetyPath::Other,
                };
                validate_json_safety_at(value, depth + 1, child_path)?;
            }
            Ok(())
        }
    }
}

fn validate_json_value(value: &Value, depth: usize) -> Result<(), AuroraCommandError> {
    if depth > MAX_JSON_DEPTH {
        return Err(local_data_error("json value max depth"));
    }
    match value {
        Value::Null | Value::Bool(_) => Ok(()),
        Value::Number(number) => validate_json_number(number, "json value"),
        Value::String(value) => {
            if value.len() > MAX_JSON_STRING_BYTES {
                return Err(local_data_error("json value string too large"));
            }
            Ok(())
        }
        Value::Array(values) => {
            if values.len() > MAX_JSON_ARRAY_ITEMS {
                return Err(local_data_error("json value array too large"));
            }
            for value in values {
                validate_json_value(value, depth + 1)?;
            }
            Ok(())
        }
        Value::Object(object) => {
            if object.len() > MAX_JSON_OBJECT_KEYS {
                return Err(local_data_error("json value object too large"));
            }
            for (key, value) in object {
                if key.is_empty() || key.len() > 256 {
                    return Err(local_data_error("json value key invalid"));
                }
                validate_json_value(value, depth + 1)?;
            }
            Ok(())
        }
    }
}

fn validate_id(value: &str, context: &str) -> Result<(), AuroraCommandError> {
    if value.is_empty()
        || value.len() > 256
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | ':' | '@' | '/' | '-'))
    {
        return Err(local_data_error(format!("{context} invalid")));
    }
    Ok(())
}

fn validate_hash(value: &str, context: &str) -> Result<(), AuroraCommandError> {
    if value.len() != 64
        || !value
            .chars()
            .all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase())
    {
        return Err(local_data_error(format!("{context} invalid")));
    }
    Ok(())
}

fn validate_safe_int(value: i64, context: &str) -> Result<(), AuroraCommandError> {
    if !(0..=MAX_SAFE_INTEGER).contains(&value) {
        return Err(local_data_error(format!("{context} invalid integer")));
    }
    Ok(())
}

fn validate_json_number(value: &Number, context: &str) -> Result<(), AuroraCommandError> {
    if let Some(value) = value.as_i64() {
        return validate_safe_int(value, context);
    }
    if let Some(value) = value.as_u64() {
        if value <= MAX_SAFE_INTEGER as u64 {
            return Ok(());
        }
    }
    Err(local_data_error(format!("{context} unsafe number")))
}

fn validate_optional_safe_int(value: Option<i64>, context: &str) -> Result<(), AuroraCommandError> {
    if let Some(value) = value {
        validate_safe_int(value, context)?;
    }
    Ok(())
}

fn validate_delete_now_ms(value: i64) -> Result<(), AuroraCommandError> {
    if !(0..=MAX_SAFE_INTEGER).contains(&value) {
        return Err(local_data_error("delete_now_ms"));
    }
    Ok(())
}

fn validate_delete_limit(value: i64) -> Result<i64, AuroraCommandError> {
    if !(1..=MAX_SAFE_INTEGER).contains(&value) {
        return Err(local_data_error("delete_limit"));
    }
    Ok(value)
}

fn select_count(
    conn: &SqliteConnection,
    sql: &str,
    params: &[Value],
) -> Result<i64, AuroraCommandError> {
    let rows = conn.query(sql, params)?;
    row_i64(
        rows.first()
            .ok_or_else(|| local_data_error("count query returned no rows"))?,
        "count",
    )
}

fn sqlite_changes(conn: &SqliteConnection) -> Result<i64, AuroraCommandError> {
    select_count(conn, "SELECT changes() AS count", &[])
}

fn validate_optional_text(
    value: Option<&str>,
    max_len: usize,
    context: &str,
) -> Result<(), AuroraCommandError> {
    if let Some(value) = value {
        if value.len() > max_len {
            return Err(local_data_error(format!("{context} too long")));
        }
    }
    Ok(())
}

fn decode_canonical_base64url(value: &str) -> Result<Vec<u8>, AuroraCommandError> {
    if value.is_empty()
        || value.contains('=')
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err(local_data_error("invalid base64url"));
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| local_data_error("invalid base64url"))?;
    if URL_SAFE_NO_PAD.encode(&decoded) != value {
        return Err(local_data_error("noncanonical base64url"));
    }
    Ok(decoded)
}

fn require_unique<I, S>(values: I, reason: &str) -> Result<HashSet<String>, AuroraCommandError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut seen = HashSet::new();
    for value in values {
        let value = value.as_ref().to_string();
        if !seen.insert(value) {
            return Err(local_data_error(reason));
        }
    }
    Ok(seen)
}

fn validate_id_set(
    ids: Option<Vec<String>>,
    context: &str,
) -> Result<Option<Vec<String>>, AuroraCommandError> {
    let Some(ids) = ids else {
        return Ok(None);
    };
    if ids.len() > 500 {
        return Err(local_data_error(format!("{context} too large")));
    }
    for id in &ids {
        validate_id(id, &format!("{context}[]"))?;
    }
    let mut unique = Vec::with_capacity(ids.len());
    let mut seen = HashSet::new();
    for id in ids {
        if seen.insert(id.clone()) {
            unique.push(id);
        }
    }
    Ok(Some(unique))
}

fn id_filter(ids: &[String], column: &str) -> (String, Vec<Value>) {
    let placeholders = std::iter::repeat("?")
        .take(ids.len())
        .collect::<Vec<_>>()
        .join(", ");
    (
        format!(" AND {column} IN ({placeholders})"),
        ids.iter().map(|id| json!(id)).collect(),
    )
}

fn conversation_list_sql(
    profile_id: &str,
    local_node_id: &str,
    options: Option<ConversationListQuery>,
) -> Result<(String, Vec<Value>), AuroraCommandError> {
    let mut sql = "SELECT id, profile_id, local_node_id, title_envelope_json, created_at_ms, updated_at_ms, archived_at_ms FROM aurora_conversations WHERE profile_id = ? AND local_node_id = ?".to_string();
    let mut params = vec![json!(profile_id), json!(local_node_id)];
    let bounded = options.as_ref().and_then(|query| query.limit).is_some();
    if let Some(query) = options.as_ref() {
        if let Some(limit) = query.limit {
            if limit == 0 || limit > 501 {
                return Err(local_data_error("conversation limit invalid"));
            }
        }
        if query.include_archived == Some(false) {
            sql.push_str(" AND archived_at_ms IS NULL");
        }
        if let Some(cursor) = query.cursor.as_ref() {
            validate_safe_int(cursor.updated_at_ms, "conversation.cursor.updatedAtMs")?;
            validate_id(&cursor.id, "conversation.cursor.id")?;
            sql.push_str(" AND (updated_at_ms < ? OR (updated_at_ms = ? AND id > ?))");
            params.extend([
                json!(cursor.updated_at_ms),
                json!(cursor.updated_at_ms),
                json!(cursor.id),
            ]);
        }
        sql.push_str(" ORDER BY updated_at_ms DESC, id COLLATE BINARY ASC");
        if let Some(limit) = query.limit {
            if bounded {
                sql.push_str(" LIMIT ?");
                params.push(json!(limit as i64));
            }
        }
    } else {
        sql.push_str(" ORDER BY updated_at_ms DESC, id COLLATE BINARY ASC");
    }
    Ok((sql, params))
}

fn message_list_sql(
    profile_id: &str,
    local_node_id: &str,
    conversation_id: &str,
    options: Option<MessageListQuery>,
) -> Result<(String, Vec<Value>), AuroraCommandError> {
    let mut sql = "SELECT m.id, m.conversation_id, m.sequence, m.role, m.content_envelope_json, m.tool_envelope_json, m.status, m.created_at_ms FROM aurora_messages m INNER JOIN aurora_conversations c ON c.id = m.conversation_id WHERE c.profile_id = ? AND c.local_node_id = ? AND m.conversation_id = ?".to_string();
    let mut params = vec![
        json!(profile_id),
        json!(local_node_id),
        json!(conversation_id),
    ];
    let direction = options
        .as_ref()
        .and_then(|q| q.direction.as_deref())
        .unwrap_or("asc");
    if let Some(limit) = options.as_ref().and_then(|q| q.limit) {
        if limit == 0 || limit > 2001 {
            return Err(local_data_error("message limit invalid"));
        }
    }
    if direction != "asc" && direction != "desc" {
        return Err(local_data_error("message direction invalid"));
    }
    if let Some(query) = options.as_ref() {
        if query.before_sequence.is_some() && query.after_sequence.is_some() {
            return Err(local_data_error("message bounds are ambiguous"));
        }
        if let Some(sequence) = query.before_sequence {
            validate_safe_int(sequence, "message.beforeSequence")?;
            sql.push_str(" AND m.sequence < ?");
            params.push(json!(sequence));
        }
        if let Some(sequence) = query.after_sequence {
            validate_safe_int(sequence, "message.afterSequence")?;
            sql.push_str(" AND m.sequence > ?");
            params.push(json!(sequence));
        }
    }
    sql.push_str(if direction == "desc" {
        " ORDER BY m.sequence DESC, m.id COLLATE BINARY ASC"
    } else {
        " ORDER BY m.sequence ASC, m.id COLLATE BINARY ASC"
    });
    if let Some(limit) = options.as_ref().and_then(|q| q.limit) {
        sql.push_str(" LIMIT ?");
        params.push(json!(limit as i64));
    }
    Ok((sql, params))
}

fn conversation_from_row(row: Value) -> Result<Value, AuroraCommandError> {
    Ok(json!({
        "id": row_string(&row, "id")?,
        "profileId": row_string(&row, "profile_id")?,
        "localNodeId": row_string(&row, "local_node_id")?,
        "titleEnvelope": parse_json_column(&row, "title_envelope_json")?,
        "createdAtMs": row_i64(&row, "created_at_ms")?,
        "updatedAtMs": row_i64(&row, "updated_at_ms")?,
        "archivedAtMs": row.get("archived_at_ms").and_then(Value::as_i64),
    }))
}

fn message_from_row(row: Value) -> Result<Value, AuroraCommandError> {
    Ok(json!({
        "id": row_string(&row, "id")?,
        "conversationId": row_string(&row, "conversation_id")?,
        "sequence": row_i64(&row, "sequence")?,
        "role": row_string(&row, "role")?,
        "contentEnvelope": parse_json_column(&row, "content_envelope_json")?,
        "toolEnvelope": parse_json_column(&row, "tool_envelope_json")?,
        "status": row_string(&row, "status")?,
        "createdAtMs": row_i64(&row, "created_at_ms")?,
    }))
}

fn memory_from_row(row: Value) -> Result<Value, AuroraCommandError> {
    Ok(json!({
        "id": row_string(&row, "id")?,
        "profileId": row_string(&row, "profile_id")?,
        "localNodeId": row_string(&row, "local_node_id")?,
        "namespace": row_string(&row, "namespace")?,
        "payloadEnvelope": parse_json_column(&row, "payload_envelope_json")?,
        "sourceType": row.get("source_type").and_then(Value::as_str),
        "sourceId": row.get("source_id").and_then(Value::as_str),
        "createdAtMs": row_i64(&row, "created_at_ms")?,
        "updatedAtMs": row_i64(&row, "updated_at_ms")?,
        "expiresAtMs": row.get("expires_at_ms").and_then(Value::as_i64),
    }))
}

fn tool_from_row(row: Value) -> Result<Value, AuroraCommandError> {
    Ok(json!({
        "profileId": row_string(&row, "profile_id")?,
        "localNodeId": row_string(&row, "local_node_id")?,
        "toolContractId": row_string(&row, "tool_contract_id")?,
        "descriptorJson": parse_json_column(&row, "descriptor_json")?,
        "descriptorHash": row_string(&row, "descriptor_hash")?,
        "enabled": row_i64(&row, "enabled")? != 0,
        "settingsEnvelope": parse_json_column(&row, "settings_envelope_json")?,
        "revision": row_i64(&row, "revision")?,
        "updatedAtMs": row_i64(&row, "updated_at_ms")?,
    }))
}

fn grant_from_row(row: Value) -> Result<Value, AuroraCommandError> {
    Ok(json!({
        "grantId": row_string(&row, "grant_id")?,
        "profileId": row_string(&row, "profile_id")?,
        "localNodeId": row_string(&row, "local_node_id")?,
        "claimantPeerId": row_string(&row, "claimant_peer_id")?,
        "tokenId": row_string(&row, "token_id")?,
        "scopeEnvelope": parse_json_column(&row, "scope_envelope_json")?,
        "revision": row_i64(&row, "revision")?,
        "createdAtMs": row_i64(&row, "created_at_ms")?,
        "expiresAtMs": row.get("expires_at_ms").and_then(Value::as_i64),
        "revokedAtMs": row.get("revoked_at_ms").and_then(Value::as_i64),
    }))
}

fn audit_from_row(row: Value) -> Result<Value, AuroraCommandError> {
    Ok(json!({
        "id": row_string(&row, "id")?,
        "profileId": row_string(&row, "profile_id")?,
        "localNodeId": row_string(&row, "local_node_id")?,
        "peerId": row.get("peer_id").and_then(Value::as_str),
        "action": row_string(&row, "action")?,
        "decision": row_string(&row, "decision")?,
        "resultStatus": row_string(&row, "result_status")?,
        "connectionEpoch": row.get("connection_epoch").and_then(Value::as_str),
        "methodId": row.get("method_id").and_then(Value::as_str),
        "toolContractId": row.get("tool_contract_id").and_then(Value::as_str),
        "correlationId": row.get("correlation_id").and_then(Value::as_str),
        "redactedDetailJson": parse_json_column(&row, "redacted_detail_json")?,
        "createdAtMs": row_i64(&row, "created_at_ms")?,
    }))
}

fn record_counts(records: &Value) -> Value {
    json!({
        "conversations": records_array_len(records, "conversations"),
        "messages": records_array_len(records, "messages"),
        "memoryItems": records_array_len(records, "memoryItems"),
        "localToolStates": records_array_len(records, "localToolStates"),
        "peerGrantMetadata": records_array_len(records, "peerGrantMetadata"),
        "localAudit": records_array_len(records, "localAudit"),
        "transcriptSessions": records_array_len(records, "transcriptSessions"),
        "transcriptSegments": records_array_len(records, "transcriptSegments"),
    })
}

fn collection_hashes(records: &Value) -> Result<Value, AuroraCommandError> {
    Ok(json!({
        "conversations": hash_json(&sorted_collection(records, "conversations", compare_by_id))?,
        "messages": hash_json(&sorted_collection(records, "messages", compare_messages))?,
        "memoryItems": hash_json(&sorted_collection(records, "memoryItems", compare_by_id))?,
        "localToolStates": hash_json(&sorted_collection(records, "localToolStates", compare_local_tool_state))?,
        "peerGrantMetadata": hash_json(&sorted_collection(records, "peerGrantMetadata", compare_by_grant_id))?,
        "localAudit": hash_json(&sorted_collection(records, "localAudit", compare_audit))?,
        "transcriptSessions": hash_json(&sorted_collection(records, "transcriptSessions", compare_by_id))?,
        "transcriptSegments": hash_transcript_segments(&sorted_collection(records, "transcriptSegments", compare_transcript_segments))?,
    }))
}

fn compare_transcript_segments(a: &Value, b: &Value) -> std::cmp::Ordering {
    value_string(a, "sessionId")
        .cmp(&value_string(b, "sessionId"))
        .then_with(|| value_i64(a, "sequence").cmp(&value_i64(b, "sequence")))
        .then_with(|| value_string(a, "id").cmp(&value_string(b, "id")))
}

fn empty_collection_hash() -> String {
    "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945".to_owned()
}

fn sorted_collection(
    records: &Value,
    key: &str,
    compare: fn(&Value, &Value) -> std::cmp::Ordering,
) -> Value {
    let mut values = records
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    values.sort_by(compare);
    Value::Array(values)
}

fn compare_by_id(a: &Value, b: &Value) -> std::cmp::Ordering {
    value_string(a, "id").cmp(&value_string(b, "id"))
}

fn compare_by_grant_id(a: &Value, b: &Value) -> std::cmp::Ordering {
    value_string(a, "grantId").cmp(&value_string(b, "grantId"))
}

fn compare_messages(a: &Value, b: &Value) -> std::cmp::Ordering {
    value_string(a, "conversationId")
        .cmp(&value_string(b, "conversationId"))
        .then_with(|| value_i64(a, "sequence").cmp(&value_i64(b, "sequence")))
        .then_with(|| value_string(a, "id").cmp(&value_string(b, "id")))
}

fn compare_local_tool_state(a: &Value, b: &Value) -> std::cmp::Ordering {
    value_string(a, "profileId")
        .cmp(&value_string(b, "profileId"))
        .then_with(|| value_string(a, "localNodeId").cmp(&value_string(b, "localNodeId")))
        .then_with(|| value_string(a, "toolContractId").cmp(&value_string(b, "toolContractId")))
}

fn compare_audit(a: &Value, b: &Value) -> std::cmp::Ordering {
    value_i64(a, "createdAtMs")
        .cmp(&value_i64(b, "createdAtMs"))
        .then_with(|| value_string(a, "id").cmp(&value_string(b, "id")))
}

fn value_string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn value_i64(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or_default()
}

fn hash_json(value: &Value) -> Result<String, AuroraCommandError> {
    let mut hasher = Sha256::new();
    hasher.update(canonical_json(value)?);
    Ok(format!("{:x}", hasher.finalize()))
}

fn hash_transcript_segments(value: &Value) -> Result<String, AuroraCommandError> {
    let mut hasher = Sha256::new();
    hasher.update(canonical_transcript_segments(value)?);
    Ok(format!("{:x}", hasher.finalize()))
}

fn canonical_transcript_segments(value: &Value) -> Result<String, AuroraCommandError> {
    let records = value
        .as_array()
        .ok_or_else(|| local_data_error("transcript segments must be an array"))?;
    let mut result = String::from("[");
    for (index, record) in records.iter().enumerate() {
        if index > 0 {
            result.push(',');
        }
        let object = record
            .as_object()
            .ok_or_else(|| local_data_error("transcript segment must be an object"))?;
        let mut keys = object.keys().collect::<Vec<_>>();
        keys.sort();
        result.push('{');
        for (key_index, key) in keys.iter().enumerate() {
            if key_index > 0 {
                result.push(',');
            }
            result.push_str(
                &serde_json::to_string(key).map_err(|error| local_data_error(error.to_string()))?,
            );
            result.push(':');
            let field = &object[*key];
            if key.as_str() == "confidence" {
                if let Value::Number(number) = field {
                    result.push_str(&js_confidence_number(number)?);
                } else {
                    result.push_str(&canonical_json(field)?);
                }
            } else {
                result.push_str(&canonical_json(field)?);
            }
        }
        result.push('}');
    }
    result.push(']');
    Ok(result)
}

fn js_confidence_number(number: &Number) -> Result<String, AuroraCommandError> {
    let value = number
        .as_f64()
        .ok_or_else(|| local_data_error("invalid_transcript_confidence"))?;
    if !value.is_finite()
        || !(0.0..=1.0).contains(&value)
        || (value == 0.0 && value.is_sign_negative())
    {
        return Err(local_data_error("invalid_transcript_confidence"));
    }
    if value == 0.0 {
        return Ok("0".to_owned());
    }
    if value == 1.0 {
        return Ok("1".to_owned());
    }

    let scientific = format!("{:e}", value);
    let (mantissa, exponent) = scientific
        .split_once('e')
        .ok_or_else(|| local_data_error("invalid_transcript_confidence"))?;
    let mantissa = mantissa.trim_end_matches(".0");
    let exponent = exponent
        .parse::<i32>()
        .map_err(|_| local_data_error("invalid_transcript_confidence"))?;
    if value < 1e-6 {
        return Ok(format!("{}e{}", mantissa, exponent));
    }

    let decimal_index = mantissa.find('.').unwrap_or(mantissa.len()) as i32 + exponent;
    let digits = mantissa.replace('.', "");
    if decimal_index <= 0 {
        Ok(format!(
            "0.{}{}",
            "0".repeat((-decimal_index) as usize),
            digits
        ))
    } else if decimal_index as usize >= digits.len() {
        Ok(format!(
            "{}{}",
            digits,
            "0".repeat(decimal_index as usize - digits.len())
        ))
    } else {
        let (whole, fraction) = digits.split_at(decimal_index as usize);
        Ok(format!("{}.{}", whole, fraction))
    }
}

fn canonical_json(value: &Value) -> Result<String, AuroraCommandError> {
    serde_json::to_string(&canonicalize(value)).map_err(|error| local_data_error(error.to_string()))
}

fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.iter().map(canonicalize).collect()),
        Value::Object(map) => {
            let mut sorted = Map::new();
            let mut keys = map.keys().collect::<Vec<_>>();
            keys.sort();
            for key in keys {
                sorted.insert(key.clone(), canonicalize(&map[key]));
            }
            Value::Object(sorted)
        }
        _ => value.clone(),
    }
}

fn records_array_len(records: &Value, key: &str) -> usize {
    records
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0)
}

fn parse_json_column(row: &Value, key: &str) -> Result<Value, AuroraCommandError> {
    match row.get(key) {
        Some(Value::Null) | None => Ok(Value::Null),
        Some(Value::String(value)) => {
            serde_json::from_str(value).map_err(|error| local_data_error(error.to_string()))
        }
        Some(value) => Ok(value.clone()),
    }
}

fn row_string(row: &Value, key: &str) -> Result<String, AuroraCommandError> {
    row.get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| local_data_error(format!("missing string column {key}")))
}

fn row_i64(row: &Value, key: &str) -> Result<i64, AuroraCommandError> {
    row.get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| local_data_error(format!("missing integer column {key}")))
}

fn option_string(value: Option<String>) -> Value {
    value.map(Value::String).unwrap_or(Value::Null)
}

fn option_i64(value: Option<i64>) -> Value {
    value
        .map(|value| Value::Number(Number::from(value)))
        .unwrap_or(Value::Null)
}

fn json_or_null(value: Option<Value>) -> Result<Value, AuroraCommandError> {
    value
        .map(|value| canonical_json(&value).map(Value::String))
        .unwrap_or(Ok(Value::Null))
}

fn bind_number(raw: *mut sqlite3_stmt, index: c_int, value: &Number) -> c_int {
    if let Some(value) = value.as_i64() {
        unsafe { sqlite3_bind_int64(raw, index, value) }
    } else if let Some(value) = value.as_u64().and_then(|value| i64::try_from(value).ok()) {
        unsafe { sqlite3_bind_int64(raw, index, value) }
    } else if let Some(value) = value.as_f64() {
        unsafe { sqlite3_bind_double(raw, index, value) }
    } else {
        unsafe { sqlite3_bind_null(raw, index) }
    }
}

fn sqlite_transient() -> unsafe extern "C" fn(*mut c_void) {
    unsafe { std::mem::transmute(-1isize) }
}

fn sqlite_error(db: *mut sqlite3) -> String {
    if db.is_null() {
        return "sqlite operation failed".to_string();
    }
    let message = unsafe { sqlite3_errmsg(db) };
    if message.is_null() {
        "sqlite operation failed".to_string()
    } else {
        unsafe { CStr::from_ptr(message).to_string_lossy().into_owned() }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn local_data_error(message: impl Into<String>) -> AuroraCommandError {
    AuroraCommandError::LocalData(message.into())
}

fn local_data_error_reason(
    message: impl Into<String>,
    reason: crate::LocalDataReasonCode,
) -> AuroraCommandError {
    AuroraCommandError::LocalDataReason {
        message: message.into(),
        reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_DB_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn native_voice_turn_persists_into_latest_native_conversation_once() {
        let (dir, path) = test_db_path("android-background-voice");
        let first = persist_native_voice_turn_at_path(
            path.clone(),
            NativeVoiceTurnPersistenceRequest {
                profile_id: "profile-1".to_string(),
                local_node_id: "node-1".to_string(),
                new_conversation_id: "voice-conversation-1".to_string(),
                user_message_id: "voice-user-1".to_string(),
                user_content_envelope: envelope_value(),
                assistant_message_id: None,
                assistant_content_envelope: None,
                created_at_ms: 10,
                completed_at_ms: 11,
            },
        )
        .unwrap();
        assert_eq!(first.conversation_id, "voice-conversation-1");

        let second_request = NativeVoiceTurnPersistenceRequest {
            profile_id: "profile-1".to_string(),
            local_node_id: "node-1".to_string(),
            new_conversation_id: "voice-conversation-unused".to_string(),
            user_message_id: "voice-user-2".to_string(),
            user_content_envelope: envelope_value(),
            assistant_message_id: Some("voice-assistant-2".to_string()),
            assistant_content_envelope: Some(envelope_value()),
            created_at_ms: 12,
            completed_at_ms: 13,
        };
        let second =
            persist_native_voice_turn_at_path(path.clone(), second_request.clone()).unwrap();
        assert_eq!(second.conversation_id, "voice-conversation-1");
        persist_native_voice_turn_at_path(path.clone(), second_request).unwrap();

        let conn = SqliteConnection::open(path).unwrap();
        let conversations = run_repository_operation(
            &conn,
            "profile-1",
            "node-1",
            LocalDataRepositoryOperation::ConversationsListConversations {
                profile_id: "profile-1".to_string(),
                local_node_id: "node-1".to_string(),
                options: None,
            },
        )
        .unwrap();
        assert_eq!(conversations.as_array().unwrap().len(), 1);
        let messages = run_repository_operation(
            &conn,
            "profile-1",
            "node-1",
            LocalDataRepositoryOperation::ConversationsListMessages {
                profile_id: "profile-1".to_string(),
                local_node_id: "node-1".to_string(),
                conversation_id: "voice-conversation-1".to_string(),
                options: None,
            },
        )
        .unwrap();
        assert_eq!(messages.as_array().unwrap().len(), 3);
        assert_eq!(messages[0]["id"], json!("voice-user-1"));
        assert_eq!(messages[1]["id"], json!("voice-user-2"));
        assert_eq!(messages[2]["id"], json!("voice-assistant-2"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn history_native_rejects_cross_conversation_message_id_and_paginates() {
        let (dir, path) = test_db_path("history-pagination");
        open_local_data_at_path(path.clone(), "profile-1", "node-1").unwrap();
        let conn = SqliteConnection::open(path).unwrap();
        for (id, updated, archived) in [
            ("conversation-a", 10, None),
            ("conversation-b", 10, None),
            ("conversation-c", 9, Some(8)),
        ] {
            let mut record = test_conversation_for("profile-1", "node-1", id);
            record.updated_at_ms = updated;
            record.archived_at_ms = archived;
            run_repository_operation(
                &conn,
                "profile-1",
                "node-1",
                LocalDataRepositoryOperation::ConversationsUpsertConversation { record },
            )
            .unwrap();
        }
        for (id, conversation_id, sequence) in [
            ("message-a1", "conversation-a", 1),
            ("message-a2", "conversation-a", 2),
            ("message-b1", "conversation-b", 1),
        ] {
            run_repository_operation(
                &conn,
                "profile-1",
                "node-1",
                LocalDataRepositoryOperation::ConversationsAppendMessage {
                    record: test_message_for_with_sequence(id, conversation_id, sequence),
                },
            )
            .unwrap();
        }
        let ordered = run_repository_operation(
            &conn,
            "profile-1",
            "node-1",
            LocalDataRepositoryOperation::ConversationsListMessages {
                profile_id: "profile-1".into(),
                local_node_id: "node-1".into(),
                conversation_id: "conversation-a".into(),
                options: Some(MessageListQuery {
                    limit: None,
                    before_sequence: None,
                    after_sequence: None,
                    direction: Some("desc".into()),
                }),
            },
        )
        .unwrap();
        assert_eq!(
            ordered
                .as_array()
                .unwrap()
                .iter()
                .map(|row| row["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["message-a2", "message-a1"]
        );
        let before = run_repository_operation(
            &conn,
            "profile-1",
            "node-1",
            LocalDataRepositoryOperation::ConversationsListMessages {
                profile_id: "profile-1".into(),
                local_node_id: "node-1".into(),
                conversation_id: "conversation-a".into(),
                options: Some(MessageListQuery {
                    limit: Some(1),
                    before_sequence: Some(2),
                    after_sequence: None,
                    direction: Some("asc".into()),
                }),
            },
        )
        .unwrap();
        assert_eq!(before.as_array().unwrap().len(), 1);
        assert_eq!(before[0]["id"], json!("message-a1"));
        let after = run_repository_operation(
            &conn,
            "profile-1",
            "node-1",
            LocalDataRepositoryOperation::ConversationsListMessages {
                profile_id: "profile-1".into(),
                local_node_id: "node-1".into(),
                conversation_id: "conversation-a".into(),
                options: Some(MessageListQuery {
                    limit: None,
                    before_sequence: None,
                    after_sequence: Some(1),
                    direction: Some("asc".into()),
                }),
            },
        )
        .unwrap();
        assert_eq!(after.as_array().unwrap().len(), 1);
        let conversations = run_repository_operation(
            &conn,
            "profile-1",
            "node-1",
            LocalDataRepositoryOperation::ConversationsListConversations {
                profile_id: "profile-1".into(),
                local_node_id: "node-1".into(),
                options: Some(ConversationListQuery {
                    limit: Some(1),
                    include_archived: Some(false),
                    cursor: None,
                }),
            },
        )
        .unwrap();
        assert_eq!(conversations.as_array().unwrap().len(), 1);
        assert_eq!(conversations[0]["id"], json!("conversation-a"));
        let next = run_repository_operation(
            &conn,
            "profile-1",
            "node-1",
            LocalDataRepositoryOperation::ConversationsListConversations {
                profile_id: "profile-1".into(),
                local_node_id: "node-1".into(),
                options: Some(ConversationListQuery {
                    limit: None,
                    include_archived: Some(false),
                    cursor: Some(ConversationCursor {
                        updated_at_ms: 10,
                        id: "conversation-a".into(),
                    }),
                }),
            },
        )
        .unwrap();
        assert_eq!(
            next.as_array()
                .unwrap()
                .iter()
                .map(|row| row["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["conversation-b"]
        );
        let empty = run_repository_operation(
            &conn,
            "profile-1",
            "node-1",
            LocalDataRepositoryOperation::ConversationsListMessageCounts {
                profile_id: "profile-1".into(),
                local_node_id: "node-1".into(),
                conversation_ids: Some(Vec::new()),
            },
        )
        .unwrap();
        assert_eq!(empty, json!({}));
        let deduped = run_repository_operation(
            &conn,
            "profile-1",
            "node-1",
            LocalDataRepositoryOperation::ConversationsListMessageCounts {
                profile_id: "profile-1".into(),
                local_node_id: "node-1".into(),
                conversation_ids: Some(vec!["conversation-a".into(), "conversation-a".into()]),
            },
        )
        .unwrap();
        assert_eq!(deduped["conversation-a"], json!(2));
        let latest = run_repository_operation(
            &conn,
            "profile-1",
            "node-1",
            LocalDataRepositoryOperation::ConversationsGetLatestMessageSequence {
                profile_id: "profile-1".into(),
                local_node_id: "node-1".into(),
                conversation_id: "conversation-a".into(),
            },
        )
        .unwrap();
        assert_eq!(latest, json!(2));
        let missing_latest = run_repository_operation(
            &conn,
            "profile-1",
            "node-1",
            LocalDataRepositoryOperation::ConversationsGetLatestMessageSequence {
                profile_id: "profile-1".into(),
                local_node_id: "node-1".into(),
                conversation_id: "conversation-c".into(),
            },
        )
        .unwrap();
        assert_eq!(missing_latest, Value::Null);
        let update = test_message_for_with_sequence("message-a1", "conversation-a", 3);
        run_repository_operation(
            &conn,
            "profile-1",
            "node-1",
            LocalDataRepositoryOperation::ConversationsAppendMessage { record: update },
        )
        .unwrap();
        let duplicate_sequence = run_repository_operation(
            &conn,
            "profile-1",
            "node-1",
            LocalDataRepositoryOperation::ConversationsAppendMessage {
                record: test_message_for_with_sequence("message-new", "conversation-a", 2),
            },
        );
        assert!(matches!(
            duplicate_sequence,
            Err(AuroraCommandError::LocalDataReason {
                reason: crate::LocalDataReasonCode::DuplicateMessageSequence,
                ..
            })
        ));
        let duplicate_id = run_repository_operation(
            &conn,
            "profile-1",
            "node-1",
            LocalDataRepositoryOperation::ConversationsAppendMessage {
                record: test_message_for_with_sequence("message-a1", "conversation-b", 3),
            },
        );
        assert!(matches!(
            duplicate_id,
            Err(AuroraCommandError::LocalDataReason {
                reason: crate::LocalDataReasonCode::DuplicateMessageId,
                ..
            })
        ));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn import_validation_rejects_hostile_documents_before_db_changes() {
        let conn = test_connection();
        apply_generated_migrations(&conn).unwrap();
        ensure_identity(&conn, "node-1").unwrap();
        run_repository_operation(
            &conn,
            "profile-1",
            "node-1",
            LocalDataRepositoryOperation::ConversationsUpsertConversation {
                record: test_conversation("existing-conversation"),
            },
        )
        .unwrap();
        let before = export_records(&conn, "profile-1", "node-1").unwrap();

        let mut cases = Vec::new();
        let mut tampered_counts = valid_import_document_value();
        tampered_counts["recordCounts"]["conversations"] = json!(99);
        cases.push(tampered_counts);

        let mut tampered_hash = valid_import_document_value();
        tampered_hash["collectionHashes"]["conversations"] = json!("0".repeat(64));
        cases.push(tampered_hash);

        let mut future_schema = valid_import_document_value();
        future_schema["schemaVersion"] =
            json!(generated::local_data_migrations::LOCAL_DATA_LATEST_VERSION + 1);
        cases.push(future_schema);

        let mut duplicate = valid_import_document_value();
        let first = duplicate["records"]["conversations"][0].clone();
        duplicate["records"]["conversations"]
            .as_array_mut()
            .unwrap()
            .push(first);
        refresh_counts_and_hashes(&mut duplicate);
        cases.push(duplicate);

        let mut bad_fk = valid_import_document_value();
        bad_fk["records"]["messages"][0]["conversationId"] = json!("missing-conversation");
        refresh_counts_and_hashes(&mut bad_fk);
        cases.push(bad_fk);

        let mut bad_identity = valid_import_document_value();
        bad_identity["records"]["memoryItems"][0]["profileId"] = json!("profile-2");
        refresh_counts_and_hashes(&mut bad_identity);
        cases.push(bad_identity);

        let mut bad_envelope = valid_import_document_value();
        bad_envelope["records"]["memoryItems"][0]["payloadEnvelope"]["nonceB64Url"] =
            json!("not_canonical");
        refresh_counts_and_hashes(&mut bad_envelope);
        cases.push(bad_envelope);

        for case in cases {
            assert!(validate_import_document(case, "profile-1", "node-1", 3).is_err());
            assert_eq!(
                export_records(&conn, "profile-1", "node-1").unwrap(),
                before
            );
        }
    }

    #[test]
    fn direct_repository_writes_validate_records_before_persisting() {
        let conn = test_connection();
        apply_generated_migrations(&conn).unwrap();
        ensure_identity(&conn, "node-1").unwrap();
        let before = export_records(&conn, "profile-1", "node-1").unwrap();
        let mut bad_memory = test_memory("memory-1");
        bad_memory.payload_envelope["ciphertextAndTagB64Url"] = json!("short");
        assert!(run_repository_operation(
            &conn,
            "profile-1",
            "node-1",
            LocalDataRepositoryOperation::MemoryUpsertMemoryItem { record: bad_memory },
        )
        .is_err());
        assert_eq!(
            export_records(&conn, "profile-1", "node-1").unwrap(),
            before
        );
    }

    #[test]
    fn native_transcript_writer_survives_renderer_close_and_refuses_a_cleared_database() {
        let (dir, path) = test_db_path("native-transcript-owner");
        let state = LocalDataCommandState::default();
        let mut record = test_transcript_session("native-recording");
        record.expires_at_ms = None;
        state
            .native_transcript_write_at_path(
                path.clone(),
                "profile-1",
                "node-1",
                NativeTranscriptArchiveWrite::CreateSession { record },
            )
            .unwrap();
        {
            let mut renderer = state.inner.lock().unwrap();
            renderer.profile_id = None;
            renderer.local_node_id = None;
            renderer.scope_generation += 1;
        }
        let segment = test_transcript_segment("native-segment", "native-recording", 0);
        let appended = state
            .native_transcript_write_at_path(
                path.clone(),
                "profile-1",
                "node-1",
                NativeTranscriptArchiveWrite::AppendSegment {
                    record: segment.clone(),
                },
            )
            .unwrap();
        assert_eq!(appended["appended"], json!(true));
        state
            .native_transcript_write_at_path(
                path.clone(),
                "profile-1",
                "node-1",
                NativeTranscriptArchiveWrite::FinalizeSession {
                    input: FinalizeTranscriptSessionInput {
                        session_id: "native-recording".into(),
                        lifecycle: "completed".into(),
                        ended_at_ms: 20,
                        terminal_reason: "user_stop".into(),
                    },
                },
            )
            .unwrap();
        std::fs::remove_file(&path).unwrap();
        assert!(state
            .native_transcript_write_at_path(
                path.clone(),
                "profile-1",
                "node-1",
                NativeTranscriptArchiveWrite::AppendSegment { record: segment },
            )
            .is_err());
        assert!(!path.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn native_transcript_restart_recovers_once_without_interrupting_a_live_session() {
        let (dir, path) = test_db_path("native-transcript-recovery");
        let create = |state: &LocalDataCommandState, id: &str| {
            let mut record = test_transcript_session(id);
            record.expires_at_ms = None;
            state
                .native_transcript_write_at_path(
                    path.clone(),
                    "profile-1",
                    "node-1",
                    NativeTranscriptArchiveWrite::CreateSession { record },
                )
                .unwrap()
        };
        create(&LocalDataCommandState::default(), "abandoned-recording");
        let restarted = LocalDataCommandState::default();
        create(&restarted, "live-recording");
        create(&restarted, "another-recording");
        let conn = SqliteConnection::open(path.clone()).unwrap();
        let read = |id: &str| {
            run_repository_operation(
                &conn,
                "profile-1",
                "node-1",
                LocalDataRepositoryOperation::TranscriptsGetSession {
                    profile_id: "profile-1".into(),
                    local_node_id: "node-1".into(),
                    session_id: id.into(),
                },
            )
            .unwrap()
        };
        assert_eq!(
            read("abandoned-recording")["lifecycle"],
            json!("interrupted")
        );
        assert_eq!(read("live-recording")["lifecycle"], json!("active"));
        drop(conn);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn transcript_archive_replay_terminal_recovery_and_delete_are_scoped() {
        let conn = migrated_test_connection();
        let created = run_repository_operation(
            &conn,
            "profile-1",
            "node-1",
            LocalDataRepositoryOperation::TranscriptsCreateSession {
                record: test_transcript_session("transcript-1"),
            },
        )
        .unwrap();
        assert_eq!(created["lifecycle"], json!("active"));
        let mut segment = test_transcript_segment("segment-1", "transcript-1", 0);
        segment.confidence = Some(0.75);
        let appended = run_repository_operation(
            &conn,
            "profile-1",
            "node-1",
            LocalDataRepositoryOperation::TranscriptsAppendSegment {
                record: segment.clone(),
            },
        )
        .unwrap();
        assert_eq!(appended["appended"], json!(true));
        run_repository_operation(
            &conn,
            "profile-1",
            "node-1",
            LocalDataRepositoryOperation::TranscriptsFinalizeSession {
                profile_id: "profile-1".into(),
                local_node_id: "node-1".into(),
                input: FinalizeTranscriptSessionInput {
                    session_id: "transcript-1".into(),
                    lifecycle: "completed".into(),
                    ended_at_ms: 20,
                    terminal_reason: "finished".into(),
                },
            },
        )
        .unwrap();
        let replay = run_repository_operation(
            &conn,
            "profile-1",
            "node-1",
            LocalDataRepositoryOperation::TranscriptsAppendSegment {
                record: segment.clone(),
            },
        )
        .unwrap();
        assert_eq!(replay, json!({ "appended": false, "record": segment }));
        let late_segment = test_transcript_segment("segment-2", "transcript-1", 1);
        assert!(run_repository_operation(
            &conn,
            "profile-1",
            "node-1",
            LocalDataRepositoryOperation::TranscriptsAppendSegment {
                record: late_segment
            },
        )
        .is_err());

        run_repository_operation(
            &conn,
            "profile-1",
            "node-1",
            LocalDataRepositoryOperation::TranscriptsCreateSession {
                record: test_transcript_session("transcript-recovery"),
            },
        )
        .unwrap();
        let recovered = run_repository_operation(
            &conn,
            "profile-1",
            "node-1",
            LocalDataRepositoryOperation::TranscriptsRecoverActiveSessions {
                profile_id: "profile-1".into(),
                local_node_id: "node-1".into(),
                now_ms: 30,
                terminal_reason: None,
            },
        )
        .unwrap();
        assert_eq!(recovered, json!({ "interrupted": 1 }));
        let recovered_session = run_repository_operation(
            &conn,
            "profile-1",
            "node-1",
            LocalDataRepositoryOperation::TranscriptsGetSession {
                profile_id: "profile-1".into(),
                local_node_id: "node-1".into(),
                session_id: "transcript-recovery".into(),
            },
        )
        .unwrap();
        assert_eq!(recovered_session["lifecycle"], json!("interrupted"));
        assert_eq!(
            recovered_session["terminalReason"],
            json!("process_restart")
        );
        let mut transfer = valid_import_document_value();
        transfer["records"]["transcriptSessions"] = json!([run_repository_operation(
            &conn,
            "profile-1",
            "node-1",
            LocalDataRepositoryOperation::TranscriptsGetSession {
                profile_id: "profile-1".into(),
                local_node_id: "node-1".into(),
                session_id: "transcript-1".into()
            }
        )
        .unwrap()]);
        let mut canonical_one =
            test_transcript_segment("segment-one-confidence", "transcript-1", 1);
        canonical_one.confidence = Some(1.0);
        let canonical_one_value = json!([canonical_one]);
        let canonical_one_json = canonical_transcript_segments(&canonical_one_value).unwrap();
        assert!(canonical_one_json.contains("\"confidence\":1"));
        assert!(!canonical_one_json.contains("\"confidence\":1.0"));
        transfer["records"]["transcriptSegments"] = json!([segment, canonical_one_value[0]]);
        refresh_counts_and_hashes(&mut transfer);
        let document = validate_import_document(
            transfer,
            "profile-1",
            "node-1",
            generated::local_data_migrations::LOCAL_DATA_LATEST_VERSION,
        )
        .unwrap();
        import_records(&conn, "profile-1", "node-1", &document).unwrap();
        let exported = export_records(&conn, "profile-1", "node-1").unwrap();
        assert_eq!(exported["transcriptSegments"].as_array().unwrap().len(), 2);
        assert_eq!(
            collection_hashes(&exported).unwrap()["transcriptSegments"],
            json!(document.collection_hashes.transcript_segments)
        );
        assert_eq!(
            run_repository_operation(
                &conn,
                "profile-1",
                "node-1",
                LocalDataRepositoryOperation::TranscriptsDeleteSession {
                    profile_id: "profile-1".into(),
                    local_node_id: "node-1".into(),
                    session_id: "transcript-1".into()
                }
            )
            .unwrap(),
            json!({ "deleted": true, "deletedSegments": 2 })
        );
    }

    #[test]
    fn transaction_ids_are_server_owned_and_forgery_checked() {
        let first = new_transaction_id().unwrap();
        let second = new_transaction_id().unwrap();
        assert_ne!(first, second);
        assert!(first.starts_with("tx-"));
        assert_eq!(first.len(), 35);

        let conn = test_connection();
        let mut state = LocalDataState {
            profile_id: Some("profile-1".to_string()),
            local_node_id: Some("node-1".to_string()),
            schema_version: Some(3),
            active_transaction: Some(ActiveTransaction {
                tx_id: first.clone(),
                conn,
            }),
            recovered_transcript_scopes: HashSet::new(),
            scope_generation: 0,
        };
        assert!(
            take_active_transaction(&mut state, "tx-00000000000000000000000000000000").is_err()
        );
        assert!(state.active_transaction.is_some());
        assert!(take_active_transaction(&mut state, &first).is_ok());
        assert!(state.active_transaction.is_none());
    }

    #[test]
    fn open_rejects_malformed_identity_without_creating_files() {
        let (dir, path) = test_db_path("malformed-open");
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(!dir.exists());

        let error = open_local_data_at_path(path.clone(), "profile with spaces", "node-1")
            .expect_err("malformed profile must fail before path creation");
        assert!(format!("{error:?}").contains("profileId invalid"));
        assert!(!dir.exists());
        assert!(!path.exists());
    }

    #[test]
    fn identity_inspection_does_not_create_a_missing_database() {
        let (dir, path) = test_db_path("inspect-missing");
        std::fs::remove_dir_all(&dir).unwrap();

        let inspection = inspect_local_data_identity_at_path(path.clone()).unwrap();

        assert_eq!(inspection["databaseExists"], json!(false));
        assert_eq!(inspection["identityTablePresent"], json!(false));
        assert_eq!(inspection["databaseLocalNodeId"], Value::Null);
        assert_eq!(inspection["schemaVersion"], Value::Null);
        assert_eq!(inspection["sqliteObjectCount"], json!(0));
        assert_eq!(inspection["recordCount"], json!(0));
        assert_eq!(inspection["secretsRedacted"], json!(true));
        assert!(!dir.exists());
        assert!(!path.exists());
    }

    #[test]
    fn identity_inspection_reports_populated_database_without_mutating_it() {
        let (dir, path) = test_db_path("inspect-populated");
        {
            let conn = SqliteConnection::open(path.clone()).unwrap();
            apply_generated_migrations(&conn).unwrap();
            ensure_identity(&conn, "node-1").unwrap();
            seed_complete_profile(&conn, "profile-1", "node-1", "inspect").unwrap();
        }
        let before = std::fs::read(&path).unwrap();

        let inspection = inspect_local_data_identity_at_path(path.clone()).unwrap();

        assert_eq!(inspection["databaseExists"], json!(true));
        assert_eq!(inspection["identityTablePresent"], json!(true));
        assert_eq!(inspection["databaseLocalNodeId"], json!("node-1"));
        assert_eq!(
            inspection["schemaVersion"],
            json!(generated::local_data_migrations::LOCAL_DATA_LATEST_VERSION)
        );
        assert!(inspection["sqliteObjectCount"].as_i64().unwrap() > 0);
        assert_eq!(inspection["recordCount"], json!(6));
        assert_eq!(inspection["secretsRedacted"], json!(true));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn open_rejects_identity_missing_database_without_migration_or_byte_mutation() {
        let (_dir, path) = test_db_path("identity-missing-open");
        {
            let conn = SqliteConnection::open(path.clone()).unwrap();
            conn.exec("CREATE TABLE unrelated_existing_data (id TEXT PRIMARY KEY);")
                .unwrap();
            conn.execute(
                "INSERT INTO unrelated_existing_data (id) VALUES (?)",
                &[json!("record-1")],
            )
            .unwrap();
        }
        let before = std::fs::read(&path).unwrap();

        let error = open_local_data_at_path(path.clone(), "profile-1", "node-1")
            .expect_err("nonempty database without identity must fail before migration");
        assert!(format!("{error:?}").contains("identity_missing"));
        assert_eq!(std::fs::read(&path).unwrap(), before);

        let conn = SqliteConnection::open(path).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), 0);
        assert!(!table_exists(&conn, "aurora_schema_migrations").unwrap());
    }

    #[test]
    fn open_rejects_wrong_identity_before_migration_without_advancing_database() {
        let (_dir, path) = test_db_path("wrong-identity-open");
        {
            let conn = SqliteConnection::open(path.clone()).unwrap();
            let first = &generated::local_data_migrations::LOCAL_DATA_MIGRATIONS[0];
            conn.exec(first.sql).unwrap();
            ensure_identity(&conn, "node-1").unwrap();
            conn.exec(first.ledger_sql).unwrap();
        }
        let before_bytes = std::fs::read(&path).unwrap();
        let before = db_version_and_ledger_count(&path);

        let error = open_local_data_at_path(path.clone(), "profile-1", "node-2")
            .expect_err("wrong local node must fail before later migrations");
        assert!(format!("{error:?}").contains("identity_mismatch"));
        assert_eq!(std::fs::read(&path).unwrap(), before_bytes);
        assert_eq!(db_version_and_ledger_count(&path), before);
    }

    #[test]
    fn open_rejects_wrong_identity_on_latest_database_without_byte_mutation() {
        let (_dir, path) = test_db_path("wrong-latest-open");
        open_local_data_at_path(path.clone(), "profile-1", "node-1").unwrap();
        let before_bytes = std::fs::read(&path).unwrap();
        let before = db_version_and_ledger_count(&path);

        let error = open_local_data_at_path(path.clone(), "profile-1", "node-2")
            .expect_err("wrong local node must not mutate latest database");
        assert!(format!("{error:?}").contains("identity_mismatch"));
        assert_eq!(std::fs::read(&path).unwrap(), before_bytes);
        assert_eq!(db_version_and_ledger_count(&path), before);
    }

    #[test]
    fn hashed_native_envelope_key_handles_are_the_only_accepted_scope() {
        let key_id = canonical_test_key_id("profile-1", "node-1", 1);
        validate_envelope_key_id(&key_id, "profile-1", "node-1", "memory.payload").unwrap();

        for bad_key_id in [
            "aurora.local-data-envelope.v1.profile-1.node-1.local-structured-data.k1".to_string(),
            canonical_test_key_id("profile-2", "node-1", 1),
            canonical_test_key_id("profile-1", "node-2", 1),
            format!(
                "aurora.local-data-envelope.v1.{}.{}.wrong-purpose.k1",
                sha256_hex("profile-1".as_bytes()),
                sha256_hex("node-1".as_bytes())
            ),
            format!(
                "aurora.local-data-envelope.v1.{}.{}.local-structured-data.k0",
                sha256_hex("profile-1".as_bytes()),
                sha256_hex("node-1".as_bytes())
            ),
        ] {
            assert!(
                validate_envelope_key_id(&bad_key_id, "profile-1", "node-1", "memory.payload")
                    .is_err(),
                "{bad_key_id} should fail scope validation"
            );
        }
    }

    #[test]
    fn native_hashed_envelopes_are_accepted_by_repository_and_import_boundaries() {
        let conn = test_connection();
        apply_generated_migrations(&conn).unwrap();
        ensure_identity(&conn, "node-1").unwrap();

        let memory = test_memory("memory-1");
        assert_eq!(
            memory.payload_envelope["keyId"],
            json!(canonical_test_key_id("profile-1", "node-1", 1))
        );
        run_repository_operation(
            &conn,
            "profile-1",
            "node-1",
            LocalDataRepositoryOperation::MemoryUpsertMemoryItem { record: memory },
        )
        .unwrap();
        assert_eq!(
            export_records(&conn, "profile-1", "node-1").unwrap()["memoryItems"][0]["id"],
            json!("memory-1")
        );

        let document = valid_import_document_value();
        let parsed = validate_import_document(document, "profile-1", "node-1", 3).unwrap();
        let import_result = import_records(&conn, "profile-1", "node-1", &parsed).unwrap();
        assert_eq!(import_result["imported"], json!(true));
    }

    #[test]
    fn import_rejects_native_envelopes_for_wrong_profile_node_or_key_format() {
        for key_id in [
            canonical_test_key_id("profile-2", "node-1", 1),
            canonical_test_key_id("profile-1", "node-2", 1),
            "aurora.local-data-envelope.v1.profile-1.node-1.local-structured-data.k1".to_string(),
        ] {
            let mut document = valid_import_document_value();
            document["records"]["memoryItems"][0]["payloadEnvelope"]["keyId"] = json!(key_id);
            refresh_counts_and_hashes(&mut document);
            assert!(validate_import_document(document, "profile-1", "node-1", 3).is_err());
        }
    }

    #[test]
    fn same_node_different_profile_records_coexist_with_distinct_global_keys() {
        let conn = migrated_test_connection();
        seed_complete_profile(&conn, "profile-1", "node-1", "one").unwrap();
        let profile_one_before = export_records(&conn, "profile-1", "node-1").unwrap();

        seed_complete_profile(&conn, "profile-2", "node-1", "two").unwrap();

        assert_eq!(
            export_records(&conn, "profile-1", "node-1").unwrap(),
            profile_one_before
        );
        assert_eq!(
            record_counts(&export_records(&conn, "profile-2", "node-1").unwrap()),
            json!({
                "conversations": 1,
                "messages": 1,
                "memoryItems": 1,
                "localToolStates": 1,
                "peerGrantMetadata": 1,
                "localAudit": 1,
                "transcriptSessions": 0,
                "transcriptSegments": 0,
            })
        );
    }

    #[test]
    fn global_key_repository_writes_reject_cross_profile_collisions_without_mutation() {
        let conn = migrated_test_connection();
        seed_complete_profile(&conn, "profile-1", "node-1", "one").unwrap();
        run_repository_operation(
            &conn,
            "profile-2",
            "node-1",
            LocalDataRepositoryOperation::ConversationsUpsertConversation {
                record: test_conversation_for("profile-2", "node-1", "profile-2-conversation"),
            },
        )
        .unwrap();
        let profile_one_before = export_records(&conn, "profile-1", "node-1").unwrap();

        let cases = [
            LocalDataRepositoryOperation::ConversationsUpsertConversation {
                record: test_conversation_for("profile-2", "node-1", "conversation-one"),
            },
            LocalDataRepositoryOperation::ConversationsAppendMessage {
                record: test_message_for("message-one", "profile-2-conversation"),
            },
            LocalDataRepositoryOperation::MemoryUpsertMemoryItem {
                record: test_memory_for("profile-2", "node-1", "memory-one"),
            },
            LocalDataRepositoryOperation::PeerGrantsUpsertPeerGrant {
                record: test_grant_for("profile-2", "node-1", "grant-one"),
            },
            LocalDataRepositoryOperation::LocalAuditAppendAudit {
                record: test_audit_for("profile-2", "node-1", "audit-one"),
            },
        ];

        for operation in cases {
            assert!(run_repository_operation(&conn, "profile-2", "node-1", operation).is_err());
            assert_eq!(
                export_records(&conn, "profile-1", "node-1").unwrap(),
                profile_one_before
            );
        }
    }

    #[test]
    fn import_rejects_cross_profile_global_key_collisions_before_deleting_current_profile() {
        let conn = migrated_test_connection();
        seed_complete_profile(&conn, "profile-1", "node-1", "one").unwrap();
        seed_complete_profile(&conn, "profile-2", "node-1", "existing-two").unwrap();
        let profile_one_before = export_records(&conn, "profile-1", "node-1").unwrap();
        let profile_two_before = export_records(&conn, "profile-2", "node-1").unwrap();

        let mut document = valid_import_document_value();
        rewrite_document_identity(&mut document, "profile-2", "node-1");
        document["records"]["conversations"][0]["id"] = json!("conversation-one");
        document["records"]["messages"][0]["id"] = json!("message-one");
        document["records"]["messages"][0]["conversationId"] = json!("conversation-one");
        document["records"]["memoryItems"][0]["id"] = json!("memory-one");
        document["records"]["peerGrantMetadata"][0]["grantId"] = json!("grant-one");
        document["records"]["localAudit"][0]["id"] = json!("audit-one");
        refresh_counts_and_hashes(&mut document);
        let parsed = validate_import_document(document, "profile-2", "node-1", 3).unwrap();

        assert!(import_records(&conn, "profile-2", "node-1", &parsed).is_err());
        assert_eq!(
            export_records(&conn, "profile-1", "node-1").unwrap(),
            profile_one_before
        );
        assert_eq!(
            export_records(&conn, "profile-2", "node-1").unwrap(),
            profile_two_before
        );
    }

    #[test]
    fn repository_operations_deserialize_js_camel_case_shapes() {
        match serde_json::from_value::<LocalDataRepositoryOperation>(json!({
            "kind": "conversations.deleteConversation",
            "conversationId": "conversation-1"
        }))
        .unwrap()
        {
            LocalDataRepositoryOperation::ConversationsDeleteConversation { conversation_id } => {
                assert_eq!(conversation_id, "conversation-1");
            }
            _ => panic!("conversation delete payload deserialized to the wrong operation"),
        }

        match serde_json::from_value::<LocalDataRepositoryOperation>(json!({
            "kind": "memory.deleteMemoryItem",
            "memoryItemId": "memory-1"
        }))
        .unwrap()
        {
            LocalDataRepositoryOperation::MemoryDeleteMemoryItem { memory_item_id } => {
                assert_eq!(memory_item_id, "memory-1");
            }
            _ => panic!("memory delete payload deserialized to the wrong operation"),
        }

        match serde_json::from_value::<LocalDataRepositoryOperation>(json!({
            "kind": "memory.deleteExpiredMemoryItems",
            "profileId": "profile-1",
            "localNodeId": "node-1",
            "nowMs": 1000,
            "limit": 2
        }))
        .unwrap()
        {
            LocalDataRepositoryOperation::MemoryDeleteExpiredMemoryItems {
                profile_id,
                local_node_id,
                now_ms,
                limit,
            } => {
                assert_eq!(profile_id, "profile-1");
                assert_eq!(local_node_id, "node-1");
                assert_eq!(now_ms, 1000);
                assert_eq!(limit, 2);
            }
            _ => panic!("expired memory delete payload deserialized to the wrong operation"),
        }

        match serde_json::from_value::<LocalDataRepositoryOperation>(json!({
            "kind": "conversations.listMessages",
            "profileId": "profile-1",
            "localNodeId": "node-1",
            "conversationId": "conversation-1"
        }))
        .unwrap()
        {
            LocalDataRepositoryOperation::ConversationsListMessages {
                profile_id,
                local_node_id,
                conversation_id,
                options,
            } => {
                assert_eq!(profile_id, "profile-1");
                assert_eq!(local_node_id, "node-1");
                assert_eq!(conversation_id, "conversation-1");
                assert!(options.is_none());
            }
            _ => panic!("list messages payload deserialized to the wrong operation"),
        }
    }

    #[test]
    fn delete_conversation_is_scoped_and_reports_cascade_count() {
        let conn = migrated_test_connection();
        run_repository_operation(
            &conn,
            "profile-1",
            "node-1",
            LocalDataRepositoryOperation::ConversationsUpsertConversation {
                record: test_conversation("conversation-1"),
            },
        )
        .unwrap();
        run_repository_operation(
            &conn,
            "profile-1",
            "node-1",
            LocalDataRepositoryOperation::ConversationsAppendMessage {
                record: test_message_for("message-1", "conversation-1"),
            },
        )
        .unwrap();
        let mut second = test_message_for("message-2", "conversation-1");
        second.sequence = 1;
        run_repository_operation(
            &conn,
            "profile-1",
            "node-1",
            LocalDataRepositoryOperation::ConversationsAppendMessage { record: second },
        )
        .unwrap();
        run_repository_operation(
            &conn,
            "profile-2",
            "node-1",
            LocalDataRepositoryOperation::ConversationsUpsertConversation {
                record: test_conversation_for("profile-2", "node-1", "conversation-foreign"),
            },
        )
        .unwrap();
        run_repository_operation(
            &conn,
            "profile-2",
            "node-1",
            LocalDataRepositoryOperation::ConversationsAppendMessage {
                record: test_message_for("message-foreign", "conversation-foreign"),
            },
        )
        .unwrap();
        let foreign_before = export_records(&conn, "profile-2", "node-1").unwrap();

        assert_eq!(
            run_repository_operation(
                &conn,
                "profile-1",
                "node-1",
                LocalDataRepositoryOperation::ConversationsDeleteConversation {
                    conversation_id: "conversation-foreign".to_string(),
                },
            )
            .unwrap(),
            json!({ "deleted": false, "deletedMessages": 0 })
        );
        assert_eq!(
            export_records(&conn, "profile-2", "node-1").unwrap(),
            foreign_before
        );

        assert_eq!(
            run_repository_operation(
                &conn,
                "profile-1",
                "node-1",
                LocalDataRepositoryOperation::ConversationsDeleteConversation {
                    conversation_id: "conversation-1".to_string(),
                },
            )
            .unwrap(),
            json!({ "deleted": true, "deletedMessages": 2 })
        );
        assert_eq!(
            record_counts(&export_records(&conn, "profile-1", "node-1").unwrap()),
            json!({
                "conversations": 0,
                "messages": 0,
                "memoryItems": 0,
                "localToolStates": 0,
                "peerGrantMetadata": 0,
                "localAudit": 0,
                "transcriptSessions": 0,
                "transcriptSegments": 0,
            })
        );
        assert_eq!(
            export_records(&conn, "profile-2", "node-1").unwrap(),
            foreign_before
        );
    }

    #[test]
    fn memory_deletes_are_scoped_bounded_and_ordered_by_expiry_then_id() {
        let conn = migrated_test_connection();
        for mut memory in [
            test_memory_for("profile-1", "node-1", "memory-live"),
            test_memory_for("profile-1", "node-1", "memory-b"),
            test_memory_for("profile-1", "node-1", "memory-a"),
            test_memory_for("profile-1", "node-1", "memory-later"),
            test_memory_for("profile-2", "node-1", "memory-foreign"),
        ] {
            memory.expires_at_ms = match memory.id.as_str() {
                "memory-live" => None,
                "memory-later" => Some(900),
                "memory-foreign" => Some(1),
                _ => Some(500),
            };
            run_repository_operation(
                &conn,
                &memory.profile_id.clone(),
                &memory.local_node_id.clone(),
                LocalDataRepositoryOperation::MemoryUpsertMemoryItem { record: memory },
            )
            .unwrap();
        }
        let foreign_before = export_records(&conn, "profile-2", "node-1").unwrap();

        assert_eq!(
            run_repository_operation(
                &conn,
                "profile-1",
                "node-1",
                LocalDataRepositoryOperation::MemoryDeleteMemoryItem {
                    memory_item_id: "memory-foreign".to_string(),
                },
            )
            .unwrap(),
            json!({ "deleted": false })
        );
        assert!(run_repository_operation(
            &conn,
            "profile-1",
            "node-1",
            LocalDataRepositoryOperation::MemoryDeleteExpiredMemoryItems {
                profile_id: "profile-2".to_string(),
                local_node_id: "node-1".to_string(),
                now_ms: 1000,
                limit: 2,
            },
        )
        .is_err());
        assert_eq!(
            run_repository_operation(
                &conn,
                "profile-1",
                "node-1",
                LocalDataRepositoryOperation::MemoryDeleteExpiredMemoryItems {
                    profile_id: "profile-1".to_string(),
                    local_node_id: "node-1".to_string(),
                    now_ms: 1000,
                    limit: 2,
                },
            )
            .unwrap(),
            json!({ "deleted": 2 })
        );

        let remaining = export_records(&conn, "profile-1", "node-1").unwrap();
        let mut remaining_ids: Vec<_> = remaining["memoryItems"]
            .as_array()
            .unwrap()
            .iter()
            .map(|record| record["id"].as_str().unwrap())
            .collect();
        remaining_ids.sort_unstable();
        assert_eq!(remaining_ids, ["memory-later", "memory-live"]);
        assert_eq!(
            export_records(&conn, "profile-2", "node-1").unwrap(),
            foreign_before
        );
    }

    #[test]
    fn malformed_expired_memory_delete_fails_before_mutation() {
        let conn = migrated_test_connection();
        let mut expired = test_memory("memory-expired");
        expired.expires_at_ms = Some(1);
        run_repository_operation(
            &conn,
            "profile-1",
            "node-1",
            LocalDataRepositoryOperation::MemoryUpsertMemoryItem { record: expired },
        )
        .unwrap();
        let before = export_records(&conn, "profile-1", "node-1").unwrap();

        for malformed in [
            json!({
                "kind": "memory.deleteExpiredMemoryItems",
                "profileId": "profile-1",
                "localNodeId": "node-1",
                "nowMs": 1.5,
                "limit": 1
            }),
            json!({
                "kind": "memory.deleteExpiredMemoryItems",
                "profileId": "profile-1",
                "localNodeId": "node-1",
                "nowMs": 1000,
                "limit": "2"
            }),
            json!({
                "kind": "memory.deleteExpiredMemoryItems",
                "profileId": "profile-1",
                "localNodeId": "node-1",
                "nowMs": 1000,
                "limit": null
            }),
            json!({
                "kind": "memory.deleteExpiredMemoryItems",
                "profileId": "profile-1",
                "localNodeId": "node-1",
                "now_ms": 1000,
                "limit": 1
            }),
            json!({
                "kind": "memory.deleteExpiredMemoryItems",
                "profile_id": "profile-1",
                "localNodeId": "node-1",
                "nowMs": 1000,
                "limit": 1
            }),
            json!({
                "kind": "memory.deleteExpiredMemoryItems",
                "profileId": "profile-1",
                "nowMs": 1000,
                "limit": 1
            }),
            json!({
                "kind": "memory.deleteExpiredMemoryItems",
                "profileId": "profile-1",
                "localNodeId": "node-1",
                "nowMs": 1000,
                "limit": 1,
                "rawSql": "DELETE FROM aurora_memory_items"
            }),
        ] {
            assert!(serde_json::from_value::<LocalDataRepositoryOperation>(malformed).is_err());
            assert_eq!(
                export_records(&conn, "profile-1", "node-1").unwrap(),
                before
            );
        }

        for operation in [
            LocalDataRepositoryOperation::MemoryDeleteExpiredMemoryItems {
                profile_id: "profile-1".to_string(),
                local_node_id: "node-1".to_string(),
                now_ms: -1,
                limit: 1,
            },
            LocalDataRepositoryOperation::MemoryDeleteExpiredMemoryItems {
                profile_id: "profile-1".to_string(),
                local_node_id: "node-1".to_string(),
                now_ms: MAX_SAFE_INTEGER + 1,
                limit: 1,
            },
            LocalDataRepositoryOperation::MemoryDeleteExpiredMemoryItems {
                profile_id: "profile-1".to_string(),
                local_node_id: "node-1".to_string(),
                now_ms: 1000,
                limit: 0,
            },
            LocalDataRepositoryOperation::MemoryDeleteExpiredMemoryItems {
                profile_id: "profile-1".to_string(),
                local_node_id: "node-1".to_string(),
                now_ms: 1000,
                limit: MAX_SAFE_INTEGER + 1,
            },
        ] {
            assert!(run_repository_operation(&conn, "profile-1", "node-1", operation).is_err());
            assert_eq!(
                export_records(&conn, "profile-1", "node-1").unwrap(),
                before
            );
        }
    }

    fn test_connection() -> SqliteConnection {
        let (_, path) = test_db_path("connection");
        let _ = std::fs::remove_file(&path);
        SqliteConnection::open(path).unwrap()
    }

    fn migrated_test_connection() -> SqliteConnection {
        let conn = test_connection();
        apply_generated_migrations(&conn).unwrap();
        ensure_identity(&conn, "node-1").unwrap();
        conn
    }

    fn seed_complete_profile(
        conn: &SqliteConnection,
        profile_id: &str,
        local_node_id: &str,
        suffix: &str,
    ) -> Result<(), AuroraCommandError> {
        let conversation_id = format!("conversation-{suffix}");
        run_repository_operation(
            conn,
            profile_id,
            local_node_id,
            LocalDataRepositoryOperation::ConversationsUpsertConversation {
                record: test_conversation_for(profile_id, local_node_id, &conversation_id),
            },
        )?;
        run_repository_operation(
            conn,
            profile_id,
            local_node_id,
            LocalDataRepositoryOperation::ConversationsAppendMessage {
                record: test_message_for(&format!("message-{suffix}"), &conversation_id),
            },
        )?;
        run_repository_operation(
            conn,
            profile_id,
            local_node_id,
            LocalDataRepositoryOperation::MemoryUpsertMemoryItem {
                record: test_memory_for(profile_id, local_node_id, &format!("memory-{suffix}")),
            },
        )?;
        run_repository_operation(
            conn,
            profile_id,
            local_node_id,
            LocalDataRepositoryOperation::LocalToolsUpsertLocalToolState {
                record: test_tool_for(
                    profile_id,
                    local_node_id,
                    &format!("Tooling.Search.{suffix}"),
                ),
            },
        )?;
        run_repository_operation(
            conn,
            profile_id,
            local_node_id,
            LocalDataRepositoryOperation::PeerGrantsUpsertPeerGrant {
                record: test_grant_for(profile_id, local_node_id, &format!("grant-{suffix}")),
            },
        )?;
        run_repository_operation(
            conn,
            profile_id,
            local_node_id,
            LocalDataRepositoryOperation::LocalAuditAppendAudit {
                record: test_audit_for(profile_id, local_node_id, &format!("audit-{suffix}")),
            },
        )?;
        Ok(())
    }

    fn test_db_path(label: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "aurora-local-data-native-test-{}-{}-{label}",
            std::process::id(),
            TEST_DB_COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(generated::local_data_migrations::LOCAL_DATA_DATABASE_NAME);
        (dir, path)
    }

    fn db_version_and_ledger_count(path: &std::path::Path) -> (u32, i64) {
        let conn = SqliteConnection::open(path.to_path_buf()).unwrap();
        let rows = conn
            .query(
                "SELECT COUNT(*) AS ledger_count FROM aurora_schema_migrations",
                &[],
            )
            .unwrap();
        (
            schema_version(&conn).unwrap(),
            row_i64(&rows[0], "ledger_count").unwrap(),
        )
    }

    fn canonical_test_key_id(profile_id: &str, local_node_id: &str, version: u32) -> String {
        format!(
            "aurora.local-data-envelope.v1.{}.{}.local-structured-data.k{}",
            sha256_hex(profile_id.as_bytes()),
            sha256_hex(local_node_id.as_bytes()),
            version
        )
    }

    fn valid_import_document_value() -> Value {
        let records = json!({
            "conversations": [test_conversation_value("conversation-1")],
            "messages": [test_message_value("message-1", "conversation-1")],
            "memoryItems": [test_memory_value("memory-1")],
            "localToolStates": [test_tool_value()],
            "peerGrantMetadata": [test_grant_value("grant-1")],
            "localAudit": [test_audit_value("audit-1")]
        });
        let mut document = json!({
            "version": 1,
            "sourceBackend": "memory",
            "schemaVersion": 3,
            "profileId": "profile-1",
            "localNodeId": "node-1",
            "exportedAtMs": 10,
            "encryptionEnvelopeVersions": [1],
            "recordCounts": record_counts(&records),
            "collectionHashes": collection_hashes(&records).unwrap(),
            "records": records
        });
        refresh_counts_and_hashes(&mut document);
        document
    }

    fn refresh_counts_and_hashes(document: &mut Value) {
        let records = document["records"].clone();
        document["recordCounts"] = record_counts(&records);
        document["collectionHashes"] = collection_hashes(&records).unwrap();
    }

    fn rewrite_document_identity(document: &mut Value, profile_id: &str, local_node_id: &str) {
        document["profileId"] = json!(profile_id);
        document["localNodeId"] = json!(local_node_id);
        for collection in [
            "conversations",
            "memoryItems",
            "localToolStates",
            "peerGrantMetadata",
            "localAudit",
        ] {
            for record in document["records"][collection].as_array_mut().unwrap() {
                record["profileId"] = json!(profile_id);
                record["localNodeId"] = json!(local_node_id);
            }
        }

        let key_id = canonical_test_key_id(profile_id, local_node_id, 1);
        for record in document["records"]["memoryItems"].as_array_mut().unwrap() {
            record["payloadEnvelope"]["keyId"] = json!(key_id);
        }
        for record in document["records"]["peerGrantMetadata"]
            .as_array_mut()
            .unwrap()
        {
            record["scopeEnvelope"]["keyId"] = json!(key_id);
        }
        refresh_counts_and_hashes(document);
    }

    fn test_conversation(id: &str) -> ConversationRecord {
        serde_json::from_value(test_conversation_value(id)).unwrap()
    }

    fn test_memory(id: &str) -> LightweightMemoryRecord {
        serde_json::from_value(test_memory_value(id)).unwrap()
    }

    fn test_conversation_for(
        profile_id: &str,
        local_node_id: &str,
        id: &str,
    ) -> ConversationRecord {
        let mut value = test_conversation_value(id);
        value["profileId"] = json!(profile_id);
        value["localNodeId"] = json!(local_node_id);
        serde_json::from_value(value).unwrap()
    }

    fn test_message_for(id: &str, conversation_id: &str) -> ConversationMessageRecord {
        serde_json::from_value(test_message_value(id, conversation_id)).unwrap()
    }

    fn test_message_for_with_sequence(
        id: &str,
        conversation_id: &str,
        sequence: i64,
    ) -> ConversationMessageRecord {
        let mut message = test_message_for(id, conversation_id);
        message.sequence = sequence;
        message
    }

    fn test_memory_for(profile_id: &str, local_node_id: &str, id: &str) -> LightweightMemoryRecord {
        let mut value = test_memory_value(id);
        value["profileId"] = json!(profile_id);
        value["localNodeId"] = json!(local_node_id);
        value["payloadEnvelope"]["keyId"] =
            json!(canonical_test_key_id(profile_id, local_node_id, 1));
        serde_json::from_value(value).unwrap()
    }

    fn test_tool_for(
        profile_id: &str,
        local_node_id: &str,
        tool_contract_id: &str,
    ) -> LocalToolStateRecord {
        let mut value = test_tool_value();
        value["profileId"] = json!(profile_id);
        value["localNodeId"] = json!(local_node_id);
        value["toolContractId"] = json!(tool_contract_id);
        value["descriptorJson"]["id"] = json!(tool_contract_id);
        serde_json::from_value(value).unwrap()
    }

    fn test_grant_for(profile_id: &str, local_node_id: &str, id: &str) -> PeerGrantMetadataRecord {
        let mut value = test_grant_value(id);
        value["profileId"] = json!(profile_id);
        value["localNodeId"] = json!(local_node_id);
        value["scopeEnvelope"]["keyId"] =
            json!(canonical_test_key_id(profile_id, local_node_id, 1));
        serde_json::from_value(value).unwrap()
    }

    fn test_audit_for(profile_id: &str, local_node_id: &str, id: &str) -> LocalAuditRecord {
        let mut value = test_audit_value(id);
        value["profileId"] = json!(profile_id);
        value["localNodeId"] = json!(local_node_id);
        serde_json::from_value(value).unwrap()
    }

    fn test_transcript_session(id: &str) -> TranscriptSessionRecord {
        TranscriptSessionRecord {
            id: id.to_owned(),
            profile_id: "profile-1".to_owned(),
            local_node_id: "node-1".to_owned(),
            capture_mode: "ambient".to_owned(),
            created_at_ms: 10,
            started_at_ms: 10,
            ended_at_ms: None,
            lifecycle: "active".to_owned(),
            terminal_reason: None,
            expires_at_ms: Some(100),
            language: Some("en".to_owned()),
            model_provenance: TranscriptModelProvenance {
                provider: Some("local".to_owned()),
                model_id: Some("stt-small".to_owned()),
                version: None,
            },
            diarization_state: "not_requested".to_owned(),
        }
    }

    fn test_transcript_segment(
        id: &str,
        session_id: &str,
        sequence: i64,
    ) -> TranscriptSegmentRecord {
        TranscriptSegmentRecord {
            id: id.to_owned(),
            session_id: session_id.to_owned(),
            sequence,
            start_at_ms: 11 + sequence,
            end_at_ms: 12 + sequence,
            text_envelope: envelope_value(),
            confidence: Some(0.8),
            speaker_id: None,
            speaker_label: None,
            created_at_ms: 13 + sequence,
        }
    }

    fn test_conversation_value(id: &str) -> Value {
        json!({
            "id": id,
            "profileId": "profile-1",
            "localNodeId": "node-1",
            "titleEnvelope": null,
            "createdAtMs": 1,
            "updatedAtMs": 2,
            "archivedAtMs": null
        })
    }

    fn test_message_value(id: &str, conversation_id: &str) -> Value {
        json!({
            "id": id,
            "conversationId": conversation_id,
            "sequence": 0,
            "role": "user",
            "contentEnvelope": null,
            "toolEnvelope": null,
            "status": "complete",
            "createdAtMs": 3
        })
    }

    fn test_memory_value(id: &str) -> Value {
        json!({
            "id": id,
            "profileId": "profile-1",
            "localNodeId": "node-1",
            "namespace": "notes",
            "payloadEnvelope": envelope_value(),
            "sourceType": null,
            "sourceId": null,
            "createdAtMs": 4,
            "updatedAtMs": 5,
            "expiresAtMs": null
        })
    }

    fn test_tool_value() -> Value {
        json!({
            "profileId": "profile-1",
            "localNodeId": "node-1",
            "toolContractId": "Tooling.Search",
            "descriptorJson": { "id": "Tooling.Search" },
            "descriptorHash": "a".repeat(64),
            "enabled": true,
            "settingsEnvelope": null,
            "revision": 1,
            "updatedAtMs": 6
        })
    }

    fn test_grant_value(id: &str) -> Value {
        json!({
            "grantId": id,
            "profileId": "profile-1",
            "localNodeId": "node-1",
            "claimantPeerId": "peer-1",
            "tokenId": "token-1",
            "scopeEnvelope": envelope_value(),
            "revision": 1,
            "createdAtMs": 7,
            "expiresAtMs": null,
            "revokedAtMs": null
        })
    }

    fn test_audit_value(id: &str) -> Value {
        json!({
            "id": id,
            "profileId": "profile-1",
            "localNodeId": "node-1",
            "peerId": null,
            "action": "read",
            "decision": "allow",
            "resultStatus": "success",
            "connectionEpoch": null,
            "methodId": null,
            "toolContractId": null,
            "correlationId": null,
            "redactedDetailJson": {},
            "createdAtMs": 8
        })
    }

    fn envelope_value() -> Value {
        json!({
            "version": 1,
            "algorithm": "AES-GCM-256",
            "keyId": canonical_test_key_id("profile-1", "node-1", 1),
            "nonceB64Url": "MTIzNDU2Nzg5MDEy",
            "ciphertextAndTagB64Url": "Y2lwaGVydGV4dC1hbmQtdGFn",
            "createdAtMs": 9
        })
    }
}
