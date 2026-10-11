//! Cactus Engine v1.14 backend for the existing serialized local-inference worker.
//!
//! This module binds only the v1.14 C ABI. It accepts only a model directory
//! resolved by the host beneath its app-private model root; callers never pass
//! an arbitrary path through completion requests.

use crate::{
    CompletionOptions, CompletionRequest, CompletionResult, LocalInferenceError,
    NativeInferenceBackend, ToolCall,
};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::ffi::{c_char, c_int, c_void, CString};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use zip::ZipArchive;

const MAX_REQUEST_BYTES: usize = 128 * 1024;
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_TOOL_COUNT: usize = 32;
const MAX_OUTPUT_TOKENS: u32 = 1024;
const MAX_IDENTIFIER_BYTES: usize = 128;
const MODEL_ID: &str = "chat-qwen3-06b-cactus";
const MODEL_ARCHIVE_BYTES: u64 = 376_414_357;
const MODEL_ARCHIVE_SHA256: &str =
    "2f4f5e3b91fc62168e66a592d09cfd1792a0b96e1994d46b5de77ddebbf94427";
const MAX_EXPANDED_BYTES: u64 = 450_000_000;
const MODEL_MANIFEST_SHA256: &str =
    "74db4d12f701eb434448d640597d6e5153ff0306f9ab658436b5eb0d99d8d483";
const MODEL_MANIFEST: &str = include_str!("../assets/qwen3-0.6b-int4.manifest.json");

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BundleManifest {
    format: u32,
    archive_sha256: String,
    archive_bytes: u64,
    expanded_bytes: u64,
    model_revision: String,
    files: Vec<BundleFile>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct BundleFile {
    path: String,
    bytes: u64,
    sha256: String,
}

type CactusTokenCallback = unsafe extern "C" fn(*const c_char, u32, *mut c_void);

unsafe extern "C" {
    fn cactus_init(
        model_path: *const c_char,
        corpus_dir: *const c_char,
        cache_index: bool,
    ) -> *mut c_void;
    fn cactus_destroy(model: *mut c_void);
    fn cactus_reset(model: *mut c_void);
    fn cactus_stop(model: *mut c_void);
    fn cactus_log_set_level(level: c_int);
    fn cactus_complete(
        model: *mut c_void,
        messages_json: *const c_char,
        response_buffer: *mut c_char,
        buffer_size: usize,
        options_json: *const c_char,
        tools_json: *const c_char,
        callback: Option<CactusTokenCallback>,
        user_data: *mut c_void,
        pcm_buffer: *const u8,
        pcm_buffer_size: usize,
    ) -> c_int;
}

struct ActiveCompletion {
    request_id: String,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
struct BackendState {
    model_id: Option<String>,
    model_handle: Option<usize>,
    model_path: Option<PathBuf>,
    active: Option<ActiveCompletion>,
}

/// Serialized owner for one Cactus model. The native handle is stored as an
/// integer so the Rust state remains `Send + Sync`; every native use is guarded
/// by the state protocol, while `cactus_stop` is the sole concurrent operation.
pub struct CactusBackend {
    app_private_root: PathBuf,
    state: Mutex<BackendState>,
    settled: Condvar,
}

impl CactusBackend {
    pub fn new(app_private_root: PathBuf) -> Self {
        Self {
            app_private_root,
            state: Mutex::new(BackendState::default()),
            settled: Condvar::new(),
        }
    }

    fn wait_until_idle<'a>(
        &'a self,
        mut state: std::sync::MutexGuard<'a, BackendState>,
        cancel_active: bool,
    ) -> Result<std::sync::MutexGuard<'a, BackendState>, LocalInferenceError> {
        if cancel_active {
            if let (Some(active), Some(handle)) = (state.active.as_ref(), state.model_handle) {
                active.cancelled.store(true, Ordering::Release);
                // v1.14 cactus_stop only stores CactusModelHandle::should_stop,
                // an std::atomic<bool>; it does not free or inspect model state.
                unsafe { cactus_stop(handle as *mut c_void) };
            }
        }
        while state.active.is_some() {
            state = self
                .settled
                .wait(state)
                .map_err(|_| LocalInferenceError::WorkerUnavailable)?;
        }
        Ok(state)
    }

    fn clear_active(&self, request_id: &str) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return true;
        };
        let Some(active) = state.active.as_ref() else {
            return false;
        };
        if active.request_id != request_id {
            return false;
        }
        let cancelled = active.cancelled.load(Ordering::Acquire);
        state.active = None;
        self.settled.notify_all();
        cancelled
    }
}

impl NativeInferenceBackend for CactusBackend {
    fn load(
        &self,
        model_id: &str,
        model_path: &Path,
        cache_path: &Path,
    ) -> Result<(), LocalInferenceError> {
        if model_id != MODEL_ID || model_id.len() > MAX_IDENTIFIER_BYTES {
            return Err(LocalInferenceError::InvalidRequest);
        }
        let root = self
            .app_private_root
            .canonicalize()
            .map_err(|_| LocalInferenceError::ModelUnverified)?;
        let archive = model_path
            .canonicalize()
            .map_err(|_| LocalInferenceError::ModelUnverified)?;
        if !archive.starts_with(&root) || !archive.is_file() {
            return Err(LocalInferenceError::ModelUnverified);
        }
        verify_model_archive(&archive)?;
        let cache = cache_path
            .canonicalize()
            .or_else(|_| {
                fs::create_dir_all(cache_path)?;
                cache_path.canonicalize()
            })
            .map_err(|_| LocalInferenceError::ModelUnverified)?;
        if !cache.starts_with(&root) || cache == root {
            return Err(LocalInferenceError::ModelUnverified);
        }
        let extracted = install_model_bundle(&archive, &cache)?;
        let path = extracted
            .canonicalize()
            .map_err(|_| LocalInferenceError::ModelUnverified)?;
        if !path.starts_with(&root) || !path.is_dir() {
            return Err(LocalInferenceError::ModelUnverified);
        }
        let path_string = path.to_str().ok_or(LocalInferenceError::ModelUnverified)?;
        let path_c = CString::new(path_string).map_err(|_| LocalInferenceError::ModelUnverified)?;

        let state = self
            .state
            .lock()
            .map_err(|_| LocalInferenceError::WorkerUnavailable)?;
        let mut state = self.wait_until_idle(state, true)?;
        if state.model_id.as_deref() == Some(model_id)
            && state.model_path.as_deref() == Some(path.as_path())
            && state.model_handle.is_some()
        {
            return Ok(());
        }
        if let Some(handle) = state.model_handle.take() {
            unsafe { cactus_destroy(handle as *mut c_void) };
        }
        state.model_id = None;
        state.model_path = None;

        // A null corpus and disabled index cache avoid RAG/index writes. The
        // runtime options below also hard-disable Cactus cloud handoff.
        // Suppress upstream diagnostic text because its messages may include
        // model paths or parser details. Level 4 is the pinned API's NONE.
        unsafe { cactus_log_set_level(4) };
        let handle = unsafe { cactus_init(path_c.as_ptr(), std::ptr::null(), false) };
        if handle.is_null() {
            return Err(LocalInferenceError::ModelUnavailable);
        }
        state.model_id = Some(model_id.to_owned());
        state.model_path = Some(path);
        state.model_handle = Some(handle as usize);
        Ok(())
    }

    fn complete(
        &self,
        request_id: &str,
        request_json: &str,
    ) -> Result<String, LocalInferenceError> {
        if request_id.is_empty()
            || request_id.len() > MAX_IDENTIFIER_BYTES
            || request_json.is_empty()
            || request_json.len() > MAX_REQUEST_BYTES
        {
            return Err(LocalInferenceError::InvalidRequest);
        }
        let request: CompletionRequest =
            serde_json::from_str(request_json).map_err(|_| LocalInferenceError::InvalidRequest)?;
        if request.model_id.is_empty()
            || request.model_id.len() > MAX_IDENTIFIER_BYTES
            || request.messages.is_empty()
            || request.messages.len() > 64
            || request.tools.len() > MAX_TOOL_COUNT
            || request
                .options
                .max_tokens
                .is_none_or(|n| n == 0 || n > MAX_OUTPUT_TOKENS)
            || request.options.force_tools == Some(true) && request.tools.is_empty()
        {
            return Err(LocalInferenceError::InvalidRequest);
        }
        let messages_json = serde_json::to_string(&request.messages)
            .map_err(|_| LocalInferenceError::InvalidRequest)?;
        let tools_json = if request.tools.is_empty() {
            None
        } else {
            Some(
                serde_json::to_string(&request.tools)
                    .map_err(|_| LocalInferenceError::InvalidRequest)?,
            )
        };
        let options_json = cactus_options(&request.options)?;
        let messages_c =
            CString::new(messages_json).map_err(|_| LocalInferenceError::InvalidRequest)?;
        let tools_c = tools_json
            .map(CString::new)
            .transpose()
            .map_err(|_| LocalInferenceError::InvalidRequest)?;
        let options_c =
            CString::new(options_json).map_err(|_| LocalInferenceError::InvalidRequest)?;

        let cancellation = Arc::new(AtomicBool::new(false));
        let handle = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| LocalInferenceError::WorkerUnavailable)?;
            if state.active.is_some() {
                return Err(LocalInferenceError::SessionBusy);
            }
            if state.model_id.as_deref() != Some(request.model_id.as_str()) {
                return Err(LocalInferenceError::SessionUnavailable);
            }
            let handle = state
                .model_handle
                .ok_or(LocalInferenceError::SessionUnavailable)?;
            state.active = Some(ActiveCompletion {
                request_id: request_id.to_owned(),
                cancelled: Arc::clone(&cancellation),
            });
            handle
        };
        let mut completion_guard = CompletionGuard {
            backend: self,
            request_id,
            settled: false,
        };
        let mut callback_context = CallbackContext {
            handle,
            cancelled: Arc::clone(&cancellation),
        };
        let mut response_buffer = vec![0u8; MAX_RESPONSE_BYTES];
        let status = unsafe {
            cactus_complete(
                handle as *mut c_void,
                messages_c.as_ptr(),
                response_buffer.as_mut_ptr().cast(),
                response_buffer.len(),
                options_c.as_ptr(),
                tools_c
                    .as_ref()
                    .map_or(std::ptr::null(), |value| value.as_ptr()),
                Some(cactus_cancel_callback),
                (&mut callback_context as *mut CallbackContext).cast(),
                std::ptr::null(),
                0,
            )
        };
        if status < 0 {
            let cancelled = completion_guard.settle();
            return if cancelled {
                Err(LocalInferenceError::Cancelled)
            } else {
                Err(LocalInferenceError::InferenceFailed)
            };
        }
        let nul = response_buffer
            .iter()
            .position(|byte| *byte == 0)
            .ok_or(LocalInferenceError::InferenceFailed)?;
        let response = std::str::from_utf8(&response_buffer[..nul])
            .map_err(|_| LocalInferenceError::InferenceFailed)?;
        let result = decode_cactus_response(response, &request)?;
        let cancelled = completion_guard.settle();
        if cancelled {
            return Err(LocalInferenceError::Cancelled);
        }
        serde_json::to_string(&result).map_err(|_| LocalInferenceError::InferenceFailed)
    }

    fn cancel(&self, request_id: &str) -> bool {
        let Ok(state) = self.state.lock() else {
            return false;
        };
        let Some(active) = state.active.as_ref() else {
            return false;
        };
        if active.request_id != request_id {
            return false;
        }
        active.cancelled.store(true, Ordering::Release);
        if let Some(handle) = state.model_handle {
            // The pinned Cactus implementation stores an atomic stop flag.
            // The callback also checks this Rust flag, covering cancel-before-
            // entry because cactus_complete resets its native flag on entry.
            unsafe { cactus_stop(handle as *mut c_void) };
        }
        true
    }

    fn reset(&self) -> Result<(), LocalInferenceError> {
        let state = self
            .state
            .lock()
            .map_err(|_| LocalInferenceError::WorkerUnavailable)?;
        let state = self.wait_until_idle(state, true)?;
        if let Some(handle) = state.model_handle {
            unsafe { cactus_reset(handle as *mut c_void) };
        }
        Ok(())
    }

    fn destroy(&self) -> Result<(), LocalInferenceError> {
        let state = self
            .state
            .lock()
            .map_err(|_| LocalInferenceError::WorkerUnavailable)?;
        let mut state = self.wait_until_idle(state, true)?;
        if let Some(handle) = state.model_handle.take() {
            unsafe { cactus_destroy(handle as *mut c_void) };
        }
        state.model_id = None;
        state.model_path = None;
        Ok(())
    }
}

fn manifest() -> Result<BundleManifest, LocalInferenceError> {
    let mut digest = Sha256::new();
    digest.update(MODEL_MANIFEST.as_bytes());
    if format!("{:x}", digest.finalize()) != MODEL_MANIFEST_SHA256 {
        return Err(LocalInferenceError::ModelUnverified);
    }
    let parsed: BundleManifest =
        serde_json::from_str(MODEL_MANIFEST).map_err(|_| LocalInferenceError::ModelUnverified)?;
    if parsed.format != 1
        || parsed.archive_sha256 != MODEL_ARCHIVE_SHA256
        || parsed.archive_bytes != MODEL_ARCHIVE_BYTES
        || parsed.model_revision != "595bcb02f28687ef00c9b5c1e04c5399e5af6bef"
        || parsed.files.len() != 317
    {
        return Err(LocalInferenceError::ModelUnverified);
    }
    let mut names = HashSet::new();
    let mut total = 0_u64;
    for file in &parsed.files {
        if file.path.is_empty()
            || file.path.contains('/')
            || file.path.contains('\\')
            || file.path == "."
            || file.path == ".."
            || file.bytes == 0
            || file.sha256.len() != 64
            || !file.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !names.insert(file.path.as_str())
        {
            return Err(LocalInferenceError::ModelUnverified);
        }
        total = total
            .checked_add(file.bytes)
            .ok_or(LocalInferenceError::ModelUnverified)?;
    }
    if total > MAX_EXPANDED_BYTES || total != parsed.expanded_bytes {
        return Err(LocalInferenceError::ModelUnverified);
    }
    Ok(parsed)
}

fn hash_reader(
    mut reader: impl Read,
    mut write: Option<&mut File>,
) -> Result<(u64, String), LocalInferenceError> {
    let mut digest = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|_| LocalInferenceError::ModelUnverified)?;
        if count == 0 {
            break;
        }
        bytes = bytes
            .checked_add(count as u64)
            .ok_or(LocalInferenceError::ModelUnverified)?;
        if bytes > MAX_EXPANDED_BYTES {
            return Err(LocalInferenceError::ModelUnverified);
        }
        digest.update(&buffer[..count]);
        if let Some(output) = write.as_deref_mut() {
            output
                .write_all(&buffer[..count])
                .map_err(|_| LocalInferenceError::ModelUnverified)?;
        }
    }
    Ok((bytes, format!("{:x}", digest.finalize())))
}

fn verify_model_archive(path: &Path) -> Result<(), LocalInferenceError> {
    let metadata = fs::metadata(path).map_err(|_| LocalInferenceError::ModelUnverified)?;
    if metadata.len() != MODEL_ARCHIVE_BYTES {
        return Err(LocalInferenceError::ModelUnverified);
    }
    let (_, digest) = hash_reader(
        File::open(path).map_err(|_| LocalInferenceError::ModelUnverified)?,
        None,
    )?;
    if digest != MODEL_ARCHIVE_SHA256 {
        return Err(LocalInferenceError::ModelUnverified);
    }
    Ok(())
}

fn verify_extracted_dir(path: &Path, expected: &BundleManifest) -> bool {
    let Ok(entries) = fs::read_dir(path) else {
        return false;
    };
    let mut actual = HashMap::new();
    for item in entries {
        let Ok(item) = item else {
            return false;
        };
        let Ok(meta) = fs::symlink_metadata(item.path()) else {
            return false;
        };
        if !meta.is_file()
            || actual
                .insert(item.file_name().to_string_lossy().into_owned(), item.path())
                .is_some()
        {
            return false;
        }
    }
    if actual.len() != expected.files.len() {
        return false;
    }
    for entry in &expected.files {
        let Some(file) = actual.get(&entry.path) else {
            return false;
        };
        let Ok(meta) = fs::metadata(file) else {
            return false;
        };
        if meta.len() != entry.bytes {
            return false;
        }
        let Ok((size, hash)) = File::open(file).and_then(|file| {
            hash_reader(file, None).map_err(|_| std::io::Error::other("verification failed"))
        }) else {
            return false;
        };
        if size != entry.bytes || hash != entry.sha256 {
            return false;
        }
    }
    true
}

fn install_model_bundle(archive_path: &Path, cache: &Path) -> Result<PathBuf, LocalInferenceError> {
    let manifest = manifest()?;
    let final_dir = cache.join("model");
    if fs::symlink_metadata(&final_dir).is_ok_and(|metadata| metadata.file_type().is_dir())
        && verify_extracted_dir(&final_dir, &manifest)
    {
        return Ok(final_dir);
    }
    let staging = cache.join(".model.staging");
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|_| LocalInferenceError::ModelUnverified)?;
    }
    fs::create_dir(&staging).map_err(|_| LocalInferenceError::ModelUnverified)?;
    let result = (|| {
        let file = File::open(archive_path).map_err(|_| LocalInferenceError::ModelUnverified)?;
        let mut zip = ZipArchive::new(file).map_err(|_| LocalInferenceError::ModelUnverified)?;
        if zip.len() != manifest.files.len() {
            return Err(LocalInferenceError::ModelUnverified);
        }
        let expected: HashMap<&str, &BundleFile> = manifest
            .files
            .iter()
            .map(|entry| (entry.path.as_str(), entry))
            .collect();
        let mut seen = HashSet::new();
        for index in 0..zip.len() {
            let mut entry = zip
                .by_index(index)
                .map_err(|_| LocalInferenceError::ModelUnverified)?;
            let name = entry.name().to_owned();
            let Some(spec) = expected.get(name.as_str()) else {
                return Err(LocalInferenceError::ModelUnverified);
            };
            if entry.is_dir()
                || entry.size() != spec.bytes
                || !seen.insert(name.clone())
                || entry.enclosed_name().as_deref() != Some(Path::new(&name))
                || entry
                    .unix_mode()
                    .is_some_and(|mode| mode & 0o170000 == 0o120000)
            {
                return Err(LocalInferenceError::ModelUnverified);
            }
            let target = staging.join(&name);
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .map_err(|_| LocalInferenceError::ModelUnverified)?;
            let (size, digest) = hash_reader(&mut entry, Some(&mut output))?;
            if size != spec.bytes || digest != spec.sha256 {
                return Err(LocalInferenceError::ModelUnverified);
            }
            output
                .sync_all()
                .map_err(|_| LocalInferenceError::ModelUnverified)?;
        }
        if seen.len() != manifest.files.len() {
            return Err(LocalInferenceError::ModelUnverified);
        }
        if final_dir.exists() {
            fs::remove_dir_all(&final_dir).map_err(|_| LocalInferenceError::ModelUnverified)?;
        }
        fs::rename(&staging, &final_dir).map_err(|_| LocalInferenceError::ModelUnverified)?;
        Ok(final_dir.clone())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

impl Drop for CactusBackend {
    fn drop(&mut self) {
        let Ok(state) = self.state.get_mut() else {
            return;
        };
        if let Some(handle) = state.model_handle.take() {
            unsafe { cactus_destroy(handle as *mut c_void) };
        }
    }
}

struct CallbackContext {
    handle: usize,
    cancelled: Arc<AtomicBool>,
}

unsafe extern "C" fn cactus_cancel_callback(
    _token: *const c_char,
    _token_id: u32,
    user_data: *mut c_void,
) {
    if user_data.is_null() {
        return;
    }
    let context = unsafe { &*(user_data.cast::<CallbackContext>()) };
    if context.cancelled.load(Ordering::Acquire) {
        // Safe for this cross-thread callback: the exact pinned implementation
        // writes only its std::atomic<bool> stop field here.
        unsafe { cactus_stop(context.handle as *mut c_void) };
    }
}

struct CompletionGuard<'a> {
    backend: &'a CactusBackend,
    request_id: &'a str,
    settled: bool,
}

impl CompletionGuard<'_> {
    fn settle(&mut self) -> bool {
        self.settled = true;
        self.backend.clear_active(self.request_id)
    }
}

impl Drop for CompletionGuard<'_> {
    fn drop(&mut self) {
        if !self.settled {
            self.backend.clear_active(self.request_id);
        }
    }
}

fn cactus_options(options: &CompletionOptions) -> Result<String, LocalInferenceError> {
    let max_tokens = options
        .max_tokens
        .filter(|value| *value > 0 && *value <= MAX_OUTPUT_TOKENS)
        .ok_or(LocalInferenceError::InvalidRequest)?;
    let temperature = options.temperature.unwrap_or(0.0);
    if !temperature.is_finite() || !(0.0..=2.0).contains(&temperature) {
        return Err(LocalInferenceError::InvalidRequest);
    }
    let mut json = Map::new();
    json.insert("max_tokens".into(), json!(max_tokens));
    json.insert("temperature".into(), json!(temperature));
    json.insert(
        "force_tools".into(),
        json!(options.force_tools.unwrap_or(false)),
    );
    json.insert(
        "tool_rag_top_k".into(),
        json!(options
            .tool_rag_top_k
            .unwrap_or(0)
            .min(MAX_TOOL_COUNT as u32)),
    );
    json.insert(
        "stop_sequences".into(),
        json!(options.stop_sequences.as_deref().unwrap_or_default()),
    );
    json.insert("auto_handoff".into(), json!(false));
    serde_json::to_string(&json).map_err(|_| LocalInferenceError::InvalidRequest)
}

fn decode_cactus_response(
    response: &str,
    request: &CompletionRequest,
) -> Result<CompletionResult, LocalInferenceError> {
    if response.len() > MAX_RESPONSE_BYTES {
        return Err(LocalInferenceError::InferenceFailed);
    }
    let value: Value =
        serde_json::from_str(response).map_err(|_| LocalInferenceError::InferenceFailed)?;
    if value.get("success").and_then(Value::as_bool) != Some(true)
        || value.get("cloud_handoff").and_then(Value::as_bool) != Some(false)
    {
        return Err(LocalInferenceError::InferenceFailed);
    }
    let content = value
        .get("response")
        .and_then(Value::as_str)
        .ok_or(LocalInferenceError::InferenceFailed)?
        .to_owned();
    let function_calls = value
        .get("function_calls")
        .and_then(Value::as_array)
        .ok_or(LocalInferenceError::InferenceFailed)?;
    if function_calls.is_empty() {
        if content.is_empty() {
            return Err(LocalInferenceError::InferenceFailed);
        }
        return Ok(CompletionResult::Message { content });
    }
    if request.tools.is_empty() || function_calls.len() > MAX_TOOL_COUNT {
        return Err(LocalInferenceError::InferenceFailed);
    }
    let mut tool_calls = Vec::with_capacity(function_calls.len());
    for call in function_calls {
        let name = call
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| name.len() <= MAX_IDENTIFIER_BYTES)
            .ok_or(LocalInferenceError::InferenceFailed)?;
        let arguments = call
            .get("arguments")
            .filter(|arguments| arguments.is_object())
            .cloned()
            .ok_or(LocalInferenceError::InferenceFailed)?;
        if !request.tools.iter().any(|tool| tool.function.name == name) {
            return Err(LocalInferenceError::InferenceFailed);
        }
        tool_calls.push(ToolCall {
            name: name.to_owned(),
            arguments,
        });
    }
    Ok(CompletionResult::ToolCalls {
        content,
        tool_calls,
    })
}
