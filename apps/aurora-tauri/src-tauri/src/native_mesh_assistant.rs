use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use aurora_contracts::ids;
use aurora_voice_core::CancellationToken;
use aurora_voice_native::{
    install_native_mesh_assistant_transport_factory, NativeMeshAssistantTransport,
    NativeMeshAssistantTransportFactory, NativeMeshAssistantTransportOptions,
    NativeMeshAssistantTurnLink, NativeMeshExternalUserInput, NativeMeshExternalUserInputStream,
    NativeMeshInterruptRequest, TransportError,
};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::mesh_session::{MeshSessionState, NativeAssistantPendingCall, OutboundDataChannelFrame};
use crate::native_event_hub::{
    assistant_failure_event_with_link, global_native_event_hub, NativeEventPeerPublicationLease,
};
use crate::native_webrtc::{self, NativeWebRtcState};

const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(10);

#[async_trait]
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

#[async_trait]
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
    stream_events: bool,
    turn: Option<NativeMeshAssistantTurnLink>,
}

struct NativeMeshBeginCallRequest<'a> {
    preferred_peer_id: Option<&'a str>,
    method_id: &'a str,
    request_id: &'a str,
    require_advertised_method: bool,
    stream_events: bool,
    turn: Option<NativeMeshAssistantTurnLink>,
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
                stream_events: false,
                turn: request.turn().cloned(),
            })
            .await;
        if response.is_err() {
            self.active_peer_id = None;
        }
        response
    }

    async fn external_user_input_stream(
        &mut self,
        request: NativeMeshExternalUserInput,
        cancellation: CancellationToken,
    ) -> Result<NativeMeshExternalUserInputStream, TransportError> {
        let preferred = self
            .options
            .route()
            .preferred_stable_peer_id()
            .map(str::to_owned);
        let stream = self
            .invoke_stream(NativeMeshInvokeRequest {
                method_id: ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                request_id: request.request_id(),
                idempotency_key: request.idempotency_key(),
                payload: request.payload(),
                timeout: request.timeout(),
                cancellation,
                preferred_peer_id: preferred.as_deref(),
                require_advertised_method: true,
                stream_events: true,
                turn: request.turn().cloned(),
            })
            .await;
        if stream.is_err() {
            self.active_peer_id = None;
        }
        stream
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
            stream_events: false,
            turn: None,
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
            stream_events,
            turn,
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
                stream_events,
                turn,
            })
            .await?;
        let peer_id = pending.peer_id.clone();
        let frame = assistant_call_frame(method_id, request_id, idempotency_key, payload, &pending);
        let encoded = match serde_json::to_vec(&frame) {
            Ok(encoded) => encoded,
            Err(_) => {
                self.mesh_state
                    .cancel_native_assistant_call(&peer_id, request_id)
                    .await;
                return Err(TransportError::InvalidPayload);
            }
        };
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
        let native_event_epoch = pending.native_event_epoch;
        let native_event_lease = pending.native_event_lease.clone();
        let turn = pending.turn.clone();
        let response = await_response(
            self.mesh_state.clone(),
            Arc::clone(&self.sender),
            pending,
            request_id.to_owned(),
            remaining_timeout,
            self.options.limits().max_response_bytes,
            cancellation,
        )
        .await;
        if let Err(error) = &response {
            publish_assistant_failure(
                native_event_epoch,
                &native_event_lease,
                &peer_id,
                request_id,
                turn.as_ref(),
                true,
                error,
            );
        }
        response
    }

    async fn invoke_stream(
        &mut self,
        request: NativeMeshInvokeRequest<'_>,
    ) -> Result<NativeMeshExternalUserInputStream, TransportError> {
        let NativeMeshInvokeRequest {
            method_id,
            request_id,
            idempotency_key,
            payload,
            timeout,
            cancellation,
            preferred_peer_id,
            require_advertised_method,
            stream_events,
            turn,
        } = request;
        if cancellation.is_cancelled() {
            return Err(TransportError::Cancelled);
        }
        if !stream_events {
            return Err(TransportError::InvalidConfiguration);
        }
        let started = Instant::now();
        let mut pending = self
            .begin_call_when_ready(NativeMeshBeginCallRequest {
                preferred_peer_id,
                method_id,
                request_id,
                require_advertised_method,
                stream_events: true,
                timeout,
                started,
                cancellation: &cancellation,
                turn,
            })
            .await?;
        let peer_id = pending.peer_id.clone();
        let native_event_epoch = pending.native_event_epoch;
        let native_event_lease = pending.native_event_lease.clone();
        let turn = pending.turn.clone();
        let events = pending
            .events
            .take()
            .ok_or(TransportError::InvalidConfiguration)?;
        let subscription_ack = pending
            .subscription_ack
            .take()
            .ok_or(TransportError::InvalidConfiguration)?;
        let subscribe = assistant_subscribe_frame(request_id, idempotency_key);
        if let Err(error) = send_encoded_frame(
            &self.mesh_state,
            &self.sender,
            &peer_id,
            pending.data_channel_id,
            &subscribe,
        )
        .await
        {
            self.mesh_state
                .cancel_native_assistant_call(&peer_id, request_id)
                .await;
            return Err(error);
        }
        let remaining_subscribe_timeout = timeout
            .checked_sub(started.elapsed())
            .unwrap_or(Duration::ZERO);
        if remaining_subscribe_timeout.is_zero() {
            self.mesh_state
                .abandon_native_assistant_call(&peer_id, request_id)
                .await;
            return Err(TransportError::Timeout);
        }
        let subscribed = await_subscribe_ack(
            subscription_ack,
            request_id,
            idempotency_key,
            remaining_subscribe_timeout,
            &cancellation,
            &self.mesh_state,
            &self.sender,
            &peer_id,
            pending.data_channel_id,
        )
        .await;
        let subscription_id = match subscribed {
            Ok(subscription_id) => subscription_id,
            Err(error) => {
                self.mesh_state
                    .abandon_native_assistant_call(&peer_id, request_id)
                    .await;
                return Err(error);
            }
        };
        let cleanup = NativeMeshSubscriptionCleanup::new(
            self.mesh_state.clone(),
            Arc::clone(&self.sender),
            peer_id.clone(),
            pending.data_channel_id,
            subscription_id,
            request_id.to_owned(),
        );
        if cancellation.is_cancelled() {
            cleanup.unsubscribe().await;
            self.mesh_state
                .abandon_native_assistant_call(&peer_id, request_id)
                .await;
            return Err(TransportError::Cancelled);
        }
        let remaining_timeout = timeout
            .checked_sub(started.elapsed())
            .unwrap_or(Duration::ZERO);
        if remaining_timeout.is_zero() {
            cleanup.unsubscribe().await;
            self.mesh_state
                .abandon_native_assistant_call(&peer_id, request_id)
                .await;
            return Err(TransportError::Timeout);
        }
        let frame = assistant_call_frame(method_id, request_id, idempotency_key, payload, &pending);
        let encoded = match serde_json::to_vec(&frame) {
            Ok(encoded) => encoded,
            Err(_) => {
                cleanup.unsubscribe().await;
                self.mesh_state
                    .cancel_native_assistant_call(&peer_id, request_id)
                    .await;
                return Err(TransportError::InvalidPayload);
            }
        };
        if encoded.len() > self.options.limits().max_request_bytes {
            cleanup.unsubscribe().await;
            self.mesh_state
                .cancel_native_assistant_call(&peer_id, request_id)
                .await;
            return Err(TransportError::RequestTooLarge);
        }
        if let Err(error) = send_encoded_frame(
            &self.mesh_state,
            &self.sender,
            &peer_id,
            pending.data_channel_id,
            &frame,
        )
        .await
        {
            cleanup.unsubscribe().await;
            self.mesh_state
                .cancel_native_assistant_call(&peer_id, request_id)
                .await;
            return Err(error);
        }
        self.active_peer_id = Some(peer_id.clone());
        let remaining_timeout = timeout
            .checked_sub(started.elapsed())
            .unwrap_or(Duration::ZERO);
        let mesh_state = self.mesh_state.clone();
        let sender = Arc::clone(&self.sender);
        let request_id = request_id.to_owned();
        let max_response_bytes = self.options.limits().max_response_bytes;
        let terminal_peer_id = peer_id.clone();
        let terminal_cleanup = cleanup.clone();
        let terminal = Box::pin(async move {
            let result = await_response(
                mesh_state,
                sender,
                pending,
                request_id.clone(),
                remaining_timeout,
                max_response_bytes,
                cancellation,
            )
            .await;
            terminal_cleanup.unsubscribe().await;
            if let Err(error) = &result {
                publish_assistant_failure(
                    native_event_epoch,
                    &native_event_lease,
                    &terminal_peer_id,
                    &request_id,
                    turn.as_ref(),
                    false,
                    error,
                );
            }
            result
        });
        Ok(NativeMeshExternalUserInputStream::new_with_cleanup(
            events,
            terminal,
            Box::new(move || cleanup.unsubscribe_background()),
        ))
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
            stream_events,
            turn,
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
                    stream_events,
                    turn.clone(),
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

#[derive(Clone)]
struct NativeMeshSubscriptionCleanup {
    mesh_state: MeshSessionState,
    sender: Arc<dyn NativeMeshAssistantFrameSender>,
    peer_id: String,
    data_channel_id: u64,
    subscription_id: String,
    request_id: String,
    complete: Arc<AtomicBool>,
}

impl NativeMeshSubscriptionCleanup {
    fn new(
        mesh_state: MeshSessionState,
        sender: Arc<dyn NativeMeshAssistantFrameSender>,
        peer_id: String,
        data_channel_id: u64,
        subscription_id: String,
        request_id: String,
    ) -> Self {
        Self {
            mesh_state,
            sender,
            peer_id,
            data_channel_id,
            subscription_id,
            request_id,
            complete: Arc::new(AtomicBool::new(false)),
        }
    }

    async fn unsubscribe(&self) {
        if self.complete.swap(true, Ordering::AcqRel) {
            return;
        }
        let frame = assistant_unsubscribe_frame(&self.subscription_id);
        let _ = send_encoded_frame(
            &self.mesh_state,
            &self.sender,
            &self.peer_id,
            self.data_channel_id,
            &frame,
        )
        .await;
    }

    fn unsubscribe_background(self) {
        if self.complete.swap(true, Ordering::AcqRel) {
            return;
        }
        let frame = assistant_unsubscribe_frame(&self.subscription_id);
        let request_id = self.request_id;
        let mesh_state = self.mesh_state;
        let sender = self.sender;
        let peer_id = self.peer_id;
        let data_channel_id = self.data_channel_id;
        tokio::spawn(async move {
            send_cancel_frame(&mesh_state, &sender, &peer_id, data_channel_id, &request_id).await;
            let _ =
                send_encoded_frame(&mesh_state, &sender, &peer_id, data_channel_id, &frame).await;
            mesh_state
                .abandon_native_assistant_call(&peer_id, &request_id)
                .await;
        });
    }
}

async fn await_subscribe_ack(
    mut subscription_ack: tokio::sync::oneshot::Receiver<Result<Value, TransportError>>,
    request_id: &str,
    correlation_id: &str,
    timeout: Duration,
    cancellation: &CancellationToken,
    mesh_state: &MeshSessionState,
    sender: &Arc<dyn NativeMeshAssistantFrameSender>,
    peer_id: &str,
    data_channel_id: u64,
) -> Result<String, TransportError> {
    let timeout = tokio::time::sleep(timeout);
    tokio::pin!(timeout);
    loop {
        tokio::select! {
            ack = &mut subscription_ack => {
                let frame = ack.map_err(|_| TransportError::RequestFailed)??;
                match validate_subscribed_frame(&frame, request_id, correlation_id) {
                    Ok(subscription_id) => return Ok(subscription_id),
                    Err(error) => {
                        if let Some(subscription_id) = accepted_subscription_id(&frame, request_id) {
                            let unsubscribe = assistant_unsubscribe_frame(&subscription_id);
                            let _ = send_encoded_frame(mesh_state, sender, peer_id, data_channel_id, &unsubscribe).await;
                        }
                        return Err(error);
                    }
                }
            }
            _ = &mut timeout => return Err(TransportError::Timeout),
            _ = tokio::time::sleep(CANCEL_POLL_INTERVAL) => {
                if cancellation.is_cancelled() {
                    return Err(TransportError::Cancelled);
                }
            }
        }
    }
}

fn accepted_subscription_id(frame: &Value, request_id: &str) -> Option<String> {
    if frame.get("type").and_then(Value::as_str) != Some("subscribed") {
        return None;
    }
    if frame.get("id").and_then(Value::as_str) != Some(request_id) {
        return None;
    }
    if frame.get("accepted").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    frame
        .get("subscription_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn validate_subscribed_frame(
    frame: &Value,
    request_id: &str,
    correlation_id: &str,
) -> Result<String, TransportError> {
    if frame.get("type").and_then(Value::as_str) != Some("subscribed") {
        return Err(TransportError::InvalidResponse);
    }
    if frame.get("id").and_then(Value::as_str) != Some(request_id) {
        return Err(TransportError::InvalidResponse);
    }
    if frame.get("accepted").and_then(Value::as_bool) != Some(true) {
        return Err(TransportError::InvalidResponse);
    }
    let subscription_id = frame
        .get("subscription_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(TransportError::InvalidResponse)?;
    let accepted_topics = frame
        .get("accepted_topics")
        .and_then(Value::as_array)
        .ok_or(TransportError::InvalidResponse)?;
    if !accepted_topics
        .iter()
        .any(|topic| topic.as_str() == Some(ids::ORCHESTRATOR_RESPONSE))
    {
        return Err(TransportError::InvalidResponse);
    }
    let correlation_ids = frame
        .get("correlation_ids")
        .and_then(Value::as_array)
        .ok_or(TransportError::InvalidResponse)?;
    if !correlation_ids
        .iter()
        .any(|id| id.as_str() == Some(correlation_id))
    {
        return Err(TransportError::InvalidResponse);
    }
    let ttl_seconds = frame
        .get("ttl_seconds")
        .and_then(Value::as_f64)
        .filter(|ttl| *ttl > 0.0 && *ttl <= 60.0)
        .ok_or(TransportError::InvalidResponse)?;
    let _ = ttl_seconds;
    if !frame
        .get("rejected_topics")
        .and_then(Value::as_array)
        .is_some_and(Vec::is_empty)
    {
        return Err(TransportError::InvalidResponse);
    }
    if !frame.get("reason").is_some_and(Value::is_null) {
        return Err(TransportError::InvalidResponse);
    }
    if !frame.get("idempotent").is_some_and(Value::is_boolean) {
        return Err(TransportError::InvalidResponse);
    }
    Ok(subscription_id.to_owned())
}

async fn await_response(
    mesh_state: MeshSessionState,
    sender: Arc<dyn NativeMeshAssistantFrameSender>,
    pending: NativeAssistantPendingCall,
    request_id: String,
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
                send_cancel_frame(&mesh_state, &sender, &peer_id, data_channel_id, &request_id).await;
                mesh_state.abandon_native_assistant_call(&peer_id, &request_id).await;
                return Err(TransportError::Timeout);
            }
            _ = tokio::time::sleep(CANCEL_POLL_INTERVAL) => {
                if cancellation.is_cancelled() {
                    send_cancel_frame(&mesh_state, &sender, &peer_id, data_channel_id, &request_id).await;
                    mesh_state.abandon_native_assistant_call(&peer_id, &request_id).await;
                    return Err(TransportError::Cancelled);
                }
            }
        }
    }
}

async fn send_encoded_frame(
    mesh_state: &MeshSessionState,
    sender: &Arc<dyn NativeMeshAssistantFrameSender>,
    peer_id: &str,
    data_channel_id: u64,
    frame: &Value,
) -> Result<(), TransportError> {
    let outbound = mesh_state
        .encode_native_assistant_frame(peer_id, data_channel_id, frame)
        .await?;
    send_outbound_frame(sender, data_channel_id, outbound).await
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

fn assistant_subscribe_frame(request_id: &str, correlation_id: &str) -> Value {
    json!({
        "type": "subscribe",
        "id": request_id,
        "topics": [ids::ORCHESTRATOR_RESPONSE],
        "correlation_ids": [correlation_id],
        "ttl_seconds": 60,
    })
}

fn assistant_unsubscribe_frame(subscription_id: &str) -> Value {
    json!({
        "type": "unsubscribe",
        "id": subscription_id,
    })
}

fn publish_assistant_failure(
    native_event_epoch: u64,
    native_event_lease: &NativeEventPeerPublicationLease,
    peer_id: &str,
    request_id: &str,
    turn: Option<&NativeMeshAssistantTurnLink>,
    publish_voice_linked: bool,
    error: &TransportError,
) {
    if turn.is_some() && !publish_voice_linked {
        return;
    }
    let _ = global_native_event_hub().publish_with_peer_lease_if_epoch(
        native_event_epoch,
        native_event_lease,
        assistant_failure_event_with_link(
            peer_id,
            request_id,
            transport_error_reason_code(error),
            turn.map(NativeMeshAssistantTurnLink::generation),
            turn.map(NativeMeshAssistantTurnLink::session_id),
            turn.map(NativeMeshAssistantTurnLink::correlation_id),
        ),
    );
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

fn transport_error_reason_code(error: &TransportError) -> &'static str {
    match error {
        TransportError::Cancelled => "cancelled",
        TransportError::InvalidConfiguration => "invalid_configuration",
        TransportError::InvalidPayload => "invalid_payload",
        TransportError::InvalidResponse => "invalid_response",
        TransportError::RequestFailed => "request_failed",
        TransportError::RequestTooLarge => "request_too_large",
        TransportError::ResponseTooLarge => "response_too_large",
        TransportError::Timeout => "timeout",
        TransportError::UnknownMethod => "unknown_method",
        TransportError::HttpStatus { .. } => "http_status",
        _ => "transport_error",
    }
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

    #[async_trait]
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

    #[test]
    fn revoked_peer_lease_cannot_be_selected_until_rebound() {
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
            global_native_event_hub().clear_peer("peer-a");
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
                        request_id: "request-after-revoke",
                        idempotency_key: "idem-after-revoke",
                        payload: &json!({"text": "blocked"}),
                        timeout: Duration::from_millis(20),
                        cancellation: CancellationToken::new(),
                        preferred_peer_id: Some("peer-a"),
                        require_advertised_method: true,
                        stream_events: false,
                        turn: None,
                    })
                    .await
                    .expect_err("revoked binding cannot be selected"),
                TransportError::InvalidConfiguration
            );
            assert!(sender.frames.lock().expect("frames").is_empty());

            mesh_state
                .test_bind_native_assistant_peer(
                    "peer-a",
                    42,
                    &[ids::ORCHESTRATOR_EXTERNAL_USER_INPUT],
                    true,
                    Some("local-node"),
                )
                .await;
            let payload = json!({"text": "allowed"});
            let response = transport.invoke(NativeMeshInvokeRequest {
                method_id: ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                request_id: "request-after-rebind",
                idempotency_key: "idem-after-rebind",
                payload: &payload,
                timeout: Duration::from_millis(40),
                cancellation: CancellationToken::new(),
                preferred_peer_id: Some("peer-a"),
                require_advertised_method: true,
                stream_events: false,
                turn: None,
            });
            tokio::pin!(response);
            tokio::select! {
                _ = &mut response => panic!("rebound request completed before frame send"),
                _ = wait_for_frame_count(&sender, 1) => {}
            }
            assert_eq!(sender.frames.lock().expect("frames").len(), 1);
        });
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
                        stream_events: false,
                        turn: None,
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
                stream_events: false,
                turn: None,
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
    fn invoke_stream_waits_for_subscribed_ack_before_call_and_unsubscribes_on_terminal() {
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
            let payload = json!({"text": "hello", "correlation_id": "voice-correlation-native-9"});
            let stream = transport.invoke_stream(NativeMeshInvokeRequest {
                method_id: ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                request_id: "voice-request-native-9",
                idempotency_key: "voice-correlation-native-9",
                payload: &payload,
                timeout: Duration::from_secs(1),
                cancellation: CancellationToken::new(),
                preferred_peer_id: None,
                require_advertised_method: true,
                stream_events: true,
                turn: Some(NativeMeshAssistantTurnLink::new(
                    9,
                    "voice-session-native-9",
                    "voice-request-native-9",
                    "voice-correlation-native-9",
                )),
            });
            tokio::pin!(stream);
            tokio::select! {
                _ = &mut stream => panic!("stream completed before subscribe acknowledgement"),
                _ = wait_for_frame_count(&sender, 1) => {}
            }
            assert_eq!(sender.frames.lock().expect("frames").len(), 1);
            let subscribe: Value =
                serde_json::from_str(&sender.frames.lock().expect("frames")[0].1)
                    .expect("subscribe frame");
            assert_eq!(subscribe["type"], "subscribe");
            assert_eq!(subscribe["topics"], json!([ids::ORCHESTRATOR_RESPONSE]));
            assert_eq!(
                subscribe["correlation_ids"],
                json!(["voice-correlation-native-9"])
            );

            assert!(
                mesh_state
                    .test_settle_native_assistant_response(
                        "peer-a",
                        &json!({
                            "type": "subscribed",
                            "id": "voice-request-native-9",
                            "subscription_id": "voice-request-native-9",
                            "accepted": true,
                            "accepted_topics": [ids::ORCHESTRATOR_RESPONSE],
                            "rejected_topics": [],
                            "correlation_ids": ["voice-correlation-native-9"],
                            "ttl_seconds": 60,
                            "reason": null,
                            "idempotent": false
                        }),
                    )
                    .await
            );
            let mut stream = stream.await.expect("stream pending");
            let sent = sender.frames.lock().expect("frames").clone();
            let call: Value = serde_json::from_str(&sent[1].1).expect("call frame");
            assert_eq!(call["type"], "call");
            assert_eq!(call["method"], ids::ORCHESTRATOR_EXTERNAL_USER_INPUT);
            assert_eq!(call["id"], "voice-request-native-9");
            assert!(
                mesh_state
                    .test_settle_native_assistant_response(
                        "peer-a",
                        &json!({
                            "type": "event",
                            "topic": ids::ORCHESTRATOR_RESPONSE,
                            "correlation_id": "voice-correlation-native-9",
                            "params": {
                                "kind": "assistant.delta",
                                "sequence": 1,
                                "session_id": "voice-session-native-9",
                                "request_id": "voice-request-native-9",
                                "correlation_id": "voice-correlation-native-9",
                                "delta": "hel"
                            }
                        }),
                    )
                    .await
            );
            let event = stream
                .next_event()
                .await
                .expect("forwarded event")
                .expect("event result");
            assert_eq!(event["params"]["generation"], 9);

            assert!(
                mesh_state
                    .test_settle_native_assistant_response(
                        "peer-a",
                        &json!({
                            "type": "result",
                            "id": "voice-request-native-9",
                            "result": {
                                "text": "hello",
                                "session_id": "voice-session-native-9",
                                "request_id": "voice-request-native-9",
                                "correlation_id": "voice-correlation-native-9"
                            }
                        }),
                    )
                    .await
            );
            assert_eq!(
                stream.terminal_response().await.expect("terminal response"),
                json!({
                    "text": "hello",
                    "session_id": "voice-session-native-9",
                    "request_id": "voice-request-native-9",
                    "correlation_id": "voice-correlation-native-9"
                })
            );
            wait_for_frame_count(&sender, 3).await;
            let sent = sender.frames.lock().expect("frames").clone();
            assert_eq!(
                sent.iter()
                    .filter_map(|(_, frame)| serde_json::from_str::<Value>(frame).ok())
                    .filter(|frame| frame["type"] == "unsubscribe"
                        && frame["id"] == "voice-request-native-9")
                    .count(),
                1
            );
        });
    }

    #[test]
    fn invoke_stream_full_observer_queue_preserves_terminal_response_and_unsubscribes() {
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
            let payload =
                json!({"text": "hello", "correlation_id": "voice-correlation-full-queue"});
            let stream = transport.invoke_stream(NativeMeshInvokeRequest {
                method_id: ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                request_id: "voice-request-full-queue",
                idempotency_key: "voice-correlation-full-queue",
                payload: &payload,
                timeout: Duration::from_secs(1),
                cancellation: CancellationToken::new(),
                preferred_peer_id: None,
                require_advertised_method: true,
                stream_events: true,
                turn: Some(NativeMeshAssistantTurnLink::new(
                    101,
                    "voice-session-full-queue",
                    "voice-request-full-queue",
                    "voice-correlation-full-queue",
                )),
            });
            tokio::pin!(stream);
            tokio::select! {
                _ = &mut stream => panic!("stream completed before subscribe acknowledgement"),
                _ = wait_for_frame_count(&sender, 1) => {}
            }
            assert!(
                mesh_state
                    .test_settle_native_assistant_response(
                        "peer-a",
                        &json!({
                            "type": "subscribed",
                            "id": "voice-request-full-queue",
                            "subscription_id": "voice-request-full-queue",
                            "accepted": true,
                            "accepted_topics": [ids::ORCHESTRATOR_RESPONSE],
                            "rejected_topics": [],
                            "correlation_ids": ["voice-correlation-full-queue"],
                            "ttl_seconds": 60,
                            "reason": null,
                            "idempotent": false
                        }),
                    )
                    .await
            );
            let stream = stream.await.expect("stream pending");
            wait_for_frame_count(&sender, 2).await;

            for sequence in 1..=33_u64 {
                assert!(
                    mesh_state
                        .test_settle_native_assistant_response(
                            "peer-a",
                            &json!({
                                "type": "event",
                                "topic": ids::ORCHESTRATOR_RESPONSE,
                                "correlation_id": "voice-correlation-full-queue",
                                "params": {
                                    "kind": "assistant.delta",
                                    "sequence": sequence,
                                    "session_id": "voice-session-full-queue",
                                    "request_id": "voice-request-full-queue",
                                    "correlation_id": "voice-correlation-full-queue",
                                    "delta": "x"
                                }
                            }),
                        )
                        .await
                );
            }

            assert!(
                mesh_state
                    .test_settle_native_assistant_response(
                        "peer-a",
                        &json!({
                            "type": "result",
                            "id": "voice-request-full-queue",
                            "result": {
                                "text": "terminal answer",
                                "session_id": "voice-session-full-queue",
                                "request_id": "voice-request-full-queue",
                                "correlation_id": "voice-correlation-full-queue"
                            }
                        }),
                    )
                    .await
            );
            assert_eq!(
                stream.terminal_response().await.expect("terminal response"),
                json!({
                    "text": "terminal answer",
                    "session_id": "voice-session-full-queue",
                    "request_id": "voice-request-full-queue",
                    "correlation_id": "voice-correlation-full-queue"
                })
            );
            wait_for_frame_count(&sender, 3).await;
            let sent = sender.frames.lock().expect("frames").clone();
            assert_eq!(
                sent.iter()
                    .filter_map(|(_, frame)| serde_json::from_str::<Value>(frame).ok())
                    .filter(|frame| frame["type"] == "unsubscribe"
                        && frame["id"] == "voice-request-full-queue")
                    .count(),
                1
            );
        });
    }

    #[test]
    fn invoke_stream_rejects_subscribe_failure_before_call() {
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
            let payload = json!({"text": "hello"});
            let stream = transport.invoke_stream(NativeMeshInvokeRequest {
                method_id: ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                request_id: "request-rejected-subscribe",
                idempotency_key: "corr-rejected-subscribe",
                payload: &payload,
                timeout: Duration::from_secs(1),
                cancellation: CancellationToken::new(),
                preferred_peer_id: None,
                require_advertised_method: true,
                stream_events: true,
                turn: None,
            });
            tokio::pin!(stream);
            tokio::select! {
                _ = &mut stream => panic!("stream completed before subscribe acknowledgement"),
                _ = wait_for_frame_count(&sender, 1) => {}
            }
            assert!(
                mesh_state
                    .test_settle_native_assistant_response(
                        "peer-a",
                        &json!({"type": "subscribe_rejected", "id": "request-rejected-subscribe", "reason": "not_authorized"}),
                    )
                    .await
            );
            assert_eq!(
                stream.await.err().expect("subscribe rejected"),
                TransportError::UnknownEvent
            );
            assert_eq!(sender.frames.lock().expect("frames").len(), 1);
        });
    }

    #[test]
    fn invoke_stream_unsubscribes_invalid_accepted_ack_before_call() {
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
            let payload = json!({"text": "hello"});
            let stream = transport.invoke_stream(NativeMeshInvokeRequest {
                method_id: ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                request_id: "request-invalid-accepted-subscribe",
                idempotency_key: "corr-invalid-accepted-subscribe",
                payload: &payload,
                timeout: Duration::from_secs(1),
                cancellation: CancellationToken::new(),
                preferred_peer_id: None,
                require_advertised_method: true,
                stream_events: true,
                turn: None,
            });
            tokio::pin!(stream);
            tokio::select! {
                _ = &mut stream => panic!("stream completed before subscribe acknowledgement"),
                _ = wait_for_frame_count(&sender, 1) => {}
            }
            assert!(
                mesh_state
                    .test_settle_native_assistant_response(
                        "peer-a",
                        &json!({
                            "type": "subscribed",
                            "id": "request-invalid-accepted-subscribe",
                            "subscription_id": "sub-invalid-accepted",
                            "accepted": true,
                            "accepted_topics": ["Other.Topic"],
                            "rejected_topics": [],
                            "correlation_ids": ["corr-invalid-accepted-subscribe"],
                            "ttl_seconds": 60,
                            "reason": null,
                            "idempotent": false
                        }),
                    )
                    .await
            );
            assert_eq!(
                stream.await.err().expect("invalid accepted subscribe"),
                TransportError::InvalidResponse
            );
            wait_for_frame_count(&sender, 2).await;
            let sent = sender.frames.lock().expect("frames").clone();
            assert_eq!(sent.len(), 2);
            assert_eq!(
                serde_json::from_str::<Value>(&sent[0].1).expect("subscribe")["type"],
                "subscribe"
            );
            assert_eq!(
                serde_json::from_str::<Value>(&sent[1].1).expect("unsubscribe"),
                json!({"type": "unsubscribe", "id": "sub-invalid-accepted"})
            );
        });
    }

    #[test]
    fn dropping_stream_unsubscribes_once() {
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
            let payload = json!({"text": "hello"});
            let stream = transport.invoke_stream(NativeMeshInvokeRequest {
                method_id: ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                request_id: "request-drop-stream",
                idempotency_key: "corr-drop-stream",
                payload: &payload,
                timeout: Duration::from_secs(1),
                cancellation: CancellationToken::new(),
                preferred_peer_id: None,
                require_advertised_method: true,
                stream_events: true,
                turn: None,
            });
            tokio::pin!(stream);
            tokio::select! {
                _ = &mut stream => panic!("stream completed before subscribe acknowledgement"),
                _ = wait_for_frame_count(&sender, 1) => {}
            }
            assert!(
                mesh_state
                    .test_settle_native_assistant_response(
                        "peer-a",
                        &json!({
                            "type": "subscribed",
                            "id": "request-drop-stream",
                            "subscription_id": "request-drop-stream",
                            "accepted": true,
                            "accepted_topics": [ids::ORCHESTRATOR_RESPONSE],
                            "rejected_topics": [],
                            "correlation_ids": ["corr-drop-stream"],
                            "ttl_seconds": 60,
                            "reason": null,
                            "idempotent": false
                        }),
                    )
                    .await
            );
            let stream = stream.await.expect("stream pending");
            drop(stream);
            wait_for_frame_count(&sender, 4).await;
            let sent = sender.frames.lock().expect("frames").clone();
            assert_eq!(
                sent.iter()
                    .filter_map(|(_, frame)| serde_json::from_str::<Value>(frame).ok())
                    .filter(|frame| frame["type"] == "unsubscribe"
                        && frame["id"] == "request-drop-stream")
                    .count(),
                1
            );
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
                stream_events: false,
                turn: None,
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
                stream_events: false,
                turn: None,
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
                        stream_events: false,
                        turn: None,
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
    fn invoke_timeout_publishes_failed_native_event_without_waiting_for_peer_terminal() {
        block_on(async {
            let mesh_state = MeshSessionState::default();
            let request_id = "request-timeout-native-event";
            let subscription = global_native_event_hub().subscribe_with_capacity(
                crate::native_event_hub::NativeEventFilter {
                    kinds: vec![crate::native_event_hub::ASSISTANT_FAILED.to_owned()],
                    subjects: vec![request_id.to_owned()],
                    after_sequence: Some(
                        global_native_event_hub().next_sequence().saturating_sub(1),
                    ),
                    ..crate::native_event_hub::NativeEventFilter::default()
                },
                4,
            );
            mesh_state
                .test_bind_native_assistant_peer(
                    "peer-timeout-native-event",
                    42,
                    &[ids::ORCHESTRATOR_EXTERNAL_USER_INPUT],
                    true,
                    None,
                )
                .await;
            let sender = Arc::new(RecordingSender::default());
            let mut transport = TauriNativeMeshAssistantTransport {
                mesh_state,
                sender,
                options: mesh_route(),
                active_peer_id: None,
            };

            assert_eq!(
                transport
                    .invoke(NativeMeshInvokeRequest {
                        method_id: ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                        request_id,
                        idempotency_key: "idem-timeout-native-event",
                        payload: &json!({"text": "hello"}),
                        timeout: Duration::from_millis(5),
                        cancellation: CancellationToken::new(),
                        preferred_peer_id: None,
                        require_advertised_method: true,
                        stream_events: false,
                        turn: None,
                    })
                    .await
                    .expect_err("timeout"),
                TransportError::Timeout
            );

            let event = subscription.recv().await.expect("timeout event");
            assert_eq!(event.kind, crate::native_event_hub::ASSISTANT_FAILED);
            assert_eq!(event.audit.correlation_id.as_deref(), Some(request_id));
            assert_eq!(
                event.audit.peer_id.as_deref(),
                Some("peer-timeout-native-event")
            );
            assert_eq!(event.payload["error"]["code"], "timeout");
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
                stream_events: false,
                turn: None,
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
                        stream_events: false,
                        turn: None,
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
                        stream_events: false,
                        turn: None,
                    })
                    .await
                    .expect_err("cancelled"),
                TransportError::Cancelled
            );
            assert!(sender.frames.lock().expect("frames").is_empty());
        });
    }
}
