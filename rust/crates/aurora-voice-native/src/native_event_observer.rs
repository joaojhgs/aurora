//! Process-local observation bridge for native voice turns.
//!
//! This crate cannot depend on the Tauri native event hub without creating a
//! cycle, so it exposes redacted, data-only observations. The Tauri shell
//! installs a callback that maps these observations into the single
//! NativeEventHub owned by the app.

use aurora_voice_core::Generation;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex, OnceLock};

pub const MAX_OBSERVED_TEXT_BYTES: usize = 8 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeVoiceObservationToken {
    sink_generation: u64,
    token_id: u64,
}

impl NativeVoiceObservationToken {
    pub fn to_wire(self) -> String {
        format!("{}:{}", self.sink_generation, self.token_id)
    }

    pub fn from_wire(value: &str) -> Option<Self> {
        let (sink_generation, token_id) = value.split_once(':')?;
        Some(Self {
            sink_generation: sink_generation.parse().ok()?,
            token_id: token_id.parse().ok()?,
        })
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeVoiceTurnIds {
    pub generation: Generation,
    pub session_id: Option<String>,
    pub request_id: Option<String>,
    pub correlation_id: Option<String>,
    pub conversation_id: Option<String>,
}

impl NativeVoiceTurnIds {
    pub fn from_generation(generation: Generation) -> Self {
        Self {
            generation,
            session_id: None,
            request_id: None,
            correlation_id: None,
            conversation_id: None,
        }
    }

    pub fn with_assistant_ids(
        generation: Generation,
        session_id: impl Into<String>,
        request_id: impl Into<String>,
        correlation_id: impl Into<String>,
    ) -> Self {
        Self {
            generation,
            session_id: Some(session_id.into()),
            request_id: Some(request_id.into()),
            correlation_id: Some(correlation_id.into()),
            conversation_id: None,
        }
    }

    pub fn primary_subject(&self) -> String {
        format!("voice:{}", self.generation.0)
    }

    pub fn subjects(&self) -> Vec<String> {
        let mut subjects = vec![format!("voice:{}", self.generation.0)];
        for value in [
            self.session_id.as_ref(),
            self.request_id.as_ref(),
            self.correlation_id.as_ref(),
            self.conversation_id.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            if !subjects.iter().any(|subject| subject == value) {
                subjects.push(value.clone());
            }
        }
        subjects
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeVoiceTurnSnapshot {
    pub ids: NativeVoiceTurnIds,
    pub subjects: Vec<String>,
    pub status: String,
    pub transcript: Option<String>,
    pub transcript_truncated: bool,
    pub accumulated_text: Option<String>,
    pub text_truncated: bool,
    pub terminal: bool,
    pub persisted: Option<bool>,
    pub persistence_error_code: Option<String>,
}

impl NativeVoiceTurnSnapshot {
    pub fn new(ids: NativeVoiceTurnIds, status: impl Into<String>) -> Self {
        let subjects = ids.subjects();
        Self {
            ids,
            subjects,
            status: status.into(),
            transcript: None,
            transcript_truncated: false,
            accumulated_text: None,
            text_truncated: false,
            terminal: false,
            persisted: None,
            persistence_error_code: None,
        }
    }

    pub fn with_text(mut self, text: &str) -> Self {
        let (text, truncated) = bound_observed_text(text);
        self.accumulated_text = Some(text);
        self.text_truncated = truncated;
        self
    }

    pub fn with_transcript(mut self, transcript: &str) -> Self {
        let (transcript, truncated) = bound_observed_text(transcript);
        self.transcript = Some(transcript);
        self.transcript_truncated = truncated;
        self
    }

    pub fn terminal(mut self, terminal: bool) -> Self {
        self.terminal = terminal;
        self
    }

    pub fn persistence(
        mut self,
        conversation_id: Option<String>,
        persisted: bool,
        persistence_error_code: Option<String>,
    ) -> Self {
        self.ids.conversation_id = conversation_id;
        self.subjects = self.ids.subjects();
        self.persisted = Some(persisted);
        self.persistence_error_code = persistence_error_code;
        self
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NativeVoiceObservation {
    TurnSnapshot {
        snapshot: NativeVoiceTurnSnapshot,
    },
    AssistantDelta {
        ids: NativeVoiceTurnIds,
        sequence: u64,
        delta: String,
        accumulated_text: String,
        text_truncated: bool,
    },
    AssistantCompleted {
        ids: NativeVoiceTurnIds,
        sequence: u64,
        final_text: String,
        text_truncated: bool,
    },
    AssistantFailed {
        ids: NativeVoiceTurnIds,
        reason_code: String,
    },
}

pub trait NativeVoiceObservationSink: Send + Sync {
    fn observe(&self, observation: NativeVoiceObservation);
}

impl<F> NativeVoiceObservationSink for F
where
    F: Fn(NativeVoiceObservation) + Send + Sync,
{
    fn observe(&self, observation: NativeVoiceObservation) {
        self(observation);
    }
}

#[derive(Default)]
struct ObserverState {
    sink_generation: u64,
    next_token_id: u64,
    sink: Option<Arc<dyn NativeVoiceObservationSink>>,
}

static OBSERVER: OnceLock<Mutex<ObserverState>> = OnceLock::new();

pub fn install_native_voice_observation_sink(sink: Arc<dyn NativeVoiceObservationSink>) -> u64 {
    match OBSERVER
        .get_or_init(|| Mutex::new(ObserverState::default()))
        .lock()
    {
        Ok(mut state) => {
            state.sink_generation = state.sink_generation.saturating_add(1).max(1);
            state.next_token_id = 0;
            state.sink = Some(sink);
            state.sink_generation
        }
        Err(_) => 0,
    }
}

pub fn clear_native_voice_observation_sink() -> u64 {
    let Some(slot) = OBSERVER.get() else {
        return 0;
    };
    match slot.lock() {
        Ok(mut state) => {
            state.sink_generation = state.sink_generation.saturating_add(1).max(1);
            state.next_token_id = 0;
            state.sink = None;
            state.sink_generation
        }
        Err(_) => 0,
    }
}

pub fn begin_native_voice_observation_producer() -> Option<NativeVoiceObservationToken> {
    let mut state = OBSERVER
        .get_or_init(|| Mutex::new(ObserverState::default()))
        .lock()
        .ok()?;
    if state.sink.is_none() || state.sink_generation == 0 {
        return None;
    }
    state.next_token_id = state.next_token_id.saturating_add(1).max(1);
    Some(NativeVoiceObservationToken {
        sink_generation: state.sink_generation,
        token_id: state.next_token_id,
    })
}

pub fn emit_native_voice_observation(
    token: NativeVoiceObservationToken,
    observation: NativeVoiceObservation,
) {
    observe_native_voice(token, observation);
}

pub fn emit_native_voice_observation_from_wire(
    token_wire: &str,
    observation: NativeVoiceObservation,
) {
    let Some(token) = NativeVoiceObservationToken::from_wire(token_wire) else {
        return;
    };
    observe_native_voice(token, observation);
}

pub(crate) fn observe_native_voice(
    token: NativeVoiceObservationToken,
    observation: NativeVoiceObservation,
) {
    let Some(sink) = OBSERVER
        .get_or_init(|| Mutex::new(ObserverState::default()))
        .lock()
        .ok()
        .and_then(|state| {
            if state.sink_generation == token.sink_generation {
                state.sink.as_ref().cloned()
            } else {
                None
            }
        })
    else {
        return;
    };
    sink.observe(observation);
}

pub(crate) fn bound_observed_text(text: &str) -> (String, bool) {
    if text.len() <= MAX_OBSERVED_TEXT_BYTES {
        return (text.to_owned(), false);
    }
    let mut end = MAX_OBSERVED_TEXT_BYTES;
    while !text.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    (text[..end].to_owned(), true)
}
