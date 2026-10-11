use std::error::Error;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use aurora_voice_engine::{
    BoundTaskRequest, FiniteSttAudioBuilder, FiniteSttPort, FiniteSttProviderBinding, TaskRequest,
    VoiceTask,
};
use aurora_voice_native::{
    build_installed_stt_provider, CancellationToken, SpeechPackManager, SpeechPackManagerConfig,
};

const MODEL_ID: &str = "stt:whisper:tiny";
const SAMPLE_RATE_HZ: u32 = 16_000;
const MAX_WAV_BYTES: usize = 8 * 1024 * 1024;

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = std::env::args_os().skip(1);
    let pack_root = PathBuf::from(args.next().ok_or_else(usage_error)?);
    let wav_path = PathBuf::from(args.next().ok_or_else(usage_error)?);
    let expected = args
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(" ");
    if expected.trim().is_empty() {
        return Err(usage_error().into());
    }

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(run(pack_root, wav_path, expected))
}

async fn run(
    pack_root: PathBuf,
    wav_path: PathBuf,
    expected: String,
) -> Result<(), Box<dyn Error>> {
    let manager = SpeechPackManager::open(SpeechPackManagerConfig::new(pack_root, None)?)?;
    let cancellation = CancellationToken::new();
    let installed = manager
        .install_model(MODEL_ID, &cancellation, |_| {})
        .await?;
    if installed.model_id != MODEL_ID {
        return Err(invalid_data("catalog installed an unexpected STT model").into());
    }

    let samples = read_pcm16_wav(&wav_path)?;
    let mut provider = build_installed_stt_provider(&manager, MODEL_ID)?;
    let provider_binding = provider.finite_stt_binding()?;
    provider.warm_finite_stt(provider_binding.clone()).await?;
    let FiniteSttProviderBinding::LocalTask(task_binding) = provider_binding else {
        return Err(invalid_data("installed local STT returned a routed binding").into());
    };
    let request = BoundTaskRequest::new(
        TaskRequest {
            task: VoiceTask::SpeechToText,
            language: Some("en".to_owned()),
            generation: 1,
        },
        *task_binding,
    )?;
    let mut audio = FiniteSttAudioBuilder::new(request)?;
    for frame in samples.chunks(SAMPLE_RATE_HZ as usize) {
        audio.push_frame(frame)?;
    }
    let (request, audio) = audio.finish()?;
    let result = provider
        .transcribe_finite(request, audio, &|| false)
        .await?;
    let transcript = result.transcript().trim();
    let expected = expected.trim();
    if transcript.is_empty() || !transcript.to_lowercase().contains(&expected.to_lowercase()) {
        return Err(invalid_data("STT transcript did not contain the expected phrase").into());
    }

    println!("model_id={MODEL_ID}");
    println!("matched_expected_phrase=true");
    println!("transcript={transcript}");
    Ok(())
}

fn read_pcm16_wav(path: &Path) -> io::Result<Vec<f32>> {
    let bytes = fs::read(path)?;
    if bytes.len() > MAX_WAV_BYTES
        || bytes.len() < 12
        || &bytes[..4] != b"RIFF"
        || &bytes[8..12] != b"WAVE"
    {
        return Err(invalid_data("expected a bounded RIFF/WAVE file"));
    }

    let mut offset = 12usize;
    let mut format = None;
    let mut data = None;
    while offset.checked_add(8).is_some_and(|end| end <= bytes.len()) {
        let chunk_id = &bytes[offset..offset + 4];
        let chunk_len = u32::from_le_bytes(
            bytes[offset + 4..offset + 8]
                .try_into()
                .map_err(|_| invalid_data("invalid WAV chunk header"))?,
        ) as usize;
        let payload_start = offset + 8;
        let payload_end = payload_start
            .checked_add(chunk_len)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| invalid_data("WAV chunk exceeds file bounds"))?;
        let payload = &bytes[payload_start..payload_end];
        if chunk_id == b"fmt " {
            if payload.len() < 16 {
                return Err(invalid_data("invalid WAV format chunk"));
            }
            format = Some((
                u16::from_le_bytes([payload[0], payload[1]]),
                u16::from_le_bytes([payload[2], payload[3]]),
                u32::from_le_bytes([payload[4], payload[5], payload[6], payload[7]]),
                u16::from_le_bytes([payload[14], payload[15]]),
            ));
        } else if chunk_id == b"data" && data.is_none() {
            data = Some(payload);
        }
        offset = payload_end
            .checked_add(chunk_len & 1)
            .ok_or_else(|| invalid_data("WAV chunk offset overflow"))?;
    }

    let (encoding, channels, sample_rate, bits_per_sample) =
        format.ok_or_else(|| invalid_data("WAV format chunk is missing"))?;
    if encoding != 1 || channels != 1 || sample_rate != SAMPLE_RATE_HZ || bits_per_sample != 16 {
        return Err(invalid_data("WAV must be 16 kHz mono PCM16"));
    }
    let data = data.ok_or_else(|| invalid_data("WAV audio data is missing"))?;
    if data.is_empty() || data.len() % 2 != 0 {
        return Err(invalid_data("WAV audio data must contain PCM16 samples"));
    }
    let samples = data
        .chunks_exact(2)
        .map(|sample| i16::from_le_bytes([sample[0], sample[1]]) as f32 / 32_768.0)
        .collect::<Vec<_>>();
    if samples.len() > SAMPLE_RATE_HZ as usize * 30 {
        return Err(invalid_data("WAV exceeds the 30 second STT limit"));
    }
    Ok(samples)
}

fn usage_error() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "usage: speech_stt_main_flow <speech-pack-root> <upstream-16khz-mono-pcm.wav> <expected transcript phrase>",
    )
}

fn invalid_data(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
