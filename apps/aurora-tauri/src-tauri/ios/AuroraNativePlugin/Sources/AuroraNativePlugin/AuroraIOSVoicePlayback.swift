import AVFAudio
import CAuroraIOSVoiceBridge
import Foundation

/// Drains Rust-owned PCM chunks into an AVAudioPlayerNode without exposing
/// audio bytes to the WebView or logs.
public final class AuroraIOSVoicePlayback {
  private static let maxChunkSamples = 48_000
  private let output: OpaquePointer
  private let audioSession: AVAudioSession
  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private let queue = DispatchQueue(label: "dev.aurora.ios.voice-playback")
  private var timer: DispatchSourceTimer?
  private var running = false
  private var chunkInFlight = false

  public init(output: OpaquePointer, audioSession: AVAudioSession = .sharedInstance()) {
    self.output = output
    self.audioSession = audioSession
  }

  deinit {
    stop()
  }

  public func start() throws {
    try queue.sync {
      guard !running else { return }
      try audioSession.setCategory(.playAndRecord, mode: .voiceChat, options: [.duckOthers])
      try audioSession.setActive(true)
      let format = AVAudioFormat(
        standardFormatWithSampleRate: 16_000,
        channels: 1
      )
      engine.attach(player)
      engine.connect(player, to: engine.mainMixerNode, format: format)
      try engine.start()
      player.play()
      running = true
      let timer = DispatchSource.makeTimerSource(queue: queue)
      timer.schedule(deadline: .now(), repeating: .milliseconds(10))
      timer.setEventHandler { [weak self] in self?.drainOne() }
      timer.resume()
      self.timer = timer
    }
  }

  public func stop() {
    queue.sync {
      guard running || timer != nil else { return }
      running = false
      timer?.setEventHandler {}
      timer?.cancel()
      timer = nil
      chunkInFlight = false
      player.stop()
      engine.stop()
      if player.engine != nil {
        engine.detach(player)
      }
      try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
      aurora_ios_audio_output_close(output)
    }
  }

  private func drainOne() {
    guard running, !chunkInFlight else { return }
    var samples = [Int16](repeating: 0, count: Self.maxChunkSamples)
    var sampleCount: UInt = 0
    var sampleRate: UInt32 = 0
    var channels: UInt16 = 0
    var sequence: UInt64 = 0
    var finalChunk: UInt32 = 0
    let result = samples.withUnsafeMutableBufferPointer { buffer in
      aurora_ios_audio_output_drain(
        output,
        buffer.baseAddress,
        UInt(buffer.count),
        &sampleCount,
        &sampleRate,
        &channels,
        &sequence,
        &finalChunk
      )
    }
    guard result == AURORA_IOS_AUDIO_OK,
          sampleCount > 0,
          sampleRate > 0,
          channels == 1,
          Int(sampleCount) <= samples.count else {
      return
    }
    chunkInFlight = true
    guard let format = AVAudioFormat(
      commonFormat: .pcmFormatInt16,
      sampleRate: Double(sampleRate),
      channels: AVAudioChannelCount(channels),
      interleaved: true
    ), let buffer = AVAudioPCMBuffer(
      pcmFormat: format,
      frameCapacity: AVAudioFrameCount(sampleCount)
    ) else {
      chunkInFlight = false
      aurora_ios_audio_output_close(output)
      running = false
      return
    }
    buffer.frameLength = AVAudioFrameCount(sampleCount)
    let byteCount = Int(sampleCount) * MemoryLayout<Int16>.size
    samples.withUnsafeBytes { source in
      guard let sourceBase = source.baseAddress,
            let destinationBase = buffer.mutableAudioBufferList.pointee.mBuffers.mData else {
        return
      }
      destinationBase.copyMemory(from: sourceBase, byteCount: byteCount)
    }
    player.scheduleBuffer(buffer, completionHandler: { [weak self] in
      guard let self else { return }
      self.queue.async {
        aurora_ios_audio_output_acknowledge(self.output)
        self.chunkInFlight = false
      }
    })
  }
}
