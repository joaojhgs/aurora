//! C ABI for the Swift-owned iOS audio host and Rust voice session.
//!
//! The opaque session owns the Rust input/output queues. The audio state and
//! output pointers borrowed from it are valid only until the session is freed.

use aurora_voice_engine::PackTask;
use aurora_voice_ios_bridge::{AuroraIosAudioOutput, AuroraIosAudioState};
use aurora_voice_native::{
    GatewayAuth, IosVoicePackBinding, IosVoicePackBindings, IosVoiceSession,
    IosVoiceSessionCommandError, IosVoiceSessionConfig, IosVoiceSessionStatus,
};
use std::ffi::CStr;
use std::os::raw::c_char;
use url::Url;

pub const AURORA_IOS_VOICE_OK: i32 = 0;
pub const AURORA_IOS_VOICE_INVALID_ARGUMENT: i32 = -1;
pub const AURORA_IOS_VOICE_UNAVAILABLE: i32 = 1;
pub const AURORA_IOS_VOICE_ALREADY_ACTIVE: i32 = 2;
pub const AURORA_IOS_VOICE_NOT_ACTIVE: i32 = 3;
pub const AURORA_IOS_VOICE_CLOSED: i32 = 4;

#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AuroraIosVoiceSessionStatus {
    pub active: u32,
    pub phase: i64,
    pub has_generation: u32,
    pub generation: u64,
    pub completed_turns: u64,
    pub failed_turns: u64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuroraIosVoiceTaskPackBinding {
    /// 1=kws, 2=wakeword, 3=vad, 4=stt, 5=tts.
    pub task: i32,
    /// Optional NUL-terminated UTF-8 slot id. Null means the default slot.
    pub slot_id: *const c_char,
    /// Required NUL-terminated UTF-8 active pack path selected by Swift.
    pub pack_path: *const c_char,
}

/// # Safety
/// `value` must be null or point to a valid NUL-terminated UTF-8 string of at
/// most `max_bytes` bytes for the duration of the call.
unsafe fn bounded_string(value: *const c_char, max_bytes: usize) -> Option<String> {
    if value.is_null() {
        return None;
    }
    let bytes = unsafe { CStr::from_ptr(value) }.to_bytes();
    if bytes.is_empty() || bytes.len() > max_bytes {
        return None;
    }
    std::str::from_utf8(bytes).ok().map(ToOwned::to_owned)
}

fn command_error_code(error: IosVoiceSessionCommandError) -> i32 {
    match error {
        IosVoiceSessionCommandError::AlreadyActive => AURORA_IOS_VOICE_ALREADY_ACTIVE,
        IosVoiceSessionCommandError::NotActive => AURORA_IOS_VOICE_NOT_ACTIVE,
        IosVoiceSessionCommandError::Unavailable => AURORA_IOS_VOICE_UNAVAILABLE,
        IosVoiceSessionCommandError::Closed => AURORA_IOS_VOICE_CLOSED,
    }
}

fn status_payload(status: IosVoiceSessionStatus) -> AuroraIosVoiceSessionStatus {
    AuroraIosVoiceSessionStatus {
        active: u32::from(status.active),
        phase: status.phase as i64,
        has_generation: u32::from(status.generation.is_some()),
        generation: status.generation.map_or(0, |generation| generation.0),
        completed_turns: status.completed_turns,
        failed_turns: status.failed_turns,
    }
}

fn pack_task_from_abi(value: i32) -> Option<PackTask> {
    match value {
        1 => Some(PackTask::Kws),
        2 => Some(PackTask::Wakeword),
        3 => Some(PackTask::Vad),
        4 => Some(PackTask::Stt),
        5 => Some(PackTask::Tts),
        _ => None,
    }
}

/// # Safety
/// `bindings` must be null when `bindings_len` is zero, otherwise it must
/// point to `bindings_len` initialized [`AuroraIosVoiceTaskPackBinding`] items.
/// Each string pointer follows [`bounded_string`]'s UTF-8/NUL contract and is
/// copied before this function returns.
unsafe fn parse_pack_bindings(
    bindings: *const AuroraIosVoiceTaskPackBinding,
    bindings_len: usize,
) -> Option<IosVoicePackBindings> {
    if bindings_len == 0 {
        return Some(IosVoicePackBindings::default());
    }
    if bindings.is_null() {
        return None;
    }
    let raw = unsafe { std::slice::from_raw_parts(bindings, bindings_len) };
    let mut parsed = Vec::with_capacity(raw.len());
    for binding in raw {
        let task = pack_task_from_abi(binding.task)?;
        let slot_id =
            unsafe { bounded_string(binding.slot_id, 64) }.unwrap_or_else(|| "default".to_owned());
        let pack_path = unsafe { bounded_string(binding.pack_path, 4096) }?;
        parsed.push(IosVoicePackBinding::new(task, slot_id, pack_path).ok()?);
    }
    IosVoicePackBindings::new(parsed).ok()
}

/// # Safety
/// `gateway` and `bearer` must be null or valid NUL-terminated UTF-8 strings
/// for the duration of the call. Each string is copied and bounded to 4096
/// bytes; neither pointer is retained after this function returns.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_voice_session_new(
    gateway: *const c_char,
    bearer: *const c_char,
    remote_audio_consent: u32,
) -> *mut IosVoiceSession {
    let gateway =
        match unsafe { bounded_string(gateway, 4096) }.and_then(|value| Url::parse(&value).ok()) {
            Some(gateway) => gateway,
            None => return std::ptr::null_mut(),
        };
    let auth = match unsafe { bounded_string(bearer, 4096) } {
        Some(value) => GatewayAuth::Bearer(value),
        None => GatewayAuth::None,
    };
    let config = IosVoiceSessionConfig::new(gateway, auth, remote_audio_consent != 0);
    match IosVoiceSession::new_default(config) {
        Ok(session) => Box::into_raw(Box::new(session)),
        Err(_) => std::ptr::null_mut(),
    }
}

/// # Safety
/// `gateway`, `bearer`, and every string in `bindings` must be null or valid
/// NUL-terminated UTF-8 strings for the duration of this call. Strings are
/// copied and bounded; no pointer is retained after this function returns.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_voice_session_new_with_pack_bindings(
    gateway: *const c_char,
    bearer: *const c_char,
    remote_audio_consent: u32,
    bindings: *const AuroraIosVoiceTaskPackBinding,
    bindings_len: usize,
) -> *mut IosVoiceSession {
    let gateway =
        match unsafe { bounded_string(gateway, 4096) }.and_then(|value| Url::parse(&value).ok()) {
            Some(gateway) => gateway,
            None => return std::ptr::null_mut(),
        };
    let auth = match unsafe { bounded_string(bearer, 4096) } {
        Some(value) => GatewayAuth::Bearer(value),
        None => GatewayAuth::None,
    };
    let Some(pack_bindings) = (unsafe { parse_pack_bindings(bindings, bindings_len) }) else {
        return std::ptr::null_mut();
    };
    let config = IosVoiceSessionConfig::with_pack_bindings(
        gateway,
        auth,
        remote_audio_consent != 0,
        pack_bindings,
    );
    match IosVoiceSession::new_default(config) {
        Ok(session) => Box::into_raw(Box::new(session)),
        Err(_) => std::ptr::null_mut(),
    }
}

/// # Safety
/// `session` must be null or a pointer returned by
/// `aurora_ios_voice_session_new` that has not already been freed.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_voice_session_free(session: *mut IosVoiceSession) {
    if !session.is_null() {
        // SAFETY: the caller owns the allocation returned by `session_new`.
        unsafe { drop(Box::from_raw(session)) };
    }
}

/// # Safety
/// `session` must be null or a valid session pointer. The returned pointer is
/// borrowed and becomes invalid when `session` is freed.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_voice_session_audio_state(
    session: *mut IosVoiceSession,
) -> *mut AuroraIosAudioState {
    // SAFETY: the caller guarantees that a non-null pointer is valid.
    unsafe { session.as_ref() }.map_or(std::ptr::null_mut(), IosVoiceSession::audio_state_ptr)
}

/// # Safety
/// `session` must be null or a valid session pointer. The returned pointer is
/// borrowed and becomes invalid when `session` is freed.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_voice_session_output(
    session: *mut IosVoiceSession,
) -> *mut AuroraIosAudioOutput {
    // SAFETY: the caller guarantees that a non-null pointer is valid.
    unsafe { session.as_ref() }.map_or(std::ptr::null_mut(), IosVoiceSession::output_ptr)
}

/// # Safety
/// `session` and `out_generation` must be null or valid pointers for the
/// duration of this call.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_voice_session_start(
    session: *mut IosVoiceSession,
    out_generation: *mut u64,
) -> i32 {
    if session.is_null() || out_generation.is_null() {
        return AURORA_IOS_VOICE_INVALID_ARGUMENT;
    }
    // SAFETY: validated non-null pointers are valid by the ABI contract.
    let result = unsafe { &*session }.start();
    match result {
        Ok(generation) => {
            // SAFETY: validated caller-owned output pointer.
            unsafe { *out_generation = generation.0 };
            AURORA_IOS_VOICE_OK
        }
        Err(error) => command_error_code(error),
    }
}

/// # Safety
/// `session` and `out_generation` follow the same contract as
/// [`aurora_ios_voice_session_start`]. Background capture remains subject to
/// the session's explicit remote-audio consent and platform policy.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_voice_session_start_background(
    session: *mut IosVoiceSession,
    out_generation: *mut u64,
) -> i32 {
    if session.is_null() || out_generation.is_null() {
        return AURORA_IOS_VOICE_INVALID_ARGUMENT;
    }
    // SAFETY: validated non-null pointers are valid by the ABI contract.
    let result = unsafe { &*session }.start_background();
    match result {
        Ok(generation) => {
            // SAFETY: validated caller-owned output pointer.
            unsafe { *out_generation = generation.0 };
            AURORA_IOS_VOICE_OK
        }
        Err(error) => command_error_code(error),
    }
}

/// # Safety
/// `session` must be null or a valid session pointer.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_voice_session_finish(
    session: *mut IosVoiceSession,
    generation: u64,
) -> i32 {
    if session.is_null() {
        return AURORA_IOS_VOICE_INVALID_ARGUMENT;
    }
    // SAFETY: the caller guarantees that a non-null pointer is valid.
    unsafe { &*session }
        .finish(generation)
        .map_or_else(command_error_code, |_| AURORA_IOS_VOICE_OK)
}

/// # Safety
/// `session` must be null or a valid session pointer.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_voice_session_cancel(
    session: *mut IosVoiceSession,
    generation: u64,
) -> i32 {
    if session.is_null() {
        return AURORA_IOS_VOICE_INVALID_ARGUMENT;
    }
    // SAFETY: the caller guarantees that a non-null pointer is valid.
    unsafe { &*session }
        .cancel(generation)
        .map_or_else(command_error_code, |_| AURORA_IOS_VOICE_OK)
}

/// # Safety
/// `session` and `out_status` must be null or valid pointers for the duration
/// of this call.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_voice_session_status(
    session: *mut IosVoiceSession,
    out_status: *mut AuroraIosVoiceSessionStatus,
) -> i32 {
    if session.is_null() || out_status.is_null() {
        return AURORA_IOS_VOICE_INVALID_ARGUMENT;
    }
    // SAFETY: validated non-null pointers are valid by the ABI contract.
    let status = status_payload(unsafe { &*session }.status());
    // SAFETY: validated caller-owned output pointer.
    unsafe { *out_status = status };
    AURORA_IOS_VOICE_OK
}

/// # Safety
/// `session` must be null or a valid session pointer.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_voice_session_close(session: *mut IosVoiceSession) {
    if !session.is_null() {
        // SAFETY: the caller guarantees that a non-null pointer is valid.
        unsafe { &*session }.close();
    }
}
