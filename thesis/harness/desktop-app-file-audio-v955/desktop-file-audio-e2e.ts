import type { AuroraClient } from "@aurora/client";
import type { AuroraTauriRuntime } from "./aurora-client";

const HOOK = "__AURORA_DESKTOP_FILE_AUDIO_E2E__";
const PAYLOAD_SCHEMA = "aurora.desktop_file_audio_e2e.payload.v1";
const REPORT_SCHEMA = "aurora.desktop_file_audio_e2e.report.v1";
const FIXED_WAV_SHA256 = "da0ecc4ad0885746ab6e716585473917ab2b543a505bf0db09ebacfaa7943cbb";
const FIXED_WAV_BYTES = 219_794;
const EXPECTED_TRANSCRIPT = "What is the capital of France? Answer with only the city name.";
const EXPECTED_REPLY = "Paris";

type Payload = { schema: typeof PAYLOAD_SCHEMA; runId: string; audioBase64: string };
type WindowWithHook = Window & {
  __AURORA_DESKTOP_FILE_AUDIO_E2E__?: (payload: unknown) => Promise<Record<string, unknown>>;
};

export function installDesktopFileAudioE2e(runtime: AuroraTauriRuntime): () => void {
  const client: AuroraClient = runtime.client;
  if (runtime.mode !== "desktop-local" || client.transport.kind !== "tauri-local") {
    return () => undefined;
  }
  const target = window as WindowWithHook;
  let active = false;
  const action = async (raw: unknown): Promise<Record<string, unknown>> => {
    const payload = validatePayload(raw);
    if (active) throw new Error("desktop_file_audio_action_already_active");
    active = true;
    let wav = new Uint8Array();
    const stages: Record<string, unknown> = {};
    let phase = "fixture_validation";
    try {
      wav = decodeBase64(payload.audioBase64);
      if (wav.byteLength !== FIXED_WAV_BYTES || await sha256(wav) !== FIXED_WAV_SHA256) {
        throw new Error("desktop_file_audio_fixture_mismatch");
      }
      assertWavHeader(wav);

      phase = "transcription";
      const sttStart = performance.now();
      const stt = await client.assistant.transcribeVoiceAudio({
        audio_data: payload.audioBase64,
        format: "wav",
        sample_rate: 22_050,
        channels: 1,
        model: "accurate",
        language: null,
      });
      stages.transcription_ms = elapsed(sttStart);
      if (!stt.ok) throw new Error("desktop_file_audio_transcription_failed");
      const transcript = stt.data.text.trim();
      const transcriptMatches = transcript === EXPECTED_TRANSCRIPT;
      stages.transcript = {
        exact: transcriptMatches,
        characters: transcript.length,
        sha256: await sha256(new TextEncoder().encode(transcript)),
        modelUsed: stt.data.model_used,
        correlationId: stt.audit.correlationId ?? null,
      };
      if (!transcriptMatches) throw new Error("desktop_file_audio_transcript_mismatch");

      phase = "assistant";
      const sessionId = `desktop-file-audio-${payload.runId}`;
      const assistantStart = performance.now();
      const assistant = await client.assistant.sendMessage({
        text: transcript,
        sessionId,
        timeoutMs: 120_000,
      });
      stages.assistant_ms = elapsed(assistantStart);
      if (!assistant.ok) throw new Error("desktop_file_audio_assistant_failed");
      const reply = assistant.data.response.text.trim();
      const replyMatches = reply === EXPECTED_REPLY;
      const automaticTtsStatus = assistant.data.metadata.tts_status;
      stages.assistant = {
        exact: replyMatches,
        characters: reply.length,
        sha256: await sha256(new TextEncoder().encode(reply)),
        modelLabel: assistant.data.modelLabel ?? null,
        sessionId: assistant.data.sessionId,
        correlationId: assistant.audit.correlationId ?? null,
        automaticTtsStatus: typeof automaticTtsStatus === "string" ? automaticTtsStatus : null,
      };
      if (!replyMatches) throw new Error("desktop_file_audio_assistant_predicate_failed");
      if (automaticTtsStatus !== "skipped") throw new Error("desktop_file_audio_automatic_tts_not_skipped");

      phase = "synthesis";
      const ttsStart = performance.now();
      const tts = await client.assistant.synthesizeReadAloud({ text: reply, format: "wav" });
      stages.synthesis_ms = elapsed(ttsStart);
      if (!tts.ok) throw new Error("desktop_file_audio_synthesis_failed");
      const output = decodeBase64(tts.data.audio_data);
      const audioProfile = validateSynthesizedWav(output, {
        format: tts.data.format,
        text: tts.data.text,
        sampleRate: tts.data.sample_rate,
        channels: tts.data.channels,
        durationMs: tts.data.duration_ms,
        requestedText: reply,
      });
      return {
        schema: REPORT_SCHEMA,
        runId: payload.runId,
        status: "passed",
        runtimeMode: runtime.mode,
        transport: client.transport.kind,
        input: { bytes: wav.byteLength, sha256: FIXED_WAV_SHA256, format: "wav", channels: 1, sampleRate: 22_050 },
        stages,
        synthesis: {
          format: tts.data.format,
          sampleRate: tts.data.sample_rate,
          durationMs: tts.data.duration_ms,
          frames: audioProfile.frames,
          pcmSamples: audioProfile.frames,
          actualDurationMs: audioProfile.durationMs,
          channels: audioProfile.channels,
          bytes: output.byteLength,
          sha256: await sha256(output),
          audioBase64: tts.data.audio_data,
          correlationId: tts.audit.correlationId ?? null,
        },
        native16kConversion: "not_exercised_by_finite_sdk_wav_request",
      };
    } catch (error) {
      return {
        schema: REPORT_SCHEMA,
        runId: payload.runId,
        status: "failed",
        failedStage: phase,
        failureCode: error instanceof Error && /^desktop_file_audio_[a-z_]+$/u.test(error.message)
          ? error.message
          : "desktop_file_audio_unknown_failure",
        transport: client.transport.kind,
        stages,
      };
    } finally {
      active = false;
    }
  };
  target[HOOK] = action;
  return () => {
    if (target[HOOK] === action) delete target[HOOK];
  };
}

function validatePayload(value: unknown): Payload {
  if (!value || typeof value !== "object") throw new Error("desktop_file_audio_payload_invalid");
  const candidate = value as Record<string, unknown>;
  if (candidate.schema !== PAYLOAD_SCHEMA) throw new Error("desktop_file_audio_payload_schema_invalid");
  if (typeof candidate.runId !== "string" || !/^[A-Za-z0-9_-]{16,80}$/u.test(candidate.runId)) {
    throw new Error("desktop_file_audio_run_id_invalid");
  }
  if (typeof candidate.audioBase64 !== "string" || candidate.audioBase64.length > 400_000) {
    throw new Error("desktop_file_audio_payload_size_invalid");
  }
  return candidate as Payload;
}

function assertWavHeader(bytes: Uint8Array): void {
  if (bytes.length < 44 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    throw new Error("desktop_file_audio_wav_invalid");
  }
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/^data:audio\/wav;base64,/iu, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized)) throw new Error("desktop_file_audio_base64_invalid");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function validateSynthesizedWav(
  bytes: Uint8Array,
  response: { format: string; text: string; sampleRate: number; channels: number; durationMs: number; requestedText: string },
): { frames: number; durationMs: number; channels: number } {
  const maxOutputBytes = 1_048_576;
  if (bytes.byteLength < 44 || bytes.byteLength > maxOutputBytes || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    throw new Error("desktop_file_audio_synthesis_wav_invalid");
  }
  if (response.format !== "wav" || response.channels !== 1 || response.text !== response.requestedText) {
    throw new Error("desktop_file_audio_synthesis_metadata_mismatch");
  }
  if (!Number.isInteger(response.sampleRate) || response.sampleRate <= 0 || response.sampleRate > 192_000 ||
      !Number.isFinite(response.durationMs) || response.durationMs <= 0) {
    throw new Error("desktop_file_audio_synthesis_metadata_invalid");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.byteLength) {
    throw new Error("desktop_file_audio_synthesis_riff_length_invalid");
  }
  let format: { encoding: number; channels: number; sampleRate: number; byteRate: number; blockAlign: number; bitsPerSample: number } | null = null;
  let dataStart: number | null = null;
  let dataLength = 0;
  for (let offset = 12; offset < bytes.byteLength;) {
    if (offset + 8 > bytes.byteLength) throw new Error("desktop_file_audio_synthesis_chunk_header_invalid");
    const tag = ascii(bytes, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + length;
    const paddedEnd = end + (length & 1);
    if (end > bytes.byteLength || paddedEnd > bytes.byteLength) throw new Error("desktop_file_audio_synthesis_chunk_bounds_invalid");
    if (tag === "fmt ") {
      if (format || length < 16) throw new Error("desktop_file_audio_synthesis_fmt_invalid");
      format = {
        encoding: view.getUint16(start, true),
        channels: view.getUint16(start + 2, true),
        sampleRate: view.getUint32(start + 4, true),
        byteRate: view.getUint32(start + 8, true),
        blockAlign: view.getUint16(start + 12, true),
        bitsPerSample: view.getUint16(start + 14, true),
      };
    } else if (tag === "data") {
      if (dataStart !== null) throw new Error("desktop_file_audio_synthesis_duplicate_data");
      dataStart = start;
      dataLength = length;
    }
    offset = paddedEnd;
  }
  if (!format || dataStart === null || dataLength <= 0 || dataLength % 2 !== 0 ||
      format.encoding !== 1 || format.channels !== 1 || format.sampleRate !== response.sampleRate ||
      format.byteRate !== format.sampleRate * 2 || format.blockAlign !== 2 || format.bitsPerSample !== 16) {
    throw new Error("desktop_file_audio_synthesis_pcm_profile_invalid");
  }
  const frames = dataLength / 2;
  let nonsilent = false;
  for (let index = dataStart; index < dataStart + dataLength; index += 2) {
    if (view.getInt16(index, true) !== 0) {
      nonsilent = true;
      break;
    }
  }
  if (!frames || !nonsilent) throw new Error("desktop_file_audio_synthesis_pcm_empty_or_silent");
  const durationMs = frames * 1000 / format.sampleRate;
  if (Math.abs(durationMs - response.durationMs) > 2) {
    throw new Error("desktop_file_audio_synthesis_duration_mismatch");
  }
  return { frames, durationMs, channels: format.channels };
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function elapsed(start: number): number {
  return Math.round((performance.now() - start) * 1000) / 1000;
}
