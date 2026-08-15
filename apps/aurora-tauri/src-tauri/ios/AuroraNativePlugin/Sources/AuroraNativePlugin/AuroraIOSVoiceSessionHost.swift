import AVFAudio
import CAuroraIOSVoiceBridge
import Foundation
import UIKit

public enum AuroraIOSVoiceSessionHostError: Error {
  case invalidGateway
  case credentialsUnavailable
  case nativeSessionUnavailable
  case audioStateUnavailable
  case requiredTaskPackUnavailable
  case commandFailed(Int32)
}

private struct AuroraIOSVoiceTaskPackPathBinding {
  let task: Int32
  let slotId: String
  let packPath: String
  let sha256: String
  let fileSize: UInt64
  let runtimeRevision: String
  let filesJson: String
  let language: String
  let packId: String
  let sampleRateHz: UInt32
  let frameSize: UInt32
  let modelFamily: String
  let referenceAudioPath: String?
  let referenceAudioSha256: String?
  let referenceAudioSizeBytes: UInt64
  let referenceAudioSampleRateHz: UInt32
  let referenceText: String?
  let referenceRevision: String?
}

/// Swift-owned lifecycle host for a Rust-owned native voice session.
///
/// Swift owns permission and AVAudioEngine callbacks. Rust owns the session,
/// generation, route policy, transport, cancellation, and bounded queues.
/// This boundary is intentionally not enabled by the public capability flag
/// until the app has a native credential source and Apple runtime evidence.
public final class AuroraIOSVoiceSessionHost {
  private var nativeSession: OpaquePointer?
  private var capture: AuroraIOSVoiceCapture?
  private var playback: AuroraIOSVoicePlayback?
  private let output: OpaquePointer?
  private let audioSession: AVAudioSession
  private let boundTaskPacks: [AuroraIOSVoicePackPathBinding]
  private var activeGeneration: UInt64?
  private var backgroundSessionActive = false
  private var lifecycleObservers: [NSObjectProtocol] = []

  public convenience init(
    storedConfiguration audioSession: AVAudioSession = .sharedInstance()
  ) throws {
    try self.init(
      requiredSlots: ["vad", "kws", "stt", "tts"],
      storedConfiguration: audioSession
    )
  }

  public convenience init(
    requiredSlots: [String],
    storedConfiguration audioSession: AVAudioSession = .sharedInstance()
  ) throws {
    guard let configuration = try AuroraIOSVoiceCredentialStore.load() else {
      throw AuroraIOSVoiceSessionHostError.credentialsUnavailable
    }
    try self.init(
      gateway: configuration.gateway,
      bearer: configuration.bearer,
      remoteAudioConsent: configuration.remoteAudioConsent,
      requiredSlots: requiredSlots,
      audioSession: audioSession
    )
  }

  public init(
    gateway: String,
    bearer: String?,
    remoteAudioConsent: Bool,
    audioSession: AVAudioSession = .sharedInstance()
  ) throws {
    try self.init(
      gateway: gateway,
      bearer: bearer,
      remoteAudioConsent: remoteAudioConsent,
      requiredSlots: ["vad", "kws", "stt", "tts"],
      audioSession: audioSession
    )
  }

  private init(
    gateway: String,
    bearer: String?,
    remoteAudioConsent: Bool,
    requiredSlots: [String],
    audioSession: AVAudioSession = .sharedInstance()
  ) throws {
    let normalizedSlots = requiredSlots.map { $0.lowercased() }
    let boundPacks = try AuroraIOSVoicePackManager.boundPackBindings(for: normalizedSlots)
    guard boundPacks.count == Set(normalizedSlots).count else {
      throw AuroraIOSVoiceSessionHostError.requiredTaskPackUnavailable
    }
    let taskBindings = try Self.taskPackBindings(from: boundPacks)

    guard !gateway.isEmpty else { throw AuroraIOSVoiceSessionHostError.invalidGateway }
    let session = Self.createNativeSession(
      gateway: gateway,
      bearer: bearer,
      remoteAudioConsent: remoteAudioConsent,
      bindings: taskBindings
    )
    guard let session else {
      throw AuroraIOSVoiceSessionHostError.nativeSessionUnavailable
    }
    guard let state = aurora_ios_voice_session_audio_state(session) else {
      aurora_ios_voice_session_free(session)
      throw AuroraIOSVoiceSessionHostError.audioStateUnavailable
    }
    self.nativeSession = session
    self.output = aurora_ios_voice_session_output(session)
    self.audioSession = audioSession
    self.boundTaskPacks = boundPacks
    self.capture = AuroraIOSVoiceCapture(
      borrowingState: state,
      session: audioSession
    )
    if let output = self.output {
      self.playback = AuroraIOSVoicePlayback(output: output, audioSession: audioSession)
    }
    self.activeGeneration = nil
    installLifecycleObservers()
  }

  private static func createNativeSession(
    gateway: String,
    bearer: String?,
    remoteAudioConsent: Bool,
    bindings: [AuroraIOSVoiceTaskPackPathBinding]
  ) -> OpaquePointer? {
    gateway.withCString { gatewayPointer in
      let buildWithBearer: (UnsafePointer<CChar>?) -> OpaquePointer? = { bearerPointer in
        withNativePackBindings(bindings) { nativeBindings, bindingCount in
          aurora_ios_voice_session_new_with_pack_bindings(
            gatewayPointer,
            bearerPointer,
            remoteAudioConsent ? 1 : 0,
            nativeBindings,
            bindingCount
          )
        }
      }
      if let bearer, !bearer.isEmpty {
        return bearer.withCString { bearerPointer in
          buildWithBearer(bearerPointer)
        }
      }
      return buildWithBearer(nil)
    }
  }

  private static func taskPackBindings(
    from packs: [AuroraIOSVoicePackPathBinding]
  ) throws -> [AuroraIOSVoiceTaskPackPathBinding] {
    try packs.map { pack in
      guard let task = taskCode(for: pack.task) else {
        throw AuroraIOSVoiceSessionHostError.requiredTaskPackUnavailable
      }
      return AuroraIOSVoiceTaskPackPathBinding(
        task: task,
        slotId: pack.slot,
        packPath: pack.packPath,
        sha256: pack.sha256,
        fileSize: pack.fileSize,
        runtimeRevision: pack.runtimeRevision,
        filesJson: pack.filesJson,
        language: pack.language,
        packId: pack.packId,
        sampleRateHz: pack.sampleRateHz,
        frameSize: pack.frameSize,
        modelFamily: pack.modelFamily,
        referenceAudioPath: pack.referenceAudioPath,
        referenceAudioSha256: pack.referenceAudioSha256,
        referenceAudioSizeBytes: pack.referenceAudioSizeBytes,
        referenceAudioSampleRateHz: pack.referenceAudioSampleRateHz,
        referenceText: pack.referenceText,
        referenceRevision: pack.referenceRevision
      )
    }
  }

  private static func taskCode(for slot: String) -> Int32? {
    switch slot.lowercased() {
    case "kws":
      return 1
    case "wakeword":
      return 2
    case "vad":
      return 3
    case "stt":
      return 4
    case "tts":
      return 5
    default:
      return nil
    }
  }

  private static func withNativePackBindings<T>(
    _ bindings: [AuroraIOSVoiceTaskPackPathBinding],
    _ body: (UnsafePointer<AuroraIosVoiceTaskPackBinding>?, UInt) -> T
  ) -> T {
    guard !bindings.isEmpty else {
      return body(nil, 0)
    }
    var nativeBindings = Array(
      repeating: AuroraIosVoiceTaskPackBinding(
        task: 0,
        slot_id: nil,
        pack_id: nil,
        pack_path: nil,
        expected_sha256: nil,
        expected_size_bytes: 0,
        runtime_revision: nil,
        files_json: nil,
        language: nil,
        sample_rate_hz: 0,
        frame_size: 0,
        model_family: nil,
        reference_audio_path: nil,
        reference_audio_sha256: nil,
        reference_audio_size_bytes: 0,
        reference_audio_sample_rate_hz: 0,
        reference_text: nil,
        reference_revision: nil
      ),
      count: bindings.count
    )

    func bind(_ index: Int) -> T {
      guard index < bindings.count else {
        return nativeBindings.withUnsafeBufferPointer { buffer in
          body(buffer.baseAddress, UInt(buffer.count))
        }
      }
      let binding = bindings[index]
      return binding.slotId.withCString { slotPointer in
        binding.packId.withCString { packIdPointer in
          binding.packPath.withCString { packPathPointer in
            binding.sha256.withCString { shaPointer in
              binding.runtimeRevision.withCString { revisionPointer in
                binding.filesJson.withCString { filesPointer in
                  binding.language.withCString { languagePointer in
                    binding.modelFamily.withCString { familyPointer in
                      withOptionalCString(binding.referenceAudioPath) { referenceAudioPathPointer in
                        withOptionalCString(binding.referenceAudioSha256) { referenceAudioShaPointer in
                          withOptionalCString(binding.referenceText) { referenceTextPointer in
                            withOptionalCString(binding.referenceRevision) { referenceRevisionPointer in
                              nativeBindings[index] = AuroraIosVoiceTaskPackBinding(
                                task: binding.task,
                                slot_id: slotPointer,
                                pack_id: packIdPointer,
                                pack_path: packPathPointer,
                                expected_sha256: shaPointer,
                                expected_size_bytes: binding.fileSize,
                                runtime_revision: revisionPointer,
                                files_json: filesPointer,
                                language: languagePointer,
                                sample_rate_hz: binding.sampleRateHz,
                                frame_size: binding.frameSize,
                                model_family: familyPointer,
                                reference_audio_path: referenceAudioPathPointer,
                                reference_audio_sha256: referenceAudioShaPointer,
                                reference_audio_size_bytes: binding.referenceAudioSizeBytes,
                                reference_audio_sample_rate_hz: binding.referenceAudioSampleRateHz,
                                reference_text: referenceTextPointer,
                                reference_revision: referenceRevisionPointer
                              )
                              return bind(index + 1)
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    return bind(0)
  }

  private static func withOptionalCString<T>(
    _ value: String?,
    _ body: (UnsafePointer<CChar>?) -> T
  ) -> T {
    guard let value, !value.isEmpty else {
      return body(nil)
    }
    return value.withCString(body)
  }

  deinit {
    removeLifecycleObservers()
    playback?.stop()
    playback = nil
    capture?.stop()
    // Destroy the Swift audio host while the Rust-owned borrowed queue is
    // still valid, then close and free the opaque Rust session.
    capture = nil
    if let nativeSession {
      aurora_ios_voice_session_close(nativeSession)
      aurora_ios_voice_session_free(nativeSession)
    }
  }

  public func start() throws -> UInt64 {
    guard let nativeSession else {
      throw AuroraIOSVoiceSessionHostError.nativeSessionUnavailable
    }
    var generation: UInt64 = 0
    let code = aurora_ios_voice_session_start(nativeSession, &generation)
    guard code == AURORA_IOS_VOICE_OK else {
      throw AuroraIOSVoiceSessionHostError.commandFailed(code)
    }
    backgroundSessionActive = false
    activeGeneration = generation
    do {
      try capture?.start()
      try playback?.start()
      return generation
    } catch {
      _ = try? cancel(generation: generation)
      throw error
    }
  }

  public func startBackground() throws -> UInt64 {
    guard let nativeSession else {
      throw AuroraIOSVoiceSessionHostError.nativeSessionUnavailable
    }
    var generation: UInt64 = 0
    let code = aurora_ios_voice_session_start_background(nativeSession, &generation)
    guard code == AURORA_IOS_VOICE_OK else {
      throw AuroraIOSVoiceSessionHostError.commandFailed(code)
    }
    backgroundSessionActive = true
    activeGeneration = generation
    do {
      try capture?.start()
      try playback?.start()
      return generation
    } catch {
      _ = try? cancel(generation: generation)
      throw error
    }
  }

  public func finish(generation: UInt64) throws {
    guard let nativeSession else {
      throw AuroraIOSVoiceSessionHostError.nativeSessionUnavailable
    }
    capture?.stop()
    let code = aurora_ios_voice_session_finish(nativeSession, generation)
    guard code == AURORA_IOS_VOICE_OK else {
      throw AuroraIOSVoiceSessionHostError.commandFailed(code)
    }
    backgroundSessionActive = false
    activeGeneration = nil
  }

  public func cancel(generation: UInt64) throws {
    guard let nativeSession else {
      throw AuroraIOSVoiceSessionHostError.nativeSessionUnavailable
    }
    capture?.stop()
    playback?.stop()
    let code = aurora_ios_voice_session_cancel(nativeSession, generation)
    guard code == AURORA_IOS_VOICE_OK else {
      throw AuroraIOSVoiceSessionHostError.commandFailed(code)
    }
    backgroundSessionActive = false
    activeGeneration = nil
  }

  public func stopCapture() {
    capture?.stop()
  }

  public func captureStats() -> AuroraIOSVoiceCaptureStats? {
    capture?.stats()
  }

  public func outputHandle() -> OpaquePointer? {
    output
  }

  public func status() -> AuroraIosVoiceSessionStatus? {
    guard let nativeSession else { return nil }
    var status = AuroraIosVoiceSessionStatus()
    guard aurora_ios_voice_session_status(nativeSession, &status) == AURORA_IOS_VOICE_OK else {
      return nil
    }
    return status
  }

  private func installLifecycleObservers() {
    let center = NotificationCenter.default
    lifecycleObservers.append(
      center.addObserver(
        forName: AVAudioSession.interruptionNotification,
        object: audioSession,
        queue: .main
      ) { [weak self] notification in
        guard
          let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: rawType),
          type == .began
        else { return }
        self?.cancelForLifecycleChange()
      }
    )
    lifecycleObservers.append(
      center.addObserver(
        forName: AVAudioSession.routeChangeNotification,
        object: audioSession,
        queue: .main
      ) { [weak self] notification in
        guard
          let rawReason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
          let reason = AVAudioSession.RouteChangeReason(rawValue: rawReason),
          reason == .oldDeviceUnavailable
            || reason == .noSuitableRouteForCategory
        else { return }
        self?.cancelForLifecycleChange()
      }
    )
    lifecycleObservers.append(
      center.addObserver(
        forName: AVAudioSession.mediaServicesWereResetNotification,
        object: audioSession,
        queue: .main
      ) { [weak self] _ in
        self?.cancelForLifecycleChange()
      }
    )
    lifecycleObservers.append(
      center.addObserver(
        forName: UIApplication.didEnterBackgroundNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.cancelForLifecycleChange(respectBackgroundSession: true)
      }
    )
    lifecycleObservers.append(
      center.addObserver(
        forName: UIApplication.protectedDataWillBecomeUnavailableNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.cancelForLifecycleChange(respectBackgroundSession: true)
      }
    )
    lifecycleObservers.append(
      center.addObserver(
        forName: ProcessInfo.powerStateDidChangeNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        guard ProcessInfo.processInfo.isLowPowerModeEnabled else { return }
        self?.cancelForLifecycleChange()
      }
    )
    lifecycleObservers.append(
      center.addObserver(
        forName: UIApplication.willTerminateNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.cancelForLifecycleChange()
      }
    )
  }

  private func removeLifecycleObservers() {
    let center = NotificationCenter.default
    lifecycleObservers.forEach(center.removeObserver)
    lifecycleObservers.removeAll()
  }

  private func cancelForLifecycleChange(respectBackgroundSession: Bool = false) {
    if respectBackgroundSession && backgroundSessionActive { return }
    capture?.stop()
    playback?.stop()
    guard let nativeSession, let generation = activeGeneration else { return }
    _ = aurora_ios_voice_session_cancel(nativeSession, generation)
    backgroundSessionActive = false
    activeGeneration = nil
  }
}
