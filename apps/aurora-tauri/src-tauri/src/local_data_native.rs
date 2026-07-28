use crate::{generated, AuroraCommandError};
use serde::Deserialize;
use serde_json::{json, Map, Number, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_double, c_int, c_void};
use std::path::PathBuf;
use std::ptr;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

const SQLITE_OK: c_int = 0;
const SQLITE_ROW: c_int = 100;
const SQLITE_DONE: c_int = 101;
const SQLITE_INTEGER: c_int = 1;
const SQLITE_FLOAT: c_int = 2;
const SQLITE_TEXT: c_int = 3;
const SQLITE_NULL: c_int = 5;
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

#[derive(Default)]
pub(crate) struct LocalDataCommandState {
    inner: Mutex<LocalDataState>,
}

#[derive(Default)]
struct LocalDataState {
    profile_id: Option<String>,
    local_node_id: Option<String>,
    schema_version: Option<u32>,
    transactions: HashMap<String, SqliteConnection>,
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
pub(crate) struct LocalDataRepositoryRequest {
    tx_id: Option<String>,
    operation: LocalDataRepositoryOperation,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalDataImportRequest {
    document: Value,
}

#[derive(Deserialize)]
#[serde(tag = "kind")]
enum LocalDataRepositoryOperation {
    #[serde(rename = "conversations.upsertConversation")]
    ConversationsUpsertConversation { record: ConversationRecord },
    #[serde(rename = "conversations.appendMessage")]
    ConversationsAppendMessage { record: ConversationMessageRecord },
    #[serde(rename = "conversations.listConversations")]
    ConversationsListConversations {
        profile_id: String,
        local_node_id: String,
    },
    #[serde(rename = "conversations.listMessages")]
    ConversationsListMessages {
        profile_id: String,
        local_node_id: String,
        conversation_id: String,
    },
    #[serde(rename = "memory.upsertMemoryItem")]
    MemoryUpsertMemoryItem { record: LightweightMemoryRecord },
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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationRecord {
    id: String,
    profile_id: String,
    local_node_id: String,
    title_envelope: Option<Value>,
    created_at_ms: i64,
    updated_at_ms: i64,
    archived_at_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
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
        let path = CString::new(path.to_string_lossy().as_bytes())
            .map_err(|_| local_data_error("database path contains a nul byte"))?;
        let mut raw = ptr::null_mut();
        let rc = unsafe {
            sqlite3_open_v2(
                path.as_ptr(),
                &mut raw,
                SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
                ptr::null(),
            )
        };
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
    let db_path = local_data_db_path(&app)?;
    let conn = SqliteConnection::open(db_path)?;
    apply_generated_migrations(&conn)?;
    ensure_identity(&conn, &request.local_node_id)?;
    let schema_version = schema_version(&conn)?;

    let mut state = state
        .inner
        .lock()
        .map_err(|_| local_data_error("local data state lock failed"))?;
    if let (Some(open_profile), Some(open_node)) = (&state.profile_id, &state.local_node_id) {
        if open_profile != &request.profile_id || open_node != &request.local_node_id {
            return Err(local_data_error("identity_mismatch"));
        }
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
}

#[tauri::command]
pub(crate) async fn aurora_local_data_status(
    state: State<'_, LocalDataCommandState>,
) -> Result<Value, AuroraCommandError> {
    let state = state
        .inner
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
}

#[tauri::command]
pub(crate) async fn aurora_local_data_close(
    state: State<'_, LocalDataCommandState>,
) -> Result<Value, AuroraCommandError> {
    let mut state = state
        .inner
        .lock()
        .map_err(|_| local_data_error("local data state lock failed"))?;
    state.transactions.clear();
    state.profile_id = None;
    state.local_node_id = None;
    state.schema_version = None;
    Ok(status_value(None, None, None, "idle"))
}

#[tauri::command]
pub(crate) async fn aurora_local_data_transaction_begin(
    app: AppHandle,
    state: State<'_, LocalDataCommandState>,
    request: LocalDataTransactionRequest,
) -> Result<Value, AuroraCommandError> {
    let mut state = state
        .inner
        .lock()
        .map_err(|_| local_data_error("local data state lock failed"))?;
    ensure_open_state(&state)?;
    if state.transactions.contains_key(&request.tx_id) {
        return Err(local_data_error("transaction already exists"));
    }
    let conn = SqliteConnection::open(local_data_db_path(&app)?)?;
    conn.exec("BEGIN IMMEDIATE;")?;
    state.transactions.insert(request.tx_id.clone(), conn);
    Ok(json!({ "txId": request.tx_id, "begun": true }))
}

#[tauri::command]
pub(crate) async fn aurora_local_data_transaction_commit(
    state: State<'_, LocalDataCommandState>,
    request: LocalDataTransactionRequest,
) -> Result<Value, AuroraCommandError> {
    let mut state = state
        .inner
        .lock()
        .map_err(|_| local_data_error("local data state lock failed"))?;
    let conn = state
        .transactions
        .remove(&request.tx_id)
        .ok_or_else(|| local_data_error("transaction not found"))?;
    conn.exec("COMMIT;")?;
    Ok(json!({ "txId": request.tx_id, "committed": true }))
}

#[tauri::command]
pub(crate) async fn aurora_local_data_transaction_rollback(
    state: State<'_, LocalDataCommandState>,
    request: LocalDataTransactionRequest,
) -> Result<Value, AuroraCommandError> {
    let mut state = state
        .inner
        .lock()
        .map_err(|_| local_data_error("local data state lock failed"))?;
    if let Some(conn) = state.transactions.remove(&request.tx_id) {
        let _ = conn.exec("ROLLBACK;");
    }
    Ok(json!({ "txId": request.tx_id, "rolledBack": true }))
}

#[tauri::command]
pub(crate) async fn aurora_local_data_repository_operation(
    app: AppHandle,
    state: State<'_, LocalDataCommandState>,
    request: LocalDataRepositoryRequest,
) -> Result<Value, AuroraCommandError> {
    let state_guard = state
        .inner
        .lock()
        .map_err(|_| local_data_error("local data state lock failed"))?;
    let (profile_id, local_node_id) = ensure_open_state(&state_guard)?;
    if let Some(tx_id) = request.tx_id {
        let conn = state_guard
            .transactions
            .get(&tx_id)
            .ok_or_else(|| local_data_error("transaction not found"))?;
        return run_repository_operation(conn, &profile_id, &local_node_id, request.operation);
    }
    drop(state_guard);
    let conn = SqliteConnection::open(local_data_db_path(&app)?)?;
    run_repository_operation(&conn, &profile_id, &local_node_id, request.operation)
}

#[tauri::command]
pub(crate) async fn aurora_local_data_export_v1(
    app: AppHandle,
    state: State<'_, LocalDataCommandState>,
) -> Result<Value, AuroraCommandError> {
    let state = state
        .inner
        .lock()
        .map_err(|_| local_data_error("local data state lock failed"))?;
    let (profile_id, local_node_id) = ensure_open_state(&state)?;
    let schema_version = state.schema_version.unwrap_or(0);
    drop(state);

    let conn = SqliteConnection::open(local_data_db_path(&app)?)?;
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
}

#[tauri::command]
pub(crate) async fn aurora_local_data_import_v1(
    app: AppHandle,
    state: State<'_, LocalDataCommandState>,
    request: LocalDataImportRequest,
) -> Result<Value, AuroraCommandError> {
    let state = state
        .inner
        .lock()
        .map_err(|_| local_data_error("local data state lock failed"))?;
    let (profile_id, local_node_id) = ensure_open_state(&state)?;
    drop(state);

    let document_profile = request
        .document
        .get("profileId")
        .and_then(Value::as_str)
        .ok_or_else(|| local_data_error("import profileId missing"))?;
    let document_node = request
        .document
        .get("localNodeId")
        .and_then(Value::as_str)
        .ok_or_else(|| local_data_error("import localNodeId missing"))?;
    if document_profile != profile_id || document_node != local_node_id {
        return Err(local_data_error("identity_mismatch"));
    }
    let records = request
        .document
        .get("records")
        .cloned()
        .ok_or_else(|| local_data_error("import records missing"))?;
    let conn = SqliteConnection::open(local_data_db_path(&app)?)?;
    conn.exec("BEGIN IMMEDIATE;")?;
    let result = import_records(&conn, &profile_id, &local_node_id, records);
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

fn run_repository_operation(
    conn: &SqliteConnection,
    profile_id: &str,
    local_node_id: &str,
    operation: LocalDataRepositoryOperation,
) -> Result<Value, AuroraCommandError> {
    match operation {
        LocalDataRepositoryOperation::ConversationsUpsertConversation { record } => {
            ensure_scope(
                profile_id,
                local_node_id,
                &record.profile_id,
                &record.local_node_id,
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
            let rows = conn.query(
                "SELECT id FROM aurora_conversations WHERE id = ? AND profile_id = ? AND local_node_id = ? LIMIT 1",
                &[json!(record.conversation_id), json!(profile_id), json!(local_node_id)],
            )?;
            if rows.is_empty() {
                return Err(local_data_error("conversation not found for identity"));
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
        LocalDataRepositoryOperation::ConversationsListConversations {
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
                "SELECT id, profile_id, local_node_id, title_envelope_json, created_at_ms, updated_at_ms, archived_at_ms
                 FROM aurora_conversations
                 WHERE profile_id = ? AND local_node_id = ?
                 ORDER BY updated_at_ms DESC, id ASC",
                &[json!(profile_id), json!(local_node_id)],
            )?.into_iter().map(conversation_from_row).collect::<Result<Vec<_>, _>>()?))
        }
        LocalDataRepositoryOperation::ConversationsListMessages {
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
            Ok(Value::Array(conn.query(
                "SELECT m.id, m.conversation_id, m.sequence, m.role, m.content_envelope_json, m.tool_envelope_json, m.status, m.created_at_ms
                 FROM aurora_messages m
                 INNER JOIN aurora_conversations c ON c.id = m.conversation_id
                 WHERE c.profile_id = ? AND c.local_node_id = ? AND m.conversation_id = ?
                 ORDER BY m.sequence ASC, m.id ASC",
                &[json!(profile_id), json!(local_node_id), json!(conversation_id)],
            )?.into_iter().map(message_from_row).collect::<Result<Vec<_>, _>>()?))
        }
        LocalDataRepositoryOperation::MemoryUpsertMemoryItem { record } => {
            ensure_scope(
                profile_id,
                local_node_id,
                &record.profile_id,
                &record.local_node_id,
            )?;
            conn.execute(
                "INSERT INTO aurora_memory_items (id, profile_id, local_node_id, namespace, payload_envelope_json, source_type, source_id, created_at_ms, updated_at_ms, expires_at_ms)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET namespace = excluded.namespace, payload_envelope_json = excluded.payload_envelope_json, source_type = excluded.source_type, source_id = excluded.source_id, updated_at_ms = excluded.updated_at_ms, expires_at_ms = excluded.expires_at_ms",
                &[json!(record.id), json!(record.profile_id), json!(record.local_node_id), json!(record.namespace), json_or_null(Some(record.payload_envelope))?, option_string(record.source_type), option_string(record.source_id), json!(record.created_at_ms), json!(record.updated_at_ms), option_i64(record.expires_at_ms)],
            )?;
            Ok(Value::Null)
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
            ensure_scope(
                profile_id,
                local_node_id,
                &record.profile_id,
                &record.local_node_id,
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
            ensure_scope(
                profile_id,
                local_node_id,
                &record.profile_id,
                &record.local_node_id,
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
    }
}

fn import_records(
    conn: &SqliteConnection,
    profile_id: &str,
    local_node_id: &str,
    records: Value,
) -> Result<Value, AuroraCommandError> {
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

    for record in records_array(&records, "conversations")? {
        let record: ConversationRecord = serde_json::from_value(record.clone())
            .map_err(|error| local_data_error(error.to_string()))?;
        run_repository_operation(
            conn,
            profile_id,
            local_node_id,
            LocalDataRepositoryOperation::ConversationsUpsertConversation { record },
        )?;
    }
    for record in records_array(&records, "messages")? {
        let record: ConversationMessageRecord = serde_json::from_value(record.clone())
            .map_err(|error| local_data_error(error.to_string()))?;
        run_repository_operation(
            conn,
            profile_id,
            local_node_id,
            LocalDataRepositoryOperation::ConversationsAppendMessage { record },
        )?;
    }
    for record in records_array(&records, "memoryItems")? {
        let record: LightweightMemoryRecord = serde_json::from_value(record.clone())
            .map_err(|error| local_data_error(error.to_string()))?;
        run_repository_operation(
            conn,
            profile_id,
            local_node_id,
            LocalDataRepositoryOperation::MemoryUpsertMemoryItem { record },
        )?;
    }
    for record in records_array(&records, "localToolStates")? {
        let record: LocalToolStateRecord = serde_json::from_value(record.clone())
            .map_err(|error| local_data_error(error.to_string()))?;
        run_repository_operation(
            conn,
            profile_id,
            local_node_id,
            LocalDataRepositoryOperation::LocalToolsUpsertLocalToolState { record },
        )?;
    }
    for record in records_array(&records, "peerGrantMetadata")? {
        let record: PeerGrantMetadataRecord = serde_json::from_value(record.clone())
            .map_err(|error| local_data_error(error.to_string()))?;
        run_repository_operation(
            conn,
            profile_id,
            local_node_id,
            LocalDataRepositoryOperation::PeerGrantsUpsertPeerGrant { record },
        )?;
    }
    for record in records_array(&records, "localAudit")? {
        let record: LocalAuditRecord = serde_json::from_value(record.clone())
            .map_err(|error| local_data_error(error.to_string()))?;
        run_repository_operation(
            conn,
            profile_id,
            local_node_id,
            LocalDataRepositoryOperation::LocalAuditAppendAudit { record },
        )?;
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
        "conversations": run_repository_operation(conn, profile_id, local_node_id, LocalDataRepositoryOperation::ConversationsListConversations { profile_id: profile_id.to_string(), local_node_id: local_node_id.to_string() })?,
        "messages": export_messages(conn, profile_id, local_node_id)?,
        "memoryItems": run_repository_operation(conn, profile_id, local_node_id, LocalDataRepositoryOperation::MemoryListMemoryItems { profile_id: profile_id.to_string(), local_node_id: local_node_id.to_string(), namespace: None })?,
        "localToolStates": run_repository_operation(conn, profile_id, local_node_id, LocalDataRepositoryOperation::LocalToolsListLocalToolStates { profile_id: profile_id.to_string(), local_node_id: local_node_id.to_string() })?,
        "peerGrantMetadata": run_repository_operation(conn, profile_id, local_node_id, LocalDataRepositoryOperation::PeerGrantsListPeerGrants { profile_id: profile_id.to_string(), local_node_id: local_node_id.to_string() })?,
        "localAudit": run_repository_operation(conn, profile_id, local_node_id, LocalDataRepositoryOperation::LocalAuditListAudit { profile_id: profile_id.to_string(), local_node_id: local_node_id.to_string() })?,
    }))
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
    let base = app
        .path()
        .app_config_dir()
        .map_err(|error| local_data_error(error.to_string()))?;
    std::fs::create_dir_all(&base).map_err(|error| local_data_error(error.to_string()))?;
    Ok(base.join(generated::local_data_migrations::LOCAL_DATA_DATABASE_NAME))
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
    }))
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

fn records_array<'a>(records: &'a Value, key: &str) -> Result<&'a Vec<Value>, AuroraCommandError> {
    records
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| local_data_error(format!("import {key} records missing")))
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
