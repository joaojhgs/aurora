import { describe, expect, it, vi } from "vitest";
import type {
  DataChannelLike,
  PeerConnectionLike,
} from "@aurora/client/webrtc";
import {
  createTauriNativePeerConnectionFactory,
  deliverNativeTransportFrame,
  nativeTransportHandleForRemoteSignalingId,
  NativeWebRtcMessageTooLargeError,
  NATIVE_WEBRTC_MAX_MESSAGE_BYTES,
  type TauriNativeWebRtcBridge,
} from "./native-webrtc";

class FakeNativeWebRtcBridge implements TauriNativeWebRtcBridge {
  readonly calls: Array<{
    command: string;
    args?: Record<string, unknown>;
  }> = [];
  private eventHandler:
    | ((event: { payload: Record<string, unknown> }) => void)
    | undefined;
  beforeDataChannelResponse: (() => void) | undefined;
  failSendWith: unknown | undefined;

  async invoke<T>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T> {
    this.calls.push({ command, args });
    if (
      command === "aurora_native_webrtc_data_channel_send" &&
      this.failSendWith !== undefined
    ) {
      throw this.failSendWith;
    }
    switch (command) {
      case "aurora_native_webrtc_create":
        return {
          peerConnectionId: 7,
          connectionState: "new",
          iceConnectionState: "new",
        } as T;
      case "aurora_native_webrtc_create_data_channel":
        this.beforeDataChannelResponse?.();
        return {
          dataChannelId: 8,
          label: "aurora-rpc",
          readyState: "connecting",
          bufferedAmount: 0,
        } as T;
      case "aurora_native_webrtc_create_offer":
        return { type: "offer", sdp: "v=0\r\no=native-offer" } as T;
      case "aurora_native_webrtc_create_answer":
        return { type: "answer", sdp: "v=0\r\no=native-answer" } as T;
      case "aurora_native_webrtc_get_stats":
        return {
          pair: {
            type: "candidate-pair",
            state: "succeeded",
            nominated: true,
            localCandidateId: "local",
            remoteCandidateId: "remote",
          },
        } as T;
      default:
        return undefined as T;
    }
  }

  async listen<T>(
    event: string,
    handler: (event: { payload: T }) => void,
  ): Promise<() => void> {
    expect(event).toBe("aurora://native-webrtc");
    this.eventHandler = handler as (
      event: { payload: Record<string, unknown> },
    ) => void;
    return () => {
      this.eventHandler = undefined;
    };
  }

  emit(payload: Record<string, unknown>): void {
    this.eventHandler?.({ payload });
  }
}

describe("Tauri native WebRTC fallback", () => {
  it("indexes and reinjects frames by the session's exact signaling identity", async () => {
    const bridge = new FakeNativeWebRtcBridge();
    const peer = createTauriNativePeerConnectionFactory(bridge)(
      {},
      { remoteSignalingId: "signal-exact-peer" },
    );
    const channel = peer.createDataChannel("aurora-rpc");
    const onMessage = vi.fn();
    channel.onmessage = onMessage;
    await peer.createOffer();
    bridge.emit({
      type: "dataChannelOpen",
      peerConnectionId: 7,
      dataChannelId: 8,
    });

    expect(
      nativeTransportHandleForRemoteSignalingId("signal-exact-peer"),
    ).toEqual({ peerConnectionId: 7, dataChannelId: 8 });
    expect(deliverNativeTransportFrame(8, {
      kind: "json",
      frame: { type: "event", id: "replay-1" },
    }))
      .toBe(true);
    expect(onMessage).toHaveBeenCalledWith({
      data: '{"type":"event","id":"replay-1"}',
    });
    expect(deliverNativeTransportFrame(8, {
      kind: "nativeBinary",
      payloadBase64: "AQID",
    })).toBe(true);
    expect(onMessage).toHaveBeenLastCalledWith({
      data: expect.any(ArrayBuffer),
    });
    expect(new Uint8Array(onMessage.mock.lastCall?.[0].data as ArrayBuffer))
      .toEqual(new Uint8Array([1, 2, 3]));
    expect(deliverNativeTransportFrame(8, {
      kind: "json",
      frame: {
        __auroraNativeDataChannelFrame: {
          version: 1,
          binary: true,
          payloadBase64: "AQID",
        },
      },
    })).toBe(true);
    expect(onMessage).toHaveBeenLastCalledWith({
      data: JSON.stringify({
        __auroraNativeDataChannelFrame: {
          version: 1,
          binary: true,
          payloadBase64: "AQID",
        },
      }),
    });
    expect(
      nativeTransportHandleForRemoteSignalingId("signal-other-peer"),
    ).toBeNull();
  });

  it("keeps negotiation ordering and browser-like peer/data-channel semantics", async () => {
    const bridge = new FakeNativeWebRtcBridge();
    const createPeerConnection =
      createTauriNativePeerConnectionFactory(bridge);
    const peer = createPeerConnection({
      iceServers: [
        {
          urls: [
            "stun:stun.example.test:3478",
            "turn:turn.example.test:3478?transport=udp",
          ],
          username: "aurora",
          credential: "turn-secret",
        },
      ],
    });
    const channel = peer.createDataChannel("aurora-rpc", {
      ordered: true,
    });
    channel.bufferedAmountLowThreshold = 64 * 1024;
    const onOpen = vi.fn();
    const onMessage = vi.fn();
    channel.onopen = onOpen;
    channel.onmessage = onMessage;

    const offer = await peer.createOffer();
    expect(offer).toEqual({
      type: "offer",
      sdp: "v=0\r\no=native-offer",
    });
    expect(
      bridge.calls.slice(0, 4).map(({ command }) => command),
    ).toEqual([
      "aurora_native_webrtc_create",
      "aurora_native_webrtc_create_data_channel",
      "aurora_native_webrtc_set_data_channel_buffered_amount_low_threshold",
      "aurora_native_webrtc_create_offer",
    ]);
    expect(bridge.calls[0]?.args).toMatchObject({
      request: {
        iceServers: [
          {
            urls: [
              "stun:stun.example.test:3478",
              "turn:turn.example.test:3478?transport=udp",
            ],
            username: "aurora",
            credential: "turn-secret",
          },
        ],
      },
    });

    bridge.emit({
      type: "dataChannelOpen",
      peerConnectionId: 7,
      dataChannelId: 8,
    });
    expect(channel.readyState).toBe("open");
    expect(onOpen).toHaveBeenCalledOnce();
    bridge.emit({
      type: "dataChannelOpen",
      peerConnectionId: 7,
      dataChannelId: 8,
    });
    expect(onOpen).toHaveBeenCalledOnce();

    channel.send("encrypted-frame");
    await vi.waitFor(() => {
      expect(
        bridge.calls.some(
          ({ command }) =>
            command === "aurora_native_webrtc_data_channel_send",
        ),
      ).toBe(true);
    });
    expect(
      bridge.calls.find(
        ({ command }) =>
          command === "aurora_native_webrtc_data_channel_send",
      )?.args,
    ).toEqual({
      request: {
        dataChannelId: 8,
        payload: "encrypted-frame",
        binary: false,
      },
    });

    bridge.emit({
      type: "dataChannelMessage",
      peerConnectionId: 7,
      dataChannelId: 8,
      payload: "reply-frame",
      binary: false,
    });
    expect(onMessage).toHaveBeenCalledWith({ data: "reply-frame" });

    const onIceCandidate = vi.fn();
    peer.onicecandidate = onIceCandidate;
    bridge.emit({
      type: "iceCandidate",
      peerConnectionId: 7,
      candidate: {
        candidate: "candidate:1 1 UDP 1 192.0.2.1 1234 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
      },
    });
    expect(onIceCandidate).toHaveBeenCalledOnce();
    expect(
      onIceCandidate.mock.calls[0]?.[0].candidate.toJSON(),
    ).toEqual({
      candidate: "candidate:1 1 UDP 1 192.0.2.1 1234 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
    });

    const stats = await peer.getStats?.();
    expect(stats).toBeInstanceOf(Map);
    expect(stats?.get("pair")).toMatchObject({
      type: "candidate-pair",
      state: "succeeded",
      nominated: true,
    });
  });

  it("projects an incoming native data channel to the answerer", async () => {
    const bridge = new FakeNativeWebRtcBridge();
    const peer = createTauriNativePeerConnectionFactory(bridge)({});
    const incoming: DataChannelLike[] = [];
    peer.ondatachannel = ({ channel }) => incoming.push(channel);

    await peer.setRemoteDescription({
      type: "offer",
      sdp: "v=0\r\no=remote-offer",
    });
    bridge.emit({
      type: "dataChannel",
      peerConnectionId: 7,
      dataChannelId: 11,
      label: "aurora-rpc",
      readyState: "connecting",
      bufferedAmount: 0,
    });

    expect(incoming).toHaveLength(1);
    expect(incoming[0]?.label).toBe("aurora-rpc");
    expect(incoming[0]?.readyState).toBe("connecting");

    const opened = vi.fn();
    incoming[0]!.onopen = opened;
    bridge.emit({
      type: "dataChannelOpen",
      peerConnectionId: 7,
      dataChannelId: 11,
    });
    expect(incoming[0]?.readyState).toBe("open");
    expect(opened).toHaveBeenCalledOnce();
  });

  it("replays native channel events that race the command response", async () => {
    const bridge = new FakeNativeWebRtcBridge();
    const peer = createTauriNativePeerConnectionFactory(bridge)({});
    const channel = peer.createDataChannel("aurora-rpc");
    const opened = vi.fn();
    const messaged = vi.fn();
    channel.onopen = opened;
    channel.onmessage = messaged;
    bridge.beforeDataChannelResponse = () => {
      bridge.emit({
        type: "dataChannelOpen",
        peerConnectionId: 7,
        dataChannelId: 8,
      });
      bridge.emit({
        type: "dataChannelMessage",
        peerConnectionId: 7,
        dataChannelId: 8,
        payload: "early-encrypted-frame",
        binary: false,
      });
    };

    await peer.createOffer();

    expect(channel.readyState).toBe("open");
    expect(opened).toHaveBeenCalledOnce();
    expect(messaged).toHaveBeenCalledWith({
      data: "early-encrypted-frame",
    });
  });

  it("rejects a message above the transport ceiling instead of losing it", async () => {
    const bridge = new FakeNativeWebRtcBridge();
    const peer = createTauriNativePeerConnectionFactory(bridge)({});
    const channel = peer.createDataChannel("aurora-rpc");
    await peer.createOffer();
    bridge.emit({
      type: "dataChannelOpen",
      peerConnectionId: 7,
      dataChannelId: 8,
    });
    expect(channel.readyState).toBe("open");

    // Measured, not chosen: 65,535 round-trips and 65,536 does not, so the
    // boundary is the assertion rather than the rough magnitude.
    expect(NATIVE_WEBRTC_MAX_MESSAGE_BYTES).toBe(65_535);
    const sendsBefore = bridge.calls.filter(
      ({ command }) => command === "aurora_native_webrtc_data_channel_send",
    ).length;

    expect(() => channel.send("a".repeat(65_536))).toThrow(
      NativeWebRtcMessageTooLargeError,
    );
    try {
      channel.send(new Uint8Array(131_072));
      expect.unreachable("an oversize binary send must not be accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(NativeWebRtcMessageTooLargeError);
      // A browser RTCDataChannel throws a TypeError for this, and this channel
      // stands in for one.
      expect(error).toBeInstanceOf(TypeError);
      expect((error as NativeWebRtcMessageTooLargeError).code).toBe(
        "messageTooLarge",
      );
      expect((error as NativeWebRtcMessageTooLargeError).byteLength).toBe(
        131_072,
      );
      expect((error as NativeWebRtcMessageTooLargeError).maxByteLength).toBe(
        65_535,
      );
    }

    // Nothing reached the transport, and the refusal did not leave the channel
    // accounting for bytes it never sent.
    expect(
      bridge.calls.filter(
        ({ command }) => command === "aurora_native_webrtc_data_channel_send",
      ),
    ).toHaveLength(sendsBefore);
    expect(channel.bufferedAmount).toBe(0);

    // A message exactly at the ceiling still goes.
    channel.send("a".repeat(65_535));
    await vi.waitFor(() => {
      expect(
        bridge.calls.filter(
          ({ command }) => command === "aurora_native_webrtc_data_channel_send",
        ),
      ).toHaveLength(sendsBefore + 1);
    });
  });

  it("surfaces the Rust ceiling rejection as the same typed error", async () => {
    const bridge = new FakeNativeWebRtcBridge();
    bridge.failSendWith = {
      code: "messageTooLarge",
      byteLength: 70_000,
      maxByteLength: 65_535,
    };
    const peer = createTauriNativePeerConnectionFactory(bridge)({});
    const channel = peer.createDataChannel("aurora-rpc");
    const errored = vi.fn();
    channel.onerror = errored;
    await peer.createOffer();
    bridge.emit({
      type: "dataChannelOpen",
      peerConnectionId: 7,
      dataChannelId: 8,
    });

    // Under the ceiling on this side, so it reaches Rust, which is the backstop
    // for anything the TypeScript guard cannot see.
    channel.send("frame");
    await vi.waitFor(() => {
      expect(errored).toHaveBeenCalled();
    });
    const error = errored.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(NativeWebRtcMessageTooLargeError);
    expect((error as NativeWebRtcMessageTooLargeError).byteLength).toBe(70_000);
    expect((error as NativeWebRtcMessageTooLargeError).maxByteLength).toBe(
      65_535,
    );
  });

  it("uses the native factory only as the PeerConnection primitive", () => {
    const sourcePeer: Pick<
      PeerConnectionLike,
      "connectionState" | "iceConnectionState"
    > = createTauriNativePeerConnectionFactory(
      new FakeNativeWebRtcBridge(),
    )({});
    expect(sourcePeer.connectionState).toBe("new");
    expect(sourcePeer.iceConnectionState).toBe("new");
  });
});
