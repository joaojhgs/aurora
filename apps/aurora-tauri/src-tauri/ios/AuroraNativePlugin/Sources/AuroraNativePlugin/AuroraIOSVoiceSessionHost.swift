import AVFAudio
import CAuroraIOSVoiceBridge
import Foundation

public enum AuroraIOSVoiceSessionHostError: Error {
  case invalidGateway
  case credentialsUnavailable
  case nativeSessionUnavailable
  case audioStateUnavailable
  case commandFailed(Int32)
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
  private var activeGeneration: UInt64?
  private var lifecycleObservers: [NSObjectProtocol] = []

  public convenience init(
    storedConfiguration audioSession: AVAudioSession = .sharedInstance()
  ) throws {
    guard let configuration = try AuroraIOSVoiceCredentialStore.load() else {
      throw AuroraIOSVoiceSessionHostError.credentialsUnavailable
    }
    try self.init(
      gateway: configuration.gateway,
      bearer: configuration.bearer,
      remoteAudioConsent: configuration.remoteAudioConsent,
      audioSession: audioSession
    )
  }

  public init(
    gateway: String,
    bearer: String?,
    remoteAudioConsent: Bool,
    audioSession: AVAudioSession = .sharedInstance()
  ) throws {
    guard !gateway.isEmpty else { throw AuroraIOSVoiceSessionHostError.invalidGateway }
    let session = gateway.withCString { gatewayPointer in
      if let bearer, !bearer.isEmpty {
        return bearer.withCString { bearerPointer in
          aurora_ios_voice_session_new(
            gatewayPointer,
            bearerPointer,
            remoteAudioConsent ? 1 : 0
          )
        }
      }
      return aurora_ios_voice_session_new(
        gatewayPointer,
        nil,
        remoteAudioConsent ? 1 : 0
      )
    }
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
  }

  private func removeLifecycleObservers() {
    let center = NotificationCenter.default
    lifecycleObservers.forEach(center.removeObserver)
    lifecycleObservers.removeAll()
  }

  private func cancelForLifecycleChange() {
    capture?.stop()
    playback?.stop()
    guard let nativeSession, let generation = activeGeneration else { return }
    _ = aurora_ios_voice_session_cancel(nativeSession, generation)
    activeGeneration = nil
  }
}
