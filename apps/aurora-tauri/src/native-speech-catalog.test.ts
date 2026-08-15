import { describe, expect, it, vi } from "vitest";
import type { TauriLocalTransport } from "@aurora/client";
import {
  createTauriNativeSpeechCatalogPort,
  type TauriNativeSpeechCatalogPortOptions,
} from "./native-speech-catalog";

type TransportMock = TauriNativeSpeechCatalogPortOptions["transport"];

function transport(overrides: Partial<TransportMock>): TransportMock {
  return {
    getNativeSpeechPackCatalog: vi.fn(),
    getNativeSpeechPackStatus: vi.fn(),
    installNativeSpeechPack: vi.fn(),
    activateNativeSpeechPack: vi.fn(),
    removeNativeSpeechPack: vi.fn(),
    getAndroidVoicePackCatalogStatus: vi.fn(),
    downloadAndroidVoicePack: vi.fn(),
    getAndroidVoicePackDownloadStatus: vi.fn(),
    activateAndroidVoicePack: vi.fn(),
    removeAndroidVoicePack: vi.fn(),
    listIosVoicePacks: vi.fn(),
    getIosVoicePackStatus: vi.fn(),
    downloadIosVoicePack: vi.fn(),
    activateIosVoicePack: vi.fn(),
    removeIosVoicePack: vi.fn(),
    ...overrides,
  } as unknown as TauriLocalTransport;
}

describe("createTauriNativeSpeechCatalogPort", () => {
  it("lists desktop catalog metadata without installing on a fresh profile", async () => {
    const mock = transport({
      getNativeSpeechPackCatalog: vi.fn(async () => ({
        available: false,
        count: 1,
        languages: ["en"],
        secretsRedacted: true,
        packs: [{
          packId: "whisper.tiny.en",
          displayName: "English tiny",
          task: "stt" as const,
          languages: ["en"],
          language: "en",
          sha256: "a".repeat(64),
          fileSize: 123,
          installed: false,
          activeSlot: null,
          revision: "speech-catalog-2026.08",
          runtimeRevision: "sherpa-onnx-1.13.5",
          modelFamily: "whisper",
        }],
      })),
    });
    const port = createTauriNativeSpeechCatalogPort({ platform: "desktop", transport: mock });

    await expect(port.listCatalog()).resolves.toEqual({
      state: "ready",
      items: [{
        task: "stt",
        packId: "whisper.tiny.en",
        packVersion: "speech-catalog-2026.08",
        displayName: "English tiny",
        language: "en",
        cached: false,
        active: false,
      }],
    });
    expect(mock.installNativeSpeechPack).not.toHaveBeenCalled();
    expect(mock.activateNativeSpeechPack).not.toHaveBeenCalled();
  });

  it("keeps the native TTS archive identity separate from the persisted language selection", async () => {
    const mock = transport({
      getNativeSpeechPackCatalog: vi.fn(async () => ({
        available: false,
        count: 1,
        languages: ["en"],
        secretsRedacted: true,
        packs: [{
          packId: "pockettts.en.voice-1",
          displayName: "Pocket English",
          task: "tts" as const,
          languages: ["en"],
          language: "en",
          sha256: "a".repeat(64),
          fileSize: 123,
          installed: false,
          activeSlot: null,
          revision: "tts-catalog-2026.08",
          runtimeRevision: "sherpa-onnx-1.13.5",
          modelFamily: "pockettts",
          requiresReferenceAudio: true,
          voiceId: "pockettts.en.voice-1",
          voiceRevision: "tts-catalog-2026.08",
          referenceProfileId: null,
        }],
      })),
    });
    const port = createTauriNativeSpeechCatalogPort({ platform: "desktop", transport: mock });

    await expect(port.listCatalog()).resolves.toEqual({
      state: "ready",
      items: [{
        task: "tts",
        packId: "pockettts.en.voice-1",
        packVersion: "tts-catalog-2026.08",
        profilePackId: "en",
        profilePackRevision: "tts-catalog-2026.08",
        displayName: "Pocket English",
        language: "en",
        cached: false,
        active: false,
        voiceId: "pockettts.en.voice-1",
        voiceRevision: "tts-catalog-2026.08",
        requiresReferenceProfile: true,
        referenceProfileSelected: false,
      }],
    });
  });

  it("uses explicit desktop selection for install and activation", async () => {
    const mock = transport({
      installNativeSpeechPack: vi.fn(async () => ({ available: true, activeSlots: {}, count: 1, packs: [], secretsRedacted: true })),
      activateNativeSpeechPack: vi.fn(async () => ({ available: true, activeSlots: { stt: "whisper.tiny.en" }, count: 1, packs: [], secretsRedacted: true })),
      removeNativeSpeechPack: vi.fn(async () => ({ available: true, activeSlots: {}, count: 1, packs: [], secretsRedacted: true })),
      getNativeSpeechPackStatus: vi.fn(async () => ({ available: true, activeSlots: {}, count: 1, packs: [], secretsRedacted: true })),
    });
    const port = createTauriNativeSpeechCatalogPort({ platform: "desktop", transport: mock });

    await expect(port.select({
      selection: {
        task: "stt",
        packId: "whisper.tiny.en",
        packVersion: "2026.08",
        displayName: "English tiny",
      },
    })).resolves.toMatchObject({
      task: "stt",
      packId: "whisper.tiny.en",
      packVersion: "2026.08",
    });
    expect(mock.installNativeSpeechPack).toHaveBeenCalledWith({ task: "stt", packId: "whisper.tiny.en" });
    expect(mock.activateNativeSpeechPack).toHaveBeenCalledWith({ task: "stt", packId: "whisper.tiny.en", slot: "stt" });

    await expect(port.remove({ task: "stt", packId: "whisper.tiny.en" })).resolves.toMatchObject({
      state: "unavailable",
      capabilities: { vad: false, kws: false, stt: false, tts: false },
    });
    expect(mock.removeNativeSpeechPack).toHaveBeenCalledWith({ task: "stt", packId: "whisper.tiny.en" });
  });

  it("polls Android downloads and passes an explicit Pocket reference profile", async () => {
    const progress: string[] = [];
    const mock = transport({
      getAndroidVoicePackCatalogStatus: vi.fn(async () => ({
        platform: "android",
        available: false,
        entries: [{
          packId: "pocket.en",
          packName: "Pocket English",
          language: "en",
          sha256: "b".repeat(64),
          sizeBytes: 456,
          engineRuntimeRevision: "sherpa-onnx-1.13.5",
          installed: false,
          active: false,
          runtimeTask: "tts" as const,
          modelFamily: "pockettts",
          requiresReferenceAudio: true,
          referenceSelectionPresent: false,
        }],
        secretsRedacted: true,
      })),
      downloadAndroidVoicePack: vi.fn(async () => ({ started: true, packId: "pocket.en", jobId: "job-1" })),
      getAndroidVoicePackDownloadStatus: vi.fn(async () => ({
        jobId: "job-1",
        status: "completed",
        packId: "pocket.en",
        downloadedBytes: 456,
        totalBytes: 456,
      })),
      activateAndroidVoicePack: vi.fn(async () => ({ ok: true })),
    });
    const port = createTauriNativeSpeechCatalogPort({
      platform: "android",
      transport: mock,
      androidPollIntervalMs: 1,
      sleep: vi.fn(async () => undefined),
      loadReferenceProfile: vi.fn(async () => ({
        referenceId: "voice-1",
        referenceText: "hello",
        referenceRevision: "rev-1",
        referenceSampleRateHz: 16_000,
        referenceSamples: [0, 0.25, -0.25],
      })),
    });
    const catalog = await port.listCatalog();

    await port.select({
      selection: {
        ...catalog.items[0]!,
        referenceProfileId: "voice-1",
        referenceProfileSelected: true,
      },
      onProgress: (next) => progress.push(next.state),
    });

    expect(mock.downloadAndroidVoicePack).toHaveBeenCalledWith({
      task: "tts",
      packId: "pocket.en",
      forceDownload: false,
      activate: false,
      referenceId: "voice-1",
      referenceText: "hello",
      referenceRevision: "rev-1",
      referenceSampleRateHz: 16_000,
      referenceSamples: [0, 0.25, -0.25],
    });
    expect(mock.getAndroidVoicePackDownloadStatus).toHaveBeenCalledWith("job-1");
    expect(mock.activateAndroidVoicePack).toHaveBeenCalledWith(expect.objectContaining({
      task: "tts",
      packId: "pocket.en",
      slot: "tts",
      referenceId: "voice-1",
    }));
    expect(progress).toEqual(["queued", "downloading", "saving", "saving", "ready"]);
  });

  it("rejects Pocket selection before native commands when the reference profile is missing", async () => {
    const mock = transport({
      downloadAndroidVoicePack: vi.fn(),
      activateAndroidVoicePack: vi.fn(),
    });
    const port = createTauriNativeSpeechCatalogPort({ platform: "android", transport: mock });

    await expect(port.select({
      selection: {
        task: "tts",
        packId: "pocket.en",
        packVersion: "sherpa",
        displayName: "Pocket English",
        requiresReferenceProfile: true,
      },
    })).rejects.toThrow("voice_reference_required");
    expect(mock.downloadAndroidVoicePack).not.toHaveBeenCalled();
    expect(mock.activateAndroidVoicePack).not.toHaveBeenCalled();
  });

  it("normalizes iOS list/status objects for catalog and readiness", async () => {
    const mock = transport({
      listIosVoicePacks: vi.fn(async () => [{
        packId: "silero.vad",
        displayName: "Silero VAD",
        language: "multi",
        task: "vad",
        version: "2026.08",
        runtimeRevision: "sherpa-onnx-1.13.5",
        sha256: "c".repeat(64),
        fileSize: 789,
        installed: false,
        activeSlot: null,
      }]),
      getIosVoicePackStatus: vi.fn(async () => ({
        available: false,
        activeSlots: { vad: "silero.vad" },
        count: 1,
        packs: [],
        secretsRedacted: true,
      })),
    });
    const port = createTauriNativeSpeechCatalogPort({ platform: "ios", transport: mock });

    await expect(port.listCatalog()).resolves.toEqual({
      state: "ready",
      items: [{
        task: "vad",
        packId: "silero.vad",
        packVersion: "2026.08",
        displayName: "Silero VAD",
        language: "multi",
        cached: false,
        active: false,
      }],
    });
    await expect(port.getReadiness()).resolves.toMatchObject({
      available: false,
      state: "ready",
      capabilities: { vad: true, kws: false, stt: false, tts: false },
      activeSlots: { vad: "silero.vad" },
      catalogCount: 1,
    });
  });
});
