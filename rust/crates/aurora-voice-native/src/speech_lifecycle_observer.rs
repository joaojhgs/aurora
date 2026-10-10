//! Optional, payload-free speech lifecycle observation for native hosts.
//!
//! This is intentionally independent from transcript delivery and has no
//! persistence/exporter behavior. With no installed observer, emission returns
//! before reading the clock or allocating a record.

use aurora_voice_core::{SpeechLifecycleEventKind, SpeechLifecycleEventV1, SpeechLifecycleOutcome};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::Instant;

#[cfg(test)]
use std::collections::VecDeque;
#[cfg(test)]
use std::sync::Mutex;

const MAX_TEST_EVENTS: usize = 512;
const MAX_TEST_BYTES: usize = 256 * 1024;
const RESERVED_EVENT_CAPACITY: usize = 32;
const RESERVED_BYTE_CAPACITY: usize = 16 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct NativeSpeechLifecycleRecordV1 {
    #[serde(flatten)]
    pub boundary: SpeechLifecycleEventV1,
    pub monotonic_ns: String,
    pub boot_id: Option<String>,
    pub clock_domain: String,
    pub redacted: bool,
}

pub trait NativeSpeechLifecycleObserver: Send + Sync {
    fn observe(&self, event: NativeSpeechLifecycleRecordV1) -> Result<(), ()>;
}

impl<F> NativeSpeechLifecycleObserver for F
where
    F: Fn(NativeSpeechLifecycleRecordV1) -> Result<(), ()> + Send + Sync,
{
    fn observe(&self, event: NativeSpeechLifecycleRecordV1) -> Result<(), ()> {
        self(event)
    }
}

static OBSERVER: OnceLock<RwLock<Option<Arc<dyn NativeSpeechLifecycleObserver>>>> = OnceLock::new();
static PROCESS_MONOTONIC_ORIGIN: OnceLock<Instant> = OnceLock::new();
static PROCESS_START_ID: OnceLock<String> = OnceLock::new();

/// Installs the process-local observer. A callback is never allowed to affect
/// speech routing, cleanup, or provider outcomes.
pub fn install_native_speech_lifecycle_observer(
    observer: Arc<dyn NativeSpeechLifecycleObserver>,
) -> bool {
    OBSERVER
        .get_or_init(|| RwLock::new(None))
        .write()
        .map(|mut installed| *installed = Some(observer))
        .is_ok()
}

pub fn clear_native_speech_lifecycle_observer() -> bool {
    let Some(observer) = OBSERVER.get() else {
        return true;
    };
    observer
        .write()
        .map(|mut installed| *installed = None)
        .is_ok()
}

pub fn native_speech_lifecycle_observer_enabled() -> bool {
    OBSERVER
        .get()
        .and_then(|slot| slot.read().ok().map(|installed| installed.is_some()))
        .unwrap_or(false)
}

/// Emits only when a native observer is installed. Callback failures and
/// panics are isolated from the business operation.
pub fn emit_native_speech_lifecycle(event: SpeechLifecycleEventV1) {
    let Some(observer) = OBSERVER
        .get()
        .and_then(|slot| slot.read().ok().and_then(|installed| installed.clone()))
    else {
        return;
    };
    let record = NativeSpeechLifecycleRecordV1 {
        boundary: event,
        monotonic_ns: PROCESS_MONOTONIC_ORIGIN
            .get_or_init(Instant::now)
            .elapsed()
            .as_nanos()
            .to_string(),
        boot_id: Some(process_start_id().clone()),
        clock_domain: "native_process_start_monotonic".to_owned(),
        redacted: true,
    };
    let _ = catch_unwind(AssertUnwindSafe(|| observer.observe(record)));
}

fn process_start_id() -> &'static String {
    PROCESS_START_ID.get_or_init(|| {
        let wall_clock_start = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |duration| duration.as_nanos());
        let identity = format!("{}-{wall_clock_start}", std::process::id());
        Sha256::digest(identity.as_bytes())[..16]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<Vec<_>>()
            .join("")
    })
}

#[cfg(test)]
#[derive(Default)]
pub struct BoundedSpeechLifecycleTestSink {
    events: Mutex<VecDeque<NativeSpeechLifecycleRecordV1>>,
    regular_bytes: Mutex<usize>,
    reserved_bytes: Mutex<usize>,
    dropped: Mutex<u64>,
    dropped_detail: Mutex<[u64; 29]>,
}

#[cfg(test)]
impl BoundedSpeechLifecycleTestSink {
    pub fn events(&self) -> Vec<NativeSpeechLifecycleRecordV1> {
        self.events
            .lock()
            .map(|events| events.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn dropped_count(&self) -> u64 {
        self.dropped.lock().map(|count| *count).unwrap_or_default()
    }

    pub fn dropped_detail(&self) -> [u64; 29] {
        self.dropped_detail
            .lock()
            .map(|counts| *counts)
            .unwrap_or_default()
    }
}

#[cfg(test)]
impl NativeSpeechLifecycleObserver for BoundedSpeechLifecycleTestSink {
    fn observe(&self, mut event: NativeSpeechLifecycleRecordV1) -> Result<(), ()> {
        let reserved = is_reserved(event.boundary.event);
        let mut events = self.events.lock().map_err(|_| ())?;
        let mut total = self.regular_bytes.lock().map_err(|_| ())?;
        let mut reserved_total = self.reserved_bytes.lock().map_err(|_| ())?;
        event.boundary.dropped_count = self.dropped.lock().map(|count| *count).unwrap_or_default();
        let bytes = serialized_size(&event);
        let reserved_count = events
            .iter()
            .filter(|entry| is_reserved(entry.boundary.event))
            .count();
        let regular_count = events.len().saturating_sub(reserved_count);
        let fits = if reserved {
            reserved_count < RESERVED_EVENT_CAPACITY
                && reserved_total.saturating_add(bytes) <= RESERVED_BYTE_CAPACITY
        } else {
            regular_count < MAX_TEST_EVENTS - RESERVED_EVENT_CAPACITY
                && total.saturating_add(bytes) <= MAX_TEST_BYTES - RESERVED_BYTE_CAPACITY
        };
        if !fits {
            if let Ok(mut count) = self.dropped.lock() {
                *count = count.saturating_add(1);
                event.boundary.dropped_count = *count;
            }
            if let Ok(mut detail) = self.dropped_detail.lock() {
                let index = event.boundary.event as usize;
                if let Some(count) = detail.get_mut(index) {
                    *count = count.saturating_add(1);
                }
            }
            return Ok(());
        }
        if reserved {
            *reserved_total = reserved_total.saturating_add(bytes);
        } else {
            *total = total.saturating_add(bytes);
        }
        events.push_back(event);
        Ok(())
    }
}

fn is_reserved(event: SpeechLifecycleEventKind) -> bool {
    matches!(
        event,
        SpeechLifecycleEventKind::ActionAdmitted
            | SpeechLifecycleEventKind::AdmissionStarted
            | SpeechLifecycleEventKind::AdmissionEnded
            | SpeechLifecycleEventKind::Terminal
    )
}

#[cfg(test)]
fn serialized_size(event: &NativeSpeechLifecycleRecordV1) -> usize {
    serde_json::to_vec(event).map_or(MAX_TEST_BYTES.saturating_add(1), |bytes| bytes.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use aurora_voice_core::{Generation, SpeechLifecycleReason, SpeechLifecycleStage};

    fn event(kind: SpeechLifecycleEventKind) -> NativeSpeechLifecycleRecordV1 {
        NativeSpeechLifecycleRecordV1 {
            boundary: SpeechLifecycleEventV1 {
                event: kind,
                operation_id: "voice-session-test-1".to_owned(),
                attempt_id: "voice-request-test-1".to_owned(),
                generation: Generation(1),
                stage: SpeechLifecycleStage::Capture,
                route_revision: Some("1".to_owned()),
                config_revision: None,
                outcome: SpeechLifecycleOutcome::Started,
                reason_code: Some(SpeechLifecycleReason::Accepted),
                byte_count: None,
                sample_count: Some(160),
                chunk_count: None,
                dropped_count: 0,
            },
            monotonic_ns: "1".to_owned(),
            boot_id: None,
            clock_domain: "native_process_start_monotonic".to_owned(),
            redacted: true,
        }
    }

    #[test]
    fn disabled_observer_is_a_noop_and_callback_failure_isolated() {
        clear_native_speech_lifecycle_observer();
        emit_native_speech_lifecycle(event(SpeechLifecycleEventKind::ActionAdmitted).boundary);
        assert!(PROCESS_MONOTONIC_ORIGIN.get().is_none());
        let observed = Arc::new(Mutex::new(None));
        let observed_by_sink = Arc::clone(&observed);
        assert!(install_native_speech_lifecycle_observer(Arc::new(
            move |record| {
                if let Ok(mut slot) = observed_by_sink.lock() {
                    *slot = Some(record);
                }
                Ok(())
            }
        )));
        emit_native_speech_lifecycle(event(SpeechLifecycleEventKind::ActionAdmitted).boundary);
        assert!(PROCESS_MONOTONIC_ORIGIN.get().is_some());
        let record = observed
            .lock()
            .expect("record lock")
            .clone()
            .expect("installed observer receives the event");
        assert!(record
            .monotonic_ns
            .bytes()
            .all(|byte| byte.is_ascii_digit()));
        assert_eq!(record.boot_id.as_deref().map(str::len), Some(32));
        assert_eq!(record.clock_domain, "native_process_start_monotonic");
        assert!(record.redacted);
        assert!(install_native_speech_lifecycle_observer(Arc::new(|_| Err(
            ()
        ))));
        emit_native_speech_lifecycle(event(SpeechLifecycleEventKind::ActionAdmitted).boundary);
        assert!(clear_native_speech_lifecycle_observer());
    }

    #[test]
    fn payload_type_serializes_only_allowlisted_fields() {
        let serialized = serde_json::to_string(&event(SpeechLifecycleEventKind::Terminal))
            .expect("typed record serializes");
        for forbidden in ["transcript", "prompt", "pcm", "token", "path", "secret"] {
            assert!(!serialized.contains(forbidden));
        }
        assert!(serialized.contains("monotonic_ns"));
        assert!(serialized.contains("route_revision"));
        assert!(serialized.contains("\"outcome\":\"started\""));
        assert!(serialized.contains("\"redacted\":true"));
    }

    #[test]
    fn bounded_sink_retains_drop_details_and_reserves_terminal_capacity() {
        let sink = BoundedSpeechLifecycleTestSink::default();
        for _ in 0..MAX_TEST_EVENTS {
            sink.observe(event(SpeechLifecycleEventKind::ModelInvokeStart))
                .expect("observer callback");
        }
        assert_eq!(
            sink.events().len(),
            MAX_TEST_EVENTS - RESERVED_EVENT_CAPACITY
        );
        assert_eq!(sink.dropped_count(), RESERVED_EVENT_CAPACITY as u64);
        sink.observe(event(SpeechLifecycleEventKind::Terminal))
            .expect("reserved terminal is retained");
        assert!(sink
            .events()
            .iter()
            .any(|record| record.boundary.event == SpeechLifecycleEventKind::Terminal));
        assert_eq!(
            sink.dropped_detail()[SpeechLifecycleEventKind::ModelInvokeStart as usize],
            32
        );
        assert!(sink.events().iter().all(|record| {
            record
                .monotonic_ns
                .bytes()
                .all(|byte| byte.is_ascii_digit())
                && record.monotonic_ns.len() <= 32
        }));

        let byte_limited_sink = BoundedSpeechLifecycleTestSink::default();
        let mut oversized = event(SpeechLifecycleEventKind::ModelInvokeStart);
        oversized.boundary.operation_id = "x".repeat(MAX_TEST_BYTES);
        byte_limited_sink
            .observe(oversized)
            .expect("oversized detail is dropped safely");
        assert!(byte_limited_sink.events().is_empty());
        assert_eq!(byte_limited_sink.dropped_count(), 1);
    }
}
