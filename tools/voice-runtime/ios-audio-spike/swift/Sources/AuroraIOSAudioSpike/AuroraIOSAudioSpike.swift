import AVFoundation
import CAuroraIOSAudioBridge
import Foundation

public struct AuroraIOSAudioCaptureStats: Equatable {
    public let acceptedChunks: UInt64
    public let acceptedSamples: UInt64
    public let droppedChunks: UInt64
    public let discontinuities: UInt64
    public let queuedChunks: UInt32
    public let closed: Bool
}

public enum AuroraIOSAudioCaptureError: Error {
    case nativeStateUnavailable
    case inputFormatUnavailable
    case captureStartFailed
}

public final class AuroraIOSAudioCapture {
    private let engine = AVAudioEngine()
    private let session: AVAudioSession
    private let state: OpaquePointer?
    private let maxChunkSamples: AVAudioFrameCount
    private var sequence: UInt64 = 0
    private var running = false

    public init(
        session: AVAudioSession = .sharedInstance(),
        capacityChunks: Int = 8,
        maxChunkSamples: Int = 4096
    ) {
        self.session = session
        self.maxChunkSamples = AVAudioFrameCount(max(1, maxChunkSamples))
        self.state = aurora_ios_audio_state_new(capacityChunks, maxChunkSamples)
    }

    deinit {
        stop()
        aurora_ios_audio_state_free(state)
    }

    public func start() throws {
        guard let state else {
            throw AuroraIOSAudioCaptureError.nativeStateUnavailable
        }
        if running {
            return
        }

        try session.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers])
        try session.setPreferredSampleRate(16_000)
        try session.setActive(true)

        let input = engine.inputNode
        let format = input.inputFormat(forBus: 0)
        guard format.channelCount > 0, format.sampleRate > 0 else {
            throw AuroraIOSAudioCaptureError.inputFormatUnavailable
        }

        sequence = 0
        input.installTap(onBus: 0, bufferSize: maxChunkSamples, format: format) {
            [weak self] buffer, _ in
            guard
                let self,
                let state = self.state,
                let channels = buffer.floatChannelData
            else {
                return
            }
            let frameCount = Int(buffer.frameLength)
            if frameCount == 0 {
                return
            }

            let firstChannel = channels[0]
            let result = aurora_ios_audio_state_push_pcm_f32(
                state,
                firstChannel,
                frameCount,
                self.sequence,
                UInt32(format.sampleRate.rounded())
            )
            self.sequence &+= 1
            if result == AURORA_IOS_AUDIO_BACKPRESSURE {
                _ = aurora_ios_audio_state_drain_one(state)
            }
        }

        do {
            try engine.start()
            running = true
        } catch {
            input.removeTap(onBus: 0)
            aurora_ios_audio_state_close(state)
            throw AuroraIOSAudioCaptureError.captureStartFailed
        }
    }

    public func stop() {
        guard running else {
            return
        }
        running = false
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        if let state {
            aurora_ios_audio_state_close(state)
        }
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
    }

    public func stats() -> AuroraIOSAudioCaptureStats {
        var raw = AuroraIosAudioStats()
        if let state {
            _ = aurora_ios_audio_state_stats(state, &raw)
        }
        return AuroraIOSAudioCaptureStats(
            acceptedChunks: raw.accepted_chunks,
            acceptedSamples: raw.accepted_samples,
            droppedChunks: raw.dropped_chunks,
            discontinuities: raw.discontinuities,
            queuedChunks: raw.queued_chunks,
            closed: raw.closed != 0
        )
    }
}
