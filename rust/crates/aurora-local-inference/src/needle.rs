//! Narrow first-turn adapter for the pinned Cactus Compute Needle2 ABI.
//!
//! Needle2 exposes a process-global conversation, not a model/session handle.
//! This adapter serializes every FFI call and accepts one initial user request.
//! After one matched tool result, it returns an empty terminal message so the
//! existing SDK tool-result summarizer can report the actual action result; it
//! does not replay history through Needle. It cannot interrupt inference or
//! unload a loaded model through the published ABI.

#![cfg(all(
    feature = "native-needle2",
    target_os = "android",
    target_arch = "aarch64"
))]

use crate::{
    ChatMessage, CompletionRequest, CompletionResult, FunctionTool, LocalInferenceError,
    NativeInferenceBackend, ToolCall, MAX_MODEL_BYTES, MAX_OUTPUT_TOKENS,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    ffi::{c_char, c_int, CString},
    fs,
    path::Path,
    ptr,
    sync::{Mutex, OnceLock},
};

const MAX_TOOL_COUNT: usize = 5;
const MAX_OUTPUT_BYTES: usize = 64 * 1024;
const NEEDLE2_MODEL_ID: &str = "actions-needle2";
const NEEDLE2_MODEL_BYTES: u64 = 13_737_807;
const NEEDLE2_MODEL_SHA256: &str =
    "b43aabfcaf1a6db6acf488076eab71d823c08697c7af4521fc1d174b60ede5ba";

#[link(name = "needle", kind = "static")]
unsafe extern "C" {
    fn needle_load(cact: *const u8, length: u64) -> c_int;
    fn needle_init(
        system_prompt: *const c_char,
        tools_json: *const c_char,
        tool_index_path: *const c_char,
    ) -> c_int;
    fn needle_complete(
        input: *const c_char,
        max_new_tokens: c_int,
        out: *mut c_char,
        out_capacity: c_int,
    ) -> c_int;
    fn needle_reset();
}

struct NeedleState {
    model_id: Option<String>,
    // The published C ABI does not document whether needle_load copies bytes.
    // Retain them for process lifetime so a borrowed native pointer stays valid.
    retained_model_bytes: Option<Vec<u8>>,
    active_session_id: Option<String>,
    poisoned: bool,
}

impl Default for NeedleState {
    fn default() -> Self {
        Self {
            model_id: None,
            retained_model_bytes: None,
            active_session_id: None,
            poisoned: false,
        }
    }
}

fn state() -> &'static Mutex<NeedleState> {
    static STATE: OnceLock<Mutex<NeedleState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(NeedleState::default()))
}

/// Needle2 is a process-global, first-turn tool proposer over one pinned model.
pub struct Needle2Backend;

impl NativeInferenceBackend for Needle2Backend {
    fn load(
        &self,
        model_id: &str,
        model_path: &Path,
        _cache_path: &Path,
    ) -> Result<(), LocalInferenceError> {
        if model_id != NEEDLE2_MODEL_ID
            || model_path.extension().and_then(|ext| ext.to_str()) != Some("cact")
        {
            return Err(LocalInferenceError::ModelUnavailable);
        }
        let mut state = state()
            .lock()
            .map_err(|_| LocalInferenceError::WorkerUnavailable)?;
        if state.poisoned {
            return Err(LocalInferenceError::WorkerUnavailable);
        }
        if let Some(loaded_model_id) = state.model_id.as_deref() {
            if loaded_model_id != model_id {
                // No unload/release operation is present in needle.h.
                return Err(LocalInferenceError::ModelUnavailable);
            }
            unsafe { needle_reset() };
            state.active_session_id = None;
            return Ok(());
        }

        let metadata =
            fs::symlink_metadata(model_path).map_err(|_| LocalInferenceError::ModelUnavailable)?;
        if !metadata.file_type().is_file()
            || metadata.len() == 0
            || metadata.len() > MAX_MODEL_BYTES
        {
            return Err(LocalInferenceError::ModelUnverified);
        }
        let bytes = fs::read(model_path).map_err(|_| LocalInferenceError::ModelUnavailable)?;
        if bytes.is_empty()
            || bytes.len() as u64 != metadata.len()
            || bytes.len() as u64 > MAX_MODEL_BYTES
            || bytes.len() as u64 != NEEDLE2_MODEL_BYTES
            || format!("{:x}", Sha256::digest(&bytes)) != NEEDLE2_MODEL_SHA256
        {
            return Err(LocalInferenceError::ModelUnverified);
        }

        state.retained_model_bytes = Some(bytes);
        let retained = state
            .retained_model_bytes
            .as_ref()
            .ok_or(LocalInferenceError::WorkerUnavailable)?;
        let status = unsafe { needle_load(retained.as_ptr(), retained.len() as u64) };
        if status != 0 {
            // The API has no unload/rollback operation; don't retry after a
            // possibly partial global load in this process.
            state.poisoned = true;
            return Err(LocalInferenceError::ModelUnavailable);
        }
        state.model_id = Some(model_id.to_owned());
        state.active_session_id = None;
        Ok(())
    }

    fn complete(
        &self,
        _request_id: &str,
        request_json: &str,
    ) -> Result<String, LocalInferenceError> {
        let request: CompletionRequest =
            serde_json::from_str(request_json).map_err(|_| LocalInferenceError::InvalidRequest)?;
        if is_single_tool_result_continuation(&request)? {
            let state = state()
                .lock()
                .map_err(|_| LocalInferenceError::WorkerUnavailable)?;
            if state.poisoned {
                return Err(LocalInferenceError::WorkerUnavailable);
            }
            if state.model_id.as_deref() != Some(request.model_id.as_str())
                || state.active_session_id.as_deref() != Some(request.session_id.as_str())
            {
                return Err(LocalInferenceError::SessionUnavailable);
            }
            // The SDK recognizes an empty message as the terminal action result
            // and summarizes the actual tool-result message in the request.
            // Needle itself is not called again and no answer is synthesized.
            return serde_json::to_string(&CompletionResult::Message {
                content: String::new(),
            })
            .map_err(|_| LocalInferenceError::InferenceFailed);
        }
        validate_needle_request(&request)?;
        let system_prompt = initial_system_prompt(&request.messages)?;
        let user_prompt = initial_user_prompt(&request.messages)?;
        let tools_json = serde_json::to_string(&request.tools)
            .map_err(|_| LocalInferenceError::InvalidRequest)?;
        let system_c = system_prompt
            .map(CString::new)
            .transpose()
            .map_err(|_| LocalInferenceError::InvalidRequest)?;
        let tools_c = CString::new(tools_json).map_err(|_| LocalInferenceError::InvalidRequest)?;
        let user_c = CString::new(user_prompt).map_err(|_| LocalInferenceError::InvalidRequest)?;
        let max_tokens = request
            .options
            .max_tokens
            .unwrap_or(128)
            .min(MAX_OUTPUT_TOKENS);
        if max_tokens == 0 {
            return Err(LocalInferenceError::InvalidRequest);
        }
        let max_tokens =
            c_int::try_from(max_tokens).map_err(|_| LocalInferenceError::InvalidRequest)?;
        let capacity = c_int::try_from(MAX_OUTPUT_BYTES)
            .map_err(|_| LocalInferenceError::WorkerUnavailable)?;

        let mut state = state()
            .lock()
            .map_err(|_| LocalInferenceError::WorkerUnavailable)?;
        if state.poisoned {
            return Err(LocalInferenceError::WorkerUnavailable);
        }
        if state.model_id.as_deref() != Some(request.model_id.as_str()) {
            return Err(LocalInferenceError::ModelUnavailable);
        }
        if state
            .active_session_id
            .as_deref()
            .is_some_and(|id| id != request.session_id.as_str())
        {
            return Err(LocalInferenceError::SessionUnavailable);
        }
        state.active_session_id = Some(request.session_id.clone());

        // The C API retains one process-global conversation. Re-initialize and
        // reject carried history, so no other Aurora session can inherit it.
        unsafe { needle_reset() };
        let init_status = unsafe {
            needle_init(
                system_c
                    .as_ref()
                    .map_or(ptr::null(), |value| value.as_ptr()),
                tools_c.as_ptr(),
                ptr::null(),
            )
        };
        if init_status < 0 {
            unsafe { needle_reset() };
            state.poisoned = true;
            return Err(LocalInferenceError::InferenceFailed);
        }

        // Fill with nonzero bytes; the trailing NUL is reserved. A native
        // response without an in-buffer terminator is rejected below.
        let mut output = vec![1 as c_char; MAX_OUTPUT_BYTES];
        output[MAX_OUTPUT_BYTES - 1] = 0;
        let complete_status =
            unsafe { needle_complete(user_c.as_ptr(), max_tokens, output.as_mut_ptr(), capacity) };
        let response = if complete_status < 0 {
            state.poisoned = true;
            Err(LocalInferenceError::InferenceFailed)
        } else {
            let response = c_buffer_string(&output);
            if response.is_err() {
                state.poisoned = true;
            }
            response
        };
        unsafe { needle_reset() };
        let response = response?;
        let result = map_needle_response(&response, &request.tools)?;
        serde_json::to_string(&result).map_err(|_| LocalInferenceError::InferenceFailed)
    }

    fn cancel(&self, _request_id: &str) -> bool {
        // needle.h has no stop/cancel symbol, so never report cancellation.
        false
    }

    fn reset(&self) -> Result<(), LocalInferenceError> {
        let mut state = state()
            .lock()
            .map_err(|_| LocalInferenceError::WorkerUnavailable)?;
        if state.poisoned || state.model_id.is_none() {
            return Err(LocalInferenceError::WorkerUnavailable);
        }
        unsafe { needle_reset() };
        state.active_session_id = None;
        Ok(())
    }

    fn destroy(&self) -> Result<(), LocalInferenceError> {
        // Reset conversation memory; model bytes and native allocation remain
        // process-owned because the upstream API has no destroy/unload call.
        self.reset()
    }
}

fn validate_needle_request(request: &CompletionRequest) -> Result<(), LocalInferenceError> {
    validate_needle_tools(request)?;
    // The production provider supplies temperature=0.2 and forceTools=false
    // by default. Needle's pinned C ABI exposes no temperature control, so only
    // accept that default (or omission) and never claim it was applied.
    if request
        .options
        .temperature
        .is_some_and(|value| value != 0.2)
        || request.options.stop_sequences.is_some()
        || request.options.tool_rag_top_k.is_some()
    {
        return Err(LocalInferenceError::InvalidRequest);
    }
    Ok(())
}

fn validate_needle_tools(request: &CompletionRequest) -> Result<(), LocalInferenceError> {
    if request.tools.is_empty() || request.tools.len() > MAX_TOOL_COUNT {
        return Err(LocalInferenceError::InvalidRequest);
    }
    for tool in &request.tools {
        if tool.r#type != "function" {
            return Err(LocalInferenceError::InvalidRequest);
        }
    }
    Ok(())
}

/// Accept exactly the existing one-tool confirmation continuation shape.
/// The SDK will derive the user-facing completion from this real tool result;
/// arbitrary history, multi-tool turns, and Needle transcript replay stay out.
fn is_single_tool_result_continuation(
    request: &CompletionRequest,
) -> Result<bool, LocalInferenceError> {
    validate_needle_tools(request)?;
    if request
        .options
        .temperature
        .is_some_and(|value| value != 0.2)
        || request.options.stop_sequences.is_some()
        || request.options.tool_rag_top_k.is_some()
        || request.messages.len() < 3
        || request.messages.len() > 4
    {
        return Ok(false);
    }
    let offset = if request.messages.len() == 4 {
        if request.messages[0].role != "system" {
            return Ok(false);
        }
        1
    } else {
        0
    };
    let [user, assistant, tool_result] = &request.messages[offset..] else {
        return Ok(false);
    };
    if user.role != "user"
        || user.content.trim().is_empty()
        || assistant.role != "assistant"
        || !assistant.content.is_empty()
        || tool_result.role != "tool"
        || assistant
            .tool_calls
            .as_ref()
            .is_none_or(|calls| calls.len() != 1)
    {
        return Ok(false);
    }
    let Some(calls) = assistant.tool_calls.as_ref() else {
        return Ok(false);
    };
    let call = &calls[0];
    let call_id = call.get("id").and_then(Value::as_str);
    let function = call.get("function");
    let name = function
        .and_then(|value| value.get("name"))
        .and_then(Value::as_str);
    let arguments = function
        .and_then(|value| value.get("arguments"))
        .and_then(Value::as_str);
    if call.get("type").and_then(Value::as_str) != Some("function")
        || call_id.is_none_or(str::is_empty)
        || name.is_none_or(str::is_empty)
        || arguments.is_none_or(str::is_empty)
        || tool_result.tool_call_id.as_deref() != call_id
        || tool_result.name.as_deref() != name
        || !request
            .tools
            .iter()
            .any(|tool| tool.function.name == name.unwrap_or_default())
    {
        return Ok(false);
    }
    let parsed_arguments: Value = serde_json::from_str(arguments.unwrap_or_default())
        .map_err(|_| LocalInferenceError::InvalidRequest)?;
    if !parsed_arguments.is_object() {
        return Err(LocalInferenceError::InvalidRequest);
    }
    let result: Value = serde_json::from_str(&tool_result.content)
        .map_err(|_| LocalInferenceError::InvalidRequest)?;
    if result.get("ok").and_then(Value::as_bool).is_none()
        || result.get("secretsRedacted").and_then(Value::as_bool) != Some(true)
    {
        return Err(LocalInferenceError::InvalidRequest);
    }
    Ok(true)
}

fn initial_system_prompt(messages: &[ChatMessage]) -> Result<Option<String>, LocalInferenceError> {
    match messages {
        [ChatMessage { role, content, .. }, ChatMessage {
            role: user_role, ..
        }] if role == "system" && user_role == "user" => Ok(Some(content.clone())),
        [ChatMessage { role, .. }] if role == "user" => Ok(None),
        _ => Err(LocalInferenceError::InvalidRequest),
    }
}

fn initial_user_prompt(messages: &[ChatMessage]) -> Result<String, LocalInferenceError> {
    match messages.last() {
        Some(ChatMessage { role, content, .. }) if role == "user" && !content.trim().is_empty() => {
            Ok(content.clone())
        }
        _ => Err(LocalInferenceError::InvalidRequest),
    }
}

fn c_buffer_string(output: &[c_char]) -> Result<String, LocalInferenceError> {
    let end = output
        .iter()
        .position(|byte| *byte == 0)
        .ok_or(LocalInferenceError::InferenceFailed)?;
    let bytes: Vec<u8> = output[..end].iter().map(|byte| *byte as u8).collect();
    String::from_utf8(bytes).map_err(|_| LocalInferenceError::InferenceFailed)
}

fn map_needle_response(
    response: &str,
    tools: &[FunctionTool],
) -> Result<CompletionResult, LocalInferenceError> {
    let value: Value =
        serde_json::from_str(response).map_err(|_| LocalInferenceError::InferenceFailed)?;
    if value.get("success").and_then(Value::as_bool) != Some(true)
        || value.get("type").and_then(Value::as_str) != Some("call")
    {
        // Needle's documented terminal `respond` carries no free-form answer.
        return Err(LocalInferenceError::InferenceFailed);
    }
    let tool_calls = value
        .get("function_calls")
        .and_then(Value::as_array)
        .ok_or(LocalInferenceError::InferenceFailed)?
        .iter()
        .map(|call| {
            let name = call
                .get("name")
                .and_then(Value::as_str)
                .ok_or(LocalInferenceError::InferenceFailed)?;
            let arguments = call
                .get("arguments")
                .filter(|value| value.is_object())
                .cloned()
                .ok_or(LocalInferenceError::InferenceFailed)?;
            if !tools.iter().any(|tool| tool.function.name == name) {
                return Err(LocalInferenceError::InferenceFailed);
            }
            Ok(ToolCall {
                name: name.to_owned(),
                arguments,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(CompletionResult::ToolCalls {
        content: String::new(),
        tool_calls,
    })
}
