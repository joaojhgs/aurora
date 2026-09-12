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
use webrtc::peer_connection::RTCPeerConnection;

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

    if std::env::args().any(|argument| argument == "--self-test") {
        return run_native_self_test().await;
    }

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
    println!(
        "OFFER {}",
        serde_json::json!({"type": "offer", "sdp": local.sdp})
    );

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let answer_line = lines.next_line().await?.ok_or("no answer on stdin")?;
    let raw = answer_line.trim_start_matches("ANSWER ").trim();
    let parsed: serde_json::Value = serde_json::from_str(raw)?;
    let sdp = parsed["sdp"]
        .as_str()
        .ok_or("answer missing sdp")?
        .to_owned();
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

/// Exercise the same webrtc-rs dependency and vendored DTLS stack entirely in
/// the target runtime. CI pushes this binary into an Android emulator so the
/// lane proves real Android linking, startup, negotiation, SCTP, and ordered
/// data-channel delivery rather than stopping at cross-compilation.
async fn run_native_self_test() -> Result<(), Box<dyn std::error::Error>> {
    let api = APIBuilder::new().build();
    let offerer = Arc::new(api.new_peer_connection(RTCConfiguration::default()).await?);
    let answerer = Arc::new(api.new_peer_connection(RTCConfiguration::default()).await?);
    install_echo_data_channel_handler(Arc::clone(&answerer));

    let channel = offerer.create_data_channel("aurora-rpc", None).await?;
    let (open_tx, mut open_rx) = mpsc::channel::<()>(1);
    channel.on_open(Box::new(move || {
        let open_tx = open_tx.clone();
        Box::pin(async move {
            let _ = open_tx.send(()).await;
        })
    }));

    let (message_tx, mut message_rx) = mpsc::channel::<Vec<u8>>(64);
    channel.on_message(Box::new(move |message: DataChannelMessage| {
        let message_tx = message_tx.clone();
        Box::pin(async move {
            let _ = message_tx.send(message.data.to_vec()).await;
        })
    }));

    let offer = offerer.create_offer(None).await?;
    let mut offer_gathering = offerer.gathering_complete_promise().await;
    offerer.set_local_description(offer).await?;
    let _ = offer_gathering.recv().await;
    let local_offer = offerer
        .local_description()
        .await
        .ok_or("self-test offer missing")?;
    answerer.set_remote_description(local_offer).await?;

    let answer = answerer.create_answer(None).await?;
    let mut answer_gathering = answerer.gathering_complete_promise().await;
    answerer.set_local_description(answer).await?;
    let _ = answer_gathering.recv().await;
    let local_answer = answerer
        .local_description()
        .await
        .ok_or("self-test answer missing")?;
    offerer.set_remote_description(local_answer).await?;

    tokio::time::timeout(
        std::time::Duration::from_secs(HANDSHAKE_TIMEOUT_SECS),
        open_rx.recv(),
    )
    .await
    .map_err(|_| "self-test data channel never opened")?
    .ok_or("self-test data channel open signal closed")?;

    let sent = send_test_messages(&channel).await?;
    let received = receive_test_messages(&mut message_rx, sent.len()).await;
    let ordered_exact_echo = received == sent;
    let large_payload_ok = received.last().map(Vec::len) == Some(large_len());
    let passed = ordered_exact_echo && large_payload_ok && received.len() == sent.len();
    println!(
        "RESULT {}",
        serde_json::json!({
            "schema": "aurora.webrtc_native_android_interop.v1",
            "status": if passed { "passed" } else { "failed" },
            "runtimeOs": std::env::consts::OS,
            "nativeAndroid": cfg!(target_os = "android"),
            "echoed": received.len(),
            "expected": sent.len(),
            "orderedExactEcho": ordered_exact_echo,
            "largePayloadBytes": received.last().map(Vec::len).unwrap_or(0),
            "largePayloadOk": large_payload_ok,
            "secretsRedacted": true,
        })
    );

    offerer.close().await?;
    answerer.close().await?;
    if !passed {
        return Err("native WebRTC self-test failed".into());
    }
    Ok(())
}

fn install_echo_data_channel_handler(peer: Arc<RTCPeerConnection>) {
    peer.on_data_channel(Box::new(move |channel| {
        Box::pin(async move {
            let echo_channel = Arc::clone(&channel);
            channel.on_message(Box::new(move |message: DataChannelMessage| {
                let echo_channel = Arc::clone(&echo_channel);
                Box::pin(async move {
                    let _ = echo_channel.send(&message.data).await;
                })
            }));
        })
    }));
}

async fn send_test_messages(
    channel: &Arc<webrtc::data_channel::RTCDataChannel>,
) -> Result<Vec<Vec<u8>>, Box<dyn std::error::Error>> {
    let mut sent = Vec::new();
    for index in 0..SMALL_MESSAGE_COUNT {
        let payload = format!("aurora-seq-{index}").into_bytes();
        channel.send(&Bytes::from(payload.clone())).await?;
        sent.push(payload);
    }
    let large = vec![b'A'; large_len()];
    channel.send(&Bytes::from(large.clone())).await?;
    sent.push(large);
    Ok(sent)
}

async fn receive_test_messages(
    receiver: &mut mpsc::Receiver<Vec<u8>>,
    expected: usize,
) -> Vec<Vec<u8>> {
    let mut received = Vec::new();
    while received.len() < expected {
        match tokio::time::timeout(
            std::time::Duration::from_secs(HANDSHAKE_TIMEOUT_SECS),
            receiver.recv(),
        )
        .await
        {
            Ok(Some(data)) => received.push(data),
            _ => break,
        }
    }
    received
}
