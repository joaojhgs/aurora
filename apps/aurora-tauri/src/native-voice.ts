import type {
  NativeDesktopVoiceConnection,
  NativeDesktopVoiceControlRequest,
  NativeDesktopVoiceEvent,
  NativeDesktopVoicePhase,
  NativeDesktopVoicePort,
  NativeDesktopVoiceStartRequest,
  NativeDesktopVoiceStatus,
  NativeDesktopVoiceStopReason,
  NativeDesktopVoiceTrigger,
} from "@aurora/ui";

export const AURORA_NATIVE_VOICE_STATUS_EVENT = "aurora://native-voice-status";

type UnlistenFn = () => void;

const PHASES = new Set<NativeDesktopVoicePhase>([
  "unavailable",
  "idle",
  "starting",
  "listening",
  "processing",
  "speaking",
  "stopping",
  "faulted",
]);

const CONNECTIONS = new Set<NativeDesktopVoiceConnection>([
  "this_device",
  "connected_device",
  "unavailable",
]);

const TRIGGERS = new Set<NativeDesktopVoiceTrigger>([
  "focused_push_to_talk",
  "tray_push_to_talk",
]);

const STOP_REASONS = new Set<NativeDesktopVoiceStopReason>([
  "user_request",
  "window_hidden",
  "permission_revoked",
  "shutdown",
]);

const STATUS_KEYS = new Set([
  "available",
  "phase",
  "generation",
  "backgroundEligible",
  "connection",
  "reasonCode",
  "redacted",
]);

const EVENT_KEYS = new Set(["sequence", "status"]);
const SAFE_REASON_CODE = /^[a-z][a-z0-9_.-]{0,63}$/u;

type NativeInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

type NativeListen = <T>(
  event: string,
  handler: (event: { payload: T }) => void,
) => Promise<UnlistenFn>;

export interface TauriNativeVoiceBridge {
  invoke: NativeInvoke;
  listen: NativeListen;
}

export function createTauriNativeDesktopVoicePort(
  bridge: TauriNativeVoiceBridge,
): NativeDesktopVoicePort {
  return {
    status: async () =>
      validateStatus(
        await safeInvoke(bridge, "aurora_native_voice_status", {
          request: {},
        }),
      ),
    start: async (request) =>
      validateStatus(
        await safeInvoke(bridge, "aurora_native_voice_start", {
          request: validateStartRequest(request),
        }),
      ),
    finish: async (request) =>
      validateStatus(
        await safeInvoke(bridge, "aurora_native_voice_finish", {
          request: validateControlRequest(request),
        }),
      ),
    cancel: async (request) =>
      validateStatus(
        await safeInvoke(bridge, "aurora_native_voice_cancel", {
          request: validateControlRequest(request),
        }),
      ),
    subscribe: async (listener) => {
      let closed = false;
      let lastSequence = 0;
      const unlisten = await safeListen(
        bridge,
        AURORA_NATIVE_VOICE_STATUS_EVENT,
        (event) => {
          if (closed) return;
          const parsed = parseEvent(event.payload);
          if (!parsed || parsed.sequence <= lastSequence) return;
          lastSequence = parsed.sequence;
          listener(parsed);
        },
      );
      return () => {
        if (closed) return;
        closed = true;
        unlisten();
      };
    },
  };
}

async function safeInvoke(
  bridge: TauriNativeVoiceBridge,
  command: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await bridge.invoke<unknown>(command, args);
  } catch {
    throw nativeVoiceUnavailableError();
  }
}

async function safeListen(
  bridge: TauriNativeVoiceBridge,
  event: string,
  handler: (event: { payload: unknown }) => void,
): Promise<UnlistenFn> {
  try {
    return await bridge.listen<unknown>(event, handler);
  } catch {
    throw nativeVoiceUnavailableError();
  }
}

function nativeVoiceUnavailableError(): Error {
  return new Error("Native voice is unavailable.");
}

function validateStartRequest(
  request: NativeDesktopVoiceStartRequest,
): NativeDesktopVoiceStartRequest {
  if (
    !isRecord(request) ||
    !hasOnlyKeys(request, ["trigger", "remoteAudioConsent"]) ||
    !TRIGGERS.has(request.trigger as NativeDesktopVoiceTrigger) ||
    typeof request.remoteAudioConsent !== "boolean"
  ) {
    throw new Error("Native voice start request is invalid.");
  }
  return {
    trigger: request.trigger,
    remoteAudioConsent: request.remoteAudioConsent,
  };
}

function validateControlRequest(
  request: NativeDesktopVoiceControlRequest,
): NativeDesktopVoiceControlRequest {
  if (
    !isRecord(request) ||
    !hasOnlyKeys(request, ["generation", "reason"]) ||
    !isSafeNonzeroInteger(request.generation) ||
    !STOP_REASONS.has(request.reason as NativeDesktopVoiceStopReason)
  ) {
    throw new Error("Native voice control request is invalid.");
  }
  return {
    generation: request.generation,
    reason: request.reason,
  };
}

function validateStatus(payload: unknown): NativeDesktopVoiceStatus {
  const status = parseStatus(payload);
  if (!status) throw new Error("Native voice status payload is invalid.");
  return status;
}

function parseEvent(payload: unknown): NativeDesktopVoiceEvent | null {
  if (
    !isRecord(payload) ||
    !hasOnlyKeys(payload, EVENT_KEYS) ||
    !isSafeNonzeroInteger(payload.sequence)
  ) {
    return null;
  }
  const status = parseStatus(payload.status);
  if (!status) return null;
  return {
    sequence: payload.sequence,
    status,
  };
}

function parseStatus(payload: unknown): NativeDesktopVoiceStatus | null {
  if (!isRecord(payload) || !hasOnlyKeys(payload, STATUS_KEYS)) return null;
  if (
    typeof payload.available !== "boolean" ||
    !PHASES.has(payload.phase as NativeDesktopVoicePhase) ||
    !isSafeGeneration(payload.generation) ||
    typeof payload.backgroundEligible !== "boolean" ||
    !CONNECTIONS.has(payload.connection as NativeDesktopVoiceConnection) ||
    !isSafeReasonCode(payload.reasonCode) ||
    payload.redacted !== true
  ) {
    return null;
  }
  return {
    available: payload.available,
    phase: payload.phase as NativeDesktopVoicePhase,
    generation: payload.generation,
    backgroundEligible: payload.backgroundEligible,
    connection: payload.connection as NativeDesktopVoiceConnection,
    reasonCode: payload.reasonCode,
    redacted: true,
  };
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: Iterable<string>,
): boolean {
  const allowed = keys instanceof Set ? keys : new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isSafeGeneration(value: unknown): value is number | null {
  return value === null || isSafeNonzeroInteger(value);
}

function isSafeNonzeroInteger(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    typeof value === "number" &&
    value > 0
  );
}

function isSafeReasonCode(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && SAFE_REASON_CODE.test(value))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
