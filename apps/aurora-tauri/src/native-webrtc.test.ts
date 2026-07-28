import { describe, expect, it, vi } from "vitest";
import type {
  DataChannelLike,
  PeerConnectionLike,
} from "@aurora/client/webrtc";
import {
  createTauriNativePeerConnectionFactory,
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

  async invoke<T>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T> {
    this.calls.push({ command, args });
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
