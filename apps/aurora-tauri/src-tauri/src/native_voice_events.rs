//! Adapts native voice observations to the app's shared event stream.

use std::sync::Arc;

use aurora_voice_native::{
    install_native_voice_observation_sink, NativeVoiceObservation, NativeVoiceTurnIds,
};
use serde_json::json;

use crate::native_event_hub::{
    global_native_event_hub, native_event_timestamp_now, NativeEventDraft, NativeEventHub,
    NativeEventSubjectSnapshot, ASSISTANT_COMPLETED, ASSISTANT_DELTA, ASSISTANT_FAILED,
};

/// Capture the profile epoch at installation, never at asynchronous delivery.
pub fn install() {
    let epoch = global_native_event_hub().source_epoch();
    install_native_voice_observation_sink(Arc::new(move |observation| {
        publish_observation(global_native_event_hub(), epoch, observation);
    }));
}

fn publish_observation(hub: &NativeEventHub, epoch: u64, observation: NativeVoiceObservation) {
    let (ids, kind, mut snapshot, mut payload) = match observation {
        NativeVoiceObservation::TurnSnapshot { snapshot } => {
            let kind = lifecycle_kind(&snapshot.status, snapshot.terminal);
            let ids = snapshot.ids;
            let mut state = subject_snapshot(&ids, kind, &snapshot.status);
            state.transcript = snapshot.transcript;
            state.transcript_truncated = snapshot.transcript_truncated;
            state.accumulated_text = snapshot.accumulated_text;
            state.text_truncated = snapshot.text_truncated;
            state.terminal = snapshot.terminal;
            state.persisted = snapshot.persisted;
            state.persistence_error_code = snapshot.persistence_error_code;
            let payload = json!({
                "transcript": state.transcript,
                "transcriptTruncated": state.transcript_truncated,
                "accumulatedText": state.accumulated_text,
                "textTruncated": snapshot.text_truncated,
                "status": state.status,
                "terminal": state.terminal,
                "persisted": state.persisted,
                "persistenceErrorCode": state.persistence_error_code,
            });
            (ids, kind, state, payload)
        }
        NativeVoiceObservation::AssistantDelta {
            ids,
            sequence,
            delta,
            accumulated_text,
            text_truncated,
        } => {
            let mut state = subject_snapshot(&ids, ASSISTANT_DELTA, "requesting");
            state.accumulated_text = Some(accumulated_text.clone());
            state.text_truncated = text_truncated;
            let payload = json!({
                "textDelta": delta,
                "accumulatedText": accumulated_text,
                "sequence": sequence,
                "textTruncated": text_truncated,
            });
            (ids, ASSISTANT_DELTA, state, payload)
        }
        NativeVoiceObservation::AssistantCompleted {
            ids,
            sequence,
            final_text,
            text_truncated,
        } => {
            let mut state = subject_snapshot(&ids, ASSISTANT_COMPLETED, "completed");
            state.accumulated_text = Some(final_text.clone());
            state.text_truncated = text_truncated;
            state.terminal = true;
            let payload = json!({
                "assistantText": final_text,
                "sequence": sequence,
                "terminal": true,
                "textTruncated": text_truncated,
            });
            (ids, ASSISTANT_COMPLETED, state, payload)
        }
        NativeVoiceObservation::AssistantFailed { ids, reason_code } => {
            let mut state = subject_snapshot(&ids, ASSISTANT_FAILED, "failed");
            state.terminal = true;
            let payload = json!({ "errorCode": reason_code, "terminal": true });
            (ids, ASSISTANT_FAILED, state, payload)
        }
    };
    payload["generation"] = json!(ids.generation.0);
    payload["sessionId"] = json!(ids.session_id);
    payload["requestId"] = json!(ids.request_id);
    payload["correlationId"] = json!(ids.correlation_id);
    payload["conversationId"] = json!(ids.conversation_id);
    // All phases of one voice generation share one subject, even before the
    // assistant request and final persisted conversation IDs become available.
    snapshot.subject = format!("voice:{}", ids.generation.0);
    let mut draft = NativeEventDraft::new(kind, payload)
        .topic("Voice.Turn")
        .subjects(ids.subjects());
    if let Some(correlation_id) = ids.correlation_id {
        draft = draft.correlation_id(correlation_id);
    }
    hub.publish_observation_if_epoch(epoch, draft, Some(snapshot));
}

fn subject_snapshot(
    ids: &NativeVoiceTurnIds,
    kind: &str,
    status: &str,
) -> NativeEventSubjectSnapshot {
    NativeEventSubjectSnapshot {
        peer_id: None,
        subject: format!("voice:{}", ids.generation.0),
        kind: kind.to_owned(),
        generation: Some(ids.generation.0),
        session_id: ids.session_id.clone(),
        request_id: ids.request_id.clone(),
        correlation_id: ids.correlation_id.clone(),
        conversation_id: ids.conversation_id.clone(),
        transcript: None,
        transcript_truncated: false,
        accumulated_text: None,
        text_truncated: false,
        status: status.to_owned(),
        terminal: false,
        persisted: None,
        persistence_error_code: None,
        updated_at: native_event_timestamp_now(),
    }
}

fn lifecycle_kind(status: &str, terminal: bool) -> &'static str {
    match status {
        "failed" | "background_failed" | "persistence_failed" => "voice.turn.failed",
        "persisted" | "background_completed" | "completed" | "finalized" => "voice.turn.finalized",
        "speaking" => "voice.turn.speaking",
        "transcribed" | "processing" | "requesting" | "responding" => "voice.turn.requesting",
        "transcribing" | "listening" => "voice.turn.transcribing",
        _ if terminal => "voice.turn.finalized",
        _ => "voice.turn.started",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_event_hub::NativeEventFilter;
    use aurora_voice_native::NativeVoiceTurnSnapshot;

    #[test]
    fn observations_keep_user_and_assistant_text_distinct_through_persistence() {
        let hub = NativeEventHub::new(1);
        let epoch = hub.source_epoch();
        let ids: NativeVoiceTurnIds = serde_json::from_value(json!({
            "generation": 7, "sessionId": null, "requestId": "request-7",
            "correlationId": "correlation-7", "conversationId": null,
        }))
        .unwrap();
        let mut initial = NativeVoiceTurnSnapshot::new(ids.clone(), "transcribed");
        initial.transcript = Some("Hello".to_owned());
        publish_observation(
            &hub,
            epoch,
            NativeVoiceObservation::TurnSnapshot { snapshot: initial },
        );
        publish_observation(
            &hub,
            epoch,
            NativeVoiceObservation::AssistantDelta {
                ids: ids.clone(),
                sequence: 1,
                delta: "Welcome".to_owned(),
                accumulated_text: "Welcome".to_owned(),
                text_truncated: false,
            },
        );
        let final_state = NativeVoiceTurnSnapshot::new(ids, "persisted")
            .terminal(true)
            .persistence(Some("conversation-7".to_owned()), true, None);
        publish_observation(
            &hub,
            epoch,
            NativeVoiceObservation::TurnSnapshot {
                snapshot: final_state,
            },
        );
        let snapshot = hub.state_snapshot(NativeEventFilter::default());
        assert_eq!(snapshot.subjects.len(), 1);
        assert_eq!(snapshot.subjects[0].transcript.as_deref(), Some("Hello"));
        assert_eq!(
            snapshot.subjects[0].accumulated_text.as_deref(),
            Some("Welcome")
        );
        assert_eq!(snapshot.subjects[0].persisted, Some(true));
        assert_eq!(
            snapshot.subjects[0].conversation_id.as_deref(),
            Some("conversation-7")
        );
    }

    #[test]
    fn profile_reset_rejects_both_event_and_snapshot_from_old_observer() {
        let hub = NativeEventHub::new(4);
        let epoch = hub.source_epoch();
        hub.reset_for_profile_change();
        let ids = serde_json::from_value(json!({ "generation": 1 })).unwrap();
        publish_observation(
            &hub,
            epoch,
            NativeVoiceObservation::AssistantFailed {
                ids,
                reason_code: "cancelled".to_owned(),
            },
        );
        let snapshot = hub.state_snapshot(NativeEventFilter::default());
        assert!(snapshot.events.is_empty());
        assert!(snapshot.subjects.is_empty());
    }
}
