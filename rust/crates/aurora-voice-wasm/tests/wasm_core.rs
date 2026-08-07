#![cfg(target_arch = "wasm32")]

use aurora_voice_core::{
    BoundedPcmBuffer, BufferPush, CancellationToken, Generation, PcmFrame, RouteRevision,
    TimestampMicros,
};
use wasm_bindgen_test::wasm_bindgen_test;

#[wasm_bindgen_test]
fn shared_pcm_and_bounded_buffer_execute_inside_wasm() {
    let generation = Generation(7);
    let frame = PcmFrame::new(
        vec![0.0, 0.25, -0.25, 1.0, -1.0],
        TimestampMicros(10),
        1,
        false,
        RouteRevision(2),
        generation,
    )
    .expect("valid normalized PCM");
    let buffer = BoundedPcmBuffer::nonblocking_queue(2, 10, generation);

    assert_eq!(buffer.push(frame), Ok(BufferPush::Accepted));
    let received = buffer.pop().expect("read buffer").expect("one frame");
    assert_eq!(received.generation(), generation);
    assert_eq!(received.samples(), &[0.0, 0.25, -0.25, 1.0, -1.0]);
}

#[wasm_bindgen_test]
fn shared_cancellation_token_executes_inside_wasm() {
    let cancellation = CancellationToken::new();
    assert!(cancellation.check().is_ok());
    cancellation.cancel();
    assert!(cancellation.check().is_err());
}
