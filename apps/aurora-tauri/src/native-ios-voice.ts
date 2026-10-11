import type {
  NativeMobileVoicePhase,
  NativeMobileVoicePort,
  NativeMobileVoiceStatus,
} from "@aurora/ui";

type NativeCommand = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

type NativeIosVoiceStartRequest = {
  remoteAudioConsent: boolean;
};

type IosVoiceFixtureState = {
  callNative: NativeCommand;
  generation: number;
  chunks: number;
  samples: number;
  transcriptReceived: boolean;
  cancelled: boolean;
};

const iosVoiceMainFlowEnabled = import.meta.env.VITE_AURORA_IOS_VOICE_LIVE_TEST === "1";
let activeIosVoiceFixture: IosVoiceFixtureState | null = null;
let lastIosVoiceFixture: Omit<IosVoiceFixtureState, "callNative" | "generation"> | null = null;

/**
 * Adapts the iOS Rust-session Tauri commands to the shared mobile PTT port.
 *
 * The capture payload alone reports audio plumbing, so availability is
 * intentionally gated by the separate iOS voice capability status. This
 * prevents a wired-but-unverified native session from being advertised as
 * usable.
 */
export function createTauriNativeIosVoicePort(
  callNative: NativeCommand,
): NativeMobileVoicePort {
  let completedTranscript: string | null = null;
  return {
    status: async () => {
      const [capability, capture] = await Promise.all([
        callNative("aurora_ios_voice_status"),
        callNative("aurora_ios_voice_foreground_capture_status"),
      ]);
      return parseStatus(capability, capture);
    },
    start: async (request) => {
      completedTranscript = null;
      const startRequest = validateStartRequest(request);
      if (iosVoiceMainFlowEnabled) {
        const fixture = await callNative("aurora_ios_voice_live_test_start");
        if (!isRecord(fixture) || typeof fixture.generation !== "number" || !Number.isSafeInteger(fixture.generation) || fixture.generation <= 0) {
          throw new Error("Native iOS voice fixture could not start.");
        }
        activeIosVoiceFixture = {
          callNative,
          generation: fixture.generation,
          chunks: 0,
          samples: 0,
          transcriptReceived: false,
          cancelled: false,
        };
        if (fixture.sampleRateHz !== 16000 || fixture.maxSamplesPerCall !== 4096) {
          await callNative("aurora_ios_voice_foreground_capture_stop").catch(() => undefined);
          activeIosVoiceFixture = null;
          throw new Error("Native iOS voice fixture contract is unsupported.");
        }
        const status = parseStatus(
          await callNative("aurora_ios_voice_status"),
          await callNative("aurora_ios_voice_foreground_capture_status"),
        );
        if (!status.available || status.phase === "unavailable" || status.phase === "faulted") {
          await callNative("aurora_ios_voice_foreground_capture_stop").catch(() => undefined);
          activeIosVoiceFixture = null;
          return status;
        }
        return status;
      }
      return parseStatus(
        await callNative("aurora_ios_voice_foreground_capture_start", {
          request: startRequest,
        }),
        await callNative("aurora_ios_voice_foreground_capture_status"),
      );
    },
    finish: async () => {
      completedTranscript = null;
      const finishValue = await callNative("aurora_ios_voice_foreground_capture_finish");
      const finishPayload = isRecord(finishValue) ? finishValue : {};
      const transcript = finishPayload.transcript;
      completedTranscript = typeof transcript === "string" && transcript.trim()
        ? transcript.trim()
        : null;
      if (activeIosVoiceFixture) {
        activeIosVoiceFixture.transcriptReceived = completedTranscript !== null;
        lastIosVoiceFixture = fixtureSummary(activeIosVoiceFixture);
        activeIosVoiceFixture = null;
      }
      return parseStatus(
        finishValue,
        await callNative("aurora_ios_voice_foreground_capture_status"),
      );
    },
    takeTranscript: async () => {
      const transcript = completedTranscript;
      completedTranscript = null;
      return transcript;
    },
    cancel: async () => {
      completedTranscript = null;
      const stopped = await callNative("aurora_ios_voice_foreground_capture_stop");
      if (activeIosVoiceFixture) {
        activeIosVoiceFixture.cancelled = true;
        lastIosVoiceFixture = fixtureSummary(activeIosVoiceFixture);
        activeIosVoiceFixture = null;
      }
      return parseStatus(
        stopped,
        await callNative("aurora_ios_voice_foreground_capture_status"),
      );
    },
    backgroundStatus: async () => {
      const [capability, background, capture] = await Promise.all([
        callNative("aurora_ios_voice_status"),
        callNative("aurora_ios_background_status"),
        callNative("aurora_ios_voice_foreground_capture_status"),
      ]);
      return parseStatus(capability, capture, background);
    },
    startBackground: async (request) => {
      completedTranscript = null;
      return parseStatus(
        await callNative("aurora_ios_voice_background_capture_start", {
          request: validateStartRequest(request),
        }),
        await callNative("aurora_ios_voice_foreground_capture_status"),
        await callNative("aurora_ios_background_status"),
      );
    },
    stopBackground: async () => {
      completedTranscript = null;
      return parseStatus(
        await callNative("aurora_ios_voice_foreground_capture_stop"),
        await callNative("aurora_ios_voice_foreground_capture_status"),
        await callNative("aurora_ios_background_status"),
      );
    },
  };
}

function parseStatus(
  capabilityValue: unknown,
  captureValue: unknown,
  backgroundValue?: unknown,
): NativeMobileVoiceStatus {
  const capability = isRecord(capabilityValue) ? capabilityValue : {};
  const capture = isRecord(captureValue) ? captureValue : {};
  const background = isRecord(backgroundValue) ? backgroundValue : null;
  const backgroundDetails = isRecord(background?.details) ? background.details : {};
  const backgroundAvailable = background ? background.available === true : true;
  const available = capability.available === true && backgroundAvailable;
  const backgroundActive = capture.backgroundListening === true || backgroundDetails.backgroundSessionActive === true;
  const running = capture.running === true || backgroundActive;
  const captureActive = running || backgroundActive;
  const reasonCode = typeof capability.reason === "string"
    ? capability.reason
    : typeof background?.reason === "string"
      ? background.reason
      : typeof capture.reason === "string"
      ? capture.reason
      : null;
  const phase: NativeMobileVoicePhase = !available
    ? "unavailable"
    : reasonCode && !running
      ? "faulted"
      : captureActive || backgroundActive
        ? "listening"
        : "idle";

  return {
    available,
    phase,
    running,
    captureActive,
    backgroundActive,
    reasonCode,
    redacted: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateStartRequest(request: unknown): NativeIosVoiceStartRequest {
  if (
    !isRecord(request) ||
    !hasOnlyKeys(request, ["remoteAudioConsent"]) ||
    typeof request.remoteAudioConsent !== "boolean"
  ) {
    throw new Error("Native iOS voice start request is invalid.");
  }
  return {
    remoteAudioConsent: request.remoteAudioConsent,
  };
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}


/** Pushes bounded PCM only into the currently active debug iOS voice generation. */
export async function pushIosVoiceMainFlowPcm(samples: Float32Array): Promise<void> {
  const fixture = activeIosVoiceFixture;
  if (!iosVoiceMainFlowEnabled || !fixture || samples.length === 0 || samples.length > 4096) {
    throw new Error("No active iOS voice fixture session.");
  }
  for (const sample of samples) {
    if (!Number.isFinite(sample)) throw new Error("Invalid iOS voice fixture samples.");
  }
  const response = await fixture.callNative("aurora_ios_voice_live_test_push_pcm", {
    request: { generation: fixture.generation, samples: Array.from(samples) },
  });
  if (!isRecord(response) || response.accepted !== true || response.sampleCount !== samples.length) {
    throw new Error("iOS voice fixture input was not accepted.");
  }
  fixture.chunks += 1;
  fixture.samples += samples.length;
}

/** Returns redacted counters for the dedicated main-flow hook; never returns audio or transcript text. */
export function iosVoiceMainFlowCounters() {
  const fixture = activeIosVoiceFixture ? fixtureSummary(activeIosVoiceFixture) : lastIosVoiceFixture;
  return fixture ? { ...fixture } : null;
}

/** Cleanup uses the same production stop command exposed by the mobile voice port. */
export async function cancelIosVoiceMainFlowFixture(): Promise<void> {
  if (!activeIosVoiceFixture) return;
  await activeIosVoiceFixture.callNative("aurora_ios_voice_foreground_capture_stop");
  activeIosVoiceFixture.cancelled = true;
  lastIosVoiceFixture = fixtureSummary(activeIosVoiceFixture);
  activeIosVoiceFixture = null;
}

function fixtureSummary(fixture: IosVoiceFixtureState) {
  return {
    chunks: fixture.chunks,
    samples: fixture.samples,
    transcriptReceived: fixture.transcriptReceived,
    cancelled: fixture.cancelled,
  };
}
