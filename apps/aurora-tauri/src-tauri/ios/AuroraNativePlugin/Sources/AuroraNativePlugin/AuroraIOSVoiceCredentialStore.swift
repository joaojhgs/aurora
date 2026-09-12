import Foundation
import Security

private let auroraIOSVoiceCredentialService = "dev.aurora.ios.voice-credentials"
private let auroraIOSVoiceCredentialAccount = "aurora.voice.gateway.v1"
private let auroraIOSVoiceMaxGatewayBytes = 2048
private let auroraIOSVoiceMaxBearerBytes = 4096

struct AuroraIOSVoiceCredentialSetArgs: Decodable {
  let gateway: String
  let bearer: String?
  let remoteAudioConsent: Bool
}

struct AuroraIOSVoiceStoredConfiguration {
  let gateway: String
  let bearer: String?
  let remoteAudioConsent: Bool
}

private struct AuroraIOSVoiceCredentialRecord: Codable {
  let gateway: String
  let bearer: String?
  let remoteAudioConsent: Bool
  let updatedAtMs: UInt64
}

enum AuroraIOSVoiceCredentialStoreError: Error {
  case invalidGateway
  case invalidBearer
  case corruptRecord
  case keychainFailure
}

/// Native-only storage for the Gateway credential used by the Rust voice session.
/// Raw bearer values never appear in status payloads or logs.
enum AuroraIOSVoiceCredentialStore {
  static func set(_ args: AuroraIOSVoiceCredentialSetArgs) throws -> [String: Any] {
    let gateway = try validateGateway(args.gateway)
    let bearer = try validateBearer(args.bearer)
    let record = AuroraIOSVoiceCredentialRecord(
      gateway: gateway,
      bearer: bearer,
      remoteAudioConsent: args.remoteAudioConsent,
      updatedAtMs: UInt64(max(0, Date().timeIntervalSince1970 * 1_000))
    )
    let encoded: Data
    do {
      encoded = try JSONEncoder().encode(record)
    } catch {
      throw AuroraIOSVoiceCredentialStoreError.corruptRecord
    }
    try keychainWrite(encoded)
    return status(record: record)
  }

  static func status() throws -> [String: Any] {
    guard let record = try loadRecord() else {
      return [
        "configured": false,
        "hasBearer": false,
        "remoteAudioConsent": false,
        "secretsRedacted": true
      ]
    }
    return status(record: record)
  }

  static func delete() throws -> [String: Any] {
    let status = SecItemDelete(keychainQuery() as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw AuroraIOSVoiceCredentialStoreError.keychainFailure
    }
    return [
      "configured": false,
      "hasBearer": false,
      "remoteAudioConsent": false,
      "secretsRedacted": true
    ]
  }

  static func load() throws -> AuroraIOSVoiceStoredConfiguration? {
    guard let record = try loadRecord() else { return nil }
    return AuroraIOSVoiceStoredConfiguration(
      gateway: record.gateway,
      bearer: record.bearer,
      remoteAudioConsent: record.remoteAudioConsent
    )
  }

  private static func status(record: AuroraIOSVoiceCredentialRecord) -> [String: Any] {
    [
      "configured": true,
      "hasBearer": record.bearer != nil,
      "remoteAudioConsent": record.remoteAudioConsent,
      "endpointClass": endpointClass(record.gateway),
      "secretsRedacted": true
    ]
  }

  private static func loadRecord() throws -> AuroraIOSVoiceCredentialRecord? {
    var query = keychainQuery()
    query[kSecReturnData as String] = kCFBooleanTrue
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else {
      throw AuroraIOSVoiceCredentialStoreError.keychainFailure
    }
    let record: AuroraIOSVoiceCredentialRecord
    do {
      record = try JSONDecoder().decode(AuroraIOSVoiceCredentialRecord.self, from: data)
    } catch {
      discardStoredRecord()
      throw AuroraIOSVoiceCredentialStoreError.corruptRecord
    }
    do {
      _ = try validateGateway(record.gateway)
      _ = try validateBearer(record.bearer)
    } catch let error as AuroraIOSVoiceCredentialStoreError {
      discardStoredRecord()
      throw error
    } catch {
      discardStoredRecord()
      throw AuroraIOSVoiceCredentialStoreError.corruptRecord
    }
    return record
  }

  private static func validateGateway(_ value: String) throws -> String {
    guard !value.isEmpty, value.utf8.count <= auroraIOSVoiceMaxGatewayBytes,
          let url = URL(string: value),
          let scheme = url.scheme?.lowercased(),
          (scheme == "https" || scheme == "http"),
          url.host != nil,
          url.user == nil,
          url.password == nil,
          url.fragment == nil else {
      throw AuroraIOSVoiceCredentialStoreError.invalidGateway
    }
    if scheme == "http" && !isLoopbackHost(url.host ?? "") {
      throw AuroraIOSVoiceCredentialStoreError.invalidGateway
    }
    return value
  }

  private static func validateBearer(_ value: String?) throws -> String? {
    guard let value else { return nil }
    guard !value.isEmpty, value.utf8.count <= auroraIOSVoiceMaxBearerBytes,
          !value.contains(where: { $0.isWhitespace }) else {
      throw AuroraIOSVoiceCredentialStoreError.invalidBearer
    }
    return value
  }

  private static func endpointClass(_ value: String) -> String {
    guard let url = URL(string: value) else { return "invalid" }
    return url.scheme?.lowercased() == "http" ? "loopback" : "secure_remote"
  }

  private static func isLoopbackHost(_ host: String) -> Bool {
    let normalized = host.lowercased()
    return normalized == "localhost"
      || normalized == "127.0.0.1"
      || normalized == "::1"
      || normalized.hasPrefix("127.")
  }

  private static func keychainQuery() -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: auroraIOSVoiceCredentialService,
      kSecAttrAccount as String: auroraIOSVoiceCredentialAccount,
      kSecAttrSynchronizable as String: kCFBooleanFalse as Any
    ]
  }

  private static func discardStoredRecord() {
    _ = SecItemDelete(keychainQuery() as CFDictionary)
  }

  private static func keychainWrite(_ value: Data) throws {
    let query = keychainQuery()
    let attributes: [String: Any] = [
      kSecValueData as String: value,
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    ]
    let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if updateStatus == errSecSuccess { return }
    guard updateStatus == errSecItemNotFound else {
      throw AuroraIOSVoiceCredentialStoreError.keychainFailure
    }
    var addQuery = query
    for (key, item) in attributes { addQuery[key] = item }
    guard SecItemAdd(addQuery as CFDictionary, nil) == errSecSuccess else {
      throw AuroraIOSVoiceCredentialStoreError.keychainFailure
    }
  }
}
