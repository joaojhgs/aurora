import CryptoKit
import Foundation
import Security

private let auroraThinPeerKeychainService = "dev.aurora.ios.thin-peer-credentials"
private let auroraInboundVerifierKeychainService = "dev.aurora.ios.inbound-verifier-storage"
private let auroraThinPeerAccountPrefix = "aurora.mesh.peer-proof."
private let auroraThinRoomSecretAccountPrefix = "aurora.mesh.room-secret."
private let auroraInboundVerifierKeyPrefix = "aurora.peer-host.inbound-verifier.v1"
private let auroraInboundVerifierAccountPrefix = "aurora.mesh.inbound-verifier."
private let auroraLocalDataEnvelopeAccountPrefix = "aurora.local-data-envelope."
private let auroraLocalDataEnvelopeCurrentPrefix = "aurora.local-data-envelope-current."
private let auroraLocalDataEnvelopeAlgorithm = "AES-GCM-256"
private let auroraLocalDataEnvelopePurpose = "local-structured-data"
private let auroraThinProfileKey = "aurora.session.ios-thin-connection-profile.v1"
private let auroraReconnectProofDomain = Data("aurora.mesh.reconnect-proof.v1\u{0}".utf8)

enum AuroraThinStorageError: Error {
  case corruptCredential
  case credentialExpired
  case inboundVerifierInvalid
  case inboundVerifierKeychainFailure
  case invalidInput
  case keychainFailure
  case profileTooLarge
  case proofFailure

  var redactedCode: String {
    switch self {
    case .corruptCredential:
      return "thin_peer_credential_corrupt"
    case .credentialExpired:
      return "thin_peer_credential_expired"
    case .inboundVerifierInvalid:
      return "inbound_verifier_invalid"
    case .inboundVerifierKeychainFailure:
      return "inbound_verifier_keychain_failure"
    case .invalidInput:
      return "thin_peer_invalid_input"
    case .keychainFailure:
      return "thin_peer_keychain_failure"
    case .profileTooLarge:
      return "thin_profile_value_too_large"
    case .proofFailure:
      return "thin_peer_proof_failure"
    }
  }

  static func redactedCode(for error: Error, fallback: String) -> String {
    (error as? AuroraThinStorageError)?.redactedCode ?? fallback
  }
}

struct AuroraThinPeerCredentialSetArgs: Decodable {
  let peerId: String
  let tokenId: String
  let claimantPeerId: String
  let verifierPeerId: String
  let claimantSignalingPeerId: String
  let verifierSignalingPeerId: String
  let roomName: String
  let rawBearerToken: String
  let createdAtMs: UInt64?
  let expiresAtMs: UInt64?
}

struct AuroraThinPeerCredentialLookupArgs: Decodable {
  let peerId: String
}

struct AuroraThinPeerReconnectProveArgs: Decodable {
  let peerId: String
  let challenge: AuroraMeshReconnectChallenge
}

struct AuroraMeshReconnectChallenge: Decodable {
  let type: String
  let challenge: String
  let channelBinding: String
  let claimantPeerId: String
  let verifierPeerId: String
  let claimantSignalingPeerId: String
  let verifierSignalingPeerId: String
  let roomName: String

  enum CodingKeys: String, CodingKey {
    case type
    case challenge
    case channelBinding = "channel_binding"
    case claimantPeerId = "claimant_peer_id"
    case verifierPeerId = "verifier_peer_id"
    case claimantSignalingPeerId = "claimant_signaling_peer_id"
    case verifierSignalingPeerId = "verifier_signaling_peer_id"
    case roomName = "room_name"
  }
}

struct AuroraThinProfileSetArgs: Decodable {
  let value: String
}

struct AuroraThinRoomSecretSetArgs: Decodable {
  let ref: String
  let value: String
}

struct AuroraThinRoomSecretGetArgs: Decodable {
  let ref: String
}

struct AuroraInboundVerifierGetArgs: Decodable {
  let request: AuroraInboundVerifierGetRequest
}

struct AuroraInboundVerifierSetArgs: Decodable {
  let request: AuroraInboundVerifierSetRequest
}

struct AuroraInboundVerifierDeleteArgs: Decodable {
  let request: AuroraInboundVerifierDeleteRequest
}

struct AuroraInboundVerifierGetRequest: Decodable {
  let key: String
}

struct AuroraInboundVerifierSetRequest: Decodable {
  let key: String
  let value: String
}

struct AuroraInboundVerifierDeleteRequest: Decodable {
  let key: String
}

struct AuroraLocalDataEnvelopeEncryptArgs: Decodable {
  let keyPurpose: String
  let profileId: String
  let localNodeId: String
  let plaintextB64Url: String
  let aadB64Url: String
}

struct AuroraLocalDataEnvelopeDecryptArgs: Decodable {
  let profileId: String
  let localNodeId: String
  let envelope: AuroraLocalDataEnvelopeV1
  let aadB64Url: String
}

struct AuroraLocalDataEnvelopeRotateArgs: Decodable {
  let keyPurpose: String
  let profileId: String
  let localNodeId: String
}

struct AuroraLocalDataEnvelopeV1: Codable {
  let version: UInt32
  let algorithm: String
  let keyId: String
  let nonceB64Url: String
  let ciphertextAndTagB64Url: String
  let createdAtMs: UInt64
}

private struct AuroraThinPeerCredentialRecord: Codable {
  let tokenId: String
  let claimantPeerId: String
  let verifierPeerId: String
  let claimantSignalingPeerId: String
  let verifierSignalingPeerId: String
  let roomName: String
  let rawBearerToken: String
  let createdAtMs: UInt64?
  let expiresAtMs: UInt64?
}

private struct AuroraInboundVerifierSelector {
  let tokenId: String
  let claimantPeerId: String
  let verifierPeerId: String
  let roomName: String
}

private struct AuroraInboundVerifierRecord: Decodable {
  let version: UInt8
  let tokenId: String
  let claimantPeerId: String
  let verifierPeerId: String
  let roomName: String
  let tokenHashHex: String
  let createdAtMs: UInt64
  let expiresAtMs: UInt64?
  let revokedAtMs: UInt64?
  let credentialRevision: UInt64
}

enum AuroraThinPeerStorage {
  static func localDataEnvelopeEncrypt(_ args: AuroraLocalDataEnvelopeEncryptArgs) throws -> [String: Any] {
    try validateLocalDataEnvelopeScope(args.keyPurpose, args.profileId, args.localNodeId)
    let keyVersion = try currentLocalDataEnvelopeKeyVersion(profileId: args.profileId, localNodeId: args.localNodeId, purpose: args.keyPurpose)
    let keyId = localDataEnvelopeKeyId(profileId: args.profileId, localNodeId: args.localNodeId, purpose: args.keyPurpose, version: keyVersion)
    let plaintext = try base64UrlDecode(args.plaintextB64Url)
    let aad = try base64UrlDecode(args.aadB64Url)
    let key = try localDataEnvelopeKey(keyId: keyId)
    let sealed = try AES.GCM.seal(plaintext, using: key, authenticating: aad)
    return [
      "version": 1,
      "algorithm": auroraLocalDataEnvelopeAlgorithm,
      "keyId": keyId,
      "nonceB64Url": base64UrlEncode(Data(sealed.nonce)),
      "ciphertextAndTagB64Url": base64UrlEncode(sealed.ciphertext + sealed.tag),
      "createdAtMs": currentUnixMs()
    ]
  }

  static func localDataEnvelopeDecrypt(_ args: AuroraLocalDataEnvelopeDecryptArgs) throws -> [String: Any] {
    try validateLocalDataEnvelope(args.envelope)
    try validateLocalDataEnvelopeBinding(profileId: args.profileId, localNodeId: args.localNodeId, keyId: args.envelope.keyId)
    let nonce = try AES.GCM.Nonce(data: base64UrlDecode(args.envelope.nonceB64Url))
    let ciphertextAndTag = try base64UrlDecode(args.envelope.ciphertextAndTagB64Url)
    guard ciphertextAndTag.count >= 16 else { throw AuroraThinStorageError.invalidInput }
    let ciphertext = ciphertextAndTag.prefix(ciphertextAndTag.count - 16)
    let tag = ciphertextAndTag.suffix(16)
    let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)
    let plaintext = try AES.GCM.open(box, using: try localDataEnvelopeKey(keyId: args.envelope.keyId), authenticating: try base64UrlDecode(args.aadB64Url))
    return [
      "plaintextB64Url": base64UrlEncode(plaintext),
      "secretsRedacted": true
    ]
  }

  static func localDataEnvelopeRotate(_ args: AuroraLocalDataEnvelopeRotateArgs) throws -> [String: Any] {
    try validateLocalDataEnvelopeScope(args.keyPurpose, args.profileId, args.localNodeId)
    let previousVersion = try currentLocalDataEnvelopeKeyVersion(profileId: args.profileId, localNodeId: args.localNodeId, purpose: args.keyPurpose)
    let previousKeyId = localDataEnvelopeKeyId(profileId: args.profileId, localNodeId: args.localNodeId, purpose: args.keyPurpose, version: previousVersion)
    let newVersion = previousVersion + 1
    let newKeyId = localDataEnvelopeKeyId(profileId: args.profileId, localNodeId: args.localNodeId, purpose: args.keyPurpose, version: newVersion)
    _ = try localDataEnvelopeKey(keyId: newKeyId)
    try keychainWrite(account: localDataEnvelopeCurrentAccount(profileId: args.profileId, localNodeId: args.localNodeId, purpose: args.keyPurpose), value: Data(String(newVersion).utf8))
    return [
      "previousKeyId": previousKeyId,
      "newKeyId": newKeyId,
      "secretsRedacted": true
    ]
  }

  static func setCredential(_ args: AuroraThinPeerCredentialSetArgs) throws -> [String: Any] {
    try validatePeerId(args.peerId)
    try validateNonEmpty(args.tokenId, maxBytes: 128)
    try validateNonEmpty(args.claimantPeerId, maxBytes: 256)
    try validateNonEmpty(args.verifierPeerId, maxBytes: 256)
    try validateNonEmpty(args.claimantSignalingPeerId, maxBytes: 256)
    try validateNonEmpty(args.verifierSignalingPeerId, maxBytes: 256)
    try validateNonEmpty(args.roomName, maxBytes: 512)
    try validateNonEmpty(args.rawBearerToken, maxBytes: 4096)

    if let expiresAtMs = args.expiresAtMs, expiresAtMs <= currentUnixMs() {
      try? deleteCredential(peerId: args.peerId)
      throw AuroraThinStorageError.credentialExpired
    }

    let record = AuroraThinPeerCredentialRecord(
      tokenId: args.tokenId,
      claimantPeerId: args.claimantPeerId,
      verifierPeerId: args.verifierPeerId,
      claimantSignalingPeerId: args.claimantSignalingPeerId,
      verifierSignalingPeerId: args.verifierSignalingPeerId,
      roomName: args.roomName,
      rawBearerToken: args.rawBearerToken,
      createdAtMs: args.createdAtMs ?? currentUnixMs(),
      expiresAtMs: args.expiresAtMs
    )
    let encoded: Data
    do {
      encoded = try JSONEncoder().encode(record)
    } catch {
      throw AuroraThinStorageError.corruptCredential
    }
    try keychainWrite(account: try credentialAccount(peerId: args.peerId), value: encoded)
    return credentialStatus(peerId: args.peerId, record: record)
  }

  static func credentialStatus(peerId: String) throws -> [String: Any] {
    try validatePeerId(peerId)
    return credentialStatus(peerId: peerId, record: try loadUnexpiredCredential(peerId: peerId))
  }

  static func deleteCredential(peerId: String) throws -> [String: Any] {
    try validatePeerId(peerId)
    try keychainDelete(account: try credentialAccount(peerId: peerId))
    return credentialStatus(peerId: peerId, record: nil)
  }

  static func reconnectProof(
    peerId: String,
    challenge: AuroraMeshReconnectChallenge
  ) throws -> [String: Any] {
    try validatePeerId(peerId)
    try validateChallenge(challenge)
    guard let record = try loadUnexpiredCredential(peerId: peerId) else {
      return proofStatus(peerId: peerId, record: nil, matched: false, proof: nil)
    }
    guard reconnectChallengeMatches(record: record, challenge: challenge) else {
      return proofStatus(peerId: peerId, record: record, matched: false, proof: nil)
    }

    let proof: [String: Any] = [
      "type": "mesh_auth_proof_v1",
      "token_id": record.tokenId,
      "challenge": challenge.challenge,
      "proof": try computeReconnectProofHex(record: record, challenge: challenge),
      "channel_binding": challenge.channelBinding,
      "claimant_peer_id": record.claimantPeerId,
      "verifier_peer_id": record.verifierPeerId,
      "claimant_signaling_peer_id": challenge.claimantSignalingPeerId,
      "verifier_signaling_peer_id": challenge.verifierSignalingPeerId,
      "room_name": record.roomName
    ]
    return proofStatus(peerId: peerId, record: record, matched: true, proof: proof)
  }

  static func thinProfileGet() -> [String: Any] {
    let value: Any
    if let storedValue = UserDefaults.standard.string(forKey: auroraThinProfileKey) {
      value = storedValue
    } else {
      value = NSNull()
    }
    return [
      "key": auroraThinProfileKey,
      "value": value,
      "platform": "ios",
      "backend": "ios-user-defaults",
      "persisted": true,
      "privacyClass": "nonsecret-connection-profile",
      "secretsRedacted": true
    ]
  }

  static func thinProfileSet(value: String) throws -> [String: Any] {
    guard value.utf8.count <= 65_536 else {
      throw AuroraThinStorageError.profileTooLarge
    }
    UserDefaults.standard.set(value, forKey: auroraThinProfileKey)
    return [
      "key": auroraThinProfileKey,
      "ok": true,
      "platform": "ios",
      "backend": "ios-user-defaults",
      "persisted": true,
      "privacyClass": "nonsecret-connection-profile",
      "secretsRedacted": true
    ]
  }

  static func thinRoomSecretSet(_ args: AuroraThinRoomSecretSetArgs) throws -> [String: Any] {
    try validateNonEmpty(args.ref, maxBytes: 1024)
    try validateNonEmpty(args.value, maxBytes: 8192)
    try keychainWrite(account: try roomSecretAccount(ref: args.ref), value: Data(args.value.utf8))
    return [
      "ref": args.ref,
      "ok": true,
      "backend": "ios-keychain",
      "persisted": true,
      "privacyClass": "secret",
      "rawGetter": true,
      "allowedGenericSecureStorage": false
    ]
  }

  static func thinRoomSecretGet(_ args: AuroraThinRoomSecretGetArgs) throws -> [String: Any] {
    try validateNonEmpty(args.ref, maxBytes: 1024)
    let value: Any
    if let stored = try keychainRead(account: try roomSecretAccount(ref: args.ref)),
       let decoded = String(data: stored, encoding: .utf8) {
      value = decoded
    } else {
      value = NSNull()
    }
    return [
      "ref": args.ref,
      "value": value,
      "backend": "ios-keychain",
      "persisted": true,
      "privacyClass": "secret",
      "rawGetter": true,
      "allowedGenericSecureStorage": false
    ]
  }

  static func inboundVerifierGet(_ args: AuroraInboundVerifierGetRequest) throws -> [String: Any] {
    let selector = try parseInboundVerifierSecretKey(args.key)
    let account = inboundVerifierAccountFromValidKey(args.key)
    let value: Any
    if let stored = try keychainRead(
      service: auroraInboundVerifierKeychainService,
      account: account
    ) {
      guard let decoded = String(data: stored, encoding: .utf8) else {
        throw AuroraThinStorageError.inboundVerifierKeychainFailure
      }
      try validateInboundVerifierSecretValue(decoded, selector: selector)
      value = decoded
    } else {
      value = NSNull()
    }
    return inboundVerifierGetResponse(value: value)
  }

  static func inboundVerifierSet(_ args: AuroraInboundVerifierSetRequest) throws -> [String: Any] {
    let selector = try parseInboundVerifierSecretKey(args.key)
    try validateInboundVerifierSecretValue(args.value, selector: selector)
    try keychainWrite(
      service: auroraInboundVerifierKeychainService,
      account: inboundVerifierAccountFromValidKey(args.key),
      value: Data(args.value.utf8)
    )
    return inboundVerifierWriteResponse()
  }

  static func inboundVerifierDelete(_ args: AuroraInboundVerifierDeleteRequest) throws -> [String: Any] {
    try keychainDelete(
      service: auroraInboundVerifierKeychainService,
      account: try inboundVerifierAccount(key: args.key)
    )
    return inboundVerifierWriteResponse()
  }

  private static func loadUnexpiredCredential(
    peerId: String
  ) throws -> AuroraThinPeerCredentialRecord? {
    guard let encoded = try keychainRead(account: try credentialAccount(peerId: peerId)) else {
      return nil
    }
    let record: AuroraThinPeerCredentialRecord
    do {
      record = try JSONDecoder().decode(AuroraThinPeerCredentialRecord.self, from: encoded)
    } catch {
      throw AuroraThinStorageError.corruptCredential
    }
    if let expiresAtMs = record.expiresAtMs, expiresAtMs <= currentUnixMs() {
      try keychainDelete(account: try credentialAccount(peerId: peerId))
      return nil
    }
    return record
  }

  private static func credentialStatus(
    peerId: String,
    record: AuroraThinPeerCredentialRecord?
  ) -> [String: Any] {
    let credential: Any = record
      .map { credentialMetadata(peerId: peerId, record: $0) as Any }
      ?? NSNull()
    return [
      "peerId": peerId,
      "found": record != nil,
      "hasBearerToken": record?.rawBearerToken.isEmpty == false,
      "credential": credential,
      "backend": "ios-keychain",
      "persisted": true,
      "privacyClass": "opaque-peer-reconnect-proof",
      "rawGetter": false,
      "allowedGenericSecureStorage": false,
      "secretsRedacted": true,
      "redactedFields": ["rawBearerToken"]
    ]
  }

  private static func proofStatus(
    peerId: String,
    record: AuroraThinPeerCredentialRecord?,
    matched: Bool,
    proof: [String: Any]?
  ) -> [String: Any] {
    let credential: Any = record
      .map { credentialMetadata(peerId: peerId, record: $0) as Any }
      ?? NSNull()
    let proofPayload: Any = proof.map { $0 as Any } ?? NSNull()
    return [
      "peerId": peerId,
      "found": record != nil,
      "matched": matched,
      "proof": proofPayload,
      "credential": credential,
      "backend": "ios-keychain",
      "privacyClass": "opaque-peer-reconnect-proof",
      "rawGetter": false,
      "allowedGenericSecureStorage": false,
      "secretsRedacted": true,
      "redactedFields": ["rawBearerToken"]
    ]
  }

  private static func credentialMetadata(
    peerId: String,
    record: AuroraThinPeerCredentialRecord
  ) -> [String: Any] {
    var output: [String: Any] = [
      "peerId": peerId,
      "tokenId": record.tokenId,
      "claimantPeerId": record.claimantPeerId,
      "verifierPeerId": record.verifierPeerId,
      "claimantSignalingPeerId": record.claimantSignalingPeerId,
      "verifierSignalingPeerId": record.verifierSignalingPeerId,
      "roomName": record.roomName
    ]
    if let createdAtMs = record.createdAtMs {
      output["createdAtMs"] = createdAtMs
    }
    if let expiresAtMs = record.expiresAtMs {
      output["expiresAtMs"] = expiresAtMs
    }
    return output
  }

  private static func reconnectChallengeMatches(
    record: AuroraThinPeerCredentialRecord,
    challenge: AuroraMeshReconnectChallenge
  ) -> Bool {
    challenge.claimantPeerId == record.claimantPeerId
      && challenge.verifierPeerId == record.verifierPeerId
      && challenge.roomName == record.roomName
  }

  private static func computeReconnectProofHex(
    record: AuroraThinPeerCredentialRecord,
    challenge: AuroraMeshReconnectChallenge
  ) throws -> String {
    let keyDigest = SHA256.hash(data: Data(record.rawBearerToken.utf8))
    let key = SymmetricKey(data: Data(keyDigest))
    let authenticationCode = HMAC<SHA256>.authenticationCode(
      for: try reconnectProofMessage(record: record, challenge: challenge),
      using: key
    )
    return Data(authenticationCode).lowercaseHex
  }

  private static func reconnectProofMessage(
    record: AuroraThinPeerCredentialRecord,
    challenge: AuroraMeshReconnectChallenge
  ) throws -> Data {
    let transcript: [String: Any] = [
      "challenge": challenge.challenge,
      "channel_binding": challenge.channelBinding,
      "claimant_peer_id": challenge.claimantPeerId,
      "room_name": challenge.roomName,
      "token_id": record.tokenId,
      "verifier_peer_id": challenge.verifierPeerId,
      "version": 1
    ]
    guard JSONSerialization.isValidJSONObject(transcript) else {
      throw AuroraThinStorageError.proofFailure
    }
    do {
      let json = try JSONSerialization.data(
        withJSONObject: transcript,
        options: [.sortedKeys, .withoutEscapingSlashes]
      )
      guard let serialized = String(data: json, encoding: .utf8) else {
        throw AuroraThinStorageError.proofFailure
      }
      return auroraReconnectProofDomain + Data(ensureAscii(serialized).utf8)
    } catch {
      throw AuroraThinStorageError.proofFailure
    }
  }

  private static func ensureAscii(_ value: String) -> String {
    var output = ""
    output.reserveCapacity(value.utf8.count)
    for codeUnit in value.utf16 {
      if codeUnit >= 0x7f {
        output += String(format: "\\u%04x", codeUnit)
      } else if let scalar = UnicodeScalar(codeUnit) {
        output.unicodeScalars.append(scalar)
      }
    }
    return output
  }

  private static func validateChallenge(_ challenge: AuroraMeshReconnectChallenge) throws {
    guard challenge.type == "mesh_auth_challenge_v1" else {
      throw AuroraThinStorageError.invalidInput
    }
    try validateHex64(challenge.challenge)
    try validateHex64(challenge.channelBinding)
    try validateNonEmpty(challenge.claimantPeerId, maxBytes: 256)
    try validateNonEmpty(challenge.verifierPeerId, maxBytes: 256)
    try validateNonEmpty(challenge.claimantSignalingPeerId, maxBytes: 256)
    try validateNonEmpty(challenge.verifierSignalingPeerId, maxBytes: 256)
    try validateNonEmpty(challenge.roomName, maxBytes: 512)
  }

  private static func validatePeerId(_ peerId: String) throws {
    try validateNonEmpty(peerId, maxBytes: 256)
  }

  private static func validateNonEmpty(_ value: String, maxBytes: Int) throws {
    guard !value.isEmpty, value.utf8.count <= maxBytes else {
      throw AuroraThinStorageError.invalidInput
    }
  }

  private static func validateHex64(_ value: String) throws {
    guard value.utf8.count == 64,
          value.utf8.allSatisfy({
            ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 70) || ($0 >= 97 && $0 <= 102)
          })
    else {
      throw AuroraThinStorageError.invalidInput
    }
  }

  private static func validateLowerHex64(_ value: String) throws {
    guard value.utf8.count == 64,
          value.utf8.allSatisfy({ ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102) })
    else {
      throw AuroraThinStorageError.inboundVerifierInvalid
    }
  }

  private static func validateSafeEpoch(_ value: UInt64) throws {
    guard value <= 9_007_199_254_740_991 else {
      throw AuroraThinStorageError.inboundVerifierInvalid
    }
  }

  private static func validateInboundVerifierId(_ value: String, maxBytes: Int) throws {
    guard !value.isEmpty,
          value.utf8.count <= maxBytes,
          value.utf8.allSatisfy({
            ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) ||
              $0 == 95 || $0 == 46 || $0 == 58 || $0 == 64 || $0 == 47 || $0 == 45
          })
    else {
      throw AuroraThinStorageError.inboundVerifierInvalid
    }
  }

  private static func validateNonEmptyInboundVerifierField(_ value: String, maxBytes: Int) throws {
    guard !value.isEmpty, value.utf8.count <= maxBytes else {
      throw AuroraThinStorageError.inboundVerifierInvalid
    }
  }

  private static func parseInboundVerifierSecretKey(_ key: String) throws -> AuroraInboundVerifierSelector {
    guard !key.isEmpty, key.utf8.count <= 4096 else {
      throw AuroraThinStorageError.inboundVerifierInvalid
    }
    let prefix = "\(auroraInboundVerifierKeyPrefix):"
    guard key.hasPrefix(prefix) else {
      throw AuroraThinStorageError.inboundVerifierInvalid
    }
    let rawParts = String(key.dropFirst(prefix.count)).split(separator: ":", omittingEmptySubsequences: false)
    guard rawParts.count == 4, rawParts.allSatisfy({ !$0.isEmpty }) else {
      throw AuroraThinStorageError.inboundVerifierInvalid
    }
    let verifierPeerId = try decodeSdkKeyPart(String(rawParts[0]))
    let claimantPeerId = try decodeSdkKeyPart(String(rawParts[1]))
    let roomName = try decodeSdkKeyPart(String(rawParts[2]))
    let tokenId = try decodeSdkKeyPart(String(rawParts[3]))
    guard encodeSdkKeyPart(verifierPeerId) == rawParts[0],
          encodeSdkKeyPart(claimantPeerId) == rawParts[1],
          encodeSdkKeyPart(roomName) == rawParts[2],
          encodeSdkKeyPart(tokenId) == rawParts[3]
    else {
      throw AuroraThinStorageError.inboundVerifierInvalid
    }
    try validateInboundVerifierId(verifierPeerId, maxBytes: 256)
    try validateInboundVerifierId(claimantPeerId, maxBytes: 256)
    try validateNonEmptyInboundVerifierField(roomName, maxBytes: 512)
    try validateInboundVerifierId(tokenId, maxBytes: 256)
    return AuroraInboundVerifierSelector(
      tokenId: tokenId,
      claimantPeerId: claimantPeerId,
      verifierPeerId: verifierPeerId,
      roomName: roomName
    )
  }

  private static func validateInboundVerifierSecretValue(
    _ value: String,
    selector: AuroraInboundVerifierSelector
  ) throws {
    let record = try parseInboundVerifierSecretValue(value)
    guard record.tokenId == selector.tokenId,
          record.claimantPeerId == selector.claimantPeerId,
          record.verifierPeerId == selector.verifierPeerId,
          record.roomName == selector.roomName
    else {
      throw AuroraThinStorageError.inboundVerifierInvalid
    }
    guard canonicalInboundVerifierSecretValue(record) == value else {
      throw AuroraThinStorageError.inboundVerifierInvalid
    }
  }

  private static func parseInboundVerifierSecretValue(_ value: String) throws -> AuroraInboundVerifierRecord {
    guard !value.isEmpty, value.utf8.count <= 8192 else {
      throw AuroraThinStorageError.inboundVerifierInvalid
    }
    let data = Data(value.utf8)
    let rawJson: Any
    do {
      rawJson = try JSONSerialization.jsonObject(with: data, options: [])
    } catch {
      throw AuroraThinStorageError.inboundVerifierInvalid
    }
    guard let object = rawJson as? [String: Any] else {
      throw AuroraThinStorageError.inboundVerifierInvalid
    }
    let allowedFields: Set<String> = [
      "version",
      "tokenId",
      "claimantPeerId",
      "verifierPeerId",
      "roomName",
      "tokenHashHex",
      "createdAtMs",
      "expiresAtMs",
      "revokedAtMs",
      "credentialRevision"
    ]
    guard object.keys.allSatisfy({ allowedFields.contains($0) && !isForbiddenInboundVerifierField($0) }) else {
      throw AuroraThinStorageError.inboundVerifierInvalid
    }
    let record: AuroraInboundVerifierRecord
    do {
      record = try JSONDecoder().decode(AuroraInboundVerifierRecord.self, from: data)
    } catch {
      throw AuroraThinStorageError.inboundVerifierInvalid
    }
    guard record.version == 1 else {
      throw AuroraThinStorageError.inboundVerifierInvalid
    }
    try validateInboundVerifierId(record.tokenId, maxBytes: 256)
    try validateInboundVerifierId(record.claimantPeerId, maxBytes: 256)
    try validateInboundVerifierId(record.verifierPeerId, maxBytes: 256)
    try validateNonEmptyInboundVerifierField(record.roomName, maxBytes: 512)
    try validateLowerHex64(record.tokenHashHex)
    try validateSafeEpoch(record.createdAtMs)
    try validateSafeEpoch(record.credentialRevision)
    if let expiresAtMs = record.expiresAtMs {
      try validateSafeEpoch(expiresAtMs)
    }
    if let revokedAtMs = record.revokedAtMs {
      try validateSafeEpoch(revokedAtMs)
    }
    return record
  }

  private static func canonicalInboundVerifierSecretValue(_ record: AuroraInboundVerifierRecord) -> String {
    var fields = [
      "\"version\":\(record.version)",
      "\"tokenId\":\(canonicalJsonQuote(record.tokenId))",
      "\"claimantPeerId\":\(canonicalJsonQuote(record.claimantPeerId))",
      "\"verifierPeerId\":\(canonicalJsonQuote(record.verifierPeerId))",
      "\"roomName\":\(canonicalJsonQuote(record.roomName))",
      "\"tokenHashHex\":\(canonicalJsonQuote(record.tokenHashHex))",
      "\"createdAtMs\":\(record.createdAtMs)"
    ]
    if let expiresAtMs = record.expiresAtMs {
      fields.append("\"expiresAtMs\":\(expiresAtMs)")
    }
    if let revokedAtMs = record.revokedAtMs {
      fields.append("\"revokedAtMs\":\(revokedAtMs)")
    }
    fields.append("\"credentialRevision\":\(record.credentialRevision)")
    return "{\(fields.joined(separator: ","))}"
  }

  private static func isForbiddenInboundVerifierField(_ field: String) -> Bool {
    let normalized = field
      .filter { ($0.isASCII && $0.isLetter) || $0.isNumber }
      .lowercased()
    return [
      "bearer",
      "rawbearertoken",
      "rawtoken",
      "proof",
      "proofhex",
      "verifierkey",
      "password",
      "secret",
      "authorization"
    ].contains(normalized)
  }

  private static func decodeSdkKeyPart(_ value: String) throws -> String {
    let bytes = Array(value.utf8)
    var output = [UInt8]()
    output.reserveCapacity(bytes.count)
    var index = 0
    while index < bytes.count {
      if bytes[index] == 37 {
        guard index + 2 < bytes.count,
              let high = hexValue(bytes[index + 1]),
              let low = hexValue(bytes[index + 2])
        else {
          throw AuroraThinStorageError.inboundVerifierInvalid
        }
        output.append((high << 4) | low)
        index += 3
      } else {
        output.append(bytes[index])
        index += 1
      }
    }
    guard let decoded = String(bytes: output, encoding: .utf8) else {
      throw AuroraThinStorageError.inboundVerifierInvalid
    }
    return decoded
  }

  private static func encodeSdkKeyPart(_ value: String) -> String {
    var output = ""
    for byte in value.utf8 {
      if (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) ||
        byte == 45 || byte == 95 || byte == 33 || byte == 126 || byte == 42 || byte == 39 ||
        byte == 40 || byte == 41 {
        output.append(Character(UnicodeScalar(Int(byte))!))
      } else {
        output += String(format: "%%%02X", byte)
      }
    }
    return output
  }

  private static func hexValue(_ byte: UInt8) -> UInt8? {
    switch byte {
    case 48...57:
      return byte - 48
    case 65...70:
      return byte - 65 + 10
    case 97...102:
      return byte - 97 + 10
    default:
      return nil
    }
  }

  private static func inboundVerifierAccount(key: String) throws -> String {
    _ = try parseInboundVerifierSecretKey(key)
    return inboundVerifierAccountFromValidKey(key)
  }

  private static func inboundVerifierAccountFromValidKey(_ key: String) -> String {
    auroraInboundVerifierAccountPrefix + Data(SHA256.hash(data: Data(key.utf8))).lowercaseHex
  }

  private static func inboundVerifierGetResponse(value: Any) -> [String: Any] {
    [
      "found": !(value is NSNull),
      "value": value,
      "backend": "ios-keychain",
      "persisted": true,
      "secretsRedacted": true,
      "redactedFields": inboundVerifierRedactedFields()
    ]
  }

  private static func inboundVerifierWriteResponse() -> [String: Any] {
    [
      "ok": true,
      "backend": "ios-keychain",
      "persisted": true,
      "secretsRedacted": true,
      "redactedFields": inboundVerifierRedactedFields()
    ]
  }

  private static func inboundVerifierRedactedFields() -> [String] {
    ["tokenHashHex", "rawBearerToken", "proof", "verifierKey"]
  }

  private static func canonicalJsonQuote(_ value: String) -> String {
    var output = "\""
    for scalar in value.unicodeScalars {
      switch scalar.value {
      case 0x22:
        output += "\\\""
      case 0x5c:
        output += "\\\\"
      case 0x08:
        output += "\\b"
      case 0x0c:
        output += "\\f"
      case 0x0a:
        output += "\\n"
      case 0x0d:
        output += "\\r"
      case 0x09:
        output += "\\t"
      case 0x00...0x1f:
        output += String(format: "\\u%04x", scalar.value)
      default:
        output.unicodeScalars.append(scalar)
      }
    }
    output += "\""
    return output
  }

  private static func validateLocalDataEnvelopeScope(_ purpose: String, _ profileId: String, _ localNodeId: String) throws {
    guard purpose == auroraLocalDataEnvelopePurpose else { throw AuroraThinStorageError.invalidInput }
    try validateLocalDataId(profileId)
    try validateLocalDataId(localNodeId)
  }

  private static func validateLocalDataId(_ value: String) throws {
    guard !value.isEmpty,
          value.utf8.count <= 256,
          value.utf8.allSatisfy({
            ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) ||
              $0 == 95 || $0 == 46 || $0 == 58 || $0 == 64 || $0 == 47 || $0 == 45
          })
    else {
      throw AuroraThinStorageError.invalidInput
    }
  }

  private static func validateLocalDataEnvelope(_ envelope: AuroraLocalDataEnvelopeV1) throws {
    guard envelope.version == 1, envelope.algorithm == auroraLocalDataEnvelopeAlgorithm else {
      throw AuroraThinStorageError.invalidInput
    }
    guard try base64UrlDecode(envelope.nonceB64Url).count == 12 else {
      throw AuroraThinStorageError.invalidInput
    }
    guard try base64UrlDecode(envelope.ciphertextAndTagB64Url).count >= 16 else {
      throw AuroraThinStorageError.invalidInput
    }
    try validateLocalDataEnvelopeKeyId(envelope.keyId)
  }

  private static func validateLocalDataEnvelopeBinding(profileId: String, localNodeId: String, keyId: String) throws {
    try validateLocalDataId(profileId)
    try validateLocalDataId(localNodeId)
    let expected = "aurora.local-data-envelope.v1.\(Data(SHA256.hash(data: Data(profileId.utf8))).lowercaseHex).\(Data(SHA256.hash(data: Data(localNodeId.utf8))).lowercaseHex).\(auroraLocalDataEnvelopePurpose).k"
    guard keyId.hasPrefix(expected) else { throw AuroraThinStorageError.invalidInput }
    try validateLocalDataEnvelopeKeyId(keyId)
  }

  private static func validateLocalDataEnvelopeKeyId(_ keyId: String) throws {
    let pattern = #"^aurora\.local-data-envelope\.v1\.[0-9a-f]{64}\.[0-9a-f]{64}\.local-structured-data\.k[1-9][0-9]*$"#
    guard keyId.range(of: pattern, options: .regularExpression) != nil else {
      throw AuroraThinStorageError.invalidInput
    }
  }

  private static func localDataEnvelopeKeyId(profileId: String, localNodeId: String, purpose: String, version: UInt32) -> String {
    "aurora.local-data-envelope.v1.\(Data(SHA256.hash(data: Data(profileId.utf8))).lowercaseHex).\(Data(SHA256.hash(data: Data(localNodeId.utf8))).lowercaseHex).\(purpose).k\(version)"
  }

  private static func localDataEnvelopeCurrentAccount(profileId: String, localNodeId: String, purpose: String) -> String {
    auroraLocalDataEnvelopeCurrentPrefix + Data(SHA256.hash(data: Data("\(profileId)\u{0}\(localNodeId)\u{0}\(purpose)".utf8))).lowercaseHex
  }

  private static func localDataEnvelopeAccount(keyId: String) throws -> String {
    try validateLocalDataEnvelopeKeyId(keyId)
    return auroraLocalDataEnvelopeAccountPrefix + Data(SHA256.hash(data: Data(keyId.utf8))).lowercaseHex
  }

  private static func currentLocalDataEnvelopeKeyVersion(profileId: String, localNodeId: String, purpose: String) throws -> UInt32 {
    guard let stored = try keychainRead(account: localDataEnvelopeCurrentAccount(profileId: profileId, localNodeId: localNodeId, purpose: purpose)) else {
      return 1
    }
    guard let text = String(data: stored, encoding: .utf8), let version = UInt32(text), version > 0 else {
      throw AuroraThinStorageError.keychainFailure
    }
    return version
  }

  private static func localDataEnvelopeKey(keyId: String) throws -> SymmetricKey {
    let account = try localDataEnvelopeAccount(keyId: keyId)
    if let stored = try keychainRead(account: account) {
      guard stored.count == 32 else { throw AuroraThinStorageError.keychainFailure }
      return SymmetricKey(data: stored)
    }
    var key = Data(count: 32)
    let status = key.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
    guard status == errSecSuccess else { throw AuroraThinStorageError.keychainFailure }
    try keychainWrite(account: account, value: key)
    return SymmetricKey(data: key)
  }

  private static func base64UrlEncode(_ value: Data) -> String {
    value.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  private static func base64UrlDecode(_ value: String) throws -> Data {
    guard !value.isEmpty, !value.contains("=") else { throw AuroraThinStorageError.invalidInput }
    let padded = value
      .replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
      .padding(toLength: value.count + ((4 - (value.count % 4)) % 4), withPad: "=", startingAt: 0)
    guard let data = Data(base64Encoded: padded), base64UrlEncode(data) == value else {
      throw AuroraThinStorageError.invalidInput
    }
    return data
  }

  private static func credentialAccount(peerId: String) throws -> String {
    try validatePeerId(peerId)
    return auroraThinPeerAccountPrefix + Data(SHA256.hash(data: Data(peerId.utf8))).lowercaseHex
  }

  private static func roomSecretAccount(ref: String) throws -> String {
    try validateNonEmpty(ref, maxBytes: 1024)
    return auroraThinRoomSecretAccountPrefix + Data(SHA256.hash(data: Data(ref.utf8))).lowercaseHex
  }

  private static func keychainQuery(
    service: String = auroraThinPeerKeychainService,
    account: String
  ) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecAttrSynchronizable as String: kCFBooleanFalse as Any
    ]
  }

  private static func keychainWrite(
    service: String = auroraThinPeerKeychainService,
    account: String,
    value: Data
  ) throws {
    let query = keychainQuery(service: service, account: account)
    let attributes: [String: Any] = [
      kSecValueData as String: value,
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    ]
    let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if updateStatus == errSecSuccess {
      return
    }
    guard updateStatus == errSecItemNotFound else {
      throw keychainError(service: service)
    }
    var addQuery = query
    for (key, item) in attributes {
      addQuery[key] = item
    }
    guard SecItemAdd(addQuery as CFDictionary, nil) == errSecSuccess else {
      throw keychainError(service: service)
    }
  }

  private static func keychainRead(
    service: String = auroraThinPeerKeychainService,
    account: String
  ) throws -> Data? {
    var query = keychainQuery(service: service, account: account)
    query[kSecReturnData as String] = kCFBooleanTrue
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound {
      return nil
    }
    guard status == errSecSuccess, let data = result as? Data else {
      throw keychainError(service: service)
    }
    return data
  }

  private static func keychainDelete(
    service: String = auroraThinPeerKeychainService,
    account: String
  ) throws {
    let status = SecItemDelete(keychainQuery(service: service, account: account) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw keychainError(service: service)
    }
  }

  private static func keychainError(service: String) -> AuroraThinStorageError {
    if service == auroraInboundVerifierKeychainService {
      return AuroraThinStorageError.inboundVerifierKeychainFailure
    }
    return AuroraThinStorageError.keychainFailure
  }

  private static func currentUnixMs() -> UInt64 {
    UInt64(max(0, Date().timeIntervalSince1970 * 1_000))
  }
}

private extension Data {
  var lowercaseHex: String {
    map { String(format: "%02x", $0) }.joined()
  }
}
