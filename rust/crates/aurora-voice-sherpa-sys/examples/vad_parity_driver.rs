use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use aurora_voice_sherpa_sys::{SileroVadConfig, SpeechSegment, VoiceActivityDetector};

const THRESHOLD: f32 = 0.25;
const MIN_SILENCE_SECS: f32 = 0.25;
const MIN_SPEECH_SECS: f32 = 0.25;
const MAX_SPEECH_SECS: f32 = 10.0;
const WINDOW_SIZE: usize = 512;
const SAMPLE_RATE: i32 = 16_000;
const NUM_THREADS: i32 = 1;
const PROVIDER: &str = "cpu";
const BUFFER_SECS: f32 = 30.0;
const ACCEPT_P95_LIMIT_MS: f64 = 32.0;
const EXPECTED_START: i32 = 5_728;
const EXPECTED_LENGTH: usize = 93_696;
const SILENCE_SECONDS: usize = 31;

fn main() {
    match run() {
        Ok(report) => {
            println!("{}", report.to_json());
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}

fn run() -> Result<NativeReport, String> {
    let args = Args::parse()?;
    let pcm = read_pcm16_mono_16khz_wav(&args.wav_path)?;
    let config = SileroVadConfig::new(args.model_path)
        .with_threshold(THRESHOLD)
        .with_min_silence_duration(MIN_SILENCE_SECS)
        .with_min_speech_duration(MIN_SPEECH_SECS)
        .with_max_speech_duration(MAX_SPEECH_SECS)
        .with_window_size(WINDOW_SIZE as i32)
        .with_sample_rate(SAMPLE_RATE)
        .with_num_threads(NUM_THREADS)
        .with_provider(PROVIDER)
        .with_buffer_size_seconds(BUFFER_SECS);

    let full_flush = run_full_flush(&config, &pcm)?;
    let reset_replay = run_reset_replay(&config, &pcm, &full_flush.segments)?;
    let discontinuity = run_discontinuity_reset(&config, &pcm, &full_flush.segments)?;
    let second_flush = run_second_flush(&config, &pcm, &full_flush.segments)?;
    let cancellation = run_reset_during_feed(&config, &pcm)?;
    let long_silence = run_long_silence(&config)?;

    let timings = [
        &full_flush.feed_timing,
        &reset_replay.feed_timing,
        &discontinuity.feed_timing,
        &second_flush.feed_timing,
        &cancellation.feed_timing,
        &long_silence.feed_timing,
    ];
    let p95_ok = timings
        .iter()
        .all(|timing| timing.accept.p95_ms < ACCEPT_P95_LIMIT_MS);
    let ok = full_flush.ok
        && reset_replay.ok
        && discontinuity.ok
        && second_flush.ok
        && cancellation.ok
        && long_silence.ok
        && p95_ok;

    Ok(NativeReport {
        ok,
        physical_device_claim: false,
        config: ParityConfig,
        full_flush,
        reset_replay,
        discontinuity,
        second_flush,
        cancellation,
        long_silence,
    })
}

fn run_full_flush(config: &SileroVadConfig, pcm: &[f32]) -> Result<CaseReport, String> {
    let mut detector = VoiceActivityDetector::new(config).map_err(|error| error.to_string())?;
    let feed = feed_and_drain(&mut detector, pcm)?;
    detector.flush().map_err(|error| error.to_string())?;
    let final_drain = drain_segments_timed(&mut detector)?;
    let feed_timing = feed.to_timing();
    let drain_timing = feed.drain_timing.combine(final_drain.timing);
    let segments = combine_segments(feed.segments, final_drain.segments);
    Ok(CaseReport {
        ok: is_canonical_fixture_output(&segments)
            && feed.accept_timing.p95_ms < ACCEPT_P95_LIMIT_MS,
        segments,
        feed_timing,
        drain_timing,
        idempotent_empty: None,
    })
}

fn run_reset_replay(
    config: &SileroVadConfig,
    pcm: &[f32],
    expected: &[SegmentReport],
) -> Result<CaseReport, String> {
    let mut detector = VoiceActivityDetector::new(config).map_err(|error| error.to_string())?;
    let _ = feed_and_drain(&mut detector, pcm)?;
    detector.flush().map_err(|error| error.to_string())?;
    let _ = drain_segments_timed(&mut detector)?;

    detector.reset().map_err(|error| error.to_string())?;
    let feed = feed_and_drain(&mut detector, pcm)?;
    detector.flush().map_err(|error| error.to_string())?;
    let final_drain = drain_segments_timed(&mut detector)?;
    let feed_timing = feed.to_timing();
    let drain_timing = feed.drain_timing.combine(final_drain.timing);
    let segments = combine_segments(feed.segments, final_drain.segments);
    Ok(CaseReport {
        ok: segments == expected && feed.accept_timing.p95_ms < ACCEPT_P95_LIMIT_MS,
        segments,
        feed_timing,
        drain_timing,
        idempotent_empty: None,
    })
}

fn run_discontinuity_reset(
    config: &SileroVadConfig,
    pcm: &[f32],
    expected: &[SegmentReport],
) -> Result<CaseReport, String> {
    let mut detector = VoiceActivityDetector::new(config).map_err(|error| error.to_string())?;
    let prefix = pcm.len().min(WINDOW_SIZE * 3);
    let _ = feed_and_drain(&mut detector, &pcm[..prefix])?;
    detector.reset().map_err(|error| error.to_string())?;

    let feed = feed_and_drain(&mut detector, pcm)?;
    detector.flush().map_err(|error| error.to_string())?;
    let final_drain = drain_segments_timed(&mut detector)?;
    let feed_timing = feed.to_timing();
    let drain_timing = feed.drain_timing.combine(final_drain.timing);
    let segments = combine_segments(feed.segments, final_drain.segments);
    Ok(CaseReport {
        ok: segments == expected && feed.accept_timing.p95_ms < ACCEPT_P95_LIMIT_MS,
        segments,
        feed_timing,
        drain_timing,
        idempotent_empty: None,
    })
}

fn run_second_flush(
    config: &SileroVadConfig,
    pcm: &[f32],
    expected: &[SegmentReport],
) -> Result<CaseReport, String> {
    let mut detector = VoiceActivityDetector::new(config).map_err(|error| error.to_string())?;
    let feed = feed_and_drain(&mut detector, pcm)?;
    detector.flush().map_err(|error| error.to_string())?;
    let final_drain = drain_segments_timed(&mut detector)?;
    detector.flush().map_err(|error| error.to_string())?;
    let second_drain = drain_segments_timed(&mut detector)?;
    let feed_timing = feed.to_timing();
    let drain_timing = feed
        .drain_timing
        .combine(final_drain.timing)
        .combine(second_drain.timing);
    let segments = combine_segments(feed.segments, final_drain.segments);
    let after_second_flush = second_drain.segments;
    let idempotent_empty = after_second_flush.is_empty();
    Ok(CaseReport {
        ok: segments == expected
            && idempotent_empty
            && feed.accept_timing.p95_ms < ACCEPT_P95_LIMIT_MS,
        segments,
        feed_timing,
        drain_timing,
        idempotent_empty: Some(idempotent_empty),
    })
}

fn run_reset_during_feed(config: &SileroVadConfig, pcm: &[f32]) -> Result<CaseReport, String> {
    let mut detector = VoiceActivityDetector::new(config).map_err(|error| error.to_string())?;
    let feed = feed_and_drain_reset_after_windows(&mut detector, pcm, 3)?;
    detector.flush().map_err(|error| error.to_string())?;
    let final_drain = drain_segments_timed(&mut detector)?;
    let feed_timing = feed.to_timing();
    let drain_timing = feed.drain_timing.combine(final_drain.timing);
    let segments = combine_segments(feed.segments, final_drain.segments);
    Ok(CaseReport {
        ok: segments.is_empty()
            && feed.reset_during_feed
            && feed.accept_timing.p95_ms < ACCEPT_P95_LIMIT_MS,
        segments,
        feed_timing,
        drain_timing,
        idempotent_empty: None,
    })
}

fn run_long_silence(config: &SileroVadConfig) -> Result<CaseReport, String> {
    let mut detector = VoiceActivityDetector::new(config).map_err(|error| error.to_string())?;
    let silence = vec![0.0; SAMPLE_RATE as usize * SILENCE_SECONDS];
    let feed = feed_and_drain(&mut detector, &silence)?;
    detector.flush().map_err(|error| error.to_string())?;
    let final_drain = drain_segments_timed(&mut detector)?;
    let feed_timing = feed.to_timing();
    let drain_timing = feed.drain_timing.combine(final_drain.timing);
    let segments = combine_segments(feed.segments, final_drain.segments);
    Ok(CaseReport {
        ok: segments.is_empty() && feed.accept_timing.p95_ms < ACCEPT_P95_LIMIT_MS,
        segments,
        feed_timing,
        drain_timing,
        idempotent_empty: None,
    })
}

fn feed_and_drain(detector: &mut VoiceActivityDetector, pcm: &[f32]) -> Result<FeedReport, String> {
    feed_and_drain_with_reset(detector, pcm, None)
}

fn feed_and_drain_reset_after_windows(
    detector: &mut VoiceActivityDetector,
    pcm: &[f32],
    reset_after_full_windows: usize,
) -> Result<FeedReport, String> {
    feed_and_drain_with_reset(detector, pcm, Some(reset_after_full_windows))
}

fn feed_and_drain_with_reset(
    detector: &mut VoiceActivityDetector,
    pcm: &[f32],
    reset_after_full_windows: Option<usize>,
) -> Result<FeedReport, String> {
    let mut accept_timings = Vec::new();
    let mut drain_timings = Vec::new();
    let mut segments = Vec::new();
    let mut full_windows = 0usize;
    let mut terminal_tail_samples = 0usize;
    let mut reset_during_feed = false;
    for chunk in pcm.chunks(WINDOW_SIZE) {
        if chunk.len() < WINDOW_SIZE {
            terminal_tail_samples = chunk.len();
        } else {
            full_windows += 1;
        }
        let started = Instant::now();
        detector
            .accept_waveform(chunk)
            .map_err(|error| error.to_string())?;
        accept_timings.push(started.elapsed().as_secs_f64() * 1000.0);

        if reset_after_full_windows == Some(full_windows) {
            detector.reset().map_err(|error| error.to_string())?;
            reset_during_feed = true;
            break;
        }

        let drained = drain_segments_timed(detector)?;
        drain_timings.push(drained.timing.elapsed_ms);
        segments.extend(drained.segments);
    }

    Ok(FeedReport {
        segments,
        accept_timing: WindowTimingReport {
            p95_ms: percentile(&accept_timings, 0.95),
            max_ms: accept_timings.iter().copied().fold(0.0, f64::max),
            elapsed_ms: accept_timings.iter().sum(),
            operations: accept_timings.len(),
        },
        drain_timing: WindowTimingReport {
            p95_ms: percentile(&drain_timings, 0.95),
            max_ms: drain_timings.iter().copied().fold(0.0, f64::max),
            elapsed_ms: drain_timings.iter().sum(),
            operations: drain_timings.len(),
        },
        full_windows,
        terminal_tail_samples,
        short_terminal_tail_supported: terminal_tail_samples > 0,
        reset_during_feed,
    })
}

fn drain_segments_timed(detector: &mut VoiceActivityDetector) -> Result<DrainReport, String> {
    let started = Instant::now();
    let segments = detector
        .drain_speech_segments()
        .map_err(|error| error.to_string())?;
    Ok(DrainReport {
        segments: segments.iter().map(SegmentReport::from).collect(),
        timing: WindowTimingReport {
            p95_ms: 0.0,
            max_ms: 0.0,
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
            operations: 1,
        },
    })
}

fn combine_segments(mut left: Vec<SegmentReport>, right: Vec<SegmentReport>) -> Vec<SegmentReport> {
    left.extend(right);
    left
}

fn is_canonical_fixture_output(segments: &[SegmentReport]) -> bool {
    segments
        == [SegmentReport {
            start: EXPECTED_START,
            length: EXPECTED_LENGTH,
        }]
}

fn percentile(values: &[f64], percentile: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let index = ((sorted.len() as f64 - 1.0) * percentile).ceil() as usize;
    sorted[index.min(sorted.len() - 1)]
}

fn read_pcm16_mono_16khz_wav(path: &Path) -> Result<Vec<f32>, String> {
    let bytes = fs::read(path).map_err(|error| format!("read wav: {error}"))?;
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("wav must be RIFF/WAVE".to_owned());
    }

    let mut cursor = 12usize;
    let mut format = None;
    let mut data = None;
    while cursor + 8 <= bytes.len() {
        let id = &bytes[cursor..cursor + 4];
        let size = read_u32_le(&bytes[cursor + 4..cursor + 8])? as usize;
        cursor += 8;
        let end = cursor
            .checked_add(size)
            .ok_or_else(|| "wav chunk overflow".to_owned())?;
        if end > bytes.len() {
            return Err("wav chunk extends past file".to_owned());
        }
        match id {
            b"fmt " => format = Some(parse_format_chunk(&bytes[cursor..end])?),
            b"data" => data = Some(&bytes[cursor..end]),
            _ => {}
        }
        cursor = end + (size % 2);
    }

    let format = format.ok_or_else(|| "wav fmt chunk missing".to_owned())?;
    if format.audio_format != 1
        || format.channels != 1
        || format.sample_rate != 16_000
        || format.bits_per_sample != 16
        || format.block_align != 2
    {
        return Err("wav must be RIFF PCM16 mono 16 kHz".to_owned());
    }

    let data = data.ok_or_else(|| "wav data chunk missing".to_owned())?;
    if data.len() % 2 != 0 {
        return Err("PCM16 data must be sample aligned".to_owned());
    }
    data.chunks_exact(2)
        .map(|sample| read_i16_le(sample).map(|value| f32::from(value) / 32768.0))
        .collect()
}

fn parse_format_chunk(chunk: &[u8]) -> Result<WavFormat, String> {
    if chunk.len() < 16 {
        return Err("wav fmt chunk too short".to_owned());
    }
    Ok(WavFormat {
        audio_format: read_u16_le(&chunk[0..2])?,
        channels: read_u16_le(&chunk[2..4])?,
        sample_rate: read_u32_le(&chunk[4..8])?,
        block_align: read_u16_le(&chunk[12..14])?,
        bits_per_sample: read_u16_le(&chunk[14..16])?,
    })
}

fn read_i16_le(bytes: &[u8]) -> Result<i16, String> {
    let bytes: [u8; 2] = bytes
        .try_into()
        .map_err(|_| "i16 field should contain two bytes".to_owned())?;
    Ok(i16::from_le_bytes(bytes))
}

fn read_u16_le(bytes: &[u8]) -> Result<u16, String> {
    let bytes: [u8; 2] = bytes
        .try_into()
        .map_err(|_| "u16 field should contain two bytes".to_owned())?;
    Ok(u16::from_le_bytes(bytes))
}

fn read_u32_le(bytes: &[u8]) -> Result<u32, String> {
    let bytes: [u8; 4] = bytes
        .try_into()
        .map_err(|_| "u32 field should contain four bytes".to_owned())?;
    Ok(u32::from_le_bytes(bytes))
}

#[derive(Debug)]
struct WavFormat {
    audio_format: u16,
    channels: u16,
    sample_rate: u32,
    block_align: u16,
    bits_per_sample: u16,
}

#[derive(Debug)]
struct Args {
    model_path: PathBuf,
    wav_path: PathBuf,
}

impl Args {
    fn parse() -> Result<Self, String> {
        let mut model_path = None;
        let mut wav_path = None;
        let mut args = env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--model" => model_path = args.next().map(PathBuf::from),
                "--wav" => wav_path = args.next().map(PathBuf::from),
                _ => return Err(format!("unknown argument {arg}")),
            }
        }
        Ok(Self {
            model_path: model_path.ok_or_else(|| "--model is required".to_owned())?,
            wav_path: wav_path.ok_or_else(|| "--wav is required".to_owned())?,
        })
    }
}

#[derive(Debug)]
struct NativeReport {
    ok: bool,
    physical_device_claim: bool,
    config: ParityConfig,
    full_flush: CaseReport,
    reset_replay: CaseReport,
    discontinuity: CaseReport,
    second_flush: CaseReport,
    cancellation: CaseReport,
    long_silence: CaseReport,
}

impl NativeReport {
    fn to_json(&self) -> String {
        format!(
            concat!(
                "{{",
                "\"ok\":{},\"physical_device_claim\":{},\"config\":{},",
                "\"cases\":{{\"full_flush\":{},\"reset_replay\":{},",
                "\"discontinuity_reset\":{},\"second_flush_idempotent\":{},",
                "\"cancellation_reset_during_feed\":{},\"long_silence_rolling_buffer\":{}}}",
                "}}"
            ),
            self.ok,
            self.physical_device_claim,
            self.config.to_json(),
            self.full_flush.to_json(),
            self.reset_replay.to_json(),
            self.discontinuity.to_json(),
            self.second_flush.to_json(),
            self.cancellation.to_json(),
            self.long_silence.to_json()
        )
    }
}

#[derive(Debug)]
struct ParityConfig;

impl ParityConfig {
    fn to_json(&self) -> String {
        format!(
            concat!(
                "{{\"threshold\":{},\"min_silence_seconds\":{},",
                "\"min_speech_seconds\":{},\"max_speech_seconds\":{},",
                "\"window_size\":{},\"sample_rate\":{},\"channels\":1,",
                "\"provider\":\"{}\",\"buffer_seconds\":{}}}"
            ),
            THRESHOLD,
            MIN_SILENCE_SECS,
            MIN_SPEECH_SECS,
            MAX_SPEECH_SECS,
            WINDOW_SIZE,
            SAMPLE_RATE,
            PROVIDER,
            BUFFER_SECS
        )
    }
}

#[derive(Debug)]
struct CaseReport {
    ok: bool,
    segments: Vec<SegmentReport>,
    feed_timing: FeedTimingReport,
    drain_timing: WindowTimingReport,
    idempotent_empty: Option<bool>,
}

impl CaseReport {
    fn to_json(&self) -> String {
        let segments = self
            .segments
            .iter()
            .map(SegmentReport::to_json)
            .collect::<Vec<_>>()
            .join(",");
        let idempotent = self.idempotent_empty.map_or_else(
            || "null".to_owned(),
            |value| {
                if value {
                    "true".to_owned()
                } else {
                    "false".to_owned()
                }
            },
        );
        format!(
            concat!(
                "{{\"ok\":{},\"segments\":[{}],\"feed_timing\":{},",
                "\"drain_timing\":{},\"idempotent_empty\":{}}}"
            ),
            self.ok,
            segments,
            self.feed_timing.to_json(),
            self.drain_timing.to_json(),
            idempotent
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SegmentReport {
    start: i32,
    length: usize,
}

impl From<&SpeechSegment> for SegmentReport {
    fn from(segment: &SpeechSegment) -> Self {
        Self {
            start: segment.start,
            length: segment.samples.len(),
        }
    }
}

impl SegmentReport {
    fn to_json(&self) -> String {
        format!("{{\"start\":{},\"length\":{}}}", self.start, self.length)
    }
}

#[derive(Debug)]
struct FeedReport {
    segments: Vec<SegmentReport>,
    accept_timing: WindowTimingReport,
    drain_timing: WindowTimingReport,
    full_windows: usize,
    terminal_tail_samples: usize,
    short_terminal_tail_supported: bool,
    reset_during_feed: bool,
}

impl FeedReport {
    fn to_timing(&self) -> FeedTimingReport {
        FeedTimingReport {
            accept: self.accept_timing.clone(),
            per_chunk_drain: self.drain_timing.clone(),
            full_windows: self.full_windows,
            terminal_tail_samples: self.terminal_tail_samples,
            short_terminal_tail_supported: self.short_terminal_tail_supported,
            reset_during_feed: self.reset_during_feed,
        }
    }
}

struct DrainReport {
    segments: Vec<SegmentReport>,
    timing: WindowTimingReport,
}

#[derive(Debug)]
struct FeedTimingReport {
    accept: WindowTimingReport,
    per_chunk_drain: WindowTimingReport,
    full_windows: usize,
    terminal_tail_samples: usize,
    short_terminal_tail_supported: bool,
    reset_during_feed: bool,
}

impl FeedTimingReport {
    fn to_json(&self) -> String {
        format!(
            concat!(
                "{{\"accept\":{},\"per_chunk_drain\":{},",
                "\"full_windows\":{},\"terminal_tail_samples\":{},",
                "\"short_terminal_tail_supported\":{},\"reset_during_feed\":{}}}"
            ),
            self.accept.to_json(),
            self.per_chunk_drain.to_json(),
            self.full_windows,
            self.terminal_tail_samples,
            self.short_terminal_tail_supported,
            self.reset_during_feed
        )
    }
}

#[derive(Debug, Clone)]
struct WindowTimingReport {
    p95_ms: f64,
    max_ms: f64,
    elapsed_ms: f64,
    operations: usize,
}

impl WindowTimingReport {
    fn combine(self, other: Self) -> Self {
        Self {
            p95_ms: self.p95_ms.max(other.p95_ms),
            max_ms: self.max_ms.max(other.max_ms),
            elapsed_ms: self.elapsed_ms + other.elapsed_ms,
            operations: self.operations + other.operations,
        }
    }

    fn to_json(&self) -> String {
        format!(
            concat!(
                "{{\"p95_ms\":{:.6},\"max_ms\":{:.6},",
                "\"elapsed_ms\":{:.6},\"operations\":{}}}"
            ),
            self.p95_ms, self.max_ms, self.elapsed_ms, self.operations
        )
    }
}
