use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use aurora_contracts::ids;
use aurora_voice_core::CancellationToken;
use aurora_voice_native::{
    install_native_mesh_assistant_transport_factory, NativeMeshAssistantTransport,
    NativeMeshAssistantTransportFactory, NativeMeshAssistantTransportOptions,
    NativeMeshExternalUserInput, NativeMeshInterruptRequest, TransportError,
};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::mesh_session::{MeshSessionState, NativeAssistantPendingCall, OutboundDataChannelFrame};
use crate::native_webrtc::{self, NativeWebRtcState};

const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(10);

#[async_trait(?Send)]
trait NativeMeshAssistantFrameSender: Send + Sync {
    async fn send_text(&self, data_channel_id: u64, payload: String) -> Result<(), TransportError>;
    async fn send_binary(
        &self,
        data_channel_id: u64,
        payload: Vec<u8>,
    ) -> Result<(), TransportError>;
}

struct NativeWebRtcMeshAssistantFrameSender {
    app: AppHandle,
    state: NativeWebRtcState,
}

#[async_trait(?Send)]
impl NativeMeshAssistantFrameSender for NativeWebRtcMeshAssistantFrameSender {
    async fn send_text(&self, data_channel_id: u64, payload: String) -> Result<(), TransportError> {
        native_webrtc::send_native_text_data_channel(
            self.app.clone(),
            &self.state,
            data_channel_id,
            payload,
        )
        .await
        .map_err(|_| TransportError::RequestFailed)
    }

    async fn send_binary(
        &self,
        data_channel_id: u64,
        payload: Vec<u8>,
    ) -> Result<(), TransportError> {
        native_webrtc::send_native_binary_data_channel(
            self.app.clone(),
            &self.state,
            data_channel_id,
            payload,
        )
        .await
        .map_err(|_| TransportError::RequestFailed)
    }
}

struct TauriNativeMeshAssistantTransportFactory {
    mesh_state: MeshSessionState,
    sender: Arc<dyn NativeMeshAssistantFrameSender>,
}

impl NativeMeshAssistantTransportFactory for TauriNativeMeshAssistantTransportFactory {
    fn create(
        &self,
        options: NativeMeshAssistantTransportOptions,
    ) -> Result<Box<dyn NativeMeshAssistantTransport>, TransportError> {
        Ok(Box::new(TauriNativeMeshAssistantTransport {
            mesh_state: self.mesh_state.clone(),
            sender: Arc::clone(&self.sender),
            options,
            active_peer_id: None,
        }))
    }
}

struct TauriNativeMeshAssistantTransport {
    mesh_state: MeshSessionState,
    sender: Arc<dyn NativeMeshAssistantFrameSender>,
    options: NativeMeshAssistantTransportOptions,
    active_peer_id: Option<String>,
}

struct NativeMeshInvokeRequest<'a> {
    method_id: &'a str,
    request_id: &'a str,
    idempotency_key: &'a str,
    payload: &'a Value,
    timeout: Duration,
    cancellation: CancellationToken,
    preferred_peer_id: Option<&'a str>,
    require_advertised_method: bool,
}

struct NativeMeshBeginCallRequest<'a> {
    preferred_peer_id: Option<&'a str>,
    method_id: &'a str,
    request_id: &'a str,
    require_advertised_method: bool,
    timeout: Duration,
    started: Instant,
    cancellation: &'a CancellationToken,
}

#[async_trait(?Send)]
impl NativeMeshAssistantTransport for TauriNativeMeshAssistantTransport {
    async fn external_user_input(
        &mut self,
        request: NativeMeshExternalUserInput,
        cancellation: CancellationToken,
    ) -> Result<Value, TransportError> {
        let preferred = self
            .options
            .route()
            .preferred_stable_peer_id()
            .map(str::to_owned);
        let response = self
            .invoke(NativeMeshInvokeRequest {
                method_id: ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                request_id: request.request_id(),
                idempotency_key: request.idempotency_key(),
                payload: request.payload(),
                timeout: request.timeout(),
                cancellation,
                preferred_peer_id: preferred.as_deref(),
                require_advertised_method: true,
            })
            .await;
        if response.is_err() {
            self.active_peer_id = None;
        }
        response
    }

    async fn interrupt(
        &mut self,
        request: NativeMeshInterruptRequest,
        cancellation: CancellationToken,
    ) -> Result<Value, TransportError> {
        let active_peer_id = self
            .active_peer_id
            .as_deref()
            .or_else(|| self.options.route().preferred_stable_peer_id())
            .map(str::to_owned);
        self.invoke(NativeMeshInvokeRequest {
            method_id: ids::ORCHESTRATOR_INTERRUPT,
            request_id: request.request_id(),
            idempotency_key: request.idempotency_key(),
            payload: request.payload(),
            timeout: request.timeout(),
            cancellation,
            preferred_peer_id: active_peer_id.as_deref(),
            require_advertised_method: true,
        })
        .await
    }
}

impl TauriNativeMeshAssistantTransport {
    async fn invoke(
        &mut self,
        request: NativeMeshInvokeRequest<'_>,
    ) -> Result<Value, TransportError> {
        let NativeMeshInvokeRequest {
            method_id,
            request_id,
            idempotency_key,
            payload,
            timeout,
            cancellation,
            preferred_peer_id,
            require_advertised_method,
        } = request;
        if cancellation.is_cancelled() {
            return Err(TransportError::Cancelled);
        }
        let started = Instant::now();
        let pending = self
            .begin_call_when_ready(NativeMeshBeginCallRequest {
                preferred_peer_id,
                method_id,
                request_id,
                require_advertised_method,
                timeout,
                started,
                cancellation: &cancellation,
            })
            .await?;
        let peer_id = pending.peer_id.clone();
        let frame = assistant_call_frame(method_id, request_id, idempotency_key, payload, &pending);
        let encoded = serde_json::to_vec(&frame).map_err(|_| TransportError::InvalidPayload)?;
        if encoded.len() > self.options.limits().max_request_bytes {
            self.mesh_state
                .cancel_native_assistant_call(&peer_id, request_id)
                .await;
            return Err(TransportError::RequestTooLarge);
        }
        let outbound = match self
            .mesh_state
            .encode_native_assistant_frame(&peer_id, pending.data_channel_id, &frame)
            .await
        {
            Ok(outbound) => outbound,
            Err(error) => {
                self.mesh_state
                    .cancel_native_assistant_call(&peer_id, request_id)
                    .await;
                return Err(error);
            }
        };
        if let Err(error) =
            send_outbound_frame(&self.sender, pending.data_channel_id, outbound).await
        {
            self.mesh_state
                .cancel_native_assistant_call(&peer_id, request_id)
                .await;
            return Err(error);
        }
        self.active_peer_id = Some(peer_id.clone());
        let remaining_timeout = timeout
            .checked_sub(started.elapsed())
            .unwrap_or(Duration::ZERO);
        if remaining_timeout.is_zero() {
            send_cancel_frame(
                &self.mesh_state,
                &self.sender,
                &peer_id,
                pending.data_channel_id,
                request_id,
            )
            .await;
            self.mesh_state
                .abandon_native_assistant_call(&peer_id, request_id)
                .await;
            return Err(TransportError::Timeout);
        }
        await_response(
            &self.mesh_state,
            Arc::clone(&self.sender),
            pending,
            request_id,
            remaining_timeout,
            self.options.limits().max_response_bytes,
            cancellation,
        )
        .await
    }

    async fn begin_call_when_ready(
        &self,
        request: NativeMeshBeginCallRequest<'_>,
    ) -> Result<NativeAssistantPendingCall, TransportError> {
        let NativeMeshBeginCallRequest {
            preferred_peer_id,
            method_id,
            request_id,
            require_advertised_method,
            timeout,
            started,
            cancellation,
        } = request;
        loop {
            match self
                .mesh_state
                .begin_native_assistant_call_or_wait(
                    preferred_peer_id,
                    method_id,
                    request_id,
                    require_advertised_method,
                )
                .await
            {
                Ok(Some(pending)) => return Ok(pending),
                Ok(None) => {
                    if cancellation.is_cancelled() {
                        return Err(TransportError::Cancelled);
                    }
                    if started.elapsed() >= timeout {
                        return Err(TransportError::Timeout);
                    }
                    tokio::time::sleep(CANCEL_POLL_INTERVAL).await;
                }
                Err(error) => return Err(error),
            }
        }
    }
}

async fn await_response(
    mesh_state: &MeshSessionState,
    sender: Arc<dyn NativeMeshAssistantFrameSender>,
    pending: NativeAssistantPendingCall,
    request_id: &str,
    timeout: Duration,
    max_response_bytes: usize,
    cancellation: CancellationToken,
) -> Result<Value, TransportError> {
    let peer_id = pending.peer_id.clone();
    let data_channel_id = pending.data_channel_id;
    let mut response = pending.response;
    let timeout = tokio::time::sleep(timeout);
    tokio::pin!(timeout);
    loop {
        tokio::select! {
            result = &mut response => {
                let value = result.map_err(|_| TransportError::RequestFailed)??;
                let encoded = serde_json::to_vec(&value).map_err(|_| TransportError::InvalidResponse)?;
                if encoded.len() > max_response_bytes {
                    return Err(TransportError::ResponseTooLarge);
                }
                return Ok(value);
            }
            _ = &mut timeout => {
                send_cancel_frame(mesh_state, &sender, &peer_id, data_channel_id, request_id).await;
                mesh_state.abandon_native_assistant_call(&peer_id, request_id).await;
                return Err(TransportError::Timeout);
            }
            _ = tokio::time::sleep(CANCEL_POLL_INTERVAL) => {
                if cancellation.is_cancelled() {
                    send_cancel_frame(mesh_state, &sender, &peer_id, data_channel_id, request_id).await;
                    mesh_state.abandon_native_assistant_call(&peer_id, request_id).await;
                    return Err(TransportError::Cancelled);
                }
            }
        }
    }
}

async fn send_outbound_frame(
    sender: &Arc<dyn NativeMeshAssistantFrameSender>,
    data_channel_id: u64,
    frame: OutboundDataChannelFrame,
) -> Result<(), TransportError> {
    match frame {
        OutboundDataChannelFrame::Text(payload) => sender.send_text(data_channel_id, payload).await,
        OutboundDataChannelFrame::Binary(payload) => {
            sender.send_binary(data_channel_id, payload).await
        }
    }
}

async fn send_cancel_frame(
    mesh_state: &MeshSessionState,
    sender: &Arc<dyn NativeMeshAssistantFrameSender>,
    peer_id: &str,
    data_channel_id: u64,
    request_id: &str,
) {
    let frame = json!({
        "type": "cancel",
        "id": request_id,
    });
    let Ok(frame) = mesh_state
        .encode_native_assistant_frame(peer_id, data_channel_id, &frame)
        .await
    else {
        return;
    };
    let _ = send_outbound_frame(sender, data_channel_id, frame).await;
}

fn assistant_call_frame(
    method_id: &str,
    request_id: &str,
    idempotency_key: &str,
    payload: &Value,
    pending: &NativeAssistantPendingCall,
) -> Value {
    json!({
        "type": "call",
        "id": request_id,
        "method": method_id,
        "params": payload,
        "correlation_id": request_id,
        "idempotency_key": idempotency_key,
        "identity": {
            "principal_id": null,
            "effective_perms": null,
            "source": "native_voice",
            "method_type": "use",
            "caller_peer_id": pending.local_peer_id,
            "auth_grant_revision": null,
            "manifest_revision": null
        }
    })
}

pub fn install_for_app(app: &tauri::App) {
    let mesh_state = app.state::<MeshSessionState>().inner().clone();
    let native_webrtc_state = app.state::<NativeWebRtcState>().inner().clone();
    install_native_mesh_assistant_transport_factory(Arc::new(
        TauriNativeMeshAssistantTransportFactory {
            mesh_state,
            sender: Arc::new(NativeWebRtcMeshAssistantFrameSender {
                app: app.handle().clone(),
                state: native_webrtc_state,
            }),
        },
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::{
        aead::{Aead, KeyInit},
        Aes256Gcm, Nonce,
    };
    use std::sync::Mutex;

    #[derive(Default)]
    struct RecordingSender {
        frames: Mutex<Vec<(u64, String)>>,
        binary_frames: Mutex<Vec<(u64, Vec<u8>)>>,
    }

    #[async_trait(?Send)]
    impl NativeMeshAssistantFrameSender for RecordingSender {
        async fn send_text(
            &self,
            data_channel_id: u64,
            payload: String,
        ) -> Result<(), TransportError> {
            self.frames
                .lock()
                .expect("frames")
                .push((data_channel_id, payload));
            Ok(())
        }

        async fn send_binary(
            &self,
            data_channel_id: u64,
            payload: Vec<u8>,
        ) -> Result<(), TransportError> {
            self.binary_frames
                .lock()
                .expect("binary frames")
                .push((data_channel_id, payload));
            Ok(())
        }
    }

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("test runtime")
            .block_on(future)
    }

    fn mesh_route() -> NativeMeshAssistantTransportOptions {
        NativeMeshAssistantTransportOptions::new(
            aurora_voice_native::NativeMeshAssistantRoute::new(None).expect("route"),
            aurora_voice_native::TransportLimits {
                request_timeout: Duration::from_millis(40),
                ..Default::default()
            },
        )
        .expect("options")
    }

    async fn wait_for_frame_count(sender: &RecordingSender, count: usize) {
        for _ in 0..100 {
            if sender.frames.lock().expect("frames").len() >= count {
                return;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        panic!("timed out waiting for {count} frames");
    }

    fn open_test_frame(key: &[u8; 32], payload: &[u8]) -> Value {
        let (nonce, ciphertext) = payload.split_at(12);
        let cipher = Aes256Gcm::new_from_slice(key).expect("test key");
        let plaintext = cipher
            .decrypt(Nonce::from_slice(nonce), ciphertext)
            .expect("encrypted frame");
        serde_json::from_slice(&plaintext).expect("JSON frame")
    }

    #[test]
    fn invoke_encrypts_call_and_cancel_frames_for_an_encrypted_session() {
        block_on(async {
            let mesh_state = MeshSessionState::default();
            let key = [7_u8; 32];
            mesh_state
                .test_bind_native_assistant_peer_with_codec(
                    "peer-a",
                    42,
                    &[ids::ORCHESTRATOR_EXTERNAL_USER_INPUT],
                    true,
                    None,
                    key.to_vec(),
                )
                .await;
            let sender = Arc::new(RecordingSender::default());
            let mut transport = TauriNativeMeshAssistantTransport {
                mesh_state: mesh_state.clone(),
                sender: sender.clone(),
                options: mesh_route(),
                active_peer_id: None,
            };

            assert_eq!(
                transport
                    .invoke(NativeMeshInvokeRequest {
                        method_id: ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                        request_id: "request-encrypted",
                        idempotency_key: "idem-encrypted",
                        payload: &json!({"text": "hello"}),
                        timeout: Duration::from_millis(5),
                        cancellation: CancellationToken::new(),
                        preferred_peer_id: None,
                        require_advertised_method: true,
                    })
                    .await
                    .expect_err("timeout"),
                TransportError::Timeout
            );

            assert!(sender.frames.lock().expect("frames").is_empty());
            let binary_frames = sender.binary_frames.lock().expect("binary frames").clone();
            assert_eq!(binary_frames.len(), 2);
            assert_eq!(binary_frames[0].0, 42);
            assert_eq!(binary_frames[1].0, 42);
            let call = open_test_frame(&key, &binary_frames[0].1);
            assert_eq!(call["type"], "call");
            assert_eq!(call["method"], ids::ORCHESTRATOR_EXTERNAL_USER_INPUT);
            assert_eq!(call["id"], "request-encrypted");
            assert_eq!(
                open_test_frame(&key, &binary_frames[1].1),
                json!({"type": "cancel", "id": "request-encrypted"})
            );
        });
    }

    #[test]
    fn invoke_sends_typed_call_frame_and_reads_exact_result() {
        block_on(async {
            let mesh_state = MeshSessionState::default();
            mesh_state
                .test_bind_native_assistant_peer(
                    "peer-a",
                    42,
                    &[ids::ORCHESTRATOR_EXTERNAL_USER_INPUT],
                    true,
                    Some("local-node"),
                )
                .await;
            let sender = Arc::new(RecordingSender::default());
            let mut transport = TauriNativeMeshAssistantTransport {
                mesh_state: mesh_state.clone(),
                sender: sender.clone(),
                options: mesh_route(),
                active_peer_id: None,
            };
            let payload = json!({"text": "hello", "correlation_id": "request-1"});
            let response = transport.invoke(NativeMeshInvokeRequest {
                method_id: ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                request_id: "request-1",
                idempotency_key: "idem-1",
                payload: &payload,
                timeout: Duration::from_secs(1),
                cancellation: CancellationToken::new(),
                preferred_peer_id: None,
                require_advertised_method: true,
            });
            tokio::pin!(response);
            tokio::select! {
                result = &mut response => panic!("invoke finished before response: {result:?}"),
                _ = wait_for_frame_count(&sender, 1) => {}
            }

            let sent = sender.frames.lock().expect("frames").clone();
            assert_eq!(sent.len(), 1);
            assert_eq!(sent[0].0, 42);
            let frame: Value = serde_json::from_str(&sent[0].1).expect("frame");
            assert_eq!(frame["type"], "call");
            assert_eq!(frame["method"], ids::ORCHESTRATOR_EXTERNAL_USER_INPUT);
            assert_eq!(frame["id"], "request-1");
            assert_eq!(frame["idempotency_key"], "idem-1");
            assert_eq!(frame["identity"]["caller_peer_id"], "local-node");

            assert!(
                mesh_state
                    .test_settle_native_assistant_response(
                        "peer-a",
                        &json!({"type": "result", "id": "request-1", "result": {"text": "ready"}}),
                    )
                    .await
            );
            assert_eq!(response.await.expect("response"), json!({"text": "ready"}));
        });
    }

    #[test]
    fn invoke_waits_for_exact_peer_manifest_before_unknown_method() {
        block_on(async {
            let mesh_state = MeshSessionState::default();
            mesh_state
                .test_bind_native_assistant_peer_at("peer-a", 42, &[], true, None, 0, false)
                .await;
            let sender = Arc::new(RecordingSender::default());
            let mut transport = TauriNativeMeshAssistantTransport {
                mesh_state: mesh_state.clone(),
                sender: sender.clone(),
                options: NativeMeshAssistantTransportOptions::new(
                    aurora_voice_native::NativeMeshAssistantRoute::new(Some("peer-a".to_owned()))
                        .expect("route"),
                    aurora_voice_native::TransportLimits {
                        request_timeout: Duration::from_millis(250),
                        ..Default::default()
                    },
                )
                .expect("options"),
                active_peer_id: None,
            };
            let payload = json!({"text": "hello"});
            let response = transport.invoke(NativeMeshInvokeRequest {
                method_id: ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                request_id: "request-delayed-manifest",
                idempotency_key: "idem-delayed-manifest",
                payload: &payload,
                timeout: Duration::from_millis(250),
                cancellation: CancellationToken::new(),
                preferred_peer_id: Some("peer-a"),
                require_advertised_method: true,
            });
            tokio::pin!(response);
            tokio::time::sleep(Duration::from_millis(25)).await;
            assert!(sender.frames.lock().expect("frames").is_empty());

            mesh_state
                .test_bind_native_assistant_peer_at(
                    "peer-a",
                    42,
                    &[ids::ORCHESTRATOR_EXTERNAL_USER_INPUT],
                    true,
                    None,
                    10,
                    true,
                )
                .await;
            tokio::select! {
                result = &mut response => panic!("invoke finished before response: {result:?}"),
                _ = wait_for_frame_count(&sender, 1) => {}
            }
            assert!(
                mesh_state
                    .test_settle_native_assistant_response(
                        "peer-a",
                        &json!({
                            "type": "result",
                            "id": "request-delayed-manifest",
                            "result": {"text": "ready"}
                        }),
                    )
                    .await
            );
            assert_eq!(response.await.expect("response"), json!({"text": "ready"}));
        });
    }

    #[test]
    fn invoke_without_preferred_peer_waits_for_single_peer_manifest() {
        block_on(async {
            let mesh_state = MeshSessionState::default();
            mesh_state
                .test_bind_native_assistant_peer_at("peer-a", 42, &[], true, None, 0, false)
                .await;
            let sender = Arc::new(RecordingSender::default());
            let mut transport = TauriNativeMeshAssistantTransport {
                mesh_state: mesh_state.clone(),
                sender: sender.clone(),
                options: NativeMeshAssistantTransportOptions::new(
                    aurora_voice_native::NativeMeshAssistantRoute::new(None).expect("route"),
                    aurora_voice_native::TransportLimits {
                        request_timeout: Duration::from_millis(250),
                        ..Default::default()
                    },
                )
                .expect("options"),
                active_peer_id: None,
            };
            let payload = json!({"text": "hello"});
            let response = transport.invoke(NativeMeshInvokeRequest {
                method_id: ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                request_id: "request-auto-manifest",
                idempotency_key: "idem-auto-manifest",
                payload: &payload,
                timeout: Duration::from_millis(250),
                cancellation: CancellationToken::new(),
                preferred_peer_id: None,
                require_advertised_method: true,
            });
            tokio::pin!(response);
            tokio::time::sleep(Duration::from_millis(25)).await;
            assert!(sender.frames.lock().expect("frames").is_empty());

            mesh_state
                .test_bind_native_assistant_peer_at(
                    "peer-a",
                    42,
                    &[ids::ORCHESTRATOR_EXTERNAL_USER_INPUT],
                    true,
                    None,
                    10,
                    true,
                )
                .await;
            tokio::select! {
                result = &mut response => panic!("invoke finished before response: {result:?}"),
                _ = wait_for_frame_count(&sender, 1) => {}
            }
            assert!(
                mesh_state
                    .test_settle_native_assistant_response(
                        "peer-a",
                        &json!({
                            "type": "result",
                            "id": "request-auto-manifest",
                            "result": {"text": "ready"}
                        }),
                    )
                    .await
            );
            assert_eq!(response.await.expect("response"), json!({"text": "ready"}));
        });
    }

    #[test]
    fn invoke_times_out_and_removes_pending_call() {
        block_on(async {
            let mesh_state = MeshSessionState::default();
            mesh_state
                .test_bind_native_assistant_peer(
                    "peer-a",
                    42,
                    &[ids::ORCHESTRATOR_EXTERNAL_USER_INPUT],
                    true,
                    None,
                )
                .await;
            let sender = Arc::new(RecordingSender::default());
            let mut transport = TauriNativeMeshAssistantTransport {
                mesh_state: mesh_state.clone(),
                sender: sender.clone(),
                options: mesh_route(),
                active_peer_id: None,
            };
            assert_eq!(
                transport
                    .invoke(NativeMeshInvokeRequest {
                        method_id: ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                        request_id: "request-timeout",
                        idempotency_key: "idem-timeout",
                        payload: &json!({"text": "hello"}),
                        timeout: Duration::from_millis(5),
                        cancellation: CancellationToken::new(),
                        preferred_peer_id: None,
                        require_advertised_method: true,
                    })
                    .await
                    .expect_err("timeout"),
                TransportError::Timeout
            );
            let sent = sender.frames.lock().expect("frames").clone();
            assert_eq!(sent.len(), 2);
            let cancel: Value = serde_json::from_str(&sent[1].1).expect("cancel");
            assert_eq!(sent[1].0, 42);
            assert_eq!(cancel, json!({"type": "cancel", "id": "request-timeout"}));
            assert!(mesh_state
                .test_settle_native_assistant_response(
                    "peer-a",
                    &json!({"type": "result", "id": "request-timeout", "result": {"text": "late"}}),
                )
                .await);
        });
    }

    #[test]
    fn invoke_sends_cancel_frame_when_token_is_cancelled_after_send() {
        block_on(async {
            let mesh_state = MeshSessionState::default();
            mesh_state
                .test_bind_native_assistant_peer(
                    "peer-a",
                    42,
                    &[ids::ORCHESTRATOR_EXTERNAL_USER_INPUT],
                    true,
                    None,
                )
                .await;
            let sender = Arc::new(RecordingSender::default());
            let mut transport = TauriNativeMeshAssistantTransport {
                mesh_state: mesh_state.clone(),
                sender: sender.clone(),
                options: mesh_route(),
                active_peer_id: None,
            };
            let cancellation = CancellationToken::new();
            let payload = json!({"text": "hello"});
            let response = transport.invoke(NativeMeshInvokeRequest {
                method_id: ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                request_id: "request-cancel",
                idempotency_key: "idem-cancel",
                payload: &payload,
                timeout: Duration::from_secs(1),
                cancellation: cancellation.clone(),
                preferred_peer_id: None,
                require_advertised_method: true,
            });
            tokio::pin!(response);
            tokio::select! {
                result = &mut response => panic!("invoke finished before cancellation: {result:?}"),
                _ = wait_for_frame_count(&sender, 1) => {}
            }
            cancellation.cancel();
            assert_eq!(
                response.await.expect_err("cancelled"),
                TransportError::Cancelled
            );
            let sent = sender.frames.lock().expect("frames").clone();
            assert_eq!(sent.len(), 2);
            assert_eq!(sent[1].0, 42);
            let cancel: Value = serde_json::from_str(&sent[1].1).expect("cancel");
            assert_eq!(cancel, json!({"type": "cancel", "id": "request-cancel"}));
            assert!(mesh_state
                .test_settle_native_assistant_response(
                    "peer-a",
                    &json!({"type": "result", "id": "request-cancel", "result": {"text": "late"}}),
                )
                .await);
        });
    }

    #[test]
    fn interrupt_fails_closed_when_active_peer_does_not_advertise_interrupt() {
        block_on(async {
            let mesh_state = MeshSessionState::default();
            mesh_state
                .test_bind_native_assistant_peer(
                    "peer-a",
                    42,
                    &[ids::ORCHESTRATOR_EXTERNAL_USER_INPUT],
                    true,
                    None,
                )
                .await;
            let sender = Arc::new(RecordingSender::default());
            let mut transport = TauriNativeMeshAssistantTransport {
                mesh_state,
                sender: sender.clone(),
                options: mesh_route(),
                active_peer_id: Some("peer-a".to_owned()),
            };
            assert_eq!(
                transport
                    .invoke(NativeMeshInvokeRequest {
                        method_id: ids::ORCHESTRATOR_INTERRUPT,
                        request_id: "request-interrupt",
                        idempotency_key: "idem-interrupt",
                        payload: &json!({"session_id": "s", "request_id": "r"}),
                        timeout: Duration::from_secs(1),
                        cancellation: CancellationToken::new(),
                        preferred_peer_id: Some("peer-a"),
                        require_advertised_method: true,
                    })
                    .await
                    .expect_err("interrupt not advertised"),
                TransportError::UnknownMethod
            );
            assert!(sender.frames.lock().expect("frames").is_empty());
        });
    }

    #[test]
    fn invoke_honors_pre_cancelled_token_without_sending() {
        block_on(async {
            let mesh_state = MeshSessionState::default();
            mesh_state
                .test_bind_native_assistant_peer(
                    "peer-a",
                    42,
                    &[ids::ORCHESTRATOR_EXTERNAL_USER_INPUT],
                    true,
                    None,
                )
                .await;
            let sender = Arc::new(RecordingSender::default());
            let mut transport = TauriNativeMeshAssistantTransport {
                mesh_state,
                sender: sender.clone(),
                options: mesh_route(),
                active_peer_id: None,
            };
            let cancellation = CancellationToken::new();
            cancellation.cancel();
            assert_eq!(
                transport
                    .invoke(NativeMeshInvokeRequest {
                        method_id: ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                        request_id: "request-cancelled",
                        idempotency_key: "idem-cancelled",
                        payload: &json!({"text": "hello"}),
                        timeout: Duration::from_secs(1),
                        cancellation,
                        preferred_peer_id: None,
                        require_advertised_method: true,
                    })
                    .await
                    .expect_err("cancelled"),
                TransportError::Cancelled
            );
            assert!(sender.frames.lock().expect("frames").is_empty());
        });
    }
}
