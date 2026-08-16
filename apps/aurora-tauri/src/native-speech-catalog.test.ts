import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { TauriLocalTransport } from "@aurora/client";
import {
  createTauriNativeSpeechCatalogPort,
  type TauriNativeSpeechCatalogPortOptions,
} from "./native-speech-catalog";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

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

  it("lists Android public overlay voices without a user profile", async () => {
    const mock = transport({
      getAndroidVoicePackCatalogStatus: vi.fn(async () => ({
        platform: "android",
        available: false,
        entries: [
          {
            packId: "standard:pockettts:aurora-pockettts-en-2026-04",
            packName: "Aurora English",
            language: "en-us",
            sha256: "b".repeat(64),
            sizeBytes: 456,
            engineRuntimeRevision: "sherpa-onnx-1.13.5",
            installed: false,
            active: false,
            runtimeTask: "tts" as const,
            modelFamily: "pockettts",
            requiresReferenceAudio: false,
            referenceAudioMode: "internal",
            referenceSelectionPresent: false,
          },
          {
            packId: "standard:pockettts:sherpa-onnx-pocket-tts-int8-2026-01-26",
            packName: "Official English",
            language: "en-us",
            sha256: "c".repeat(64),
            sizeBytes: 789,
            engineRuntimeRevision: "sherpa-onnx-1.13.5",
            installed: false,
            active: false,
            runtimeTask: "tts" as const,
            modelFamily: "pockettts",
            referenceSelectionPresent: false,
          },
        ],
        secretsRedacted: true,
      })),
    });
    const port = createTauriNativeSpeechCatalogPort({ platform: "android", transport: mock });
    const catalog = await port.listCatalog();

    const byId = Object.fromEntries(catalog.items.map((item) => [item.packId, item]));
    expect(byId["standard:pockettts:aurora-pockettts-en-2026-04"]).not.toHaveProperty("requiresReferenceProfile");
    expect(byId["standard:pockettts:sherpa-onnx-pocket-tts-int8-2026-01-26"]).toMatchObject({
      requiresReferenceProfile: true,
    });
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

  it("selects Android and iOS clone packs with an audio-only reference profile", async () => {
    const android = transport({
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
    const ios = transport({
      listIosVoicePacks: vi.fn(async () => [{
        packId: "pocket.en",
        displayName: "Pocket English",
        language: "en",
        task: "tts",
        version: "2026.08",
        runtimeRevision: "sherpa-onnx-1.13.5",
        sha256: "c".repeat(64),
        fileSize: 789,
        installed: false,
        activeSlot: null,
        modelFamily: "pockettts",
        requiresReferenceAudio: true,
      }]),
      downloadIosVoicePack: vi.fn(async () => ({ ok: true })),
      activateIosVoicePack: vi.fn(async () => ({ ok: true })),
      getIosVoicePackStatus: vi.fn(async () => ({
        available: true,
        activeSlots: { tts: "pocket.en" },
        count: 1,
        packs: [],
        secretsRedacted: true,
      })),
    });
    const loadReferenceProfile = vi.fn(async () => ({
      referenceId: "voice-1",
      referenceRevision: "rev-1",
      referenceSampleRateHz: 16_000,
      referenceSamples: [0, 0.25, -0.25],
    }));

    const androidPort = createTauriNativeSpeechCatalogPort({
      platform: "android",
      transport: android,
      androidPollIntervalMs: 1,
      sleep: vi.fn(async () => undefined),
      loadReferenceProfile,
    });
    const iosPort = createTauriNativeSpeechCatalogPort({
      platform: "ios",
      transport: ios,
      loadReferenceProfile,
    });
    const androidCatalog = await androidPort.listCatalog();
    const iosCatalog = await iosPort.listCatalog();

    await androidPort.select({
      selection: {
        ...androidCatalog.items[0]!,
        referenceProfileId: "voice-1",
        referenceProfileSelected: true,
      },
    });
    await iosPort.select({
      selection: {
        ...iosCatalog.items[0]!,
        referenceProfileId: "voice-1",
        referenceProfileSelected: true,
      },
    });

    expect(android.downloadAndroidVoicePack).toHaveBeenCalledWith({
      task: "tts",
      packId: "pocket.en",
      forceDownload: false,
      activate: false,
      referenceId: "voice-1",
      referenceRevision: "rev-1",
      referenceSampleRateHz: 16_000,
      referenceSamples: [0, 0.25, -0.25],
    });
    expect(ios.downloadIosVoicePack).toHaveBeenCalledWith({
      task: "tts",
      packId: "pocket.en",
      forceDownload: false,
      activate: false,
      referenceId: "voice-1",
      referenceRevision: "rev-1",
      referenceSampleRateHz: 16_000,
      referenceSamples: [0, 0.25, -0.25],
    });
    expect(android.downloadAndroidVoicePack).not.toHaveBeenCalledWith(
      expect.objectContaining({ referenceText: expect.anything() }),
    );
    expect(ios.downloadIosVoicePack).not.toHaveBeenCalledWith(
      expect.objectContaining({ referenceText: expect.anything() }),
    );
  });

  it("lists public EN/FR Pocket packs without a user profile and keeps clone-capable English gated", async () => {
    const mock = transport({
      getNativeSpeechPackCatalog: vi.fn(async () => ({
        available: false,
        count: 3,
        languages: ["en-us", "fr-fr"],
        secretsRedacted: true,
        packs: [
          {
            packId: "standard:pockettts:aurora-pockettts-en-2026-04",
            displayName: "Aurora English",
            task: "tts" as const,
            languages: ["en-us"],
            language: "en-us",
            sha256: "a".repeat(64),
            fileSize: 123,
            installed: false,
            activeSlot: null,
            revision: "tts-catalog-2026.08",
            runtimeRevision: "sherpa-onnx-1.13.5",
            modelFamily: "pockettts",
            requiresReferenceAudio: false,
            referenceAudioMode: "internal",
            voiceId: "standard:pockettts:aurora-pockettts-en-2026-04",
            voiceRevision: "tts-catalog-2026.08",
          },
          {
            packId: "standard:pockettts:aurora-pockettts-fr-24l",
            displayName: "Aurora French",
            task: "tts" as const,
            languages: ["fr-fr"],
            language: "fr-fr",
            sha256: "b".repeat(64),
            fileSize: 456,
            installed: false,
            activeSlot: null,
            revision: "tts-catalog-2026.08",
            runtimeRevision: "sherpa-onnx-1.13.5",
            modelFamily: "pockettts",
            requiresReferenceAudio: false,
            referenceAudioMode: "internal",
            voiceId: "standard:pockettts:aurora-pockettts-fr-24l",
            voiceRevision: "tts-catalog-2026.08",
          },
          {
            packId: "standard:pockettts:sherpa-onnx-pocket-tts-int8-2026-01-26",
            displayName: "Official English",
            task: "tts" as const,
            languages: ["en-us"],
            language: "en-us",
            sha256: "c".repeat(64),
            fileSize: 789,
            installed: false,
            activeSlot: null,
            revision: "tts-catalog-2026.08",
            runtimeRevision: "sherpa-onnx-1.13.5",
            modelFamily: "pockettts",
            voiceId: "standard:pockettts:sherpa-onnx-pocket-tts-int8-2026-01-26",
            voiceRevision: "tts-catalog-2026.08",
          },
        ],
      })),
    });
    const port = createTauriNativeSpeechCatalogPort({ platform: "desktop", transport: mock });
    const catalog = await port.listCatalog();

    const byId = Object.fromEntries(catalog.items.map((item) => [item.packId, item]));
    expect(byId["standard:pockettts:aurora-pockettts-en-2026-04"]).not.toHaveProperty("requiresReferenceProfile");
    expect(byId["standard:pockettts:aurora-pockettts-fr-24l"]).not.toHaveProperty("requiresReferenceProfile");
    expect(byId["standard:pockettts:sherpa-onnx-pocket-tts-int8-2026-01-26"]).toMatchObject({
      requiresReferenceProfile: true,
      referenceProfileSelected: false,
    });
  });

  it("lets explicit internal mode override a Pocket family fallback on desktop and iOS", async () => {
    const desktop = transport({
      getNativeSpeechPackCatalog: vi.fn(async () => ({
        available: false,
        count: 1,
        languages: ["en-us"],
        secretsRedacted: true,
        packs: [{
          packId: "standard:pockettts:aurora-pockettts-en-2026-04",
          displayName: "Aurora English",
          task: "tts" as const,
          languages: ["en-us"],
          language: "en-us",
          sha256: "a".repeat(64),
          fileSize: 123,
          installed: false,
          activeSlot: null,
          revision: "tts-catalog-2026.08",
          runtimeRevision: "sherpa-onnx-1.13.5",
          modelFamily: "pockettts",
          referenceAudioMode: "internal",
        }],
      })),
    });
    const ios = transport({
      listIosVoicePacks: vi.fn(async () => [{
        packId: "standard:pockettts:aurora-pockettts-fr-24l",
        displayName: "Aurora French",
        language: "fr-fr",
        task: "tts",
        version: "2026.08",
        runtimeRevision: "sherpa-onnx-1.13.5",
        sha256: "c".repeat(64),
        fileSize: 789,
        installed: false,
        activeSlot: null,
        modelFamily: "pockettts",
        referenceAudioMode: "internal",
        requiresReferenceAudio: false,
      }]),
    });

    const desktopCatalog = await createTauriNativeSpeechCatalogPort({ platform: "desktop", transport: desktop }).listCatalog();
    const iosCatalog = await createTauriNativeSpeechCatalogPort({ platform: "ios", transport: ios }).listCatalog();
    expect(desktopCatalog.items[0]?.packId).toBe("standard:pockettts:aurora-pockettts-en-2026-04");
    expect(desktopCatalog.items[0]).not.toHaveProperty("requiresReferenceProfile");
    expect(iosCatalog.items[0]?.packId).toBe("standard:pockettts:aurora-pockettts-fr-24l");
    expect(iosCatalog.items[0]).not.toHaveProperty("requiresReferenceProfile");
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

  it("wires desktop and iOS catalog listing to the runtime overlay and explicit reference mode", () => {
    const lib = readFileSync(resolve(repoRoot, "apps/aurora-tauri/src-tauri/src/lib.rs"), "utf8");
    const nativeVoice = readFileSync(resolve(repoRoot, "apps/aurora-tauri/src-tauri/src/native_voice.rs"), "utf8");
    const iosVoice = readFileSync(resolve(repoRoot, "apps/aurora-tauri/src-tauri/src/ios_voice.rs"), "utf8");
    const catalogListing = lib.slice(
      lib.indexOf("fn native_speech_pack_catalog"),
      lib.indexOf("fn native_speech_pack_status"),
    );
    const activateBody = lib.slice(
      lib.indexOf("async fn aurora_native_speech_pack_activate"),
      lib.indexOf("async fn aurora_native_speech_pack_remove"),
    );

    expect(catalogListing).toContain("TtsVoiceCatalog::runtime()");
    expect(catalogListing).toContain("entry.requires_reference_profile()");
    expect(catalogListing).toContain("catalog_reference_audio_mode_label()");
    expect(catalogListing).not.toContain('entry.model_family == "pockettts"');
    expect(activateBody).toContain("TtsVoiceCatalog::runtime()");
    expect(activateBody).toContain("voice.requires_reference_profile()");
    expect(nativeVoice).toContain("TtsVoiceCatalog::runtime()");
    expect(nativeVoice).toContain("voice.requires_reference_profile()");
    expect(iosVoice).toContain("TtsVoiceCatalog::runtime()");
    expect(iosVoice).toContain("entry.requires_reference_profile()");
    expect(iosVoice).toContain("catalog_contains_pack");
  });
});
