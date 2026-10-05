use async_trait::async_trait;
use aurora_contracts::ids;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use aurora_voice_native::{
    transcription_audio_chunk_payload, MeshSpeechError, NativeMeshSpeechCallTransport,
    NativeMeshSpeechCancel, NativeMeshSpeechProvider, NativeMeshSpeechRequest,
};
use serde_json::{json, Value};
use std::collections::VecDeque;

struct RecordingTransport {
    responses: VecDeque<Result<Value, MeshSpeechError>>,
    calls: Vec<NativeMeshSpeechRequest>,
    cancels: Vec<NativeMeshSpeechCancel>,
}

struct SlowTransport {
    cancels: Vec<NativeMeshSpeechCancel>,
}

struct AdmittedTimeoutTransport {
    first_response: Option<Value>,
    cancels: Vec<NativeMeshSpeechCancel>,
}

struct FailingCancelTransport {
    responses: VecDeque<Result<Value, MeshSpeechError>>,
    cancels: Vec<NativeMeshSpeechCancel>,
}

#[async_trait(?Send)]
impl NativeMeshSpeechCallTransport for SlowTransport {
    async fn call(&mut self, _request: NativeMeshSpeechRequest) -> Result<Value, MeshSpeechError> {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        Err(MeshSpeechError::Transport)
    }

    async fn cancel(&mut self, request: NativeMeshSpeechCancel) -> Result<(), MeshSpeechError> {
        self.cancels.push(request);
        Ok(())
    }
}

#[async_trait(?Send)]
impl NativeMeshSpeechCallTransport for AdmittedTimeoutTransport {
    async fn call(&mut self, _request: NativeMeshSpeechRequest) -> Result<Value, MeshSpeechError> {
        if let Some(response) = self.first_response.take() { return Ok(response); }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        Err(MeshSpeechError::Transport)
    }

    async fn cancel(&mut self, request: NativeMeshSpeechCancel) -> Result<(), MeshSpeechError> {
        self.cancels.push(request);
        Ok(())
    }
}

#[async_trait(?Send)]
impl NativeMeshSpeechCallTransport for FailingCancelTransport {
    async fn call(&mut self, _request: NativeMeshSpeechRequest) -> Result<Value, MeshSpeechError> {
        self.responses.pop_front().unwrap_or(Err(MeshSpeechError::Transport))
    }

    async fn cancel(&mut self, request: NativeMeshSpeechCancel) -> Result<(), MeshSpeechError> {
        self.cancels.push(request);
        Err(MeshSpeechError::Transport)
    }
}

#[async_trait(?Send)]
impl NativeMeshSpeechCallTransport for RecordingTransport {
    async fn call(&mut self, request: NativeMeshSpeechRequest) -> Result<Value, MeshSpeechError> {
        self.calls.push(request);
        self.responses.pop_front().unwrap_or(Err(MeshSpeechError::Transport))
    }

    async fn cancel(&mut self, request: NativeMeshSpeechCancel) -> Result<(), MeshSpeechError> {
        self.cancels.push(request);
        Ok(())
    }
}

fn admission() -> Value {
    json!({
        "schema": "speech.stage-session-admission.v1",
        "status": "admitted",
        "reason_code": "admitted",
        "operation_id": "op",
        "attempt_id": "attempt",
        "session_id": "session",
        "capability_revision": 7,
        "generation": 11,
        "credits": 2,
        "lease_remaining_ms": 60_000,
        "next_sequence": 0,
        "accepted_limits": {
            "max_input_bytes": 4_194_304,
            "max_chunk_bytes": 65_536,
            "max_text_bytes": 32,
            "max_queue": 2,
            "heartbeat_ms": 100,
            "idle_lease_ms": 15_000,
            "max_active_ms": 300_000
        }
    })
}

fn start_request() -> NativeMeshSpeechRequest {
    NativeMeshSpeechRequest::new(
        ids::TRANSCRIPTION_STREAM_START,
        "request",
        "op",
        "attempt",
        None,
        json!({
            "request_id": "request", "operation_id": "op", "attempt_id": "attempt",
            "generation": 11, "capability_revision": 7, "config_revision": 1,
            "route_revision": "route", "stage": "stt", "mode": "streaming"
        }),
        1024 * 1024,
    )
    .expect("valid start")
}

fn tts_prepare_request() -> NativeMeshSpeechRequest {
    NativeMeshSpeechRequest::new(
        ids::TTS_STREAM_PREPARE_V1,
        "request",
        "op",
        "attempt",
        None,
        json!({
            "request_id": "request", "operation_id": "op", "attempt_id": "attempt",
            "generation": 11, "capability_revision": 7, "config_revision": 1,
            "route_revision": "route", "stage": "tts", "mode": "streaming",
            "voice": "standard:piper:en_gb-cori-medium-int8"
        }),
        1024 * 1024,
    )
    .expect("valid prepare")
}

fn status_response(state: &str, credits: u64, next_sequence: u64) -> Value {
    status_response_with_lease(state, credits, next_sequence, 60_000)
}

fn status_response_with_lease(
    state: &str,
    credits: u64,
    next_sequence: u64,
    lease_remaining_ms: u64,
) -> Value {
    json!({
        "session_id": "session", "state": state,
        "credits": credits, "next_sequence": next_sequence, "lease_remaining_ms": lease_remaining_ms,
        "accepted_chunks": next_sequence, "dropped_chunks": 0
    })
}

fn rejected_admission() -> Value {
    json!({
        "status": "rejected", "reason_code": "unavailable",
        "operation_id": "op", "attempt_id": "attempt",
        "capability_revision": 7, "generation": 11
    })
}

fn tts_end_request() -> NativeMeshSpeechRequest {
    NativeMeshSpeechRequest::new(
        ids::TTS_STREAM_END, "request", "op", "attempt", Some("session".into()),
        json!({"stream_id":"session", "reason":"completed"}), 1024,
    ).expect("valid TTS end")
}

fn tts_result_request() -> NativeMeshSpeechRequest {
    NativeMeshSpeechRequest::new(
        ids::TTS_STREAM_RESULT, "request", "op", "attempt", Some("session".into()),
        json!({"session_id":"session"}), 1024,
    ).expect("valid TTS result")
}

fn tts_result_response() -> Value {
    json!({
        "session_id":"session", "state":"completed", "reason_code":"completed",
        "stage":"tts", "mode":"streaming", "redacted":true,
        "final_sequence":0, "input_count":1, "output_count":1
    })
}

#[tokio::test]
async fn rejected_start_does_not_install_an_admission_or_send_a_followup_chunk() {
    let mut provider = NativeMeshSpeechProvider::new(RecordingTransport {
        responses: VecDeque::from([Ok(rejected_admission())]), calls: vec![], cancels: vec![],
    });
    provider.call(start_request()).await.expect("rejection is a valid admission response");
    let chunk = NativeMeshSpeechRequest::new(
        ids::TRANSCRIPTION_STREAM_CHUNK, "request", "op", "attempt", Some("session".into()),
        json!({"session_id":"session", "attempt_id":"attempt", "generation":11, "sequence":0,
               "payload_kind":"audio", "payload_size_bytes":1, "audio_data":"AQ==", "is_final":false}), 1024,
    ).expect("valid chunk");
    assert_eq!(provider.call(chunk).await, Err(MeshSpeechError::StaleResponse));
    assert_eq!(provider.into_inner().calls.len(), 1);
}

#[tokio::test]
async fn start_and_prepare_consume_real_admission_replies_before_chunks() {
    let mut provider = NativeMeshSpeechProvider::new(RecordingTransport {
        responses: VecDeque::from([Ok(admission()), Ok(status_response("active", 1, 1))]),
        calls: vec![],
        cancels: vec![],
    });
    let started = provider.call(start_request()).await.expect("admitted STT start");
    assert_eq!(started["accepted_limits"]["max_chunk_bytes"], 49_152);
    let chunk = NativeMeshSpeechRequest::new(
        ids::TRANSCRIPTION_STREAM_CHUNK,
        "request",
        "op",
        "attempt",
        Some("session".into()),
        json!({
            "session_id":"session", "attempt_id":"attempt", "generation":11,
            "sequence":0, "payload_kind":"audio", "payload_size_bytes":1,
            "audio_data":"AQ==", "is_final":false
        }),
        1024,
    )
    .expect("valid chunk");
    provider.call(chunk).await.expect("chunk uses negotiated admission");

    let mut tts = NativeMeshSpeechProvider::new(RecordingTransport {
        responses: VecDeque::from([Ok(admission())]),
        calls: vec![],
        cancels: vec![],
    });
    let prepared = tts.call(tts_prepare_request()).await.expect("admitted TTS prepare");
    assert_eq!(prepared["accepted_limits"]["max_text_bytes"], 32);
}

#[tokio::test]
async fn negotiated_chunk_and_text_limits_are_enforced_at_real_request_boundary() {
    let max_audio = vec![7_u8; 49_152];
    let payload = transcription_audio_chunk_payload("session", "attempt", 11, 0, &max_audio)
        .expect("49152 decoded bytes are accepted");
    assert_eq!(BASE64.decode(payload["audio_data"].as_str().unwrap()).unwrap().len(), 49_152);
    assert_eq!(transcription_audio_chunk_payload("session", "attempt", 11, 0, &vec![7; 49_153]), Err(MeshSpeechError::RequestTooLarge));

    let mut stt = NativeMeshSpeechProvider::new(RecordingTransport {
        responses: VecDeque::from([Ok(admission()), Ok(status_response("active", 1, 1))]),
        calls: vec![], cancels: vec![],
    });
    stt.call(start_request()).await.expect("start for maximum chunk");
    let maximum_chunk = NativeMeshSpeechRequest::new(
        ids::TRANSCRIPTION_STREAM_CHUNK, "request", "op", "attempt", Some("session".into()),
        payload, 1024 * 1024,
    ).expect("generated boundary accepts 49152 decoded bytes");
    stt.call(maximum_chunk).await.expect("actual call accepts local audio cap");
    let oversized_audio = BASE64.encode(vec![7_u8; 49_153]);
    assert!(NativeMeshSpeechRequest::new(
        ids::TRANSCRIPTION_STREAM_CHUNK, "request", "op", "attempt", Some("session".into()),
        json!({"session_id":"session", "attempt_id":"attempt", "generation":11, "sequence":0,
               "payload_kind":"audio", "payload_size_bytes":49_153, "audio_data":oversized_audio, "is_final":false}),
        1024 * 1024,
    ).is_err());

    let oversized_text = "x".repeat(33);
    let request = NativeMeshSpeechRequest::new(
        ids::TTS_STREAM_CHUNK, "request", "op", "attempt", Some("session".into()),
        json!({"stream_id":"session", "sequence":0, "text":oversized_text}), 1024,
    ).expect("contract-valid text before negotiated limit");
    let mut provider = NativeMeshSpeechProvider::new(RecordingTransport {
        responses: VecDeque::from([Ok(admission())]), calls: vec![], cancels: vec![],
    });
    provider.call(tts_prepare_request()).await.expect("prepare");
    assert_eq!(provider.call(request).await, Err(MeshSpeechError::RequestTooLarge));
}

#[tokio::test]
async fn status_refreshes_credits_sequence_and_lease_for_the_next_real_chunk() {
    let mut provider = NativeMeshSpeechProvider::new(RecordingTransport {
        responses: VecDeque::from([
            Ok(admission()),
            Ok(status_response_with_lease("active", 1, 0, 120_000)),
            Ok(status_response("active", 1, 1)),
        ]), calls: vec![], cancels: vec![],
    });
    provider.call(start_request()).await.expect("start");
    let status = NativeMeshSpeechRequest::new(
        ids::TRANSCRIPTION_STREAM_STATUS, "request", "op", "attempt", Some("session".into()),
        json!({"session_id":"session"}), 1024,
    ).expect("status");
    provider.call(status).await.expect("status refresh");
    let chunk = NativeMeshSpeechRequest::new(
        ids::TRANSCRIPTION_STREAM_CHUNK, "request", "op", "attempt", Some("session".into()),
        json!({"session_id":"session", "attempt_id":"attempt", "generation":11, "sequence":0,
               "payload_kind":"audio", "payload_size_bytes":1, "audio_data":"AQ==", "is_final":false}), 1024,
    ).expect("chunk");
    provider.call(chunk).await.expect("refreshed state admits next chunk");
}

#[tokio::test]
async fn malformed_or_rewound_status_leaves_admission_unchanged() {
    let mut provider = NativeMeshSpeechProvider::new(RecordingTransport {
        responses: VecDeque::from([
            Ok(admission()),
            Ok(status_response_with_lease("active", 1, 1, 120_000)),
            Ok(status_response_with_lease("active", 1, 0, 120_000)),
            Ok(status_response("active", 1, 1)),
        ]), calls: vec![], cancels: vec![],
    });
    provider.call(start_request()).await.expect("start");
    let first_status = NativeMeshSpeechRequest::new(
        ids::TRANSCRIPTION_STREAM_STATUS, "request", "op", "attempt", Some("session".into()),
        json!({"session_id":"session"}), 1024,
    ).expect("status");
    provider.call(first_status).await.expect("valid status advances sequence");
    let status = NativeMeshSpeechRequest::new(
        ids::TRANSCRIPTION_STREAM_STATUS, "request", "op", "attempt", Some("session".into()),
        json!({"session_id":"session"}), 1024,
    ).expect("status");
    assert_eq!(provider.call(status).await, Err(MeshSpeechError::StaleResponse));
    let chunk = NativeMeshSpeechRequest::new(
        ids::TRANSCRIPTION_STREAM_CHUNK, "request", "op", "attempt", Some("session".into()),
        json!({"session_id":"session", "attempt_id":"attempt", "generation":11, "sequence":1,
               "payload_kind":"audio", "payload_size_bytes":1, "audio_data":"AQ==", "is_final":false}), 1024,
    ).expect("chunk");
    provider.call(chunk).await.expect("rejected status did not partially mutate state");
}

#[tokio::test]
async fn wrong_owner_status_and_cancel_cannot_clear_current_admission() {
    let mut provider = NativeMeshSpeechProvider::new(RecordingTransport {
        responses: VecDeque::from([Ok(admission()), Ok(status_response("active", 1, 0))]),
        calls: vec![], cancels: vec![],
    });
    provider.call(start_request()).await.expect("start");
    let wrong = NativeMeshSpeechRequest::new(
        ids::TRANSCRIPTION_STREAM_STATUS, "request", "other-op", "attempt", Some("session".into()),
        json!({"session_id":"session"}), 1024,
    ).expect("request identity is syntactically valid");
    assert_eq!(provider.call(wrong.clone()).await, Err(MeshSpeechError::StaleResponse));
    assert_eq!(provider.cancel_owned(&wrong, "canceled").await, Err(MeshSpeechError::StaleResponse));
    let valid = NativeMeshSpeechRequest::new(
        ids::TRANSCRIPTION_STREAM_STATUS, "request", "op", "attempt", Some("session".into()),
        json!({"session_id":"session"}), 1024,
    ).expect("valid status");
    provider.call(valid).await.expect("current owner remains live");
}

#[tokio::test]
async fn admitted_family_rejects_cross_stage_requests_without_transport_access() {
    let mut provider = NativeMeshSpeechProvider::new(RecordingTransport {
        responses: VecDeque::from([Ok(admission())]), calls: vec![], cancels: vec![],
    });
    provider.call(start_request()).await.expect("STT admission");
    let tts_status = NativeMeshSpeechRequest::new(
        ids::TTS_STREAM_STATUS, "request", "op", "attempt", Some("session".into()),
        json!({"session_id":"session"}), 1024,
    ).expect("valid TTS status shape");
    assert_eq!(provider.call(tts_status).await, Err(MeshSpeechError::StaleResponse));
    assert_eq!(provider.into_inner().calls.len(), 1);
}

#[tokio::test]
async fn end_keeps_tts_owner_until_actual_terminal_result_then_clears_it() {
    let mut provider = NativeMeshSpeechProvider::new(RecordingTransport {
        responses: VecDeque::from([Ok(admission()), Ok(json!({})), Ok(tts_result_response())]),
        calls: vec![], cancels: vec![],
    });
    provider.call(tts_prepare_request()).await.expect("prepare");
    provider.call(tts_end_request()).await.expect("end seals input");
    provider.call(tts_result_request()).await.expect("result remains fetchable after end");

    let stale_status = NativeMeshSpeechRequest::new(
        ids::TTS_STREAM_STATUS, "request", "op", "attempt", Some("session".into()),
        json!({"session_id":"session"}), 1024,
    ).expect("valid status");
    assert_eq!(provider.call(stale_status).await, Err(MeshSpeechError::StaleResponse));
}

#[tokio::test]
async fn matching_cancel_carries_owner_identity_and_clears_the_current_session() {
    let mut provider = NativeMeshSpeechProvider::new(RecordingTransport {
        responses: VecDeque::from([Ok(admission())]), calls: vec![], cancels: vec![],
    });
    provider.call(start_request()).await.expect("start");
    let owner = NativeMeshSpeechRequest::new(
        ids::TRANSCRIPTION_STREAM_STATUS, "request", "op", "attempt", Some("session".into()),
        json!({"session_id":"session"}), 1024,
    ).expect("owner status");
    provider.cancel_owned(&owner, "canceled").await.expect("cancel");
    let transport = provider.into_inner();
    assert_eq!(transport.cancels.len(), 1);
    assert_eq!(transport.cancels[0].operation_id, "op");
    assert_eq!(transport.cancels[0].attempt_id, "attempt");
    assert_eq!(transport.cancels[0].session_id.as_deref(), Some("session"));
    assert_eq!(transport.cancels[0].generation, Some(11));
}

#[tokio::test]
async fn pre_admission_timeout_stamps_a_bounded_unowned_cancel() {
    let mut provider = NativeMeshSpeechProvider::new(SlowTransport { cancels: vec![] });
    let request = start_request().with_deadline_ms(1).expect("short deadline");
    assert_eq!(provider.call(request).await, Err(MeshSpeechError::Transport));
    let transport = provider.into_inner();
    assert_eq!(transport.cancels.len(), 1);
    assert_eq!(transport.cancels[0].operation_id, "op");
    assert_eq!(transport.cancels[0].attempt_id, "attempt");
    assert_eq!(transport.cancels[0].reason, "timed_out");
    assert_eq!(transport.cancels[0].session_id, None);
    assert_eq!(transport.cancels[0].generation, None);
}

#[tokio::test]
async fn admitted_timeout_stamps_the_exact_owned_session_and_generation() {
    let mut provider = NativeMeshSpeechProvider::new(AdmittedTimeoutTransport {
        first_response: Some(admission()),
        cancels: vec![],
    });
    provider.call(start_request()).await.expect("admission");
    let chunk = NativeMeshSpeechRequest::new(
        ids::TRANSCRIPTION_STREAM_CHUNK, "request", "op", "attempt", Some("session".into()),
        json!({"session_id":"session", "attempt_id":"attempt", "generation":11, "sequence":0,
               "payload_kind":"audio", "payload_size_bytes":1, "audio_data":"AQ==", "is_final":false}), 1024,
    ).expect("chunk").with_deadline_ms(1).expect("short deadline");
    assert_eq!(provider.call(chunk).await, Err(MeshSpeechError::Transport));
    let transport = provider.into_inner();
    assert_eq!(transport.cancels.len(), 1);
    assert_eq!(transport.cancels[0].operation_id, "op");
    assert_eq!(transport.cancels[0].attempt_id, "attempt");
    assert_eq!(transport.cancels[0].session_id.as_deref(), Some("session"));
    assert_eq!(transport.cancels[0].generation, Some(11));
}

#[tokio::test]
async fn failed_owned_cancel_preserves_owner_for_retry_and_rejects_cross_session() {
    let mut provider = NativeMeshSpeechProvider::new(FailingCancelTransport {
        responses: VecDeque::from([Ok(admission()), Ok(status_response("active", 1, 0))]),
        cancels: vec![],
    });
    provider.call(start_request()).await.expect("admission");
    let wrong_session = NativeMeshSpeechRequest::new(
        ids::TRANSCRIPTION_STREAM_STATUS, "request", "op", "attempt", Some("other-session".into()),
        json!({"session_id":"other-session"}), 1024,
    ).expect("cross-session status");
    assert_eq!(provider.cancel_owned(&wrong_session, "canceled").await, Err(MeshSpeechError::StaleResponse));
    let owner = NativeMeshSpeechRequest::new(
        ids::TRANSCRIPTION_STREAM_STATUS, "request", "op", "attempt", Some("session".into()),
        json!({"session_id":"session"}), 1024,
    ).expect("owner status");
    assert_eq!(provider.cancel_owned(&owner, "canceled").await, Err(MeshSpeechError::Transport));
    let status = NativeMeshSpeechRequest::new(
        ids::TRANSCRIPTION_STREAM_STATUS, "request", "op", "attempt", Some("session".into()),
        json!({"session_id":"session"}), 1024,
    ).expect("status after failed cancel");
    provider.call(status).await.expect("owner remains available after failed cancel");
}

#[tokio::test]
async fn interrupted_status_blocks_chunks_after_real_admission() {
    let mut provider = NativeMeshSpeechProvider::new(RecordingTransport {
        responses: VecDeque::from([
            Ok(admission()),
            Ok(status_response("interrupted", 1, 0)),
        ]), calls: vec![], cancels: vec![],
    });
    provider.call(start_request()).await.expect("start");
    let status = NativeMeshSpeechRequest::new(
        ids::TRANSCRIPTION_STREAM_STATUS, "request", "op", "attempt", Some("session".into()),
        json!({"session_id":"session"}), 1024,
    ).expect("status");
    provider.call(status).await.expect("interrupted status");
    let chunk = NativeMeshSpeechRequest::new(
        ids::TRANSCRIPTION_STREAM_CHUNK, "request", "op", "attempt", Some("session".into()),
        json!({"session_id":"session", "attempt_id":"attempt", "generation":11, "sequence":0,
               "payload_kind":"audio", "payload_size_bytes":1, "audio_data":"AQ==", "is_final":false}), 1024,
    ).expect("chunk");
    assert_eq!(provider.call(chunk).await, Err(MeshSpeechError::StaleResponse));
}

#[test]
fn deadline_wrapper_and_request_normalization_are_fail_closed() {
    let request = start_request().with_deadline_ms(25).expect("bounded deadline");
    assert_eq!(request.deadline_ms(), 25);
    assert_eq!(start_request().with_deadline_ms(60_001), Err(MeshSpeechError::InvalidRequest));
    assert_eq!(start_request().with_deadline_ms(0), Err(MeshSpeechError::InvalidRequest));
    assert!(NativeMeshSpeechRequest::new(
        ids::TRANSCRIPTION_TRANSCRIBE, "request", "op", "attempt", None,
        json!({"audio_data":"not-base64"}), 1024,
    ).is_err());
}

#[tokio::test]
async fn malformed_tts_audio_and_oversized_responses_are_rejected_at_public_boundary() {
    let synth = NativeMeshSpeechRequest::new(
        ids::TTS_SYNTHESIZE, "request", "op", "attempt", None,
        json!({"text":"hello", "voice":"standard:piper:en_gb-cori-medium-int8"}), 1024,
    ).expect("valid synthesis request");
    let mut malformed = NativeMeshSpeechProvider::new(RecordingTransport {
        responses: VecDeque::from([Ok(json!({"audio_data":"not-base64", "format":"wav"}))]),
        calls: vec![], cancels: vec![],
    });
    assert!(malformed.call(synth.clone()).await.is_err());

    let mut oversized = NativeMeshSpeechProvider::new(RecordingTransport {
        responses: VecDeque::from([Ok(json!({"session_id":"session", "state":"active",
            "credits":1, "next_sequence":0, "lease_remaining_ms":60_000,
            "accepted_chunks":0, "dropped_chunks":0}))]), calls: vec![], cancels: vec![],
    });
    let tiny = NativeMeshSpeechRequest::new(
        ids::TRANSCRIPTION_STREAM_STATUS, "request", "op", "attempt", None,
        json!({"session_id":"session"}), 1,
    ).expect("valid status with tiny response budget");
    assert_eq!(oversized.call(tiny).await, Err(MeshSpeechError::ResponseTooLarge));
}
