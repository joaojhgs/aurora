import type {
  AndroidVoicePackCatalogStatus,
  AndroidVoicePackDownloadResult,
  AndroidVoicePackDownloadStatus,
  NativeMobileSpeechPackActivateRequest,
  NativeMobileSpeechPackDownloadRequest,
  NativeSpeechPackActivateRequest,
  NativeSpeechPackCatalogResponse,
  NativeSpeechPackIdRequest,
  NativeSpeechPackStatusResponse,
  NativeSpeechPackTask,
  TauriLocalTransport,
} from "@aurora/client";
import {
  decodeAuroraPocketReferenceWav,
  deleteAuroraBrowserPocketReferenceProfile,
  listAuroraBrowserPocketReferenceProfiles,
  readAuroraBrowserPocketReferenceProfile,
  saveAuroraBrowserPocketReferenceProfile,
} from "@aurora/ui";
import type {
  AuroraBrowserSpeechPackCatalogResult,
  AuroraBrowserSpeechPackCatalogSelection,
  AuroraBrowserSpeechPackInstallProgress,
  AuroraBrowserSpeechPackInstallReceipt,
  AuroraBrowserSpeechPackInstallRequest,
  AuroraBrowserPocketReferenceProfileInput,
  AuroraLocalSpeechCatalogPort,
} from "@aurora/ui";

export type TauriNativeSpeechCatalogPlatform = "desktop" | "android" | "ios";

export interface TauriNativeSpeechCatalogReadiness {
  readonly available: boolean;
  readonly state: "ready" | "downloading" | "unavailable";
  readonly capabilities: Record<NativeSpeechPackTask, boolean>;
  readonly activeSlots: Partial<Record<NativeSpeechPackTask, string>>;
  readonly catalogCount: number;
}

export interface TauriNativeSpeechReferenceProfile {
  readonly referenceId: string;
  readonly referenceAudioUri?: string | undefined;
  readonly referenceText?: string | undefined;
  readonly referenceRevision?: string | undefined;
  readonly referenceSampleRateHz?: number | undefined;
  readonly referenceSamples?: readonly number[] | undefined;
}

export interface TauriNativeSpeechCatalogPort extends AuroraLocalSpeechCatalogPort {
  getReadiness(): Promise<TauriNativeSpeechCatalogReadiness>;
  remove(selection: Pick<AuroraBrowserSpeechPackCatalogSelection, "task" | "packId">): Promise<TauriNativeSpeechCatalogReadiness>;
}

export interface TauriNativeSpeechCatalogPortOptions {
  readonly platform: TauriNativeSpeechCatalogPlatform;
  readonly transport: Pick<
    TauriLocalTransport,
    | "getNativeSpeechPackCatalog"
    | "getNativeSpeechPackStatus"
    | "installNativeSpeechPack"
    | "activateNativeSpeechPack"
    | "removeNativeSpeechPack"
    | "getAndroidVoicePackCatalogStatus"
    | "downloadAndroidVoicePack"
    | "getAndroidVoicePackDownloadStatus"
    | "activateAndroidVoicePack"
    | "removeAndroidVoicePack"
    | "listIosVoicePacks"
    | "getIosVoicePackStatus"
    | "downloadIosVoicePack"
    | "activateIosVoicePack"
    | "removeIosVoicePack"
  >;
  readonly available?: boolean | undefined;
  readonly loadReferenceProfile?: ((profileId: string) => Promise<TauriNativeSpeechReferenceProfile | null>) | undefined;
  readonly androidPollIntervalMs?: number | undefined;
  readonly androidPollTimeoutMs?: number | undefined;
  readonly sleep?: ((ms: number, signal?: AbortSignal | undefined) => Promise<void>) | undefined;
}

const TASKS: readonly NativeSpeechPackTask[] = Object.freeze(["vad", "kws", "stt", "tts"]);
const DEFAULT_ANDROID_POLL_INTERVAL_MS = 500;
const DEFAULT_ANDROID_POLL_TIMEOUT_MS = 120_000;

export function createTauriNativeSpeechCatalogPort(
  options: TauriNativeSpeechCatalogPortOptions,
): TauriNativeSpeechCatalogPort {
  const available = options.available ?? true;
  let activeDownloadCount = 0;
  return Object.freeze({
    available,
    listCatalog: async () => {
      if (!available) return unavailableCatalog();
      try {
        const items = await listPlatformCatalog(options);
        return Object.freeze({
          state: "ready",
          items: Object.freeze(items),
        });
      } catch {
        return unavailableCatalog();
      }
    },
    select: async (request: AuroraBrowserSpeechPackInstallRequest) => {
      if (!available) throw new Error("voice_download_unavailable");
      activeDownloadCount += 1;
      try {
        return await selectPlatformCatalogEntry(options, request);
      } finally {
        activeDownloadCount = Math.max(0, activeDownloadCount - 1);
      }
    },
    getReadiness: async () => {
      if (!available) return emptyReadiness("unavailable");
      try {
        const readiness = await readinessForPlatform(options);
        return activeDownloadCount > 0 ? withDownloadingState(readiness) : readiness;
      } catch {
        return emptyReadiness("unavailable");
      }
    },
    remove: async (selection: Pick<AuroraBrowserSpeechPackCatalogSelection, "task" | "packId">) => {
      if (!available) throw new Error("voice_download_unavailable");
      validateSelection({ ...selection, packVersion: "native", displayName: selection.packId });
      await removePlatformCatalogEntry(options, selection);
      return readinessForPlatform(options);
    },
    listReferenceProfiles: () => listAuroraBrowserPocketReferenceProfiles(),
    saveReferenceProfile: (input: AuroraBrowserPocketReferenceProfileInput) => saveAuroraBrowserPocketReferenceProfile(input),
    deleteReferenceProfile: (profileId: string) => deleteAuroraBrowserPocketReferenceProfile(profileId),
  });
}

async function listPlatformCatalog(
  options: TauriNativeSpeechCatalogPortOptions,
): Promise<readonly AuroraBrowserSpeechPackCatalogSelection[]> {
  if (options.platform === "android") {
    const status = await options.transport.getAndroidVoicePackCatalogStatus();
    return Object.freeze(status.entries.map(normalizeAndroidEntry));
  }
  if (options.platform === "ios") {
    const entries = await options.transport.listIosVoicePacks();
    return Object.freeze(arrayFromCatalogResponse(entries).map(normalizeIosEntry));
  }
  const response = await options.transport.getNativeSpeechPackCatalog({});
  return Object.freeze(response.packs.map(normalizeDesktopEntry));
}

async function removePlatformCatalogEntry(
  options: TauriNativeSpeechCatalogPortOptions,
  selection: Pick<AuroraBrowserSpeechPackCatalogSelection, "task" | "packId">,
): Promise<void> {
  if (options.platform === "android") {
    await options.transport.removeAndroidVoicePack({ task: selection.task, packId: selection.packId });
    return;
  }
  if (options.platform === "ios") {
    await options.transport.removeIosVoicePack({ task: selection.task, packId: selection.packId });
    return;
  }
  await options.transport.removeNativeSpeechPack({ task: selection.task, packId: selection.packId });
}

async function selectPlatformCatalogEntry(
  options: TauriNativeSpeechCatalogPortOptions,
  request: AuroraBrowserSpeechPackInstallRequest,
): Promise<AuroraBrowserSpeechPackInstallReceipt> {
  validateSelection(request.selection);
  const reference = await referencePayloadForSelection(options, request.selection);
  request.onProgress?.({ state: "queued" });
  if (options.platform === "android") {
    await selectAndroidCatalogEntry(options, request, reference);
  } else if (options.platform === "ios") {
    await selectIosCatalogEntry(options, request, reference);
  } else {
    await selectDesktopCatalogEntry(options, request, reference);
  }
  request.onProgress?.({ state: "ready" });
  return installReceiptFromSelection(request.selection);
}

async function selectDesktopCatalogEntry(
  options: TauriNativeSpeechCatalogPortOptions,
  request: AuroraBrowserSpeechPackInstallRequest,
  reference: NativeReferenceCommandPayload,
): Promise<void> {
  const installRequest = {
    task: request.selection.task,
    packId: request.selection.packId,
    ...reference,
  } satisfies NativeSpeechPackIdRequest & NativeReferenceCommandPayload;
  request.onProgress?.({ state: "downloading" });
  await options.transport.installNativeSpeechPack(installRequest);
  request.onProgress?.({ state: "saving" });
  const activateRequest = {
    task: request.selection.task,
    packId: request.selection.packId,
    slot: request.selection.task,
    ...reference,
  } satisfies NativeSpeechPackActivateRequest & NativeReferenceCommandPayload;
  await options.transport.activateNativeSpeechPack(activateRequest);
}

async function selectIosCatalogEntry(
  options: TauriNativeSpeechCatalogPortOptions,
  request: AuroraBrowserSpeechPackInstallRequest,
  reference: NativeReferenceCommandPayload,
): Promise<void> {
  const downloadRequest = {
    task: request.selection.task,
    packId: request.selection.packId,
    forceDownload: false,
    activate: false,
    ...reference,
  } satisfies NativeMobileSpeechPackDownloadRequest;
  request.onProgress?.({ state: "downloading" });
  await options.transport.downloadIosVoicePack(downloadRequest);
  request.onProgress?.({ state: "saving" });
  const activateRequest = {
    task: request.selection.task,
    packId: request.selection.packId,
    slot: request.selection.task,
    ...reference,
  } satisfies NativeMobileSpeechPackActivateRequest;
  await options.transport.activateIosVoicePack(activateRequest);
}

async function selectAndroidCatalogEntry(
  options: TauriNativeSpeechCatalogPortOptions,
  request: AuroraBrowserSpeechPackInstallRequest,
  reference: NativeReferenceCommandPayload,
): Promise<void> {
  const downloadRequest = {
    task: request.selection.task,
    packId: request.selection.packId,
    forceDownload: false,
    activate: false,
    ...reference,
  } satisfies NativeMobileSpeechPackDownloadRequest;
  request.onProgress?.({ state: "downloading" });
  const result = await options.transport.downloadAndroidVoicePack(downloadRequest);
  if (result.started && result.jobId) {
    await pollAndroidDownload(options, result, request.signal, request.onProgress);
  } else if (result.started && !result.installed) {
    throw new Error("voice_download_unavailable");
  }
  request.onProgress?.({ state: "saving" });
  await options.transport.activateAndroidVoicePack({
    task: request.selection.task,
    packId: request.selection.packId,
    slot: request.selection.task,
    ...reference,
  });
}

async function pollAndroidDownload(
  options: TauriNativeSpeechCatalogPortOptions,
  result: AndroidVoicePackDownloadResult,
  signal: AbortSignal | undefined,
  onProgress: ((progress: AuroraBrowserSpeechPackInstallProgress) => void) | undefined,
): Promise<void> {
  const startedAt = Date.now();
  const intervalMs = options.androidPollIntervalMs ?? DEFAULT_ANDROID_POLL_INTERVAL_MS;
  const timeoutMs = options.androidPollTimeoutMs ?? DEFAULT_ANDROID_POLL_TIMEOUT_MS;
  const sleep = options.sleep ?? sleepWithAbort;
  while (true) {
    throwIfAborted(signal);
    const status = await options.transport.getAndroidVoicePackDownloadStatus(result.jobId!);
    emitAndroidProgress(status, onProgress);
    if (status.status === "completed") return;
    if (status.status === "failed") throw new Error("voice_download_failed");
    if (Date.now() - startedAt >= timeoutMs) throw new Error("voice_download_timeout");
    await sleep(intervalMs, signal);
  }
}

function emitAndroidProgress(
  status: AndroidVoicePackDownloadStatus,
  onProgress: ((progress: AuroraBrowserSpeechPackInstallProgress) => void) | undefined,
): void {
  onProgress?.({
    state: status.status === "completed" ? "saving" : "downloading",
    receivedBytes: numberOrUndefined(status.downloadedBytes),
    totalBytes: numberOrUndefined(status.totalBytes),
  });
}

async function readinessForPlatform(
  options: TauriNativeSpeechCatalogPortOptions,
): Promise<TauriNativeSpeechCatalogReadiness> {
  if (options.platform === "android") {
    const status = await options.transport.getAndroidVoicePackCatalogStatus();
    return readinessFromAndroidStatus(status);
  }
  if (options.platform === "ios") {
    return readinessFromGenericStatus(await options.transport.getIosVoicePackStatus());
  }
  return readinessFromDesktopStatus(await options.transport.getNativeSpeechPackStatus());
}

function resolveNativeRequiresReferenceProfile(
  record: Record<string, unknown>,
  modelFamily?: string,
): boolean {
  const mode = stringField(record, "referenceAudioMode") ?? stringField(record, "reference_audio_mode");
  if (mode === "internal") return false;
  if (mode === "profile") return true;
  if (record.requiresReferenceProfile === true || record.requiresReferenceAudio === true) return true;
  if (record.requiresReferenceProfile === false || record.requiresReferenceAudio === false) return false;
  return (modelFamily ?? stringField(record, "modelFamily") ?? stringField(record, "model_family")) === "pockettts";
}

function normalizeDesktopEntry(entry: NativeSpeechPackCatalogResponse["packs"][number]): AuroraBrowserSpeechPackCatalogSelection {
  const record = entry as unknown as Record<string, unknown>;
  const packVersion = stringField(record, "version")
    ?? stringField(record, "revision")
    ?? stringField(record, "runtimeRevision")
    ?? entry.activeSlot
    ?? "native";
  const modelFamily = stringField(record, "modelFamily");
  const requiresReferenceProfile = resolveNativeRequiresReferenceProfile(record, modelFamily);
  return freezeSelection({
    task: entry.task,
    packId: entry.packId,
    packVersion,
    displayName: entry.displayName,
    language: entry.language ?? entry.languages[0],
    cached: entry.installed,
    active: Boolean(entry.activeSlot),
    ...(entry.task === "tts" ? {
      profilePackId: entry.language ?? entry.languages[0] ?? entry.packId,
      profilePackRevision: stringField(record, "revision") ?? packVersion,
      voiceId: stringField(record, "voiceId") ?? entry.packId,
      voiceRevision: stringField(record, "voiceRevision") ?? packVersion,
    } : {}),
    ...(requiresReferenceProfile ? {
      requiresReferenceProfile: true,
      referenceProfileSelected: Boolean(stringField(record, "referenceProfileId")),
      ...(stringField(record, "referenceProfileId") ? { referenceProfileId: stringField(record, "referenceProfileId") } : {}),
    } : {}),
  });
}

function normalizeAndroidEntry(entry: AndroidVoicePackCatalogStatus["entries"][number]): AuroraBrowserSpeechPackCatalogSelection {
  const task = normalizeTask(entry.runtimeTask) ?? normalizeTask(entry.tasks?.[0]) ?? "stt";
  const packVersion = entry.engineRuntimeRevision ?? entry.sha256;
  return freezeSelection({
    task,
    packId: entry.packId,
    packVersion,
    displayName: entry.packName,
    language: entry.language,
    cached: entry.installed,
    active: entry.active,
    ...(task === "tts" ? {
      voiceId: entry.packId,
      voiceRevision: packVersion,
    } : {}),
    ...(resolveNativeRequiresReferenceProfile(entry as unknown as Record<string, unknown>, entry.modelFamily) ? {
      requiresReferenceProfile: true,
      referenceProfileSelected: entry.referenceSelectionPresent === true,
    } : {}),
  });
}

function normalizeIosEntry(entry: unknown): AuroraBrowserSpeechPackCatalogSelection {
  const record = asRecord(entry);
  const task = normalizeTask(record.task) ?? "stt";
  const packId = stringField(record, "packId") ?? stringField(record, "pack_id") ?? "";
  const packVersion = stringField(record, "version") ?? stringField(record, "runtimeRevision") ?? stringField(record, "sha256") ?? "ios";
  const modelFamily = stringField(record, "modelFamily");
  const requiresReferenceProfile = resolveNativeRequiresReferenceProfile(record, modelFamily);
  return freezeSelection({
    task,
    packId,
    packVersion,
    displayName: stringField(record, "displayName") ?? packId,
    language: stringField(record, "language"),
    cached: booleanField(record, "installed"),
    active: typeof record.activeSlot === "string" && record.activeSlot.length > 0,
    ...(task === "tts" ? {
      voiceId: stringField(record, "voiceId") ?? packId,
      voiceRevision: stringField(record, "voiceRevision") ?? packVersion,
    } : {}),
    ...(requiresReferenceProfile ? {
      requiresReferenceProfile: true,
      referenceProfileSelected: Boolean(stringField(record, "referenceProfileId")),
      ...(stringField(record, "referenceProfileId") ? { referenceProfileId: stringField(record, "referenceProfileId") } : {}),
    } : {}),
  });
}

function readinessFromDesktopStatus(status: NativeSpeechPackStatusResponse): TauriNativeSpeechCatalogReadiness {
  return freezeReadiness({
    available: status.available,
    state: Object.keys(status.activeSlots).length > 0 ? "ready" : "unavailable",
    activeSlots: activeSlotsFromRecord(status.activeSlots),
    catalogCount: status.count,
  });
}

function readinessFromAndroidStatus(status: AndroidVoicePackCatalogStatus): TauriNativeSpeechCatalogReadiness {
  const activeSlots: Partial<Record<NativeSpeechPackTask, string>> = {};
  const record = status as unknown as Record<string, unknown>;
  for (const task of TASKS) {
    const id = stringField(record, `active${upperTask(task)}PackId`);
    if (id) activeSlots[task] = id;
  }
  for (const entry of status.entries) {
    const task = normalizeTask(entry.runtimeTask) ?? normalizeTask(entry.tasks?.[0]);
    if (task && entry.active && entry.installed && !activeSlots[task]) activeSlots[task] = entry.packId;
  }
  return freezeReadiness({
    available: status.available,
    state: Object.keys(activeSlots).length > 0 ? "ready" : "unavailable",
    activeSlots,
    catalogCount: status.entries.length,
  });
}

function readinessFromGenericStatus(value: unknown): TauriNativeSpeechCatalogReadiness {
  const record = asRecord(value);
  const activeSlots = activeSlotsFromRecord(asRecord(record.activeSlots));
  const count = typeof record.count === "number" ? record.count : arrayFromUnknown(record.packs).length;
  return freezeReadiness({
    available: record.available === true,
    state: Object.keys(activeSlots).length > 0 ? "ready" : "unavailable",
    activeSlots,
    catalogCount: count,
  });
}

async function referencePayloadForSelection(
  options: TauriNativeSpeechCatalogPortOptions,
  selection: AuroraBrowserSpeechPackCatalogSelection,
): Promise<NativeReferenceCommandPayload> {
  if (selection.requiresReferenceProfile !== true) return {};
  if (!selection.referenceProfileId) throw new Error("voice_reference_required");
  const profile = options.loadReferenceProfile
    ? await options.loadReferenceProfile(selection.referenceProfileId)
    : await loadStoredReferenceProfile(selection.referenceProfileId);
  if (!profile) throw new Error("voice_reference_required");
  const referenceSamples = profile.referenceSamples ? Array.from(profile.referenceSamples) : undefined;
  if (!profile.referenceAudioUri && (!referenceSamples || referenceSamples.length === 0)) {
    throw new Error("voice_reference_required");
  }
  return {
    referenceId: profile.referenceId,
    ...(profile.referenceAudioUri ? { referenceAudioUri: profile.referenceAudioUri } : {}),
    ...(profile.referenceText ? { referenceText: profile.referenceText } : {}),
    ...(profile.referenceRevision ? { referenceRevision: profile.referenceRevision } : {}),
    ...(profile.referenceSampleRateHz ? { referenceSampleRateHz: profile.referenceSampleRateHz } : {}),
    ...(referenceSamples ? { referenceSamples } : {}),
  };
}

async function loadStoredReferenceProfile(
  profileId: string,
): Promise<TauriNativeSpeechReferenceProfile | null> {
  const stored = await readAuroraBrowserPocketReferenceProfile(profileId);
  if (!stored) return null;
  const decoded = decodeAuroraPocketReferenceWav(stored.audioBytes);
  return Object.freeze({
    referenceId: stored.id,
    referenceText: stored.transcript,
    referenceRevision: stored.sha256,
    referenceSampleRateHz: decoded.sampleRateHz,
    referenceSamples: Object.freeze(Array.from(decoded.samples)),
  });
}

type NativeReferenceCommandPayload = {
  readonly referenceId?: string | null | undefined;
  readonly referenceAudioUri?: string | null | undefined;
  readonly referenceText?: string | null | undefined;
  readonly referenceRevision?: string | null | undefined;
  readonly referenceSampleRateHz?: number | null | undefined;
  readonly referenceSamples?: number[] | null | undefined;
};

function validateSelection(selection: AuroraBrowserSpeechPackCatalogSelection): void {
  if (!TASKS.includes(selection.task) || !safeId(selection.packId)) {
    throw new Error("voice_download_unavailable");
  }
  if (selection.requiresReferenceProfile === true && !selection.referenceProfileId) {
    throw new Error("voice_reference_required");
  }
}

function installReceiptFromSelection(
  selection: AuroraBrowserSpeechPackCatalogSelection,
): AuroraBrowserSpeechPackInstallReceipt {
  return Object.freeze({
    task: selection.task,
    packId: selection.packId,
    packVersion: selection.packVersion,
    trust: Object.freeze({
      task: selection.task,
      packId: selection.packId,
      packVersion: selection.packVersion,
      slotId: selection.task,
      verificationMode: "embedded-catalog",
      expectedManifestSha256: selection.packVersion,
      ...(selection.voiceId ? { voiceId: selection.voiceId } : {}),
      ...(selection.referenceProfileId ? { referenceProfileId: selection.referenceProfileId } : {}),
    }),
  });
}

function freezeSelection(
  selection: AuroraBrowserSpeechPackCatalogSelection,
): AuroraBrowserSpeechPackCatalogSelection {
  return Object.freeze(selection);
}

function freezeReadiness(input: {
  readonly available: boolean;
  readonly state: "ready" | "unavailable";
  readonly activeSlots: Partial<Record<NativeSpeechPackTask, string>>;
  readonly catalogCount: number;
}): TauriNativeSpeechCatalogReadiness {
  const capabilities = TASKS.reduce((acc, task) => {
    acc[task] = Boolean(input.activeSlots[task]);
    return acc;
  }, {} as Record<NativeSpeechPackTask, boolean>);
  return Object.freeze({
    available: input.available,
    state: Object.values(capabilities).some(Boolean) ? "ready" : input.state,
    capabilities: Object.freeze(capabilities),
    activeSlots: Object.freeze({ ...input.activeSlots }),
    catalogCount: input.catalogCount,
  });
}

function withDownloadingState(readiness: TauriNativeSpeechCatalogReadiness): TauriNativeSpeechCatalogReadiness {
  return Object.freeze({
    ...readiness,
    state: "downloading" as const,
  });
}

function emptyReadiness(state: "downloading" | "unavailable"): TauriNativeSpeechCatalogReadiness {
  return Object.freeze({
    available: false,
    state,
    capabilities: Object.freeze({ vad: false, kws: false, stt: false, tts: false }),
    activeSlots: Object.freeze({}),
    catalogCount: 0,
  });
}

function unavailableCatalog(): AuroraBrowserSpeechPackCatalogResult {
  return Object.freeze({ state: "unavailable", items: Object.freeze([]) });
}

function activeSlotsFromRecord(record: Record<string, unknown>): Partial<Record<NativeSpeechPackTask, string>> {
  const activeSlots: Partial<Record<NativeSpeechPackTask, string>> = {};
  for (const task of TASKS) {
    const value = record[task];
    if (typeof value === "string" && value.length > 0) activeSlots[task] = value;
  }
  return activeSlots;
}

function normalizeTask(value: unknown): NativeSpeechPackTask | null {
  return typeof value === "string" && TASKS.includes(value as NativeSpeechPackTask)
    ? value as NativeSpeechPackTask
    : null;
}

function upperTask(task: NativeSpeechPackTask): "Stt" | "Vad" | "Kws" | "Tts" {
  return (task.charAt(0).toUpperCase() + task.slice(1)) as "Stt" | "Vad" | "Kws" | "Tts";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayFromUnknown(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function arrayFromCatalogResponse(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  return arrayFromUnknown(record.packs ?? record.entries);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanField(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true;
}

function numberOrUndefined(value: number): number | undefined {
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safeId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,256}$/u.test(value);
}

async function sleepWithAbort(ms: number, signal?: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  throwIfAborted(signal);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}
