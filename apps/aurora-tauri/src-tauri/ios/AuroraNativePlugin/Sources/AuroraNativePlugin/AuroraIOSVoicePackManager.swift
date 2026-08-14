import CryptoKit
import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

struct AuroraIOSVoicePackCatalogEntry: Codable, Equatable {
  let packId: String
  let displayName: String
  let language: String
  let task: String
  let downloadUrl: String
  let sha256: String
  let fileSize: UInt64
  let fileName: String
  let runtimeRevision: String
  let license: String
  let attribution: String
  let acknowledged: Bool
  let version: String?
  let compatiblePlatforms: [String]
  let compatibleArchitectures: [String]
  let modelFiles: [AuroraIOSVoicePackModelFile]
  let sampleRateHz: UInt32
  let frameSize: UInt32

  init(
    packId: String,
    displayName: String,
    language: String,
    task: String,
    downloadUrl: String,
    sha256: String,
    fileSize: UInt64,
    fileName: String,
    runtimeRevision: String,
    license: String,
    attribution: String,
    acknowledged: Bool = false,
    version: String? = nil,
    compatiblePlatforms: [String] = ["ios"],
    compatibleArchitectures: [String] = ["arm64"],
    modelFiles: [AuroraIOSVoicePackModelFile] = [],
    sampleRateHz: UInt32 = 16_000,
    frameSize: UInt32 = 512
  ) {
    self.packId = packId
    self.displayName = displayName
    self.language = language
    self.task = task
    self.downloadUrl = downloadUrl
    self.sha256 = sha256
    self.fileSize = fileSize
    self.fileName = fileName
    self.runtimeRevision = runtimeRevision
    self.license = license
    self.attribution = attribution
    self.acknowledged = acknowledged
    self.version = version
    self.compatiblePlatforms = compatiblePlatforms
    self.compatibleArchitectures = compatibleArchitectures
    self.modelFiles = modelFiles
    self.sampleRateHz = sampleRateHz
    self.frameSize = frameSize
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self.packId = try Self.decodeString(
      container,
      keys: ["pack_id", "packId"]
    )
    self.displayName = try Self.decodeString(
      container,
      keys: ["display_name", "displayName"]
    )
    self.language = try Self.decodeString(
      container,
      keys: ["language", "locale"]
    )
    self.task = try Self.decodeString(
      container,
      keys: ["task", "kind"]
    )
    self.downloadUrl = try Self.decodeString(
      container,
      keys: ["download_url", "downloadUrl", "url"]
    )
    self.sha256 = try Self.decodeString(
      container,
      keys: ["sha256", "sha_256"]
    ).lowercased()
    self.fileSize = try Self.decodeUInt64(
      container,
      keys: ["file_size_bytes", "fileSize", "size_bytes"]
    )
    self.fileName = try Self.decodeString(
      container,
      keys: ["file_name", "fileName"]
    )
    self.runtimeRevision = try Self.decodeString(
      container,
      keys: ["runtimeRevision", "runtime_revision", "runtime_version"]
    )
    self.license = try Self.decodeString(
      container,
      keys: ["license", "licenseType"]
    )
    self.attribution = try Self.decodeString(
      container,
      keys: ["attribution", "attributionNotice"]
    )
    self.acknowledged = try container.decodeIfPresent(Bool.self, forKey: .acknowledged) ?? false
    self.version = try? container.decodeIfPresent(String.self, forKey: .version)
      ?? container.decodeIfPresent(String.self, forKey: .modelVersion)
    let platformValue = try? container.decodeIfPresent([String].self, forKey: .compatiblePlatforms)
    let platformValueAlias = try? container.decodeIfPresent([String].self, forKey: .platforms)
    self.compatiblePlatforms = platformValue ?? platformValueAlias ?? ["ios"]
    let architectureValue = try? container.decodeIfPresent([String].self, forKey: .compatibleArchitectures)
    let architectureAlias = try? container.decodeIfPresent([String].self, forKey: .architectures)
    self.compatibleArchitectures = architectureValue ?? architectureAlias ?? ["arm64"]
    let filesValue = try? container.decodeIfPresent([AuroraIOSVoicePackModelFile].self, forKey: .modelFiles)
    let filesAlias = try? container.decodeIfPresent([AuroraIOSVoicePackModelFile].self, forKey: .model_files)
    self.modelFiles = filesValue ?? filesAlias ?? []
    self.sampleRateHz = try Self.decodeUInt32IfPresent(
      container,
      keys: ["sample_rate_hz", "sampleRateHz"]
    ) ?? 16_000
    self.frameSize = try Self.decodeUInt32IfPresent(
      container,
      keys: ["frame_size", "frameSize"]
    ) ?? 512
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(packId, forKey: .packId)
    try container.encode(displayName, forKey: .displayName)
    try container.encode(language, forKey: .language)
    try container.encode(task, forKey: .task)
    try container.encode(downloadUrl, forKey: .downloadUrl)
    try container.encode(sha256, forKey: .sha256)
    try container.encode(fileSize, forKey: .fileSize)
    try container.encode(fileName, forKey: .fileName)
    try container.encode(runtimeRevision, forKey: .runtimeRevision)
    try container.encode(license, forKey: .license)
    try container.encode(attribution, forKey: .attribution)
    try container.encode(acknowledged, forKey: .acknowledged)
    try container.encodeIfPresent(version, forKey: .version)
    try container.encode(compatiblePlatforms, forKey: .compatiblePlatforms)
    try container.encode(compatibleArchitectures, forKey: .compatibleArchitectures)
    try container.encode(modelFiles, forKey: .modelFiles)
    try container.encode(sampleRateHz, forKey: .sampleRateHz)
    try container.encode(frameSize, forKey: .frameSize)
  }

  fileprivate static func decodeString(
    _ container: KeyedDecodingContainer<CodingKeys>,
    keys: [String]
  ) throws -> String {
    for key in keys {
      if let codingKey = CodingKeys(rawValue: key),
         let value = try? container.decodeIfPresent(String.self, forKey: codingKey), !value.isEmpty {
        return value
      }
    }
    throw DecodingError.dataCorrupted(
      .init(
        codingPath: container.codingPath,
        debugDescription: "missing required voice pack catalog field"
      )
    )
  }

  fileprivate static func decodeUInt64(
    _ container: KeyedDecodingContainer<CodingKeys>,
    keys: [String]
  ) throws -> UInt64 {
    for key in keys {
      if let codingKey = CodingKeys(rawValue: key) {
        if let u64Value = try? container.decodeIfPresent(UInt64.self, forKey: codingKey) {
          return u64Value
        }
        if let stringValue = try? container.decodeIfPresent(String.self, forKey: codingKey),
           let parsed = UInt64(stringValue) {
          return parsed
        }
      }
    }
    throw DecodingError.dataCorrupted(
      .init(
        codingPath: container.codingPath,
        debugDescription: "missing or invalid voice pack catalog numeric field"
      )
    )
  }

  fileprivate static func decodeUInt32IfPresent(
    _ container: KeyedDecodingContainer<CodingKeys>,
    keys: [String]
  ) throws -> UInt32? {
    for key in keys {
      if let codingKey = CodingKeys(rawValue: key) {
        if let value = try? container.decodeIfPresent(UInt32.self, forKey: codingKey) {
          return value
        }
        if let stringValue = try? container.decodeIfPresent(String.self, forKey: codingKey),
           let parsed = UInt32(stringValue) {
          return parsed
        }
      }
    }
    return nil
  }

  enum CodingKeys: String, CodingKey {
    case packId
    case pack_id
    case displayName
    case display_name
    case language
    case locale
    case task
    case kind
    case downloadUrl
    case download_url
    case url
    case sha256
    case sha_256
    case fileSize
    case file_size_bytes
    case size_bytes
    case fileName
    case file_name
    case runtimeRevision
    case runtime_revision
    case runtime_version
    case license
    case licenseType
    case attribution
    case attributionNotice
    case acknowledged
    case version
    case modelVersion
    case compatiblePlatforms
    case platforms
    case compatibleArchitectures
    case architectures
    case modelFiles
    case model_files
    case sampleRateHz
    case sample_rate_hz
    case frameSize
    case frame_size
  }
}

struct AuroraIOSVoicePackModelFile: Codable, Equatable {
  let fileId: String
  let relativePath: String
  let sha256: String
  let fileSize: UInt64

  init(fileId: String, relativePath: String, sha256: String, fileSize: UInt64) {
    self.fileId = fileId
    self.relativePath = relativePath
    self.sha256 = sha256.lowercased()
    self.fileSize = fileSize
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self.fileId = try Self.decodeString(container, keys: [.file_id, .fileId])
    self.relativePath = try Self.decodeString(container, keys: [.relative_path, .relativePath, .path])
    self.sha256 = try Self.decodeString(container, keys: [.sha256, .sha_256]).lowercased()
    self.fileSize = try Self.decodeUInt64(container, keys: [.file_size_bytes, .fileSize, .size_bytes])
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(fileId, forKey: .fileId)
    try container.encode(relativePath, forKey: .relativePath)
    try container.encode(sha256, forKey: .sha256)
    try container.encode(fileSize, forKey: .fileSize)
  }

  private static func decodeString(
    _ container: KeyedDecodingContainer<CodingKeys>,
    keys: [CodingKeys]
  ) throws -> String {
    for key in keys {
      if let value = try? container.decodeIfPresent(String.self, forKey: key), !value.isEmpty {
        return value
      }
    }
    throw DecodingError.dataCorrupted(
      .init(codingPath: container.codingPath, debugDescription: "missing required model file field")
    )
  }

  private static func decodeUInt64(
    _ container: KeyedDecodingContainer<CodingKeys>,
    keys: [CodingKeys]
  ) throws -> UInt64 {
    for key in keys {
      if let u64Value = try? container.decodeIfPresent(UInt64.self, forKey: key) {
        return u64Value
      }
      if let stringValue = try? container.decodeIfPresent(String.self, forKey: key),
         let parsed = UInt64(stringValue) {
        return parsed
      }
    }
    throw DecodingError.dataCorrupted(
      .init(codingPath: container.codingPath, debugDescription: "missing or invalid model file size")
    )
  }

  enum CodingKeys: String, CodingKey {
    case fileId
    case file_id
    case relativePath
    case relative_path
    case path
    case sha256
    case sha_256
    case fileSize
    case file_size_bytes
    case size_bytes
  }
}

struct AuroraIOSVoicePackCatalogSetArgs: Decodable {
  let entries: [AuroraIOSVoicePackCatalogEntry]
  let replaceExisting: Bool
  let trustedHosts: [String]

  enum CodingKeys: String, CodingKey {
    case entries
    case replaceExisting
    case trustedHosts
  }

  init(
    entries: [AuroraIOSVoicePackCatalogEntry],
    replaceExisting: Bool = true,
    trustedHosts: [String] = []
  ) {
    self.entries = entries
    self.replaceExisting = replaceExisting
    self.trustedHosts = trustedHosts
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    entries = try container.decode([AuroraIOSVoicePackCatalogEntry].self, forKey: .entries)
    replaceExisting = try container.decodeIfPresent(Bool.self, forKey: .replaceExisting) ?? true
    trustedHosts = try container.decodeIfPresent([String].self, forKey: .trustedHosts) ?? []
  }
}

struct AuroraIOSVoicePackDownloadArgs: Decodable {
  let packId: String
}

struct AuroraIOSVoicePackRemoveArgs: Decodable {
  let packId: String
}

private struct AuroraIOSVoicePackInstalledRecord: Codable {
  let pack: AuroraIOSVoicePackCatalogEntry
  let installedAtMs: UInt64
  let localSha256: String
  let bytesDownloaded: UInt64
}

struct AuroraIOSVoicePackPathBinding: Equatable {
  let slot: String
  let task: String
  let packPath: String
  let sha256: String
  let fileSize: UInt64
  let runtimeRevision: String
  let language: String
  let filesJson: String
  let packId: String
  let sampleRateHz: UInt32
  let frameSize: UInt32
}

private struct AuroraIOSVoicePackActiveSelection: Codable {
  let slots: [String: String]

  init(slots: [String: String]) {
    self.slots = slots
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if let slots = try? container.decode([String: String].self) {
      self.slots = slots
      return
    }
    let packId = try container.decode(String.self)
    self.slots = ["stt": packId]
  }
}

enum AuroraIOSVoicePackManagerError: Error {
  case catalogMissing
  case packNotFound
  case downloadFailed
  case hashMismatch
  case invalidPack
  case ioFailure
  case incompatiblePack
  case invalidUri
  case runtimeUnavailable
}

enum AuroraIOSVoicePackManager {
  static let catalogFileName = "catalog.json"
  static let trustedHostsFileName = "trusted-hosts.json"
  static let activeFileName = "active.json"
  static let catalogDirectoryName = "voice-packs"
  static let stagingPrefix = "staging-"

  private static let catalogEntryLimit = 200
  private static let maxPackBytes = 1024 * 1024 * 1024
  private static let maxPackDownloadBytes = 1024 * 1024 * 1024
  private static let maxRedirects = 5
  private static let downloadTimeout: TimeInterval = 180
  private static let runtimeProbeTimeout: TimeInterval = 6
  private static let operationQueue = DispatchQueue(label: "aurora.ios.voicepack.manager")

  static func status() -> [String: Any] {
    do {
      return try withSerializedState { try statusLocked() }
    } catch {
      return [
        "available": false,
        "activeSlots": [:],
        "activePackId": NSNull(),
        "count": 0,
        "packs": [],
        "secretsRedacted": true
      ]
    }
  }

  static func setCatalog(
    entries: [AuroraIOSVoicePackCatalogEntry],
    replaceExisting: Bool = true,
    trustedHosts: [String] = []
  ) throws -> [String: Any] {
    try withSerializedState {
      let normalizedTrustedHosts = try normalizeTrustedHosts(trustedHosts, entries: entries)
      let sanitized = try entries.map { entry -> AuroraIOSVoicePackCatalogEntry in
        guard try isValidEntry(entry, trustedHosts: normalizedTrustedHosts) else {
          throw AuroraIOSVoicePackManagerError.invalidPack
        }
        return entry
      }
      guard sanitized.count <= catalogEntryLimit else { throw AuroraIOSVoicePackManagerError.invalidPack }

      let entriesToStore: [AuroraIOSVoicePackCatalogEntry]
      if replaceExisting {
        entriesToStore = sanitized
      } else {
        let existing = try loadCatalog()
        var packed = [String: AuroraIOSVoicePackCatalogEntry]()
        for entry in existing { packed[entry.packId] = entry }
        for entry in sanitized { packed[entry.packId] = entry }
        entriesToStore = Array(packed.values).sorted(by: { $0.packId < $1.packId })
      }

      let encoder = JSONEncoder()
      encoder.outputFormatting = [.withoutEscapingSlashes, .sortedKeys]
      let data = try encoder.encode(entriesToStore)
      try writeAtomically(data: data, to: catalogFileURL())
      try writeAtomically(data: try encoder.encode(Array(normalizedTrustedHosts).sorted()), to: trustedHostsFileURL())
      return try statusLocked()
    }
  }

  static func activate(packId: String, slot: String) throws -> [String: Any] {
    try withSerializedState {
      return try activateLocked(packId: packId, slot: slot)
    }
  }

  private static func activateLocked(packId: String, slot: String) throws -> [String: Any] {
    let safePackId = try sanitizePackId(packId)
    let installed = try installedPackRecords()
    guard let record = installed[safePackId] else { throw AuroraIOSVoicePackManagerError.packNotFound }
    guard slot.isEmpty == false else { throw AuroraIOSVoicePackManagerError.invalidPack }
    let normalizedSlot = slot.lowercased()
    let entry = record.pack
    guard isPackCompatible(entry) else { throw AuroraIOSVoicePackManagerError.incompatiblePack }
    guard entry.acknowledged else { throw AuroraIOSVoicePackManagerError.invalidPack }

    var currentSlots = try activeSelection()
    currentSlots[normalizedSlot] = safePackId
    let active = AuroraIOSVoicePackActiveSelection(slots: currentSlots)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes, .sortedKeys]
    let data = try encoder.encode(active)
    try writeAtomically(data: data, to: activeFileURL())
    return try statusLocked()
  }

  static func download(packId: String) throws -> [String: Any] {
    try withSerializedState {
      let safePackId = try sanitizePackId(packId)
      let catalog = try loadCatalog()
      guard let entry = catalog.first(where: { $0.packId == safePackId }) else {
        throw AuroraIOSVoicePackManagerError.packNotFound
      }
      guard entry.fileSize > 0, entry.fileSize <= maxPackDownloadBytes else {
        throw AuroraIOSVoicePackManagerError.invalidPack
      }
      if !entry.compatiblePlatforms.contains("ios") {
        throw AuroraIOSVoicePackManagerError.incompatiblePack
      }
      guard isPackCompatible(entry) else { throw AuroraIOSVoicePackManagerError.incompatiblePack }
      guard entry.acknowledged else { throw AuroraIOSVoicePackManagerError.invalidPack }
      let root = try cacheRoot()
      let safePackId = try sanitizePackId(entry.packId)
      let packDirectory = root.appendingPathComponent(safePackId, isDirectory: true)
      try FileManager.default.createDirectory(
        at: packDirectory,
        withIntermediateDirectories: true
      )
      try excludeFromBackup(packDirectory)
      cleanupStagingFiles(in: packDirectory)

      let safeFileName = try sanitizeFileName(entry.fileName)
      let targetFile = packDirectory.appendingPathComponent(safeFileName)
      let stagingFile = packDirectory.appendingPathComponent(
        "\(AuroraIOSVoicePackManager.stagingPrefix)\(UUID().uuidString).tmp"
      )
      guard isSafeCachedURL(packDirectory, candidate: targetFile) else {
        throw AuroraIOSVoicePackManagerError.invalidPack
      }
      guard isSafeCachedURL(packDirectory, candidate: stagingFile) else {
        throw AuroraIOSVoicePackManagerError.invalidPack
      }
      defer { try? FileManager.default.removeItem(at: stagingFile) }

      let result = try downloadAndVerify(
        urlString: entry.downloadUrl,
        destination: stagingFile,
        expectedSize: entry.fileSize
      )
      guard result == entry.sha256.lowercased() else {
        try? FileManager.default.removeItem(at: stagingFile)
        throw AuroraIOSVoicePackManagerError.hashMismatch
      }
      let backupTarget = targetFile.appendingPathExtension("old")
      if FileManager.default.fileExists(atPath: targetFile.path) {
        try? FileManager.default.removeItem(at: backupTarget)
        try? FileManager.default.copyItem(at: targetFile, to: backupTarget)
      }
      try writeAtomically(data: try Data(contentsOf: stagingFile), to: targetFile)
      let record = AuroraIOSVoicePackInstalledRecord(
        pack: entry,
        installedAtMs: UInt64(Date().timeIntervalSince1970 * 1000),
        localSha256: result,
        bytesDownloaded: entry.fileSize
      )
      let metadataURL = packDirectory.appendingPathComponent("metadata.json")
      let encodedMetadata = try JSONEncoder().encode(record)
      try writeAtomically(data: encodedMetadata, to: metadataURL)
      try FileManager.default.removeItem(at: backupTarget)
      _ = try activateLocked(packId: safePackId, slot: entry.task)
      return try statusLocked()
    }
  }

  static func list() throws -> [[String: Any]] {
    try withSerializedState {
      let active = try? activeSelection()
      return try loadCatalog().map { entry in
        let installed = (try? installedPackRecords()[entry.packId]) != nil
        let activeSlot = active?.first(where: { $0.value == entry.packId })?.key
        return [
          "packId": entry.packId,
          "displayName": entry.displayName,
          "language": entry.language,
          "task": entry.task,
          "version": entry.version ?? NSNull(),
          "runtimeRevision": entry.runtimeRevision,
          "license": entry.license,
          "attribution": entry.attribution,
          "acknowledged": entry.acknowledged,
          "compatiblePlatforms": entry.compatiblePlatforms,
          "compatibleArchitectures": entry.compatibleArchitectures,
          "sha256": entry.sha256,
          "fileSize": entry.fileSize,
          "installed": installed,
          "activeSlot": activeSlot ?? NSNull()
        ]
      }
    }
  }

  static func remove(packId: String) throws -> [String: Any] {
    try withSerializedState {
      let safePackId = try sanitizePackId(packId)
      let root = try cacheRoot()
      let packDirectory = root.appendingPathComponent(safePackId, isDirectory: true)
      if FileManager.default.fileExists(atPath: packDirectory.path) {
        try FileManager.default.removeItem(at: packDirectory)
      }
      if let active = try? activeSelection() {
        let filtered = active.filter { $0.value != safePackId }
        let updated = AuroraIOSVoicePackActiveSelection(slots: filtered)
        let encoded = try JSONEncoder().encode(updated)
        try writeAtomically(data: encoded, to: activeFileURL())
      }
      return try statusLocked()
    }
  }

  static func readyPackId(for slot: String? = "stt") -> String? {
    guard let active = try? activeSelection() else { return nil }
    if let slot {
      let requestedSlot = slot.lowercased()
      guard let packId = active[requestedSlot], isReadyPack(packId: packId) else { return nil }
      return packId
    }
    return active.values.first(where: { isReadyPack(packId: $0) })
  }

  static func boundPackPaths(for slots: [String]) throws -> [String: String] {
    try withSerializedState {
      let normalizedSlots = Set(slots.map { $0.lowercased() })
      return try boundPackPathsForSlotsLocked(normalizedSlots)
    }
  }

  static func boundPackBindings(for slots: [String]) throws -> [AuroraIOSVoicePackPathBinding] {
    try withSerializedState {
      let normalizedSlots = Set(slots.map { $0.lowercased() })
      return try boundPackBindingsForSlotsLocked(normalizedSlots)
    }
  }

  static func status(forSlots slots: [String]) -> [String: Bool] {
    return (try? withSerializedState {
      let normalizedSlots = Set(slots.map { $0.lowercased() })
      var result: [String: Bool] = [:]
      let bindings = try boundPackPathsForSlotsLocked(normalizedSlots)
      for slot in normalizedSlots where slot.isEmpty == false {
        result[slot] = bindings[slot] != nil
      }
      return result
    }) ?? [:]
  }

  static func slotCompatibilities() -> [String: [String: Bool]] {
    (try? withSerializedState {
      let installed = try installedPackRecords()
      let active = (try? activeSelection()) ?? [:]
      var result: [String: [String: Bool]] = [:]
      for (slot, packId) in active {
        let installedEntry = installed[packId]
        let compatible = installedEntry != nil && isPackCompatible(installedEntry?.pack ?? nil)
        result[slot] = ["compatible": compatible]
      }
      return result
    }) ?? [:]
  }

  static func listCatalogEntries() throws -> [AuroraIOSVoicePackCatalogEntry] {
    try withSerializedState { try loadCatalog() }
  }

  static func isRuntimeConnected() -> Bool {
    guard
      let configuration = try? AuroraIOSVoiceCredentialStore.load(),
      let gateway = URL(string: configuration.gateway),
      validateGatewayURL(gateway, allowHttp: false),
      validateDownloadTarget(gateway),
      let target = URL(string: configuration.gateway)
    else {
      return false
    }
    return (try? probeEngine(at: target)) ?? false
  }

  static func status(forSlot slot: String) -> [String: Any] {
    let readyPack = readyPackId(for: slot)
    let active = (try? activeSelection()) ?? [:]
    let readySlotPackId = readyPack
    let compatible = (try? {
      let packRecords = try installedPackRecords()
      if let selected = readySlotPackId, let record = packRecords[selected] {
        return isPackCompatible(record.pack)
      }
      return false
    }()) ?? false
    let runtimeConnected = isRuntimeConnected()
    return [
      "slot": slot.lowercased(),
      "activePack": readySlotPackId ?? NSNull(),
      "activeSlots": active,
      "runtimeConnected": runtimeConnected,
      "canRun": readySlotPackId != nil && compatible && runtimeConnected
    ]
  }

  private static func withSerializedState<T>(_ block: () throws -> T) throws -> T {
    try operationQueue.sync {
      try block()
    }
  }

  private static func statusLocked() throws -> [String: Any] {
    let catalog = try loadCatalog()
    let installed = try installedPackRecords()
    let active = try activeSelection()
    let available = isRuntimeConnected() && active.values.contains(where: { isReadyPack(packId: $0) })
    let safeActive = active.reduce(into: [String: String]()) { acc, pair in
      acc[pair.key.lowercased()] = pair.value
    }
    let packStatuses = catalog.map { entry in
      let isInstalled = installed[entry.packId] != nil
      let activeSlot = active.first(where: { $0.value == entry.packId })?.key
      return [
        "packId": entry.packId,
        "displayName": entry.displayName,
        "language": entry.language,
        "task": entry.task,
        "version": entry.version ?? NSNull(),
        "compatiblePlatforms": entry.compatiblePlatforms,
        "compatibleArchitectures": entry.compatibleArchitectures,
        "runtimeRevision": entry.runtimeRevision,
        "license": entry.license,
        "attribution": entry.attribution,
        "acknowledged": entry.acknowledged,
        "sha256": entry.sha256,
        "fileSize": entry.fileSize,
        "fileName": entry.fileName,
        "installed": isInstalled,
        "activeSlot": activeSlot ?? NSNull(),
        "bytesDownloaded": installed[entry.packId]?.bytesDownloaded ?? 0,
        "installedAtMs": installed[entry.packId]?.installedAtMs ?? NSNull()
      ] as [String: Any]
    }
    return [
      "available": available,
      "activeSlots": safeActive,
      "activePackId": active["stt"] ?? NSNull(),
      "count": catalog.count,
      "packs": packStatuses,
      "secretsRedacted": true
    ] as [String: Any]
  }

  private static func isReadyPack(packId: String) -> Bool {
    do {
      let installed = try installedPackRecords()
      guard let record = installed[packId] else { return false }
      return isPackCompatible(record.pack) && record.pack.acknowledged
    } catch {
      return false
    }
  }

  private static func isPackCompatible(_ entry: AuroraIOSVoicePackCatalogEntry) -> Bool {
    let task = entry.task.lowercased()
    guard ["stt", "tts", "vad", "kws", "wakeword"].contains(task) else {
      return false
    }
    guard !entry.runtimeRevision.isEmpty else { return false }
    guard isValidSha(entry.sha256), entry.license.count > 0, entry.attribution.count > 0 else {
      return false
    }
    let compatiblePlatforms = Set(entry.compatiblePlatforms.map { $0.lowercased() })
    if !compatiblePlatforms.contains("ios") && !compatiblePlatforms.contains("all") {
      return false
    }
    let compatibleArchs = Set(entry.compatibleArchitectures.map { $0.lowercased() })
    if !compatibleArchs.contains("all") && compatibleArchs.intersection(currentArchitectures()).isEmpty {
      return false
    }
    return true
  }

  private static func isPackCompatible(_ optionalEntry: AuroraIOSVoicePackCatalogEntry?) -> Bool {
    guard let entry = optionalEntry else { return false }
    return isPackCompatible(entry)
  }

  private static func sanitizePackId(_ value: String) throws -> String {
    let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard isSafeToken(normalized), normalized.count <= 64, normalized.count >= 4 else {
      throw AuroraIOSVoicePackManagerError.invalidPack
    }
    return normalized
  }

  private static func sanitizeFileName(_ value: String) throws -> String {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty,
          sanitizedFilename(trimmed),
          trimmed.count <= 128,
          trimmed.count >= 1 else {
      throw AuroraIOSVoicePackManagerError.invalidPack
    }
    return trimmed
  }

  private static func sanitizedFilename(_ value: String) -> Bool {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.contains("/") || trimmed.contains("\\") || trimmed.contains("..") {
      return false
    }
    guard !trimmed.hasPrefix(".") && !trimmed.hasSuffix(".") else { return false }
    let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
    return trimmed.rangeOfCharacter(from: allowed.inverted) == nil
  }

  private static func isSafeToken(_ value: String) -> Bool {
    let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
    return !value.isEmpty && value.rangeOfCharacter(from: allowed.inverted) == nil
  }

  private static func isValidEntry(
    _ entry: AuroraIOSVoicePackCatalogEntry,
    trustedHosts: Set<String>? = nil
  ) throws -> Bool {
    let packId = try sanitizePackId(entry.packId)
    let fileName = try sanitizeFileName(entry.fileName)
    guard packId == entry.packId,
          fileName == entry.fileName,
          !entry.displayName.isEmpty,
          !entry.language.isEmpty,
          !entry.task.isEmpty,
          isValidSha(entry.sha256),
          entry.fileSize > 0,
          entry.fileSize <= maxPackBytes else {
      return false
    }
    let url = try parseDownloadUrl(entry.downloadUrl)
    guard validateDownloadTarget(url),
          hostAllowedByCatalog(url, trustedHosts: trustedHosts),
          entry.compatiblePlatforms.isEmpty == false else {
      return false
    }
    return isPackCompatible(entry) && validateDownloadTarget(url) && isValidModelFiles(entry.modelFiles)
  }

  private static func isValidModelFiles(_ files: [AuroraIOSVoicePackModelFile]) -> Bool {
    var seen = Set<String>()
    for file in files {
      guard isValidSlot(file.fileId),
            seen.insert(file.fileId).inserted,
            isValidSha256(file.sha256),
            file.fileSize > 0,
            (try? sanitizeRelativePath(file.relativePath)) != nil else {
        return false
      }
    }
    return true
  }

  private static func currentArchitectures() -> Set<String> {
    var arches: Set<String> = ["universal"]
    #if arch(arm64)
    arches.insert("arm64")
    #endif
    #if arch(x86_64)
    arches.insert("x86_64")
    #endif
    return arches
  }

  private static func validateDownloadTarget(_ url: URL) -> Bool {
    guard validateGatewayURL(url, allowHttp: false),
          let host = url.host?.lowercased(),
          !host.isEmpty,
          !isDisallowedHost(host) else {
      return false
    }
    return url.fragment == nil
  }

  private static func parseDownloadUrl(_ value: String) throws -> URL {
    guard let url = URL(string: value), validateDownloadTarget(url),
          url.path.hasPrefix("/")
    else {
      throw AuroraIOSVoicePackManagerError.invalidUri
    }
    return url
  }

  private static func normalizeTrustedHosts(
    _ trustedHosts: [String],
    entries: [AuroraIOSVoicePackCatalogEntry]
  ) throws -> Set<String> {
    let sourceHosts = try entries.map { entry -> String in
      let url = try parseDownloadUrl(entry.downloadUrl)
      guard let host = url.host?.lowercased(), !host.isEmpty else {
        throw AuroraIOSVoicePackManagerError.invalidUri
      }
      return host
    }
    let rawHosts = trustedHosts.isEmpty ? sourceHosts : trustedHosts
    let normalized = try rawHosts.map { value -> String in
      let host = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      guard isValidTrustedHost(host), !isDisallowedHost(host) else {
        throw AuroraIOSVoicePackManagerError.invalidUri
      }
      return host
    }
    let result = Set(normalized)
    guard !result.isEmpty, sourceHosts.allSatisfy({ result.contains($0) }) else {
      throw AuroraIOSVoicePackManagerError.invalidUri
    }
    return result
  }

  private static func isValidTrustedHost(_ host: String) -> Bool {
    guard !host.isEmpty, host.count <= 253, !host.contains("/") else { return false }
    let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-")
    guard host.rangeOfCharacter(from: allowed.inverted) == nil,
          !host.hasPrefix("."),
          !host.hasSuffix("."),
          !host.contains("..") else {
      return false
    }
    return true
  }

  private static func hostAllowedByCatalog(_ url: URL, trustedHosts: Set<String>?) -> Bool {
    guard let host = url.host?.lowercased(), !host.isEmpty else { return false }
    let hosts = trustedHosts ?? ((try? loadTrustedHosts()) ?? [])
    return hosts.contains(host)
  }

  private static func isDisallowedHost(_ host: String) -> Bool {
    let value = host.lowercased()
    if value == "localhost" || value == "127.0.0.1" || value == "::1" || value.hasPrefix("127.") {
      return true
    }
    if value == "169.254.169.254" || value.hasPrefix("169.254.") { return true }
    if value.hasPrefix("10.") { return true }
    let octets = value.split(separator: ".")
    if octets.count == 4, let first = Int(octets[0]), first == 192,
       let second = Int(octets[1]), second == 168 {
      return true
    }
    if octets.count == 4, let first = Int(octets[0]), first == 172,
       let second = Int(octets[1]), (16...31).contains(second) {
      return true
    }
    if value.hasPrefix("fe80") { return true }
    return !resolvesToAllowedHost(value)
  }

  private static func resolvesToAllowedHost(_ host: String) -> Bool {
    var info: UnsafeMutablePointer<addrinfo>?
    var hints = addrinfo(
      ai_flags: 0,
      ai_family: AF_UNSPEC,
      ai_socktype: SOCK_STREAM,
      ai_protocol: 0,
      ai_addrlen: 0,
      ai_addr: nil,
      ai_canonname: nil,
      ai_next: nil
    )

    if getaddrinfo(host, nil, &hints, &info) != 0 {
      return false
    }
    guard let first = info else {
      return false
    }
    defer { freeaddrinfo(info) }
    var cursor: UnsafeMutablePointer<addrinfo>? = first
    while let current = cursor {
      if current.pointee.ai_family == AF_INET {
        guard let addr = current.pointee.ai_addr else {
          return false
        }
        let bytes = addr.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { raw in
          raw.pointee.sin_addr.s_addr
        }
        if isDisallowedIPv4(bytes) {
          return false
        }
      } else if current.pointee.ai_family == AF_INET6 {
        guard let addr = current.pointee.ai_addr else {
          return false
        }
        let bytes = addr.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { raw in
          raw.pointee.sin6_addr
        }
        if isDisallowedIPv6(bytes) {
          return false
        }
      }
      cursor = current.pointee.ai_next
    }
    return true
  }

  private static func isDisallowedIPv4(_ bytes: in_addr_t) -> Bool {
    let hostOrder = UInt32(bigEndian: bytes)
    let first = UInt8((hostOrder >> 24) & 0xFF)
    let second = UInt8((hostOrder >> 16) & 0xFF)
    if first == 127 { return true }
    if first == 10 { return true }
    if first == 192 && second == 168 { return true }
    if first == 169 && second == 254 { return true }
    if first == 172 && (16...31).contains(second) { return true }
    if first == 0 { return true }
    if first == 255 { return true }
    return false
  }

  private static func isDisallowedIPv6(_ bytes: in6_addr) -> Bool {
    let raw = withUnsafeBytes(of: bytes) { Array($0) }
    guard raw.count == 16 else { return true }
    if raw[0] == 0x00 && raw[1] == 0x00 && raw[2] == 0x00 && raw[3] == 0x00 &&
        raw[4] == 0x00 && raw[5] == 0x00 && raw[6] == 0x00 && raw[7] == 0x00 &&
        raw[8] == 0x00 && raw[9] == 0x00 && raw[10] == 0x00 && raw[11] == 0x00 &&
        raw[12] == 0x00 && raw[13] == 0x00 && raw[14] == 0x00 && raw[15] == 0x00 {
      return true
    }
    if raw[0] == 0x00 && raw[1] == 0x00 && raw[2] == 0x00 && raw[3] == 0x00 &&
        raw[4] == 0x00 && raw[5] == 0x00 && raw[6] == 0x00 && raw[7] == 0x00 &&
        raw[8] == 0x00 && raw[9] == 0x00 && raw[10] == 0x00 && raw[11] == 0x00 &&
        raw[12] == 0x00 && raw[13] == 0x00 && raw[14] == 0x00 && raw[15] == 0x01 {
      return true
    }
    if raw[0] == 0xFE && (raw[1] & 0xC0) == 0x80 {
      return true
    }
    return raw[0] >= 0xFF
  }

  private static func isDisallowedIPv6(_ sockaddr: sockaddr_in6) -> Bool {
    return isDisallowedIPv6(sockaddr.sin6_addr)
  }

  private static func isDisallowedIPv4(_ sockaddr: sockaddr_in) -> Bool {
    return isDisallowedIPv4(sockaddr.sin_addr.s_addr)
  }

  private static func validateGatewayURL(_ url: URL, allowHttp: Bool = true) -> Bool {
    guard let scheme = url.scheme?.lowercased(),
          let host = url.host,
          !host.isEmpty,
          url.user == nil,
          url.password == nil,
          url.fragment == nil else {
      return false
    }
    if scheme == "http" { return allowHttp }
    return scheme == "https"
  }

  private static func downloadAndVerify(
    urlString: String,
    destination: URL,
    expectedSize: UInt64
  ) throws -> String {
    let url = try parseDownloadUrl(urlString)
    let coordinator = try DownloadCoordinator(
      sourceURL: url,
      expectedSize: expectedSize,
      destination: destination
    )
    return try coordinator.download()
  }

  private static func isValidSha(_ value: String) -> Bool {
    let hex = CharacterSet(charactersIn: "0123456789abcdefABCDEF")
    return value.count == 64 && value.allSatisfy { char in
      let scalar = String(char).unicodeScalars.first!
      return hex.contains(scalar)
    }
  }

  private static func installedPackRecords() throws -> [String: AuroraIOSVoicePackInstalledRecord] {
    let root = try cacheRoot()
    guard FileManager.default.fileExists(atPath: root.path) else { return [:] }
    let children = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
    var result: [String: AuroraIOSVoicePackInstalledRecord] = [:]
    for child in children {
      let metadata = child.appendingPathComponent("metadata.json")
      guard FileManager.default.fileExists(atPath: metadata.path),
            let data = try? Data(contentsOf: metadata),
            let record = try? JSONDecoder().decode(AuroraIOSVoicePackInstalledRecord.self, from: data) else {
        continue
      }
      result[record.pack.packId] = record
    }
    return result
  }

  private static func activeSelection() throws -> [String: String] {
    let file = activeFileURL()
    guard FileManager.default.fileExists(atPath: file.path) else { return [:] }
    let data = try Data(contentsOf: file)
    let active = try JSONDecoder().decode(AuroraIOSVoicePackActiveSelection.self, from: data)
    return active.slots.reduce(into: [:]) { current, pair in
      current[pair.key.lowercased()] = pair.value
    }
  }

  private static func readActiveSelectionLocked() throws -> [String: String] {
    let file = activeFileURL()
    guard FileManager.default.fileExists(atPath: file.path) else { return [:] }
    let data = try Data(contentsOf: file)
    let active = try JSONDecoder().decode(AuroraIOSVoicePackActiveSelection.self, from: data)
    return active.slots.reduce(into: [:]) { current, pair in
      current[pair.key.lowercased()] = pair.value
    }
  }

  private static func boundPackPathsForSlotsLocked(_ slots: Set<String>) throws -> [String: String] {
    Dictionary(uniqueKeysWithValues: try boundPackBindingsForSlotsLocked(slots).map { ($0.slot, $0.packPath) })
  }

  private static func boundPackBindingsForSlotsLocked(_ slots: Set<String>) throws -> [AuroraIOSVoicePackPathBinding] {
    guard !slots.isEmpty else { return [] }
    let active = try readActiveSelectionLocked()
    let root = try cacheRoot()
    let catalog = try loadCatalog()
    let catalogById = Dictionary(uniqueKeysWithValues: catalog.map { ($0.packId, $0) })
    var bindings: [AuroraIOSVoicePackPathBinding] = []
    for slot in slots where slot.isEmpty == false {
      guard let packId = active[slot], let catalogEntry = catalogById[packId] else {
        continue
      }
      guard let metadata = try? readInstalledRecord(for: packId) else { continue }
      guard isPackCompatible(catalogEntry),
            metadata.pack.acknowledged,
            metadata.localSha256 == catalogEntry.sha256,
            metadata.bytesDownloaded == catalogEntry.fileSize,
            metadata.pack.runtimeRevision == catalogEntry.runtimeRevision,
            catalogEntry.sampleRateHz > 0,
            catalogEntry.frameSize > 0 else {
        continue
      }
      let packDirectory = root.appendingPathComponent(packId, isDirectory: true)
      let packPath = packDirectory.appendingPathComponent(catalogEntry.fileName)
      if isSafeCachedPackFile(packDirectory, candidate: packPath, expectedSize: catalogEntry.fileSize),
         let filesJson = modelFilesJson(root: packDirectory, files: catalogEntry.modelFiles) {
        bindings.append(AuroraIOSVoicePackPathBinding(
          slot: slot,
          task: catalogEntry.task.lowercased(),
          packPath: packPath.path,
          sha256: catalogEntry.sha256,
          fileSize: catalogEntry.fileSize,
          runtimeRevision: catalogEntry.runtimeRevision,
          language: catalogEntry.language,
          filesJson: filesJson,
          packId: catalogEntry.packId,
          sampleRateHz: catalogEntry.sampleRateHz,
          frameSize: catalogEntry.frameSize
        ))
      }
    }
    return bindings
  }

  private static func modelFilesJson(root: URL, files: [AuroraIOSVoicePackModelFile]) -> String? {
    guard !files.isEmpty, files.allSatisfy({ isSafeCachedModelFile(root, file: $0) }) else {
      return nil
    }
    do {
      let payload = try files.map { file -> [String: Any] in
        [
          "file_id": file.fileId,
          "path": try modelFileURL(root: root, file: file).path,
          "sha256": file.sha256,
          "size_bytes": file.fileSize
        ]
      }
      let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
      return String(data: data, encoding: .utf8)
    } catch {
      return nil
    }
  }

  private static func readInstalledRecord(for packId: String) throws -> AuroraIOSVoicePackInstalledRecord {
    let root = try cacheRoot()
    let metadataURL = root
      .appendingPathComponent(packId, isDirectory: true)
      .appendingPathComponent("metadata.json")
    let data = try Data(contentsOf: metadataURL)
    return try JSONDecoder().decode(AuroraIOSVoicePackInstalledRecord.self, from: data)
  }

  private static func loadCatalog() throws -> [AuroraIOSVoicePackCatalogEntry] {
    let file = catalogFileURL()
    guard FileManager.default.fileExists(atPath: file.path) else { return [] }
    let data = try Data(contentsOf: file)
    return try JSONDecoder().decode([AuroraIOSVoicePackCatalogEntry].self, from: data)
  }

  private static func loadTrustedHosts() throws -> Set<String> {
    let file = trustedHostsFileURL()
    guard FileManager.default.fileExists(atPath: file.path) else { return [] }
    let data = try Data(contentsOf: file)
    return Set(try JSONDecoder().decode([String].self, from: data).map { $0.lowercased() })
  }

  private static func cacheRoot() throws -> URL {
    let appSupport = FileManager.default.urls(
      for: .applicationSupportDirectory,
      in: .userDomainMask
    ).first
    guard let appSupport else { throw AuroraIOSVoicePackManagerError.ioFailure }
    let root = appSupport.appendingPathComponent(catalogDirectoryName, isDirectory: true)
    if !FileManager.default.fileExists(atPath: root.path) {
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
      try? excludeFromBackup(root)
    }
    return root
  }

  private static func catalogFileURL() -> URL {
    (try? cacheRoot().appendingPathComponent(catalogFileName)) ??
      FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)
        .first!
        .appendingPathComponent(catalogFileName)
  }

  private static func trustedHostsFileURL() -> URL {
    (try? cacheRoot().appendingPathComponent(trustedHostsFileName)) ??
      FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)
        .first!
        .appendingPathComponent(trustedHostsFileName)
  }

  private static func activeFileURL() -> URL {
    (try? cacheRoot().appendingPathComponent(activeFileName)) ??
      FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)
        .first!
        .appendingPathComponent(activeFileName)
  }

  private static func writeAtomically(data: Data, to destination: URL) throws {
    let temporary = destination.deletingLastPathComponent()
      .appendingPathComponent("\(UUID().uuidString).tmp")
    try data.write(to: temporary, options: .atomic)
    try FileManager.default.replaceItemAt(destination, withItemAt: temporary)
  }

  private static func isSafeCachedURL(_ root: URL, candidate: URL) -> Bool {
    let normalizedRoot = root.standardized.resolvingSymlinksInPath().path
    let normalizedCandidate = candidate.standardized.resolvingSymlinksInPath().path
    let rootPrefix = normalizedRoot.hasSuffix("/") ? normalizedRoot : normalizedRoot + "/"
    return normalizedCandidate == normalizedRoot || normalizedCandidate.hasPrefix(rootPrefix)
  }

  private static func isSafeCachedPackFile(_ root: URL, candidate: URL, expectedSize: UInt64) -> Bool {
    guard isSafeCachedURL(root, candidate: candidate) else { return false }
    do {
      let values = try candidate.resourceValues(forKeys: [
        .isRegularFileKey,
        .isSymbolicLinkKey,
        .fileSizeKey
      ])
      guard let fileSize = values.fileSize, fileSize >= 0 else { return false }
      guard values.isRegularFile == true,
            values.isSymbolicLink != true,
            UInt64(fileSize) == expectedSize else {
        return false
      }
      let actualSha256 = try sha256File(candidate)
      let installedSha256 = try readInstalledRecord(for: root.lastPathComponent).localSha256
      return actualSha256 == installedSha256
    } catch {
      return false
    }
  }

  private static func isSafeCachedModelFile(_ root: URL, file: AuroraIOSVoicePackModelFile) -> Bool {
    do {
      let candidate = try modelFileURL(root: root, file: file)
      guard isSafeCachedURL(root, candidate: candidate) else { return false }
      let values = try candidate.resourceValues(forKeys: [
        .isRegularFileKey,
        .isSymbolicLinkKey,
        .fileSizeKey
      ])
      guard let fileSize = values.fileSize, fileSize >= 0 else { return false }
      guard values.isRegularFile == true,
            values.isSymbolicLink != true,
            UInt64(fileSize) == file.fileSize else {
        return false
      }
      return try sha256File(candidate) == file.sha256
    } catch {
      return false
    }
  }

  private static func modelFileURL(root: URL, file: AuroraIOSVoicePackModelFile) throws -> URL {
    root.appendingPathComponent(try sanitizeRelativePath(file.relativePath), isDirectory: false)
  }

  private static func sanitizeRelativePath(_ value: String) throws -> String {
    guard !value.isEmpty, value.utf8.count <= 1024, !value.hasPrefix("/") else {
      throw AuroraIOSVoicePackManagerError.invalidPack
    }
    let parts = value.split(separator: "/", omittingEmptySubsequences: false)
    guard !parts.isEmpty else { throw AuroraIOSVoicePackManagerError.invalidPack }
    let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-/")
    guard value.rangeOfCharacter(from: allowed.inverted) == nil else {
      throw AuroraIOSVoicePackManagerError.invalidPack
    }
    for part in parts {
      guard !part.isEmpty,
            part != ".",
            part != ".." else {
        throw AuroraIOSVoicePackManagerError.invalidPack
      }
    }
    return value
  }

  private static func sha256File(_ url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hasher = SHA256()
    while true {
      let data = try handle.read(upToCount: 1024 * 1024) ?? Data()
      if data.isEmpty { break }
      hasher.update(data: data)
    }
    return hasher.finalize().compactMap { String(format: "%02x", $0) }.joined()
  }

  private static func cleanupStagingFiles(in packDirectory: URL) {
    guard let children = try? FileManager.default.contentsOfDirectory(atPath: packDirectory.path) else {
      return
    }
    for child in children where child.hasPrefix(stagingPrefix) {
      try? FileManager.default.removeItem(at: packDirectory.appendingPathComponent(child))
    }
  }

  private static func excludeFromBackup(_ url: URL) throws {
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try url.setResourceValues(values)
  }

  private static func probeEngine(at url: URL) throws -> Bool {
    guard let scheme = url.scheme?.lowercased(),
          scheme == "https" || scheme == "http" else {
      return false
    }
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = runtimeProbeTimeout
    config.timeoutIntervalForResource = runtimeProbeTimeout
    let session = URLSession(configuration: config)
    let request = URLRequest(
      url: url,
      cachePolicy: .reloadIgnoringLocalAndRemoteCacheData,
      timeoutInterval: runtimeProbeTimeout
    )
    let semaphore = DispatchSemaphore(value: 0)
    var engineError: Error?
    var response: URLResponse?
    let task = session.dataTask(with: request) { _, taskResponse, taskError in
      engineError = taskError
      response = taskResponse
      semaphore.signal()
    }
    task.resume()
    semaphore.wait()
    session.finishTasksAndInvalidate()
    if response != nil, engineError == nil {
      return true
    }
    return false
  }

  private static func isValidUtf8(_ value: String) -> Bool {
    return value.utf8.allSatisfy { $0 >= 0x20 && $0 < 0x7F }
  }

  private static final class DownloadCoordinator: NSObject, URLSessionDataDelegate {
    private let sourceURL: URL
    private let destination: URL
    private let expectedSize: UInt64
    private let semaphore = DispatchSemaphore(value: 0)
    private var hasher = SHA256()
    private var downloaded: UInt64 = 0
    private var streamError: Error?
    private var task: URLSessionDataTask?
    private var response: HTTPURLResponse?
    private var redirects = 0
    private var fileHandle: FileHandle?
    private var session: URLSession?

    init(sourceURL: URL, expectedSize: UInt64, destination: URL) throws {
      self.sourceURL = sourceURL
      self.expectedSize = expectedSize
      self.destination = destination
      super.init()
      FileManager.default.createFile(atPath: destination.path, contents: nil)
      self.fileHandle = try FileHandle(forWritingTo: destination)
      guard self.fileHandle != nil else {
        throw AuroraIOSVoicePackManagerError.ioFailure
      }
    }

    func download() throws -> String {
      guard expectedSize > 0, expectedSize <= maxPackDownloadBytes else {
        throw AuroraIOSVoicePackManagerError.invalidPack
      }
      defer {
        if let fileHandle {
          fileHandle.synchronizeFile()
          fileHandle.closeFile()
          self.fileHandle = nil
        }
        session?.finishTasksAndInvalidate()
      }
      var request = URLRequest(url: sourceURL)
      request.httpMethod = "GET"
      request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
      request.timeoutInterval = downloadTimeout
      let config = URLSessionConfiguration.ephemeral
      config.timeoutIntervalForRequest = downloadTimeout
      config.timeoutIntervalForResource = downloadTimeout
      session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
      guard let session else { throw AuroraIOSVoicePackManagerError.ioFailure }

      task = session.dataTask(with: request)
      task?.resume()
      semaphore.wait()

      guard streamError == nil else { throw streamError ?? AuroraIOSVoicePackManagerError.downloadFailed }
      guard downloaded == expectedSize else { throw AuroraIOSVoicePackManagerError.downloadFailed }
      guard let response = response, (200..<400).contains(response.statusCode) else {
        throw AuroraIOSVoicePackManagerError.downloadFailed
      }
      return hasher.finalize().compactMap { String(format: "%02x", $0) }.joined()
    }

    func urlSession(
      _ session: URLSession,
      task: URLSessionTask,
      willPerformHTTPRedirection response: HTTPURLResponse,
      newRequest: URLRequest,
      completionHandler: @escaping (URLRequest?) -> Void
    ) {
      guard redirects < maxRedirects,
            let newURL = newRequest.url,
            validateGatewayURL(newURL, allowHttp: false),
            validateDownloadTarget(newURL) else {
        completionHandler(nil)
        streamError = AuroraIOSVoicePackManagerError.invalidUri
        self.task?.cancel()
        semaphore.signal()
        return
      }
      redirects += 1
      completionHandler(newRequest)
    }

    func urlSession(
      _ session: URLSession,
      dataTask: URLSessionDataTask,
      didReceive response: URLResponse,
      completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
      guard let http = response as? HTTPURLResponse else {
        streamError = AuroraIOSVoicePackManagerError.invalidUri
        completionHandler(.cancel)
        return
      }
      responseCode(response: http)
      if http.statusCode >= 400 || downloaded > expectedSize {
        streamError = AuroraIOSVoicePackManagerError.downloadFailed
        completionHandler(.cancel)
        return
      }
      self.response = http
      guard let length = http.value(forHTTPHeaderField: "Content-Length"),
            let remote = UInt64(length),
            remote == expectedSize else {
        streamError = AuroraIOSVoicePackManagerError.invalidPack
        completionHandler(.cancel)
        return
      }
      completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
      guard streamError == nil else { return }
      do {
        try fileHandle?.write(contentsOf: data)
        downloaded += UInt64(data.count)
        hasher.update(data: data)
        if downloaded > expectedSize || downloaded > maxPackDownloadBytes {
          throw AuroraIOSVoicePackManagerError.downloadFailed
        }
      } catch {
        streamError = error
        dataTask.cancel()
      }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
      if let error = error {
        streamError = error
      }
      semaphore.signal()
    }

    private func responseCode(response: HTTPURLResponse) {
      switch response.statusCode {
      case 200...399:
        break
      default:
        streamError = AuroraIOSVoicePackManagerError.downloadFailed
      }
    }
  }
}
