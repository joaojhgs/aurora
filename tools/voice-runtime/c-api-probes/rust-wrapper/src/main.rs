use std::env;
use std::ffi::{CStr, CString, NulError};
use std::os::raw::{c_char, c_float, c_int};
use std::path::{Path, PathBuf};
use std::ptr::NonNull;

const ARTIFACT_ROOT_ENV: &str = "AURORA_VOICE_P4_ARTIFACT_ROOT";
const MOONSHINE_NAME: &str = "sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27";
const TTS_NAME: &str = "vits-piper-en_US-ljspeech-medium";

#[repr(C)]
struct RawProbeResult {
    ok: c_int,
    mode: *mut c_char,
    reason: *mut c_char,
    text: *mut c_char,
    sample_rate: c_int,
    input_samples: c_int,
    audio_samples: c_int,
    num_speakers: c_int,
    callback_calls: c_int,
    callback_samples: c_int,
    last_callback_samples: c_int,
    last_progress: c_float,
}

unsafe extern "C" {
    fn aurora_sherpa_probe_stt(moonshine_dir: *const c_char) -> *mut RawProbeResult;
    fn aurora_sherpa_probe_tts_cancel(
        tts_dir: *const c_char,
        text: *const c_char,
        stop_after: c_int,
    ) -> *mut RawProbeResult;
    fn aurora_sherpa_probe_free_result(result: *mut RawProbeResult);
}

struct ProbeHandle {
    ptr: NonNull<RawProbeResult>,
}

impl ProbeHandle {
    fn from_raw(ptr: *mut RawProbeResult) -> Result<Self, String> {
        NonNull::new(ptr)
            .map(|ptr| Self { ptr })
            .ok_or_else(|| "probe returned a null result pointer".to_string())
    }

    fn snapshot(&self) -> ProbeSnapshot {
        let raw = unsafe { self.ptr.as_ref() };
        ProbeSnapshot {
            ok: raw.ok != 0,
            mode: owned_c_string(raw.mode),
            reason: owned_c_string(raw.reason),
            text: owned_c_string(raw.text),
            sample_rate: raw.sample_rate,
            input_samples: raw.input_samples,
            audio_samples: raw.audio_samples,
            num_speakers: raw.num_speakers,
            callback_calls: raw.callback_calls,
            callback_samples: raw.callback_samples,
            last_callback_samples: raw.last_callback_samples,
            last_progress: raw.last_progress,
        }
    }
}

impl Drop for ProbeHandle {
    fn drop(&mut self) {
        unsafe {
            aurora_sherpa_probe_free_result(self.ptr.as_ptr());
        }
    }
}

struct ProbeSnapshot {
    ok: bool,
    mode: String,
    reason: String,
    text: String,
    sample_rate: c_int,
    input_samples: c_int,
    audio_samples: c_int,
    num_speakers: c_int,
    callback_calls: c_int,
    callback_samples: c_int,
    last_callback_samples: c_int,
    last_progress: c_float,
}

fn owned_c_string(ptr: *const c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    unsafe { CStr::from_ptr(ptr) }
        .to_string_lossy()
        .into_owned()
}

fn c_string_path(path: &Path) -> Result<CString, NulError> {
    CString::new(path.to_string_lossy().as_bytes())
}

fn run_stt(moonshine_dir: &Path) -> Result<ProbeSnapshot, String> {
    let moonshine_dir = c_string_path(moonshine_dir).map_err(|err| err.to_string())?;
    let handle = ProbeHandle::from_raw(unsafe { aurora_sherpa_probe_stt(moonshine_dir.as_ptr()) })?;
    Ok(handle.snapshot())
}

fn run_tts_cancel(tts_dir: &Path, text: &str) -> Result<ProbeSnapshot, String> {
    let tts_dir = c_string_path(tts_dir).map_err(|err| err.to_string())?;
    let text = CString::new(text).map_err(|err| err.to_string())?;
    let handle = ProbeHandle::from_raw(unsafe {
        aurora_sherpa_probe_tts_cancel(tts_dir.as_ptr(), text.as_ptr(), 1)
    })?;
    Ok(handle.snapshot())
}

fn parse_artifact_root() -> Result<PathBuf, String> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    match args.as_slice() {
        [flag, value] if flag == "--artifact-root" => return Ok(PathBuf::from(value)),
        [flag] if flag == "--artifact-root" => {
            return Err("--artifact-root requires a value".to_string());
        }
        [arg, ..] => return Err(format!("unknown argument: {arg}")),
        [] => {}
    }

    env::var_os(ARTIFACT_ROOT_ENV)
        .map(PathBuf::from)
        .ok_or_else(|| format!("missing --artifact-root or {ARTIFACT_ROOT_ENV}"))
}

fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if ch < ' ' => out.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

fn snapshot_json(snapshot: &ProbeSnapshot) -> String {
    format!(
        "{{\"ok\":{},\"mode\":{},\"reason\":{},\"text\":{},\"sample_rate\":{},\"input_samples\":{},\"audio_samples\":{},\"num_speakers\":{},\"callback_calls\":{},\"callback_samples\":{},\"last_callback_samples\":{},\"last_progress\":{:.6}}}",
        snapshot.ok,
        json_string(&snapshot.mode),
        json_string(&snapshot.reason),
        json_string(&snapshot.text),
        snapshot.sample_rate,
        snapshot.input_samples,
        snapshot.audio_samples,
        snapshot.num_speakers,
        snapshot.callback_calls,
        snapshot.callback_samples,
        snapshot.last_callback_samples,
        snapshot.last_progress
    )
}

fn main() {
    let artifact_root = match parse_artifact_root() {
        Ok(path) => path,
        Err(reason) => {
            eprintln!(
                "{{\"ok\":false,\"stage\":\"setup\",\"reason\":{}}}",
                json_string(&reason)
            );
            std::process::exit(2);
        }
    };

    let models_dir = artifact_root.join("models/extracted");
    let moonshine_dir = models_dir.join(MOONSHINE_NAME);
    let tts_dir = models_dir.join(TTS_NAME);

    let stt = run_stt(&moonshine_dir).unwrap_or_else(|reason| ProbeSnapshot {
        ok: false,
        mode: "rust_stt".to_string(),
        reason,
        text: String::new(),
        sample_rate: 0,
        input_samples: 0,
        audio_samples: 0,
        num_speakers: 0,
        callback_calls: 0,
        callback_samples: 0,
        last_callback_samples: 0,
        last_progress: 0.0,
    });
    let tts_cancel =
        run_tts_cancel(&tts_dir, "Aurora local voice probe.").unwrap_or_else(|reason| {
            ProbeSnapshot {
                ok: false,
                mode: "rust_tts_cancel".to_string(),
                reason,
                text: String::new(),
                sample_rate: 0,
                input_samples: 0,
                audio_samples: 0,
                num_speakers: 0,
                callback_calls: 0,
                callback_samples: 0,
                last_callback_samples: 0,
                last_progress: 0.0,
            }
        });

    let ok = stt.ok && tts_cancel.ok && tts_cancel.callback_calls > 0;
    println!(
        "{{\"ok\":{},\"modes\":[{},{}]}}",
        ok,
        snapshot_json(&stt),
        snapshot_json(&tts_cancel)
    );
    std::process::exit(if ok { 0 } else { 1 });
}
