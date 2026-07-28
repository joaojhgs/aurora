import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  DataChannelLike,
  IceCandidateInitLike,
  PeerConnectionLike,
  PeerSessionPeerConnectionFactory,
  SessionDescriptionLike,
} from "@aurora/client/webrtc";

const NATIVE_WEBRTC_EVENT = "aurora://native-webrtc";

type NativeInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

type NativeListen = <T>(
  event: string,
  handler: (event: { payload: T }) => void,
) => Promise<UnlistenFn>;

export interface TauriNativeWebRtcBridge {
  invoke: NativeInvoke;
  listen: NativeListen;
}

interface NativeWebRtcCreateResponse {
  peerConnectionId: number;
  connectionState: string;
  iceConnectionState: string;
}

interface NativeDataChannelResponse {
  dataChannelId: number;
  label: string;
  readyState: string;
  bufferedAmount: number;
}

interface NativeIceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

type NativeWebRtcEvent =
  | {
      type: "iceCandidate";
      peerConnectionId: number;
      candidate?: NativeIceCandidate | null;
    }
  | {
      type: "connectionState";
      peerConnectionId: number;
      connectionState: string;
    }
  | {
      type: "iceConnectionState";
      peerConnectionId: number;
      iceConnectionState: string;
    }
  | {
      type: "dataChannel";
      peerConnectionId: number;
      dataChannelId: number;
      label: string;
      readyState: string;
      bufferedAmount: number;
    }
  | {
      type: "dataChannelOpen";
      peerConnectionId: number;
      dataChannelId: number;
    }
  | {
      type: "dataChannelMessage";
      peerConnectionId: number;
      dataChannelId: number;
      payload: string;
      binary: boolean;
    }
  | {
      type: "dataChannelBufferedAmount";
      peerConnectionId: number;
      dataChannelId: number;
      bufferedAmount: number;
    }
  | {
      type: "dataChannelClose";
      peerConnectionId: number;
      dataChannelId: number;
    }
  | {
      type: "error";
      peerConnectionId: number;
      dataChannelId?: number | null;
      scope: string;
      message: string;
    };

const defaultBridge: TauriNativeWebRtcBridge = {
  invoke,
  listen,
};

export function createTauriNativePeerConnectionFactory(
  bridge: TauriNativeWebRtcBridge,
): PeerSessionPeerConnectionFactory {
  const registry = new NativeWebRtcEventRegistry(bridge);
  return (configuration) =>
    new TauriNativePeerConnection(configuration, bridge, registry);
}

class TauriNativePeerConnection implements PeerConnectionLike {
  localDescription: SessionDescriptionLike | null = null;
  remoteDescription: SessionDescriptionLike | null = null;
  connectionState: RTCPeerConnectionState | string = "new";
  iceConnectionState: RTCIceConnectionState | string = "new";
  onicecandidate: PeerConnectionLike["onicecandidate"] = null;
  ondatachannel: PeerConnectionLike["ondatachannel"] = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;

  private peerConnectionId: number | undefined;
  private initialization: Promise<number> | undefined;
  private readonly dataChannels = new Map<number, TauriNativeDataChannel>();
  private readonly pendingDataChannelEvents = new Map<
    number,
    NativeWebRtcEvent[]
  >();
  private readonly pendingDataChannels = new Set<Promise<void>>();
  private closed = false;

  constructor(
    private readonly configuration: RTCConfiguration,
    private readonly bridge: TauriNativeWebRtcBridge,
    private readonly registry: NativeWebRtcEventRegistry,
  ) {}

  createDataChannel(
    label: string,
    options: RTCDataChannelInit = {},
  ): DataChannelLike {
    const channel = new TauriNativeDataChannel(label, this.bridge);
    const binding = this.ensurePeerConnection()
      .then(async (peerConnectionId) => {
        const response =
          await this.bridge.invoke<NativeDataChannelResponse>(
            "aurora_native_webrtc_create_data_channel",
            {
              request: {
                peerConnectionId,
                label,
                ordered: options.ordered ?? true,
              },
            },
        );
        channel.bind(peerConnectionId, response);
        this.dataChannels.set(response.dataChannelId, channel);
        this.flushPendingDataChannelEvents(response.dataChannelId);
      })
      .catch((error) => channel.fail(error));
    this.trackDataChannelBinding(binding);
    return channel;
  }

  async createOffer(): Promise<SessionDescriptionLike> {
    const peerConnectionId = await this.readyForNegotiation();
    return await this.bridge.invoke<SessionDescriptionLike>(
      "aurora_native_webrtc_create_offer",
      { request: { peerConnectionId } },
    );
  }

  async createAnswer(): Promise<SessionDescriptionLike> {
    const peerConnectionId = await this.readyForNegotiation();
    return await this.bridge.invoke<SessionDescriptionLike>(
      "aurora_native_webrtc_create_answer",
      { request: { peerConnectionId } },
    );
  }

  async setLocalDescription(
    description: SessionDescriptionLike,
  ): Promise<void> {
    const peerConnectionId = await this.ensurePeerConnection();
    await this.bridge.invoke<void>(
      "aurora_native_webrtc_set_local_description",
      { request: { peerConnectionId, description } },
    );
    this.localDescription = { ...description };
  }

  async setRemoteDescription(
    description: SessionDescriptionLike,
  ): Promise<void> {
    const peerConnectionId = await this.ensurePeerConnection();
    await this.bridge.invoke<void>(
      "aurora_native_webrtc_set_remote_description",
      { request: { peerConnectionId, description } },
    );
    this.remoteDescription = { ...description };
  }

  async addIceCandidate(
    candidate: IceCandidateInitLike | null,
  ): Promise<void> {
    const peerConnectionId = await this.ensurePeerConnection();
    await this.bridge.invoke<void>(
      "aurora_native_webrtc_add_ice_candidate",
      { request: { peerConnectionId, candidate } },
    );
  }

  async getStats(): Promise<Map<string, unknown>> {
    const peerConnectionId = await this.ensurePeerConnection();
    const report = await this.bridge.invoke<Record<string, unknown>>(
      "aurora_native_webrtc_get_stats",
      { request: { peerConnectionId } },
    );
    return new Map(Object.entries(report));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connectionState = "closed";
    this.iceConnectionState = "closed";
    for (const channel of this.dataChannels.values()) channel.close();
    this.dataChannels.clear();
    this.pendingDataChannelEvents.clear();
    void this.initialization
      ?.then(async (peerConnectionId) => {
        this.registry.remove(peerConnectionId);
        await this.bridge.invoke<void>("aurora_native_webrtc_close", {
          request: { peerConnectionId },
        });
      })
      .catch(() => undefined);
  }

  handleNativeEvent(event: NativeWebRtcEvent): void {
    if (this.closed) return;
    switch (event.type) {
      case "iceCandidate":
        this.onicecandidate?.({
          candidate:
            event.candidate == null
              ? null
              : {
                  ...event.candidate,
                  toJSON: () => ({ ...event.candidate! }),
                },
        });
        return;
      case "connectionState":
        this.connectionState = event.connectionState;
        this.onconnectionstatechange?.();
        return;
      case "iceConnectionState":
        this.iceConnectionState = event.iceConnectionState;
        this.oniceconnectionstatechange?.();
        return;
      case "dataChannel": {
        const channel = new TauriNativeDataChannel(event.label, this.bridge);
        channel.bind(event.peerConnectionId, {
          dataChannelId: event.dataChannelId,
          label: event.label,
          readyState: event.readyState,
          bufferedAmount: event.bufferedAmount,
        });
        this.dataChannels.set(event.dataChannelId, channel);
        this.ondatachannel?.({ channel });
        if (event.readyState === "open") channel.open();
        return;
      }
      case "dataChannelOpen":
        if (!this.dataChannels.has(event.dataChannelId)) {
          this.queuePendingDataChannelEvent(event);
          return;
        }
        this.dataChannels.get(event.dataChannelId)?.open();
        return;
      case "dataChannelMessage":
        if (!this.dataChannels.has(event.dataChannelId)) {
          this.queuePendingDataChannelEvent(event);
          return;
        }
        this.dataChannels
          .get(event.dataChannelId)
          ?.message(
            event.binary
              ? base64ToArrayBuffer(event.payload)
              : event.payload,
          );
        return;
      case "dataChannelBufferedAmount":
        if (!this.dataChannels.has(event.dataChannelId)) {
          this.queuePendingDataChannelEvent(event);
          return;
        }
        this.dataChannels
          .get(event.dataChannelId)
          ?.setBufferedAmount(event.bufferedAmount);
        return;
      case "dataChannelClose":
        if (!this.dataChannels.has(event.dataChannelId)) {
          this.queuePendingDataChannelEvent(event);
          return;
        }
        this.dataChannels.get(event.dataChannelId)?.nativeClose();
        this.dataChannels.delete(event.dataChannelId);
        return;
      case "error":
        if (event.dataChannelId != null) {
          if (!this.dataChannels.has(event.dataChannelId)) {
            this.queuePendingDataChannelEvent(event);
            return;
          }
          this.dataChannels
            .get(event.dataChannelId)
            ?.fail(new Error(event.message));
          return;
        }
        this.connectionState = "failed";
        this.onconnectionstatechange?.();
    }
  }

  private queuePendingDataChannelEvent(event: NativeWebRtcEvent): void {
    if (!("dataChannelId" in event) || event.dataChannelId == null) return;
    const pending = this.pendingDataChannelEvents.get(event.dataChannelId) ?? [];
    pending.push(event);
    this.pendingDataChannelEvents.set(event.dataChannelId, pending);
  }

  private flushPendingDataChannelEvents(dataChannelId: number): void {
    const pending = this.pendingDataChannelEvents.get(dataChannelId);
    if (!pending) return;
    this.pendingDataChannelEvents.delete(dataChannelId);
    for (const event of pending) this.handleNativeEvent(event);
  }

  private ensurePeerConnection(): Promise<number> {
    if (this.closed) {
      return Promise.reject(
        new Error("native WebRTC peer connection is closed"),
      );
    }
    this.initialization ??= this.initialize();
    return this.initialization;
  }

  private async initialize(): Promise<number> {
    await this.registry.ensureListening();
    const response =
      await this.bridge.invoke<NativeWebRtcCreateResponse>(
        "aurora_native_webrtc_create",
        {
          request: {
            iceServers: normalizeIceServers(this.configuration.iceServers),
            iceTransportPolicy:
              this.configuration.iceTransportPolicy ?? "all",
          },
        },
      );
    this.peerConnectionId = response.peerConnectionId;
    this.connectionState = response.connectionState || "new";
    this.iceConnectionState = response.iceConnectionState || "new";
    this.registry.add(response.peerConnectionId, this);
    return response.peerConnectionId;
  }

  private async readyForNegotiation(): Promise<number> {
    const peerConnectionId = await this.ensurePeerConnection();
    await Promise.all([...this.pendingDataChannels]);
    return peerConnectionId;
  }

  private trackDataChannelBinding(binding: Promise<void>): void {
    this.pendingDataChannels.add(binding);
    void binding.finally(() => this.pendingDataChannels.delete(binding));
  }
}

class NativeWebRtcEventRegistry {
  private readonly peerConnections = new Map<
    number,
    TauriNativePeerConnection
  >();
  private nativeEventListener: Promise<UnlistenFn> | undefined;

  constructor(private readonly bridge: TauriNativeWebRtcBridge) {}

  add(
    peerConnectionId: number,
    peerConnection: TauriNativePeerConnection,
  ): void {
    this.peerConnections.set(peerConnectionId, peerConnection);
  }

  remove(peerConnectionId: number): void {
    this.peerConnections.delete(peerConnectionId);
  }

  async ensureListening(): Promise<void> {
    this.nativeEventListener ??= this.bridge.listen<NativeWebRtcEvent>(
      NATIVE_WEBRTC_EVENT,
      ({ payload }) => {
        this.peerConnections
          .get(payload.peerConnectionId)
          ?.handleNativeEvent(payload);
      },
    );
    await this.nativeEventListener;
  }
}

class TauriNativeDataChannel implements DataChannelLike {
  readonly label: string;
  readyState = "connecting";
  onopen: (() => void) | null = null;
  onmessage:
    | ((event: {
        data: string | ArrayBuffer | ArrayBufferView;
      }) => void)
    | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;

  private peerConnectionId: number | undefined;
  private dataChannelId: number | undefined;
  private nativeBufferedAmount = 0;
  private pendingIpcBytes = 0;
  private bufferedAmountLowThresholdValue = 0;
  private sendQueue: Promise<void> = Promise.resolve();
  private openNotified = false;
  private readonly listeners = new Map<
    string,
    Set<EventListenerOrEventListenerObject>
  >();

  constructor(
    label: string,
    private readonly bridge: TauriNativeWebRtcBridge,
  ) {
    this.label = label;
  }

  get bufferedAmount(): number {
    return this.nativeBufferedAmount + this.pendingIpcBytes;
  }

  get bufferedAmountLowThreshold(): number {
    return this.bufferedAmountLowThresholdValue;
  }

  set bufferedAmountLowThreshold(value: number) {
    this.bufferedAmountLowThresholdValue = Math.max(
      0,
      Math.floor(value),
    );
    this.syncBufferedAmountLowThreshold();
  }

  bind(
    peerConnectionId: number,
    response: NativeDataChannelResponse,
  ): void {
    this.peerConnectionId = peerConnectionId;
    this.dataChannelId = response.dataChannelId;
    this.readyState = response.readyState || "connecting";
    this.nativeBufferedAmount = response.bufferedAmount;
    this.syncBufferedAmountLowThreshold();
    if (this.readyState === "open") queueMicrotask(() => this.open());
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== "open" || this.dataChannelId === undefined) {
      throw new DOMException(
        "native WebRTC data channel is not open",
        "InvalidStateError",
      );
    }
    const byteLength = payloadByteLength(data);
    this.pendingIpcBytes += byteLength;
    const request =
      typeof data === "string"
        ? {
            dataChannelId: this.dataChannelId,
            payload: data,
            binary: false,
          }
        : {
            dataChannelId: this.dataChannelId,
            payload: arrayBufferViewToBase64(data),
            binary: true,
          };
    const send = this.sendQueue.then(async () => {
      try {
        await this.bridge.invoke<void>(
          "aurora_native_webrtc_data_channel_send",
          { request },
        );
      } finally {
        this.updateBufferedAmounts({
          pendingIpcBytes: Math.max(
            0,
            this.pendingIpcBytes - byteLength,
          ),
        });
      }
    });
    this.sendQueue = send.catch((error) => {
      this.fail(error);
    });
  }

  close(): void {
    if (this.readyState === "closed" || this.readyState === "closing") return;
    this.readyState = "closing";
    if (this.dataChannelId === undefined) {
      this.nativeClose();
      return;
    }
    void this.bridge
      .invoke<void>("aurora_native_webrtc_data_channel_close", {
        request: { dataChannelId: this.dataChannelId },
      })
      .catch((error) => this.fail(error));
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  open(): void {
    if (this.readyState === "closed") return;
    this.readyState = "open";
    if (this.openNotified) return;
    this.openNotified = true;
    this.onopen?.();
    this.dispatch("open");
  }

  message(data: string | ArrayBuffer): void {
    if (this.readyState !== "open") return;
    this.onmessage?.({ data });
  }

  setBufferedAmount(bufferedAmount: number): void {
    this.updateBufferedAmounts({
      nativeBufferedAmount: Math.max(0, bufferedAmount),
    });
  }

  private updateBufferedAmounts({
    nativeBufferedAmount = this.nativeBufferedAmount,
    pendingIpcBytes = this.pendingIpcBytes,
  }: {
    nativeBufferedAmount?: number;
    pendingIpcBytes?: number;
  }): void {
    const wasAboveThreshold =
      this.bufferedAmount > this.bufferedAmountLowThresholdValue;
    this.nativeBufferedAmount = nativeBufferedAmount;
    this.pendingIpcBytes = pendingIpcBytes;
    if (
      wasAboveThreshold &&
      this.bufferedAmount <= this.bufferedAmountLowThresholdValue
    ) {
      this.dispatch("bufferedamountlow");
    }
  }

  nativeClose(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.nativeBufferedAmount = 0;
    this.pendingIpcBytes = 0;
    this.onclose?.();
    this.dispatch("close");
  }

  fail(error: unknown): void {
    this.onerror?.(error);
    this.dispatch("error");
  }

  private dispatch(type: string): void {
    const event = new Event(type);
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === "function") {
        listener(event);
      } else {
        listener.handleEvent(event);
      }
    }
  }

  private syncBufferedAmountLowThreshold(): void {
    if (this.dataChannelId === undefined) return;
    void this.bridge
      .invoke<void>(
        "aurora_native_webrtc_set_data_channel_buffered_amount_low_threshold",
        {
          request: {
            dataChannelId: this.dataChannelId,
            bufferedAmountLowThreshold:
              this.bufferedAmountLowThresholdValue,
          },
        },
      )
      .catch((error) => this.fail(error));
  }
}

function normalizeIceServers(
  iceServers: RTCIceServer[] | undefined,
): Array<{
  urls: string[];
  username: string;
  credential?: string;
}> {
  return (iceServers ?? []).map((server) => {
    const urls =
      typeof server.urls === "string" ? [server.urls] : [...server.urls];
    const normalized: {
      urls: string[];
      username: string;
      credential?: string;
    } = {
      urls,
      username: server.username ?? "",
    };
    if (typeof server.credential === "string") {
      normalized.credential = server.credential;
    }
    return normalized;
  });
}

function payloadByteLength(
  data: string | ArrayBuffer | ArrayBufferView,
): number {
  if (typeof data === "string") return new TextEncoder().encode(data).length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  return data.byteLength;
}

function arrayBufferViewToBase64(
  data: ArrayBuffer | ArrayBufferView,
): string {
  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

/**
 * Linux desktop thin fallback for distributions whose WebKitGTK build omits
 * the RTCPeerConnection DOM feature. The Aurora signaling, pairing, codec,
 * reconnect, and RPC layers remain in TypeScript; only the peer-connection and
 * DataChannel primitives cross the narrow Tauri bridge.
 */
export const createTauriNativePeerConnection: PeerSessionPeerConnectionFactory =
  createTauriNativePeerConnectionFactory(defaultBridge);
