//! Tauri integration seam for the contract-aware native mesh speech provider.
//!
//! `mesh_session.rs` remains the owner of peer selection, authority checks,
//! channel encryption, and late-frame fencing. This file only translates the
//! provider request into the frame sender's existing exact-peer boundary.

use async_trait::async_trait;
use aurora_voice_native::{
    MeshSpeechError, NativeMeshSpeechCallTransport, NativeMeshSpeechCancel,
    NativeMeshSpeechRequest,
};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct NativeMeshSpeechFrame {
    pub(crate) peer_id: String,
    pub(crate) resource_id: String,
    pub(crate) method_id: String,
    pub(crate) request_id: String,
    pub(crate) operation_id: String,
    pub(crate) attempt_id: String,
    pub(crate) session_id: Option<String>,
    pub(crate) max_response_bytes: usize,
    pub(crate) deadline_ms: u64,
    pub(crate) params: Value,
}

#[async_trait(?Send)]
pub(crate) trait NativeMeshSpeechFrameGateway: Send + Sync {
    async fn send_speech_frame(&self, frame: NativeMeshSpeechFrame) -> Result<Value, MeshSpeechError>;
    async fn cancel_speech_frame(&self, peer_id: &str, request: NativeMeshSpeechCancel) -> Result<(), MeshSpeechError>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SpeechFamily { Transcription, Tts }

fn method_family(method_id: &str) -> Option<SpeechFamily> {
    if method_id.starts_with("Transcription.") { Some(SpeechFamily::Transcription) }
    else if method_id.starts_with("TTS.") { Some(SpeechFamily::Tts) }
    else { None }
}

pub(crate) struct TauriNativeMeshSpeechCallTransport<G> {
    peer_id: String,
    resource_id: String,
    family: SpeechFamily,
    gateway: G,
}

impl<G> TauriNativeMeshSpeechCallTransport<G> {
    pub(crate) fn new(peer_id: impl Into<String>, resource_id: impl Into<String>, gateway: G) -> Result<Self, MeshSpeechError> {
        let peer_id = peer_id.into();
        let resource_id = resource_id.into();
        let resource_parts = resource_id.split(':').collect::<Vec<_>>();
        let family = match resource_parts.as_slice() {
            ["remote", resource_peer, "Transcription"] if *resource_peer == peer_id => SpeechFamily::Transcription,
            ["remote", resource_peer, "TTS"] if *resource_peer == peer_id => SpeechFamily::Tts,
            _ => return Err(MeshSpeechError::InvalidRequest),
        };
        if peer_id.is_empty() || peer_id.len() > 128 || resource_id.len() > 128
            || !peer_id.bytes().enumerate().all(|(index, byte)|
                byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-')))
            || !resource_id.bytes().enumerate().all(|(index, byte)|
                byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-')))
        {
            return Err(MeshSpeechError::InvalidRequest);
        }
        Ok(Self { peer_id, resource_id, family, gateway })
    }
}

#[async_trait(?Send)]
impl<G> NativeMeshSpeechCallTransport for TauriNativeMeshSpeechCallTransport<G>
where
    G: NativeMeshSpeechFrameGateway,
{
    async fn call(&mut self, request: NativeMeshSpeechRequest) -> Result<Value, MeshSpeechError> {
        if method_family(request.method_id()) != Some(self.family) {
            return Err(MeshSpeechError::InvalidRequest);
        }
        if let Some(payload_peer) = request
            .payload()
            .pointer("/mesh_selector/peer_id")
            .and_then(Value::as_str)
        {
            if payload_peer != self.peer_id {
                return Err(MeshSpeechError::InvalidPayload);
            }
        }
        if let Some(payload_peer) = request.payload().get("target_peer_id").and_then(Value::as_str) {
            if payload_peer != self.peer_id {
                return Err(MeshSpeechError::InvalidPayload);
            }
        }
        if let Some(payload_resource) = request.payload().get("target_resource_id").and_then(Value::as_str) {
            if payload_resource != self.resource_id {
                return Err(MeshSpeechError::InvalidPayload);
            }
        }
        if let Some(payload_resource) = request
            .payload()
            .pointer("/mesh_selector/resource_namespace")
            .and_then(Value::as_str)
        {
            if payload_resource != self.resource_id {
                return Err(MeshSpeechError::InvalidPayload);
            }
        }
        self.gateway
            .send_speech_frame(NativeMeshSpeechFrame {
                peer_id: self.peer_id.clone(),
                resource_id: self.resource_id.clone(),
                method_id: request.method_id().to_owned(),
                request_id: request.request_id().to_owned(),
                operation_id: request.operation_id().to_owned(),
                attempt_id: request.attempt_id().to_owned(),
                session_id: request.session_id().map(str::to_owned),
                max_response_bytes: request.max_response_bytes(),
                deadline_ms: request.deadline_ms(),
                params: request.payload().clone(),
            })
            .await
    }

    async fn cancel(&mut self, mut request: NativeMeshSpeechCancel) -> Result<(), MeshSpeechError> {
        if let Some(resource_id) = request.resource_id.as_deref() {
            if resource_id != self.resource_id {
                return Err(MeshSpeechError::InvalidRequest);
            }
        }
        request.resource_id = Some(self.resource_id.clone());
        self.gateway.cancel_speech_frame(&self.peer_id, request).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct RecordingGateway {
        sent: Mutex<Vec<NativeMeshSpeechFrame>>,
        canceled: Mutex<Vec<(String, NativeMeshSpeechCancel)>>,
    }

    #[async_trait(?Send)]
    impl NativeMeshSpeechFrameGateway for RecordingGateway {
        async fn send_speech_frame(&self, frame: NativeMeshSpeechFrame) -> Result<Value, MeshSpeechError> {
            self.sent.lock().unwrap().push(frame);
            Ok(serde_json::json!({}))
        }

        async fn cancel_speech_frame(&self, peer_id: &str, request: NativeMeshSpeechCancel) -> Result<(), MeshSpeechError> {
            self.canceled.lock().unwrap().push((peer_id.to_owned(), request));
            Ok(())
        }
    }

    #[test]
    fn peer_boundary_uses_contract_identifier_grammar() {
        assert!(TauriNativeMeshSpeechCallTransport::<()>::new("peer id", "resource", ()).is_err());
        assert!(TauriNativeMeshSpeechCallTransport::<()>::new("peer/id", "resource", ()).is_err());
        assert!(TauriNativeMeshSpeechCallTransport::<()>::new("peer-01", "remote:peer-01:Transcription", ()).is_ok());
        assert!(TauriNativeMeshSpeechCallTransport::<()>::new("peer-01", "remote:other:TTS", ()).is_err());
        assert!(TauriNativeMeshSpeechCallTransport::<()>::new("peer-01", "tts.pack", ()).is_err());
    }

    #[tokio::test]
    async fn cancel_stamps_verified_peer_and_resource_identity() {
        let gateway = RecordingGateway::default();
        let mut transport = TauriNativeMeshSpeechCallTransport::new("peer-01", "remote:peer-01:TTS", gateway)
            .expect("verified route identity");
        let request = NativeMeshSpeechCancel {
            request_id: "request".into(), operation_id: "operation".into(),
            attempt_id: "attempt".into(), session_id: Some("session".into()),
            generation: Some(3), cancellation_ref: "operation:attempt".into(),
            reason: "canceled".into(), resource_id: None,
        };
        transport.cancel(request).await.expect("cancel frame");
        let gateway = transport.gateway;
        let canceled = gateway.canceled.into_inner().unwrap();
        assert_eq!(canceled.len(), 1);
        assert_eq!(canceled[0].0, "peer-01");
        assert_eq!(canceled[0].1.resource_id.as_deref(), Some("remote:peer-01:TTS"));
        assert_eq!(canceled[0].1.session_id.as_deref(), Some("session"));
        assert_eq!(canceled[0].1.generation, Some(3));
    }

    #[tokio::test]
    async fn transport_rejects_both_cross_family_directions_before_gateway() {
        let transcription_gateway = RecordingGateway::default();
        let mut transcription = TauriNativeMeshSpeechCallTransport::new(
            "peer-01", "remote:peer-01:Transcription", transcription_gateway,
        ).expect("transcription route");
        let tts_request = NativeMeshSpeechRequest::new(
            "TTS.StreamPrepareV1",
            "request", "operation", "attempt", None,
            serde_json::json!({
                "request_id":"request", "operation_id":"operation", "attempt_id":"attempt",
                "generation":1, "capability_revision":1, "config_revision":1,
                "route_revision":"route", "stage":"tts", "mode":"streaming",
                "voice":"standard:piper:en_gb-cori-medium-int8"
            }), 1024,
        ).expect("tts request");
        assert_eq!(transcription.call(tts_request).await, Err(MeshSpeechError::InvalidRequest));
        assert!(transcription.gateway.sent.lock().unwrap().is_empty());

        let tts_gateway = RecordingGateway::default();
        let mut tts = TauriNativeMeshSpeechCallTransport::new(
            "peer-01", "remote:peer-01:TTS", tts_gateway,
        ).expect("tts route");
        let transcription_request = NativeMeshSpeechRequest::new(
            "Transcription.StreamStart",
            "request", "operation", "attempt", None,
            serde_json::json!({
                "request_id":"request", "operation_id":"operation", "attempt_id":"attempt",
                "generation":1, "capability_revision":1, "config_revision":1,
                "route_revision":"route", "stage":"stt", "mode":"streaming"
            }), 1024,
        ).expect("transcription request");
        assert_eq!(tts.call(transcription_request).await, Err(MeshSpeechError::InvalidRequest));
        assert!(tts.gateway.sent.lock().unwrap().is_empty());
    }
}
