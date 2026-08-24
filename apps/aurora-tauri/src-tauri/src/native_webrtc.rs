use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};

const NATIVE_WEBRTC_EVENT: &str = "aurora://native-webrtc";

/// Largest single data-channel message SCTP will carry here.
///
/// Measured on the interop lane: 65,535 round-trips, 65,536 sends but never
/// comes back, 131,072 fails outright. Aurora fragments at 16 KB, so its own
/// traffic sits far below this; the ceiling is the guard for anything that
/// reaches the channel without going through fragmentation, which would
/// otherwise disappear instead of failing.
///
/// `apps/aurora-tauri/src/native-webrtc.ts` carries the same number and rejects
/// before the IPC hop, so this is the backstop rather than the only check.
pub const NATIVE_WEBRTC_MAX_MESSAGE_BYTES: usize = 65_535;

/// Typed failures from the data-channel send path.
///
/// Serialized to the webview as `{ "code": ... }` so a caller can branch on the
/// cause rather than matching on a message that is free to be reworded.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(
    tag = "code",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum NativeWebRtcSendError {
    #[error(
        "native WebRTC message of {byte_length} bytes exceeds the \
         {max_byte_length}-byte single-message ceiling"
    )]
    MessageTooLarge {
        byte_length: usize,
        max_byte_length: usize,
    },
    #[error("native WebRTC binary payload is not valid base64")]
    InvalidBase64Payload,
    #[error("native WebRTC data channel is unavailable")]
    ChannelUnavailable,
    /// Produced only by the not-compiled-in command arm, so on any platform that
    /// does compile the transport nothing constructs it. It stays in the enum
    /// regardless: the webview sees one error shape everywhere.
    #[cfg_attr(aurora_native_webrtc, allow(dead_code))]
    #[error("native WebRTC transport is not compiled in for this platform")]
    NotSupported,
}

/// Rejects a message the transport cannot carry, before it is handed to SCTP.
#[cfg_attr(not(aurora_native_webrtc), allow(dead_code))]
fn ensure_within_message_ceiling(byte_length: usize) -> Result<(), NativeWebRtcSendError> {
    if byte_length > NATIVE_WEBRTC_MAX_MESSAGE_BYTES {
        return Err(NativeWebRtcSendError::MessageTooLarge {
            byte_length,
            max_byte_length: NATIVE_WEBRTC_MAX_MESSAGE_BYTES,
        });
    }
    Ok(())
}

#[derive(Clone, Default)]
pub struct NativeWebRtcState {
    #[cfg(aurora_native_webrtc)]
    inner: std::sync::Arc<native::NativeWebRtcStore>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWebRtcCreateRequest {
    #[serde(default)]
    ice_servers: Vec<NativeIceServer>,
    ice_transport_policy: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeIceServer {
    #[serde(default)]
    urls: Vec<String>,
    #[serde(default)]
    username: String,
    credential: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSessionDescription {
    #[serde(rename = "type")]
    sdp_type: String,
    sdp: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePeerIdRequest {
    peer_connection_id: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDescriptionRequest {
    peer_connection_id: u64,
    description: NativeSessionDescription,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeIceCandidateRequest {
    peer_connection_id: u64,
    candidate: Option<NativeIceCandidate>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeIceCandidate {
    candidate: String,
    sdp_mid: Option<String>,
    sdp_m_line_index: Option<u16>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCreateDataChannelRequest {
    peer_connection_id: u64,
    label: String,
    ordered: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDataChannelIdRequest {
    data_channel_id: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDataChannelBufferedAmountLowThresholdRequest {
    data_channel_id: u64,
    buffered_amount_low_threshold: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDataChannelSendRequest {
    data_channel_id: u64,
    payload: String,
    binary: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWebRtcCreateResponse {
    peer_connection_id: u64,
    connection_state: String,
    ice_connection_state: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDataChannelResponse {
    data_channel_id: u64,
    label: String,
    ready_state: String,
    buffered_amount: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum NativeWebRtcEventPayload {
    IceCandidate {
        peer_connection_id: u64,
        candidate: Option<NativeIceCandidate>,
    },
    ConnectionState {
        peer_connection_id: u64,
        connection_state: String,
    },
    IceConnectionState {
        peer_connection_id: u64,
        ice_connection_state: String,
    },
    DataChannel {
        peer_connection_id: u64,
        data_channel_id: u64,
        label: String,
        ready_state: String,
        buffered_amount: usize,
    },
    DataChannelOpen {
        peer_connection_id: u64,
        data_channel_id: u64,
    },
    DataChannelMessage {
        peer_connection_id: u64,
        data_channel_id: u64,
        payload: String,
        binary: bool,
    },
    DataChannelBufferedAmount {
        peer_connection_id: u64,
        data_channel_id: u64,
        buffered_amount: usize,
    },
    DataChannelClose {
        peer_connection_id: u64,
        data_channel_id: u64,
    },
    Error {
        peer_connection_id: u64,
        data_channel_id: Option<u64>,
        scope: &'static str,
        message: String,
    },
}

#[tauri::command]
pub async fn aurora_native_webrtc_create(
    app: AppHandle,
    state: State<'_, NativeWebRtcState>,
    request: NativeWebRtcCreateRequest,
) -> Result<NativeWebRtcCreateResponse, String> {
    #[cfg(aurora_native_webrtc)]
    {
        return native::create_peer_connection(app, &state.inner, request).await;
    }
    #[cfg(not(aurora_native_webrtc))]
    {
        let _ = (app, state, request);
        Err("native WebRTC transport is not compiled in for this platform".to_string())
    }
}

#[tauri::command]
pub async fn aurora_native_webrtc_create_offer(
    state: State<'_, NativeWebRtcState>,
    request: NativePeerIdRequest,
) -> Result<NativeSessionDescription, String> {
    #[cfg(aurora_native_webrtc)]
    {
        return native::create_offer(&state.inner, request.peer_connection_id).await;
    }
    #[cfg(not(aurora_native_webrtc))]
    {
        let _ = (state, request);
        Err("native WebRTC transport is not compiled in for this platform".to_string())
    }
}

#[tauri::command]
pub async fn aurora_native_webrtc_create_answer(
    state: State<'_, NativeWebRtcState>,
    request: NativePeerIdRequest,
) -> Result<NativeSessionDescription, String> {
    #[cfg(aurora_native_webrtc)]
    {
        return native::create_answer(&state.inner, request.peer_connection_id).await;
    }
    #[cfg(not(aurora_native_webrtc))]
    {
        let _ = (state, request);
        Err("native WebRTC transport is not compiled in for this platform".to_string())
    }
}

#[tauri::command]
pub async fn aurora_native_webrtc_set_local_description(
    state: State<'_, NativeWebRtcState>,
    request: NativeDescriptionRequest,
) -> Result<(), String> {
    #[cfg(aurora_native_webrtc)]
    {
        return native::set_local_description(
            &state.inner,
            request.peer_connection_id,
            request.description,
        )
        .await;
    }
    #[cfg(not(aurora_native_webrtc))]
    {
        let _ = (state, request);
        Err("native WebRTC transport is not compiled in for this platform".to_string())
    }
}

#[tauri::command]
pub async fn aurora_native_webrtc_set_remote_description(
    state: State<'_, NativeWebRtcState>,
    request: NativeDescriptionRequest,
) -> Result<(), String> {
    #[cfg(aurora_native_webrtc)]
    {
        return native::set_remote_description(
            &state.inner,
            request.peer_connection_id,
            request.description,
        )
        .await;
    }
    #[cfg(not(aurora_native_webrtc))]
    {
        let _ = (state, request);
        Err("native WebRTC transport is not compiled in for this platform".to_string())
    }
}

#[tauri::command]
pub async fn aurora_native_webrtc_add_ice_candidate(
    state: State<'_, NativeWebRtcState>,
    request: NativeIceCandidateRequest,
) -> Result<(), String> {
    #[cfg(aurora_native_webrtc)]
    {
        return native::add_ice_candidate(
            &state.inner,
            request.peer_connection_id,
            request.candidate,
        )
        .await;
    }
    #[cfg(not(aurora_native_webrtc))]
    {
        let _ = (state, request);
        Err("native WebRTC transport is not compiled in for this platform".to_string())
    }
}

#[tauri::command]
pub async fn aurora_native_webrtc_create_data_channel(
    app: AppHandle,
    state: State<'_, NativeWebRtcState>,
    request: NativeCreateDataChannelRequest,
) -> Result<NativeDataChannelResponse, String> {
    #[cfg(aurora_native_webrtc)]
    {
        return native::create_data_channel(app, &state.inner, request).await;
    }
    #[cfg(not(aurora_native_webrtc))]
    {
        let _ = (app, state, request);
        Err("native WebRTC transport is not compiled in for this platform".to_string())
    }
}

#[tauri::command]
pub async fn aurora_native_webrtc_data_channel_send(
    app: AppHandle,
    state: State<'_, NativeWebRtcState>,
    request: NativeDataChannelSendRequest,
) -> Result<(), NativeWebRtcSendError> {
    #[cfg(aurora_native_webrtc)]
    {
        return native::send_data_channel(app, &state.inner, request).await;
    }
    #[cfg(not(aurora_native_webrtc))]
    {
        let _ = (app, state, request);
        Err(NativeWebRtcSendError::NotSupported)
    }
}

pub async fn send_native_text_data_channel(
    app: AppHandle,
    state: &NativeWebRtcState,
    data_channel_id: u64,
    payload: String,
) -> Result<(), NativeWebRtcSendError> {
    #[cfg(aurora_native_webrtc)]
    {
        return native::send_data_channel_text_now(app, &state.inner, data_channel_id, payload)
            .await;
    }
    #[cfg(not(aurora_native_webrtc))]
    {
        let _ = (app, state, data_channel_id, payload);
        Err(NativeWebRtcSendError::NotSupported)
    }
}

pub async fn send_native_binary_data_channel(
    app: AppHandle,
    state: &NativeWebRtcState,
    data_channel_id: u64,
    payload: Vec<u8>,
) -> Result<(), NativeWebRtcSendError> {
    #[cfg(aurora_native_webrtc)]
    {
        return native::send_data_channel_binary_now(app, &state.inner, data_channel_id, payload)
            .await;
    }
    #[cfg(not(aurora_native_webrtc))]
    {
        let _ = (app, state, data_channel_id, payload);
        Err(NativeWebRtcSendError::NotSupported)
    }
}

#[tauri::command]
pub async fn aurora_native_webrtc_data_channel_close(
    state: State<'_, NativeWebRtcState>,
    request: NativeDataChannelIdRequest,
) -> Result<(), String> {
    #[cfg(aurora_native_webrtc)]
    {
        return native::close_data_channel(&state.inner, request.data_channel_id).await;
    }
    #[cfg(not(aurora_native_webrtc))]
    {
        let _ = (state, request);
        Err("native WebRTC transport is not compiled in for this platform".to_string())
    }
}

#[tauri::command]
pub async fn aurora_native_webrtc_set_data_channel_buffered_amount_low_threshold(
    state: State<'_, NativeWebRtcState>,
    request: NativeDataChannelBufferedAmountLowThresholdRequest,
) -> Result<(), String> {
    #[cfg(aurora_native_webrtc)]
    {
        return native::set_data_channel_buffered_amount_low_threshold(
            &state.inner,
            request.data_channel_id,
            request.buffered_amount_low_threshold,
        )
        .await;
    }
    #[cfg(not(aurora_native_webrtc))]
    {
        let _ = (state, request);
        Err("native WebRTC transport is not compiled in for this platform".to_string())
    }
}

#[tauri::command]
pub async fn aurora_native_webrtc_get_stats(
    state: State<'_, NativeWebRtcState>,
    request: NativePeerIdRequest,
) -> Result<Value, String> {
    #[cfg(aurora_native_webrtc)]
    {
        return native::get_stats(&state.inner, request.peer_connection_id).await;
    }
    #[cfg(not(aurora_native_webrtc))]
    {
        let _ = (state, request);
        Err("native WebRTC transport is not compiled in for this platform".to_string())
    }
}

#[tauri::command]
pub async fn aurora_native_webrtc_close(
    state: State<'_, NativeWebRtcState>,
    request: NativePeerIdRequest,
) -> Result<(), String> {
    #[cfg(aurora_native_webrtc)]
    {
        return native::close_peer_connection(&state.inner, request.peer_connection_id).await;
    }
    #[cfg(not(aurora_native_webrtc))]
    {
        let _ = (state, request);
        Err("native WebRTC transport is not compiled in for this platform".to_string())
    }
}

#[cfg(aurora_native_webrtc)]
mod native {
    use super::{
        ensure_within_message_ceiling, NativeCreateDataChannelRequest, NativeDataChannelResponse,
        NativeDataChannelSendRequest, NativeIceCandidate, NativeSessionDescription,
        NativeWebRtcCreateRequest, NativeWebRtcCreateResponse, NativeWebRtcEventPayload,
        NativeWebRtcSendError, NATIVE_WEBRTC_EVENT,
    };
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    use bytes::Bytes;
    use serde_json::{Map, Value};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;
    use tauri::{AppHandle, Emitter};
    use tokio::sync::{Mutex, RwLock};
    use webrtc::api::APIBuilder;
    use webrtc::data_channel::data_channel_init::RTCDataChannelInit;
    use webrtc::data_channel::data_channel_state::RTCDataChannelState;
    use webrtc::data_channel::RTCDataChannel;
    use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
    use webrtc::ice_transport::ice_credential_type::RTCIceCredentialType;
    use webrtc::ice_transport::ice_server::RTCIceServer;
    use webrtc::peer_connection::configuration::RTCConfiguration;
    use webrtc::peer_connection::policy::ice_transport_policy::RTCIceTransportPolicy;
    use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
    use webrtc::peer_connection::RTCPeerConnection;

    #[derive(Default)]
    pub(super) struct NativeWebRtcStore {
        next_peer_connection_id: AtomicU64,
        next_data_channel_id: AtomicU64,
        peer_connections: RwLock<HashMap<u64, Arc<RTCPeerConnection>>>,
        data_channels: RwLock<HashMap<u64, StoredDataChannel>>,
        data_channel_send_locks: RwLock<HashMap<u64, Arc<Mutex<()>>>>,
    }

    struct StoredDataChannel {
        peer_connection_id: u64,
        channel: Arc<RTCDataChannel>,
    }

    pub(super) async fn create_peer_connection(
        app: AppHandle,
        store: &Arc<NativeWebRtcStore>,
        request: NativeWebRtcCreateRequest,
    ) -> Result<NativeWebRtcCreateResponse, String> {
        let configuration = RTCConfiguration {
            ice_servers: request
                .ice_servers
                .into_iter()
                .map(|server| RTCIceServer {
                    urls: server.urls,
                    username: server.username,
                    credential: server.credential.unwrap_or_default(),
                    credential_type: RTCIceCredentialType::Password,
                })
                .collect(),
            ice_transport_policy: request
                .ice_transport_policy
                .as_deref()
                .map(RTCIceTransportPolicy::from)
                .unwrap_or(RTCIceTransportPolicy::All),
            ..Default::default()
        };
        let peer_connection = Arc::new(
            APIBuilder::new()
                .build()
                .new_peer_connection(configuration)
                .await
                .map_err(redact_error)?,
        );
        let peer_connection_id = store
            .next_peer_connection_id
            .fetch_add(1, Ordering::Relaxed)
            + 1;
        store
            .peer_connections
            .write()
            .await
            .insert(peer_connection_id, Arc::clone(&peer_connection));
        register_peer_connection_callbacks(
            app,
            Arc::clone(store),
            peer_connection_id,
            Arc::clone(&peer_connection),
        );
        Ok(NativeWebRtcCreateResponse {
            peer_connection_id,
            connection_state: peer_connection.connection_state().to_string(),
            ice_connection_state: peer_connection.ice_connection_state().to_string(),
        })
    }

    pub(super) async fn create_offer(
        store: &Arc<NativeWebRtcStore>,
        peer_connection_id: u64,
    ) -> Result<NativeSessionDescription, String> {
        let peer = peer_connection(store, peer_connection_id).await?;
        let description = peer.create_offer(None).await.map_err(redact_error)?;
        Ok(native_description(description))
    }

    pub(super) async fn create_answer(
        store: &Arc<NativeWebRtcStore>,
        peer_connection_id: u64,
    ) -> Result<NativeSessionDescription, String> {
        let peer = peer_connection(store, peer_connection_id).await?;
        let description = peer.create_answer(None).await.map_err(redact_error)?;
        Ok(native_description(description))
    }

    pub(super) async fn set_local_description(
        store: &Arc<NativeWebRtcStore>,
        peer_connection_id: u64,
        description: NativeSessionDescription,
    ) -> Result<(), String> {
        let peer = peer_connection(store, peer_connection_id).await?;
        peer.set_local_description(rtc_description(description)?)
            .await
            .map_err(redact_error)
    }

    pub(super) async fn set_remote_description(
        store: &Arc<NativeWebRtcStore>,
        peer_connection_id: u64,
        description: NativeSessionDescription,
    ) -> Result<(), String> {
        let peer = peer_connection(store, peer_connection_id).await?;
        peer.set_remote_description(rtc_description(description)?)
            .await
            .map_err(redact_error)
    }

    pub(super) async fn add_ice_candidate(
        store: &Arc<NativeWebRtcStore>,
        peer_connection_id: u64,
        candidate: Option<NativeIceCandidate>,
    ) -> Result<(), String> {
        let peer = peer_connection(store, peer_connection_id).await?;
        let candidate = candidate
            .map(|candidate| RTCIceCandidateInit {
                candidate: candidate.candidate,
                sdp_mid: candidate.sdp_mid,
                sdp_mline_index: candidate.sdp_m_line_index,
                username_fragment: None,
            })
            .unwrap_or_default();
        peer.add_ice_candidate(candidate)
            .await
            .map_err(redact_error)
    }

    pub(super) async fn create_data_channel(
        app: AppHandle,
        store: &Arc<NativeWebRtcStore>,
        request: NativeCreateDataChannelRequest,
    ) -> Result<NativeDataChannelResponse, String> {
        let peer = peer_connection(store, request.peer_connection_id).await?;
        let channel = peer
            .create_data_channel(
                &request.label,
                Some(RTCDataChannelInit {
                    ordered: request.ordered.or(Some(true)),
                    ..Default::default()
                }),
            )
            .await
            .map_err(redact_error)?;
        let data_channel_id = register_data_channel(
            app,
            Arc::clone(store),
            request.peer_connection_id,
            Arc::clone(&channel),
            false,
        )
        .await;
        Ok(NativeDataChannelResponse {
            data_channel_id,
            label: channel.label().to_string(),
            ready_state: channel.ready_state().to_string(),
            buffered_amount: channel.buffered_amount().await,
        })
    }

    pub(super) async fn send_data_channel(
        app: AppHandle,
        store: &Arc<NativeWebRtcStore>,
        request: NativeDataChannelSendRequest,
    ) -> Result<(), NativeWebRtcSendError> {
        let (peer_connection_id, channel, send_lock) =
            data_channel_with_send_lock(store, request.data_channel_id)
                .await
                .map_err(|_| NativeWebRtcSendError::ChannelUnavailable)?;
        let payload = if request.binary {
            NativeSendPayload::Binary(
                BASE64
                    .decode(request.payload.as_bytes())
                    .map_err(|_| NativeWebRtcSendError::InvalidBase64Payload)?,
            )
        } else {
            NativeSendPayload::Text(request.payload)
        };
        // Decoded length, not the base64 length: the ceiling is what SCTP will
        // carry, and an oversize message otherwise leaves without ever arriving.
        ensure_within_message_ceiling(match &payload {
            NativeSendPayload::Binary(bytes) => bytes.len(),
            NativeSendPayload::Text(text) => text.len(),
        })?;
        let data_channel_id = request.data_channel_id;
        tauri::async_runtime::spawn(async move {
            let _send_guard = send_lock.lock().await;
            let send_result = match payload {
                NativeSendPayload::Binary(bytes) => channel.send(&Bytes::from(bytes)).await,
                NativeSendPayload::Text(text) => channel.send_text(text).await,
            };
            match send_result {
                Ok(_) => {
                    emit_to_main(
                        &app,
                        NativeWebRtcEventPayload::DataChannelBufferedAmount {
                            peer_connection_id,
                            data_channel_id,
                            buffered_amount: channel.buffered_amount().await,
                        },
                    );
                }
                Err(error) => {
                    emit_error(
                        &app,
                        peer_connection_id,
                        Some(data_channel_id),
                        "data-channel",
                        error,
                    );
                }
            }
        });
        Ok(())
    }

    pub(super) async fn send_data_channel_text_now(
        app: AppHandle,
        store: &Arc<NativeWebRtcStore>,
        data_channel_id: u64,
        payload: String,
    ) -> Result<(), NativeWebRtcSendError> {
        send_data_channel_now(
            app,
            store,
            data_channel_id,
            NativeSendPayload::Text(payload),
        )
        .await
    }

    pub(super) async fn send_data_channel_binary_now(
        app: AppHandle,
        store: &Arc<NativeWebRtcStore>,
        data_channel_id: u64,
        payload: Vec<u8>,
    ) -> Result<(), NativeWebRtcSendError> {
        send_data_channel_now(
            app,
            store,
            data_channel_id,
            NativeSendPayload::Binary(payload),
        )
        .await
    }

    async fn send_data_channel_now(
        app: AppHandle,
        store: &Arc<NativeWebRtcStore>,
        data_channel_id: u64,
        payload: NativeSendPayload,
    ) -> Result<(), NativeWebRtcSendError> {
        let (peer_connection_id, channel, send_lock) =
            data_channel_with_send_lock(store, data_channel_id)
                .await
                .map_err(|_| NativeWebRtcSendError::ChannelUnavailable)?;
        ensure_within_message_ceiling(match &payload {
            NativeSendPayload::Binary(bytes) => bytes.len(),
            NativeSendPayload::Text(text) => text.len(),
        })?;
        let _send_guard = send_lock.lock().await;
        let result = match payload {
            NativeSendPayload::Binary(bytes) => channel.send(&Bytes::from(bytes)).await,
            NativeSendPayload::Text(text) => channel.send_text(text).await,
        };
        match result {
            Ok(_) => {
                emit_to_main(
                    &app,
                    NativeWebRtcEventPayload::DataChannelBufferedAmount {
                        peer_connection_id,
                        data_channel_id,
                        buffered_amount: channel.buffered_amount().await,
                    },
                );
                Ok(())
            }
            Err(error) => {
                emit_error(
                    &app,
                    peer_connection_id,
                    Some(data_channel_id),
                    "data-channel",
                    error,
                );
                Err(NativeWebRtcSendError::ChannelUnavailable)
            }
        }
    }

    pub(super) async fn close_data_channel(
        store: &Arc<NativeWebRtcStore>,
        data_channel_id: u64,
    ) -> Result<(), String> {
        let stored = store
            .data_channels
            .write()
            .await
            .remove(&data_channel_id)
            .ok_or_else(|| "native WebRTC data channel is unavailable".to_string())?;
        store
            .data_channel_send_locks
            .write()
            .await
            .remove(&data_channel_id);
        stored.channel.close().await.map_err(redact_error)
    }

    pub(super) async fn set_data_channel_buffered_amount_low_threshold(
        store: &Arc<NativeWebRtcStore>,
        data_channel_id: u64,
        buffered_amount_low_threshold: usize,
    ) -> Result<(), String> {
        let (_, channel) = data_channel(store, data_channel_id).await?;
        channel
            .set_buffered_amount_low_threshold(buffered_amount_low_threshold)
            .await;
        Ok(())
    }

    pub(super) async fn get_stats(
        store: &Arc<NativeWebRtcStore>,
        peer_connection_id: u64,
    ) -> Result<Value, String> {
        let peer = peer_connection(store, peer_connection_id).await?;
        let value = serde_json::to_value(peer.get_stats().await).map_err(redact_error)?;
        Ok(redact_stats(value))
    }

    pub(super) async fn close_peer_connection(
        store: &Arc<NativeWebRtcStore>,
        peer_connection_id: u64,
    ) -> Result<(), String> {
        let peer = store
            .peer_connections
            .write()
            .await
            .remove(&peer_connection_id)
            .ok_or_else(|| "native WebRTC peer connection is unavailable".to_string())?;
        let channel_ids = {
            let channels = store.data_channels.read().await;
            channels
                .iter()
                .filter_map(|(id, stored)| {
                    (stored.peer_connection_id == peer_connection_id).then_some(*id)
                })
                .collect::<Vec<_>>()
        };
        let channels = {
            let mut stored = store.data_channels.write().await;
            channel_ids
                .iter()
                .filter_map(|id| stored.remove(id).map(|item| item.channel))
                .collect::<Vec<_>>()
        };
        {
            let mut send_locks = store.data_channel_send_locks.write().await;
            for id in &channel_ids {
                send_locks.remove(id);
            }
        }
        for channel in channels {
            let _ = channel.close().await;
        }
        peer.close().await.map_err(redact_error)
    }

    fn register_peer_connection_callbacks(
        app: AppHandle,
        store: Arc<NativeWebRtcStore>,
        peer_connection_id: u64,
        peer: Arc<RTCPeerConnection>,
    ) {
        let candidate_app = app.clone();
        peer.on_ice_candidate(Box::new(move |candidate| {
            let app = candidate_app.clone();
            Box::pin(async move {
                let candidate = match candidate {
                    Some(candidate) => match candidate.to_json() {
                        Ok(candidate) => Some(NativeIceCandidate {
                            candidate: candidate.candidate,
                            sdp_mid: candidate.sdp_mid,
                            sdp_m_line_index: candidate.sdp_mline_index,
                        }),
                        Err(error) => {
                            emit_error(&app, peer_connection_id, None, "ice-candidate", error);
                            return;
                        }
                    },
                    None => None,
                };
                emit_to_main(
                    &app,
                    NativeWebRtcEventPayload::IceCandidate {
                        peer_connection_id,
                        candidate,
                    },
                );
            })
        }));

        let connection_app = app.clone();
        peer.on_peer_connection_state_change(Box::new(move |state| {
            let app = connection_app.clone();
            Box::pin(async move {
                emit_to_main(
                    &app,
                    NativeWebRtcEventPayload::ConnectionState {
                        peer_connection_id,
                        connection_state: state.to_string(),
                    },
                );
            })
        }));

        let ice_app = app.clone();
        peer.on_ice_connection_state_change(Box::new(move |state| {
            let app = ice_app.clone();
            Box::pin(async move {
                emit_to_main(
                    &app,
                    NativeWebRtcEventPayload::IceConnectionState {
                        peer_connection_id,
                        ice_connection_state: state.to_string(),
                    },
                );
            })
        }));

        peer.on_data_channel(Box::new(move |channel| {
            let app = app.clone();
            let store = Arc::clone(&store);
            Box::pin(async move {
                register_data_channel(app, store, peer_connection_id, channel, true).await;
            })
        }));
    }

    async fn register_data_channel(
        app: AppHandle,
        store: Arc<NativeWebRtcStore>,
        peer_connection_id: u64,
        channel: Arc<RTCDataChannel>,
        announce_inbound: bool,
    ) -> u64 {
        let data_channel_id = store.next_data_channel_id.fetch_add(1, Ordering::Relaxed) + 1;
        store.data_channels.write().await.insert(
            data_channel_id,
            StoredDataChannel {
                peer_connection_id,
                channel: Arc::clone(&channel),
            },
        );
        let data_channel_send_lock = Arc::new(Mutex::new(()));
        store
            .data_channel_send_locks
            .write()
            .await
            .insert(data_channel_id, Arc::clone(&data_channel_send_lock));

        let message_app = app.clone();
        let message_channel = Arc::clone(&channel);
        let message_send_lock = Arc::clone(&data_channel_send_lock);
        channel.on_message(Box::new(move |message| {
            let app = message_app.clone();
            let channel = Arc::clone(&message_channel);
            let send_lock = Arc::clone(&message_send_lock);
            Box::pin(async move {
                let binary = !message.is_string;

                // R3's interception point. A frozen webview issues no commands,
                // so what Rust owns has to be decided here, before anything is
                // emitted. Everything the dispatcher does not claim -- binary
                // traffic on an unbound/unencrypted channel, or a frame the
                // section 3 table does not name -- falls through to the emit
                // below exactly as it did before R3.
                match route_inbound_frame(&app, data_channel_id, &message.data, binary).await {
                    crate::mesh_session::InboundRouting::Answer(answers) => {
                        let _send_guard = send_lock.lock().await;
                        for answer in answers {
                            let result = match answer {
                                crate::mesh_session::OutboundDataChannelFrame::Text(text) => {
                                    channel.send_text(text).await
                                }
                                crate::mesh_session::OutboundDataChannelFrame::Binary(bytes) => {
                                    channel.send(&Bytes::from(bytes)).await
                                }
                            };
                            if let Err(error) = result {
                                emit_error(
                                    &app,
                                    peer_connection_id,
                                    Some(data_channel_id),
                                    "data-channel",
                                    error,
                                );
                            }
                        }
                        return;
                    }
                    crate::mesh_session::InboundRouting::Parked => return,
                    crate::mesh_session::InboundRouting::Emit => {}
                }

                let payload = if message.is_string {
                    String::from_utf8_lossy(&message.data).into_owned()
                } else {
                    BASE64.encode(&message.data)
                };

                emit_to_main(
                    &app,
                    NativeWebRtcEventPayload::DataChannelMessage {
                        peer_connection_id,
                        data_channel_id,
                        payload,
                        binary,
                    },
                );
            })
        }));

        let close_app = app.clone();
        let close_store = Arc::clone(&store);
        channel.on_close(Box::new(move || {
            let app = close_app.clone();
            let store = Arc::clone(&close_store);
            Box::pin(async move {
                store.data_channels.write().await.remove(&data_channel_id);
                store
                    .data_channel_send_locks
                    .write()
                    .await
                    .remove(&data_channel_id);
                crate::mesh_session::route_native_data_channel_closed(&app, data_channel_id).await;
                emit_to_main(
                    &app,
                    NativeWebRtcEventPayload::DataChannelClose {
                        peer_connection_id,
                        data_channel_id,
                    },
                );
            })
        }));

        let error_app = app.clone();
        channel.on_error(Box::new(move |error| {
            let app = error_app.clone();
            Box::pin(async move {
                emit_error(
                    &app,
                    peer_connection_id,
                    Some(data_channel_id),
                    "data-channel",
                    error,
                );
            })
        }));

        let buffered_amount_app = app.clone();
        let buffered_amount_channel = Arc::clone(&channel);
        channel
            .on_buffered_amount_low(Box::new(move || {
                let app = buffered_amount_app.clone();
                let channel = Arc::clone(&buffered_amount_channel);
                Box::pin(async move {
                    emit_to_main(
                        &app,
                        NativeWebRtcEventPayload::DataChannelBufferedAmount {
                            peer_connection_id,
                            data_channel_id,
                            buffered_amount: channel.buffered_amount().await,
                        },
                    );
                })
            }))
            .await;

        if announce_inbound {
            emit_to_main(
                &app,
                NativeWebRtcEventPayload::DataChannel {
                    peer_connection_id,
                    data_channel_id,
                    label: channel.label().to_string(),
                    ready_state: channel.ready_state().to_string(),
                    buffered_amount: channel.buffered_amount().await,
                },
            );
        }

        let open_app = app.clone();
        channel.on_open(Box::new(move || {
            let app = open_app.clone();
            Box::pin(async move {
                emit_to_main(
                    &app,
                    NativeWebRtcEventPayload::DataChannelOpen {
                        peer_connection_id,
                        data_channel_id,
                    },
                );
            })
        }));

        // The SCTP association can finish between the native command response
        // and the WebView binding the returned channel id. webrtc-rs does not
        // replay an already-fired on_open callback, so explicitly publish the
        // current state and let the TypeScript adapter de-duplicate it.
        if channel.ready_state() == RTCDataChannelState::Open {
            emit_to_main(
                &app,
                NativeWebRtcEventPayload::DataChannelOpen {
                    peer_connection_id,
                    data_channel_id,
                },
            );
        }

        data_channel_id
    }

    async fn peer_connection(
        store: &Arc<NativeWebRtcStore>,
        peer_connection_id: u64,
    ) -> Result<Arc<RTCPeerConnection>, String> {
        store
            .peer_connections
            .read()
            .await
            .get(&peer_connection_id)
            .cloned()
            .ok_or_else(|| "native WebRTC peer connection is unavailable".to_string())
    }

    async fn data_channel(
        store: &Arc<NativeWebRtcStore>,
        data_channel_id: u64,
    ) -> Result<(u64, Arc<RTCDataChannel>), String> {
        store
            .data_channels
            .read()
            .await
            .get(&data_channel_id)
            .map(|stored| (stored.peer_connection_id, Arc::clone(&stored.channel)))
            .ok_or_else(|| "native WebRTC data channel is unavailable".to_string())
    }

    async fn data_channel_with_send_lock(
        store: &Arc<NativeWebRtcStore>,
        data_channel_id: u64,
    ) -> Result<(u64, Arc<RTCDataChannel>, Arc<Mutex<()>>), String> {
        let (peer_connection_id, channel) = data_channel(store, data_channel_id).await?;
        let send_lock = store
            .data_channel_send_locks
            .read()
            .await
            .get(&data_channel_id)
            .cloned()
            .ok_or_else(|| "native WebRTC data channel is unavailable".to_string())?;
        Ok((peer_connection_id, channel, send_lock))
    }

    enum NativeSendPayload {
        Binary(Vec<u8>),
        Text(String),
    }

    fn rtc_description(
        description: NativeSessionDescription,
    ) -> Result<RTCSessionDescription, String> {
        match description.sdp_type.as_str() {
            "offer" => RTCSessionDescription::offer(description.sdp),
            "answer" => RTCSessionDescription::answer(description.sdp),
            "pranswer" => RTCSessionDescription::pranswer(description.sdp),
            _ => Err(webrtc::Error::ErrUnknownType),
        }
        .map_err(redact_error)
    }

    fn native_description(description: RTCSessionDescription) -> NativeSessionDescription {
        NativeSessionDescription {
            sdp_type: description.sdp_type.to_string(),
            sdp: description.sdp,
        }
    }

    /// Ask the R3 dispatcher what to do with one inbound payload.
    ///
    /// Passes everything through untouched when the dispatcher is not managed,
    /// which is what keeps a shell built without it behaving as before.
    async fn route_inbound_frame(
        app: &AppHandle,
        data_channel_id: u64,
        payload: &[u8],
        binary: bool,
    ) -> crate::mesh_session::InboundRouting {
        use tauri::Manager;
        let Some(state) = app.try_state::<crate::mesh_session::MeshSessionState>() else {
            return crate::mesh_session::InboundRouting::Emit;
        };
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|since| since.as_millis() as i64)
            .unwrap_or_default();
        crate::mesh_session::route_inbound(app, &state, data_channel_id, payload, binary, now_ms)
            .await
    }

    fn emit_to_main(app: &AppHandle, event: NativeWebRtcEventPayload) {
        let _ = app.emit_to("main", NATIVE_WEBRTC_EVENT, event);
    }

    fn emit_error(
        app: &AppHandle,
        peer_connection_id: u64,
        data_channel_id: Option<u64>,
        scope: &'static str,
        error: impl std::fmt::Display,
    ) {
        emit_to_main(
            app,
            NativeWebRtcEventPayload::Error {
                peer_connection_id,
                data_channel_id,
                scope,
                message: redact_error(error),
            },
        );
    }

    fn redact_error(error: impl std::fmt::Display) -> String {
        error.to_string().chars().take(160).collect::<String>()
    }

    fn redact_stats(value: Value) -> Value {
        let Some(reports) = value.as_object() else {
            return Value::Object(Map::new());
        };
        let mut redacted = Map::new();
        for (id, report) in reports {
            let Some(report) = report.as_object() else {
                continue;
            };
            let Some(kind) = report.get("type").and_then(Value::as_str) else {
                continue;
            };
            let mut safe = Map::new();
            safe.insert("type".to_string(), Value::String(kind.to_string()));
            copy_safe_fields(
                report,
                &mut safe,
                match kind {
                    "candidate-pair" => &[
                        "id",
                        "localCandidateId",
                        "remoteCandidateId",
                        "state",
                        "nominated",
                        "packetsSent",
                        "packetsReceived",
                        "bytesSent",
                        "bytesReceived",
                        "currentRoundTripTime",
                        "totalRoundTripTime",
                    ],
                    "local-candidate" | "remote-candidate" => {
                        &["id", "candidateType", "relayProtocol", "networkType"]
                    }
                    "data-channel" => &[
                        "id",
                        "label",
                        "protocol",
                        "dataChannelIdentifier",
                        "state",
                        "messagesSent",
                        "bytesSent",
                        "messagesReceived",
                        "bytesReceived",
                    ],
                    "transport" => &["id", "bytesSent", "bytesReceived"],
                    "peer-connection" => &["id", "dataChannelsOpened", "dataChannelsClosed"],
                    _ => continue,
                },
            );
            if kind == "local-candidate" || kind == "remote-candidate" {
                if let Some(network_type) = report.get("networkType").and_then(Value::as_str) {
                    let protocol = if network_type.starts_with("udp") {
                        Some("udp")
                    } else if network_type.starts_with("tcp") {
                        Some("tcp")
                    } else {
                        None
                    };
                    if let Some(protocol) = protocol {
                        safe.insert("protocol".to_string(), Value::String(protocol.to_string()));
                    }
                }
                if let Some(url) = report.get("url").and_then(Value::as_str) {
                    if url.starts_with("stun:") || url.starts_with("stuns:") {
                        safe.insert("url".to_string(), Value::String(url.to_string()));
                    }
                }
            }
            redacted.insert(id.clone(), Value::Object(safe));
        }
        Value::Object(redacted)
    }

    fn copy_safe_fields(
        source: &Map<String, Value>,
        target: &mut Map<String, Value>,
        keys: &[&str],
    ) {
        for key in keys {
            if let Some(value) = source.get(*key) {
                target.insert((*key).to_string(), value.clone());
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::{redact_stats, NativeWebRtcEventPayload};
        use serde_json::json;

        #[test]
        fn native_event_fields_match_the_webview_adapter_contract() {
            let event = NativeWebRtcEventPayload::DataChannelOpen {
                peer_connection_id: 7,
                data_channel_id: 8,
            };
            assert_eq!(
                serde_json::to_value(event).expect("event should serialize"),
                json!({
                    "type": "dataChannelOpen",
                    "peerConnectionId": 7,
                    "dataChannelId": 8
                }),
            );
        }

        #[test]
        fn stats_redaction_preserves_routing_evidence_without_addresses() {
            let redacted = redact_stats(json!({
                "local": {
                    "type": "local-candidate",
                    "id": "local",
                    "candidateType": "srflx",
                    "ip": "192.0.2.10",
                    "port": 49152,
                    "networkType": "udp4",
                    "url": "stun:stun.example.test:3478"
                },
                "pair": {
                    "type": "candidate-pair",
                    "id": "pair",
                    "localCandidateId": "local",
                    "remoteCandidateId": "remote",
                    "state": "succeeded",
                    "nominated": true,
                    "currentRoundTripTime": 0.024
                }
            }));

            let serialized = redacted.to_string();
            assert!(serialized.contains("\"candidateType\":\"srflx\""));
            assert!(serialized.contains("\"protocol\":\"udp\""));
            assert!(serialized.contains("\"currentRoundTripTime\":0.024"));
            assert!(!serialized.contains("192.0.2.10"));
            assert!(!serialized.contains("49152"));
        }
    }
}

#[cfg(test)]
mod message_ceiling_tests {
    use super::{
        ensure_within_message_ceiling, NativeWebRtcSendError, NATIVE_WEBRTC_MAX_MESSAGE_BYTES,
    };
    use serde_json::json;

    #[test]
    fn the_ceiling_is_the_measured_one() {
        // 65,535 round-trips on the interop lane; 65,536 does not. Changing this
        // number means re-running scripts/webrtc_native_interop.sh, not guessing.
        assert_eq!(NATIVE_WEBRTC_MAX_MESSAGE_BYTES, 65_535);
    }

    #[test]
    fn a_message_at_the_ceiling_is_accepted() {
        assert_eq!(ensure_within_message_ceiling(65_535), Ok(()));
    }

    #[test]
    fn a_message_over_the_ceiling_is_rejected_with_the_typed_error() {
        assert_eq!(
            ensure_within_message_ceiling(65_536),
            Err(NativeWebRtcSendError::MessageTooLarge {
                byte_length: 65_536,
                max_byte_length: 65_535,
            }),
        );
    }

    #[test]
    fn aurora_fragment_sized_traffic_stays_well_clear() {
        // fragment_payload_bytes is 16 KB, so nothing that goes through
        // fragmentation can reach the ceiling.
        assert_eq!(ensure_within_message_ceiling(16 * 1024), Ok(()));
    }

    #[test]
    fn the_rejection_reaches_the_webview_as_a_branchable_code() {
        let error = ensure_within_message_ceiling(131_072)
            .expect_err("a 131,072-byte message must not be accepted");
        assert_eq!(
            serde_json::to_value(&error).expect("send error should serialize"),
            json!({
                "code": "messageTooLarge",
                "byteLength": 131_072,
                "maxByteLength": 65_535
            }),
        );
    }

    #[test]
    fn every_send_failure_is_distinguishable_by_code() {
        let codes = [
            NativeWebRtcSendError::MessageTooLarge {
                byte_length: 65_536,
                max_byte_length: 65_535,
            },
            NativeWebRtcSendError::InvalidBase64Payload,
            NativeWebRtcSendError::ChannelUnavailable,
            NativeWebRtcSendError::NotSupported,
        ]
        .map(|error| {
            serde_json::to_value(&error).expect("send error should serialize")["code"]
                .as_str()
                .expect("every variant should carry a code")
                .to_string()
        });
        assert_eq!(
            codes.to_vec(),
            vec![
                "messageTooLarge",
                "invalidBase64Payload",
                "channelUnavailable",
                "notSupported",
            ],
        );
    }
}
