use std::env;
use std::fmt;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, Sample, SampleFormat, SizedSample, Stream, StreamConfig, I24, U24};

const DEFAULT_SECONDS: f32 = 1.0;
const MAX_SECONDS: f32 = 5.0;

fn main() {
    if let Err(error) = run(env::args().skip(1)) {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}

fn run<I>(args: I) -> Result<(), String>
where
    I: IntoIterator<Item = String>,
{
    let command = parse_args(args)?;
    match command {
        Command::Help => {
            print_help();
            Ok(())
        }
        Command::List => list_devices(),
        Command::Capture(options) => capture(options),
        Command::Playback(options) => playback(options),
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Command {
    Help,
    List,
    Capture(RunOptions),
    Playback(RunOptions),
}

#[derive(Debug, Clone, PartialEq)]
struct RunOptions {
    seconds: f32,
    device_name_contains: Option<String>,
}

impl Default for RunOptions {
    fn default() -> Self {
        Self {
            seconds: DEFAULT_SECONDS,
            device_name_contains: None,
        }
    }
}

fn parse_args<I>(args: I) -> Result<Command, String>
where
    I: IntoIterator<Item = String>,
{
    let args: Vec<String> = args.into_iter().collect();
    if args.is_empty() {
        return Ok(Command::List);
    }

    let (mode, rest) = args
        .split_first()
        .ok_or_else(|| "missing command".to_string())?;
    match mode.as_str() {
        "-h" | "--help" | "help" => Ok(Command::Help),
        "list" => {
            if rest.is_empty() {
                Ok(Command::List)
            } else {
                Err(format!(
                    "list does not accept arguments: {}",
                    rest.join(" ")
                ))
            }
        }
        "capture" => parse_run_options(rest).map(Command::Capture),
        "playback" => parse_run_options(rest).map(Command::Playback),
        unknown => Err(format!("unknown command '{unknown}'")),
    }
}

fn parse_run_options(args: &[String]) -> Result<RunOptions, String> {
    let mut options = RunOptions::default();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--seconds" => {
                index += 1;
                let raw = args
                    .get(index)
                    .ok_or_else(|| "--seconds requires a value".to_string())?;
                options.seconds = parse_bounded_seconds(raw)?;
            }
            "--device" => {
                index += 1;
                let raw = args
                    .get(index)
                    .ok_or_else(|| "--device requires a value".to_string())?;
                let trimmed = raw.trim();
                if trimmed.is_empty() {
                    return Err("--device requires a non-empty value".to_string());
                }
                options.device_name_contains = Some(trimmed.to_string());
            }
            "--help" | "-h" => return Err("use 'help' for usage".to_string()),
            unknown => return Err(format!("unknown option '{unknown}'")),
        }
        index += 1;
    }
    Ok(options)
}

fn parse_bounded_seconds(raw: &str) -> Result<f32, String> {
    let seconds: f32 = raw
        .parse()
        .map_err(|_| format!("invalid --seconds value '{raw}'"))?;
    if !seconds.is_finite() || seconds <= 0.0 {
        return Err("--seconds must be greater than zero".to_string());
    }
    if seconds > MAX_SECONDS {
        return Err(format!("--seconds must be <= {MAX_SECONDS}"));
    }
    Ok(seconds)
}

fn list_devices() -> Result<(), String> {
    let host = cpal::default_host();
    println!("host: {:?}", host.id());
    print_default_device("default input", host.default_input_device());
    print_default_device("default output", host.default_output_device());
    println!();
    print_devices("input devices", host.input_devices());
    print_devices("output devices", host.output_devices());
    Ok(())
}

fn print_default_device(label: &str, device: Option<Device>) {
    match device {
        Some(device) => println!("{label}: {}", device_name(&device)),
        None => println!("{label}: none"),
    }
}

fn print_devices<I>(label: &str, devices: Result<I, cpal::DevicesError>)
where
    I: Iterator<Item = Device>,
{
    println!("{label}:");
    match devices {
        Ok(devices) => {
            let mut count = 0;
            for (index, device) in devices.enumerate() {
                count += 1;
                println!("  [{index}] {}", device_name(&device));
                print_device_configs(&device);
            }
            if count == 0 {
                println!("  none");
            }
        }
        Err(error) => println!("  unavailable: {error}"),
    }
}

fn print_device_configs(device: &Device) {
    match device.supported_input_configs() {
        Ok(configs) => {
            for config in configs.take(4) {
                print_config("input", &config);
            }
        }
        Err(error) => println!("    input configs unavailable: {error}"),
    }
    match device.supported_output_configs() {
        Ok(configs) => {
            for config in configs.take(4) {
                print_config("output", &config);
            }
        }
        Err(error) => println!("    output configs unavailable: {error}"),
    }
}

fn print_config(direction: &str, config: &cpal::SupportedStreamConfigRange) {
    println!(
        "    {direction}: {:?}, {} ch, {}-{} Hz, buffer {:?}",
        config.sample_format(),
        config.channels(),
        config.min_sample_rate(),
        config.max_sample_rate(),
        config.buffer_size()
    );
}

fn capture(options: RunOptions) -> Result<(), String> {
    let host = cpal::default_host();
    let device = select_named_device(host.input_devices(), &options.device_name_contains)?
        .or_else(|| host.default_input_device())
        .ok_or_else(|| "no input device available".to_string())?;
    let config = device
        .default_input_config()
        .map_err(|error| format!("default input config unavailable: {error}"))?;
    let sample_format = config.sample_format();
    let stream_config: StreamConfig = config.into();
    let chunks = Arc::new(AtomicUsize::new(0));
    let frames = Arc::new(AtomicUsize::new(0));
    let stream = match sample_format {
        SampleFormat::I8 => build_input_stream::<i8>(&device, &stream_config, &chunks, &frames),
        SampleFormat::I16 => build_input_stream::<i16>(&device, &stream_config, &chunks, &frames),
        SampleFormat::I24 => build_input_stream::<I24>(&device, &stream_config, &chunks, &frames),
        SampleFormat::I32 => build_input_stream::<i32>(&device, &stream_config, &chunks, &frames),
        SampleFormat::I64 => build_input_stream::<i64>(&device, &stream_config, &chunks, &frames),
        SampleFormat::U8 => build_input_stream::<u8>(&device, &stream_config, &chunks, &frames),
        SampleFormat::U16 => build_input_stream::<u16>(&device, &stream_config, &chunks, &frames),
        SampleFormat::U24 => build_input_stream::<U24>(&device, &stream_config, &chunks, &frames),
        SampleFormat::U32 => build_input_stream::<u32>(&device, &stream_config, &chunks, &frames),
        SampleFormat::U64 => build_input_stream::<u64>(&device, &stream_config, &chunks, &frames),
        SampleFormat::F32 => build_input_stream::<f32>(&device, &stream_config, &chunks, &frames),
        SampleFormat::F64 => build_input_stream::<f64>(&device, &stream_config, &chunks, &frames),
        other => Err(format!("unsupported input sample format: {other:?}")),
    }?;
    run_stream("capture", &device, stream, options.seconds)?;
    println!(
        "captured chunks={} frames={}",
        chunks.load(Ordering::SeqCst),
        frames.load(Ordering::SeqCst)
    );
    Ok(())
}

fn build_input_stream<T>(
    device: &Device,
    config: &StreamConfig,
    chunks: &Arc<AtomicUsize>,
    frames: &Arc<AtomicUsize>,
) -> Result<Stream, String>
where
    T: SizedSample,
{
    let chunks = Arc::clone(chunks);
    let frames = Arc::clone(frames);
    let channels = usize::from(config.channels.max(1));
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                chunks.fetch_add(1, Ordering::SeqCst);
                frames.fetch_add(data.len() / channels, Ordering::SeqCst);
            },
            |error| eprintln!("capture stream error: {error}"),
            None,
        )
        .map_err(|error| format!("failed to build input stream: {error}"))
}

fn playback(options: RunOptions) -> Result<(), String> {
    let host = cpal::default_host();
    let device = select_named_device(host.output_devices(), &options.device_name_contains)?
        .or_else(|| host.default_output_device())
        .ok_or_else(|| "no output device available".to_string())?;
    let config = device
        .default_output_config()
        .map_err(|error| format!("default output config unavailable: {error}"))?;
    let sample_format = config.sample_format();
    let stream_config: StreamConfig = config.into();
    let stream = match sample_format {
        SampleFormat::I8 => build_output_stream::<i8>(&device, &stream_config),
        SampleFormat::I16 => build_output_stream::<i16>(&device, &stream_config),
        SampleFormat::I24 => build_output_stream::<I24>(&device, &stream_config),
        SampleFormat::I32 => build_output_stream::<i32>(&device, &stream_config),
        SampleFormat::I64 => build_output_stream::<i64>(&device, &stream_config),
        SampleFormat::U8 => build_output_stream::<u8>(&device, &stream_config),
        SampleFormat::U16 => build_output_stream::<u16>(&device, &stream_config),
        SampleFormat::U24 => build_output_stream::<U24>(&device, &stream_config),
        SampleFormat::U32 => build_output_stream::<u32>(&device, &stream_config),
        SampleFormat::U64 => build_output_stream::<u64>(&device, &stream_config),
        SampleFormat::F32 => build_output_stream::<f32>(&device, &stream_config),
        SampleFormat::F64 => build_output_stream::<f64>(&device, &stream_config),
        other => Err(format!("unsupported output sample format: {other:?}")),
    }?;
    run_stream("playback", &device, stream, options.seconds)
}

fn build_output_stream<T>(device: &Device, config: &StreamConfig) -> Result<Stream, String>
where
    T: SizedSample + Sample,
{
    device
        .build_output_stream(
            config,
            move |data: &mut [T], _| {
                for sample in data {
                    *sample = Sample::EQUILIBRIUM;
                }
            },
            |error| eprintln!("playback stream error: {error}"),
            None,
        )
        .map_err(|error| format!("failed to build output stream: {error}"))
}

fn run_stream(label: &str, device: &Device, stream: Stream, seconds: f32) -> Result<(), String> {
    println!("{label}: {}", device_name(device));
    stream
        .play()
        .map_err(|error| format!("failed to start {label} stream: {error}"))?;
    let deadline = Instant::now() + Duration::from_secs_f32(seconds);
    while Instant::now() < deadline {
        thread::sleep(Duration::from_millis(25));
    }
    drop(stream);
    println!("{label}: stopped after {seconds:.2}s");
    Ok(())
}

fn select_named_device<I>(
    devices: Result<I, cpal::DevicesError>,
    needle: &Option<String>,
) -> Result<Option<Device>, String>
where
    I: Iterator<Item = Device>,
{
    let Some(needle) = needle else {
        return Ok(None);
    };
    let needle = needle.to_lowercase();
    let devices = devices.map_err(|error| format!("devices unavailable: {error}"))?;
    for device in devices {
        if device_name(&device).to_lowercase().contains(&needle) {
            return Ok(Some(device));
        }
    }
    Err(format!("no device name contains '{needle}'"))
}

fn device_name(device: &Device) -> String {
    device
        .description()
        .map(|description| description.name().to_string())
        .unwrap_or_else(|error| format!("<name unavailable: {error}>"))
}

fn print_help() {
    println!(
        "\
aurora-cpal-spike

Usage:
  aurora-cpal-spike [list]
  aurora-cpal-spike capture [--seconds N] [--device NAME_PART]
  aurora-cpal-spike playback [--seconds N] [--device NAME_PART]

Commands:
  list      Enumerate host defaults, devices, and bounded config summaries.
  capture   Open the selected/default input device for at most 5 seconds.
  playback  Open the selected/default output device and write silence for at most 5 seconds.
"
    );
}

impl fmt::Display for Command {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Command::Help => write!(formatter, "help"),
            Command::List => write!(formatter, "list"),
            Command::Capture(_) => write!(formatter, "capture"),
            Command::Playback(_) => write!(formatter, "playback"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_list_when_no_command_is_given() {
        assert_eq!(parse_args(Vec::<String>::new()).unwrap(), Command::List);
    }

    #[test]
    fn parses_capture_options() {
        let command = parse_args(
            ["capture", "--seconds", "2.5", "--device", "usb"]
                .into_iter()
                .map(str::to_string),
        )
        .unwrap();

        assert_eq!(
            command,
            Command::Capture(RunOptions {
                seconds: 2.5,
                device_name_contains: Some("usb".to_string()),
            })
        );
    }

    #[test]
    fn rejects_unbounded_duration() {
        let error = parse_args(
            ["playback", "--seconds", "30"]
                .into_iter()
                .map(str::to_string),
        )
        .unwrap_err();

        assert!(error.contains("<= 5"));
    }

    #[test]
    fn rejects_empty_device_filter() {
        let error =
            parse_args(["capture", "--device", " "].into_iter().map(str::to_string)).unwrap_err();

        assert!(error.contains("non-empty"));
    }

    #[test]
    fn rejects_unknown_command() {
        let error = parse_args(["record"].into_iter().map(str::to_string)).unwrap_err();

        assert!(error.contains("unknown command"));
    }
}
