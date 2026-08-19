//! Native webrtc-rs peer for the Aurora data-channel interop lanes.
//!
//! Speaks one JSON line per message over stdio so a harness in any language can
//! drive the SDP exchange:
//!
//!   stdout  `OFFER {"type":"offer","sdp":"..."}`
//!   stdin   `ANSWER {"type":"answer","sdp":"..."}`
//!   stdout  `RESULT {"echoed":9,"orderedExactEcho":true,...}`
//!
//! ICE is non-trickle: the offer is emitted only after gathering completes, so a
//! harness never needs a separate candidate channel.
//!
//! The remote side is expected to echo every data-channel message verbatim. The
//! peer then asserts byte equality and ordering, which is what Aurora's mesh RPC
//! actually depends on.
use bytes::Bytes;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;

const SMALL_MESSAGE_COUNT: u8 = 8;
const HANDSHAKE_TIMEOUT_SECS: u64 = 30;

/// Defaults to Aurora's fragment payload size so the lane exercises the largest
/// single frame the mesh actually puts on the wire.
fn large_len() -> usize {
    std::env::var("AURORA_INTEROP_LARGE_LEN")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(16_384)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = env_logger::try_init();

    let api = APIBuilder::new().build();
    let pc = Arc::new(api.new_peer_connection(RTCConfiguration::default()).await?);
    let dc = pc.create_data_channel("aurora-rpc", None).await?;

    pc.on_peer_connection_state_change(Box::new(|state| {
        eprintln!("[peer] peerConnectionState -> {state}");
        Box::pin(async {})
    }));
    pc.on_ice_connection_state_change(Box::new(|state| {
        eprintln!("[peer] iceConnectionState -> {state}");
        Box::pin(async {})
    }));

    let (open_tx, mut open_rx) = mpsc::channel::<()>(1);
    dc.on_open(Box::new(move || {
        let open_tx = open_tx.clone();
        Box::pin(async move {
            let _ = open_tx.send(()).await;
        })
    }));

    let (msg_tx, mut msg_rx) = mpsc::channel::<Vec<u8>>(64);
    dc.on_message(Box::new(move |msg: DataChannelMessage| {
        let msg_tx = msg_tx.clone();
        Box::pin(async move {
            let _ = msg_tx.send(msg.data.to_vec()).await;
        })
    }));

    let offer = pc.create_offer(None).await?;
    let mut gather = pc.gathering_complete_promise().await;
    pc.set_local_description(offer).await?;
    let _ = gather.recv().await;
    let local = pc.local_description().await.ok_or("no local description")?;
    println!("OFFER {}", serde_json::json!({"type": "offer", "sdp": local.sdp}));

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let answer_line = lines.next_line().await?.ok_or("no answer on stdin")?;
    let raw = answer_line.trim_start_matches("ANSWER ").trim();
    let parsed: serde_json::Value = serde_json::from_str(raw)?;
    let sdp = parsed["sdp"].as_str().ok_or("answer missing sdp")?.to_owned();
    pc.set_remote_description(RTCSessionDescription::answer(sdp)?)
        .await?;

    if tokio::time::timeout(
        std::time::Duration::from_secs(HANDSHAKE_TIMEOUT_SECS),
        open_rx.recv(),
    )
    .await
    .is_err()
    {
        println!(
            "RESULT {}",
            serde_json::json!({
                "echoed": 0,
                "expected": usize::from(SMALL_MESSAGE_COUNT) + 1,
                "orderedExactEcho": false,
                "largePayloadOk": false,
                "error": "data channel never opened"
            })
        );
        return Ok(());
    }

    let mut sent: Vec<Vec<u8>> = Vec::new();
    for index in 0..SMALL_MESSAGE_COUNT {
        let payload = format!("aurora-seq-{index}").into_bytes();
        dc.send(&Bytes::from(payload.clone())).await?;
        sent.push(payload);
    }

    let large_len = large_len();
    let large = vec![b'A'; large_len];
    match dc.send(&Bytes::from(large.clone())).await {
        Ok(_) => sent.push(large),
        Err(err) => {
            println!(
                "RESULT {}",
                serde_json::json!({
                    "echoed": 0,
                    "expected": sent.len() + 1,
                    "orderedExactEcho": false,
                    "largePayloadBytes": large_len,
                    "largePayloadOk": false,
                    "sendError": err.to_string()
                })
            );
            return Ok(());
        }
    }

    let mut received: Vec<Vec<u8>> = Vec::new();
    while received.len() < sent.len() {
        match tokio::time::timeout(
            std::time::Duration::from_secs(HANDSHAKE_TIMEOUT_SECS),
            msg_rx.recv(),
        )
        .await
        {
            Ok(Some(data)) => received.push(data),
            _ => break,
        }
    }

    println!(
        "RESULT {}",
        serde_json::json!({
            "echoed": received.len(),
            "expected": sent.len(),
            "orderedExactEcho": received == sent,
            "largePayloadBytes": received.last().map(|m| m.len()).unwrap_or(0),
            "largePayloadOk": received.last().map(|m| m.len()) == Some(large_len)
        })
    );
    pc.close().await?;
    Ok(())
}
