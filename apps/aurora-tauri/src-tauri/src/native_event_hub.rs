use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Notify;

pub const DEFAULT_REPLAY_CAPACITY: usize = 256;
pub const DEFAULT_SUBSCRIBER_CAPACITY: usize = 64;
pub const DEFAULT_SUBJECT_SNAPSHOT_CAPACITY: usize = 64;
const CLEARED_SUBJECT_GAP_RETENTION_LIMIT: usize = 256;

pub const ASSISTANT_DELTA: &str = "assistant.delta";
pub const ASSISTANT_TOOL: &str = "assistant.tool";
pub const ASSISTANT_COMPLETED: &str = "assistant.completed";
pub const ASSISTANT_FAILED: &str = "assistant.failed";
pub const MESH_PEER_STATE_CHANGED: &str = "mesh.peer.state_changed";
pub const NATIVE_EVENTS_GAP: &str = "native.events.gap";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeEventDelivery {
    Guaranteed,
    Lossy,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeEventFilter {
    #[serde(default)]
    pub kinds: Vec<String>,
    #[serde(default)]
    pub topics: Vec<String>,
    #[serde(default)]
    pub subjects: Vec<String>,
    #[serde(default)]
    pub after_sequence: Option<u64>,
}

impl NativeEventFilter {
    pub fn kinds(kinds: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            kinds: kinds.into_iter().map(Into::into).collect(),
            ..Self::default()
        }
    }

    fn compiled(&self) -> CompiledNativeEventFilter {
        CompiledNativeEventFilter {
            kinds: self.kinds.iter().cloned().collect(),
            topics: self.topics.iter().cloned().collect(),
            subjects: self.subjects.iter().cloned().collect(),
            after_sequence: self.after_sequence,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRedactionMetadata {
    pub secrets_redacted: bool,
    pub redacted_fields: Vec<String>,
    pub source: String,
    pub warnings: Vec<String>,
}

impl Default for NativeRedactionMetadata {
    fn default() -> Self {
        Self {
            secrets_redacted: true,
            redacted_fields: Vec::new(),
            source: "transport".to_owned(),
            warnings: Vec::new(),
        }
    }
}

impl NativeRedactionMetadata {
    fn with_fields(mut fields: Vec<String>) -> Self {
        fields.sort();
        fields.dedup();
        Self {
            redacted_fields: fields,
            ..Self::default()
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeAuditReceipt {
    pub correlation_id: Option<String>,
    pub event_kind: Option<String>,
    pub peer_id: Option<String>,
    pub principal_id: Option<String>,
    pub target_peer_id: Option<String>,
    pub method: Option<String>,
    pub bus_topic: Option<String>,
    pub tool_id: Option<String>,
    pub resource_id: Option<String>,
    pub status: Option<String>,
    pub transport: Option<String>,
    pub redaction: NativeRedactionMetadata,
}

impl NativeAuditReceipt {
    fn new(kind: &str) -> Self {
        Self {
            correlation_id: None,
            event_kind: Some(kind.to_owned()),
            peer_id: None,
            principal_id: None,
            target_peer_id: None,
            method: None,
            bus_topic: None,
            tool_id: None,
            resource_id: None,
            status: None,
            transport: Some("native".to_owned()),
            redaction: NativeRedactionMetadata::default(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeAuroraEvent {
    pub sequence: u64,
    pub id: Option<String>,
    pub kind: String,
    pub topic: Option<String>,
    pub method: Option<String>,
    pub bus_topic: Option<String>,
    pub payload: Value,
    pub audit: NativeAuditReceipt,
    pub redaction: NativeRedactionMetadata,
    pub received_at: String,
    #[serde(default)]
    pub subjects: Vec<String>,
    pub delivery: NativeEventDelivery,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeEventSubjectSnapshot {
    pub subject: String,
    pub peer_id: Option<String>,
    pub kind: String,
    pub generation: Option<u64>,
    pub session_id: Option<String>,
    pub request_id: Option<String>,
    pub correlation_id: Option<String>,
    pub conversation_id: Option<String>,
    pub transcript: Option<String>,
    pub transcript_truncated: bool,
    pub accumulated_text: Option<String>,
    pub text_truncated: bool,
    pub status: String,
    pub terminal: bool,
    pub persisted: Option<bool>,
    pub persistence_error_code: Option<String>,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeEventStateSnapshot {
    pub events: Vec<NativeAuroraEvent>,
    pub last_sequence_id: Option<String>,
    pub replay_complete: bool,
    pub subjects: Vec<NativeEventSubjectSnapshot>,
}

#[derive(Clone, Debug)]
pub struct NativeEventDraft {
    kind: String,
    topic: Option<String>,
    method: Option<String>,
    bus_topic: Option<String>,
    payload: Value,
    audit: NativeAuditReceipt,
    subjects: Vec<String>,
    delivery: NativeEventDelivery,
}

impl NativeEventDraft {
    pub fn new(kind: impl Into<String>, payload: Value) -> Self {
        let kind = kind.into();
        Self {
            audit: NativeAuditReceipt::new(&kind),
            kind,
            topic: None,
            method: None,
            bus_topic: None,
            payload,
            subjects: Vec::new(),
            delivery: NativeEventDelivery::Guaranteed,
        }
    }

    pub fn topic(mut self, topic: impl Into<String>) -> Self {
        self.topic = Some(topic.into());
        self
    }

    pub fn method(mut self, method: impl Into<String>) -> Self {
        self.method = Some(method.into());
        self
    }

    pub fn bus_topic(mut self, bus_topic: impl Into<String>) -> Self {
        self.bus_topic = Some(bus_topic.into());
        self
    }

    pub fn correlation_id(mut self, correlation_id: impl Into<String>) -> Self {
        self.audit.correlation_id = Some(correlation_id.into());
        self
    }

    pub fn peer_id(mut self, peer_id: impl Into<String>) -> Self {
        self.audit.peer_id = Some(peer_id.into());
        self
    }

    pub fn target_peer_id(mut self, peer_id: impl Into<String>) -> Self {
        self.audit.target_peer_id = Some(peer_id.into());
        self
    }

    pub fn status(mut self, status: impl Into<String>) -> Self {
        self.audit.status = Some(status.into());
        self
    }

    pub fn redaction(mut self, redaction: NativeRedactionMetadata) -> Self {
        self.audit.redaction = redaction;
        self
    }

    pub fn subject(mut self, subject: impl Into<String>) -> Self {
        self.subjects.push(subject.into());
        self
    }

    pub fn subjects(mut self, subjects: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.subjects.extend(subjects.into_iter().map(Into::into));
        self
    }

    pub fn delivery(mut self, delivery: NativeEventDelivery) -> Self {
        self.delivery = delivery;
        self
    }

    fn into_event(self, sequence: u64) -> NativeAuroraEvent {
        let id = Some(format!("native:{sequence}"));
        let received_at = now_rfc3339_millis();
        let redaction = self.audit.redaction.clone();
        NativeAuroraEvent {
            sequence,
            id,
            kind: self.kind,
            topic: self.topic,
            method: self.method,
            bus_topic: self.bus_topic,
            payload: self.payload,
            audit: self.audit,
            redaction,
            received_at,
            subjects: self.subjects,
            delivery: self.delivery,
        }
    }
}

#[derive(Clone)]
pub struct NativeEventHub {
    inner: Arc<Mutex<NativeEventHubInner>>,
}

#[derive(Clone, Debug)]
pub struct NativeEventPeerPublicationLease {
    peer_id: String,
    state: Arc<NativeEventPeerPublicationLeaseState>,
}

#[derive(Debug)]
struct NativeEventPeerPublicationLeaseState {
    revoked: AtomicBool,
}

impl NativeEventPeerPublicationLease {
    pub fn peer_id(&self) -> &str {
        &self.peer_id
    }

    pub fn is_revoked(&self) -> bool {
        self.state.revoked.load(Ordering::Acquire)
    }
}

impl Default for NativeEventHub {
    fn default() -> Self {
        Self::new(DEFAULT_REPLAY_CAPACITY)
    }
}

impl NativeEventHub {
    pub fn new(replay_capacity: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(NativeEventHubInner {
                next_sequence: 1,
                replay_capacity: replay_capacity.max(1),
                replay: VecDeque::new(),
                subject_snapshot_capacity: DEFAULT_SUBJECT_SNAPSHOT_CAPACITY,
                subject_snapshots: HashMap::new(),
                subject_snapshot_order: VecDeque::new(),
                cleared_subject_sequences: HashMap::new(),
                cleared_subject_order: VecDeque::new(),
                peer_publication_leases: HashMap::new(),
                epoch: 1,
                subscribers: Vec::new(),
                next_subscriber_id: 1,
            })),
        }
    }

    pub fn next_sequence(&self) -> u64 {
        self.inner.lock().expect("native event hub").next_sequence
    }

    pub fn source_epoch(&self) -> u64 {
        self.inner.lock().expect("native event hub").epoch
    }

    pub fn subscribe(&self, filter: NativeEventFilter) -> NativeEventSubscription {
        self.subscribe_with_capacity(filter, DEFAULT_SUBSCRIBER_CAPACITY)
    }

    pub fn subscribe_with_capacity(
        &self,
        filter: NativeEventFilter,
        capacity: usize,
    ) -> NativeEventSubscription {
        let compiled = filter.compiled();
        let capacity = capacity.max(1);
        let mut inner = self.inner.lock().expect("native event hub");
        inner.prune_dropped_subscribers();

        let id = inner.next_subscriber_id;
        inner.next_subscriber_id = inner.next_subscriber_id.saturating_add(1);
        let state = Arc::new(NativeEventSubscriptionState {
            id,
            hub: Arc::downgrade(&self.inner),
            notify: Notify::new(),
            handle_count: AtomicUsize::new(1),
            inner: Mutex::new(NativeEventSubscriptionInner {
                queue: VecDeque::new(),
                capacity,
                closed: false,
            }),
        });

        let replay = inner.replay_for_subscription(&compiled, capacity);
        {
            let mut subscriber = state.inner.lock().expect("native event subscriber");
            subscriber.queue.extend(replay.events);
            subscriber.closed = replay.close_after_delivery;
        }

        if !replay.close_after_delivery {
            inner.subscribers.push(NativeEventSubscriber {
                id,
                filter: compiled,
                subscription: Arc::downgrade(&state),
            });
        }

        state.notify.notify_waiters();
        NativeEventSubscription { state }
    }

    pub fn snapshot(&self, filter: NativeEventFilter) -> Vec<NativeAuroraEvent> {
        self.state_snapshot(filter).events
    }

    pub fn state_snapshot(&self, filter: NativeEventFilter) -> NativeEventStateSnapshot {
        let filter = filter.compiled();
        let mut inner = self.inner.lock().expect("native event hub");
        inner.prune_dropped_subscribers();
        let latest_sequence = inner.next_sequence.saturating_sub(1);
        let last_sequence_id = (latest_sequence > 0).then(|| format!("native:{latest_sequence}"));
        let subjects = inner.subject_snapshots_for_filter(&filter);
        if let Some(gap) = inner.cursor_gap_for_filter(&filter) {
            return NativeEventStateSnapshot {
                events: vec![gap],
                last_sequence_id,
                replay_complete: false,
                subjects,
            };
        }
        let events = inner
            .replay
            .iter()
            .filter(|event| filter.matches(event))
            .cloned()
            .collect();
        NativeEventStateSnapshot {
            events,
            last_sequence_id,
            replay_complete: true,
            subjects,
        }
    }

    pub fn upsert_subject_snapshot(&self, snapshot: NativeEventSubjectSnapshot) {
        let mut inner = self.inner.lock().expect("native event hub");
        inner.upsert_subject_snapshot(snapshot);
    }

    pub fn remove_subject_snapshot(&self, subject: &str) {
        let mut inner = self.inner.lock().expect("native event hub");
        inner.remove_subject_snapshot(subject);
    }

    pub fn clear_subject(&self, subject: &str) {
        let mut inner = self.inner.lock().expect("native event hub");
        inner.clear_subject(subject);
    }

    pub fn clear_peer(&self, peer_id: &str) {
        let mut inner = self.inner.lock().expect("native event hub");
        inner.clear_peer(peer_id);
    }

    pub fn issue_peer_publication_lease(
        &self,
        peer_id: impl Into<String>,
    ) -> NativeEventPeerPublicationLease {
        let mut inner = self.inner.lock().expect("native event hub");
        inner.issue_peer_publication_lease(peer_id.into())
    }

    pub fn revoke_peer_publication_leases(&self, peer_id: &str) {
        let mut inner = self.inner.lock().expect("native event hub");
        inner.revoke_peer_publication_leases(peer_id);
    }

    pub async fn publish(&self, draft: NativeEventDraft) -> NativeAuroraEvent {
        self.publish_now(draft)
    }

    pub fn publish_if_epoch(
        &self,
        epoch: u64,
        draft: NativeEventDraft,
    ) -> Option<NativeAuroraEvent> {
        self.publish_observation_if_epoch(epoch, draft, None)
    }

    pub fn publish_observation_if_epoch(
        &self,
        epoch: u64,
        draft: NativeEventDraft,
        subject_snapshot: Option<NativeEventSubjectSnapshot>,
    ) -> Option<NativeAuroraEvent> {
        let mut inner = self.inner.lock().expect("native event hub");
        if inner.epoch != epoch
            || inner.draft_or_snapshot_is_peer_owned(&draft, subject_snapshot.as_ref())
        {
            return None;
        }
        if let Some(snapshot) = subject_snapshot {
            inner.merge_subject_snapshot(snapshot);
        }
        Some(inner.publish_locked(draft, false))
    }

    pub fn publish_with_peer_lease_if_epoch(
        &self,
        epoch: u64,
        lease: &NativeEventPeerPublicationLease,
        draft: NativeEventDraft,
    ) -> Option<NativeAuroraEvent> {
        self.publish_observation_with_peer_lease_if_epoch(epoch, lease, draft, None)
    }

    pub fn publish_observation_with_peer_lease_if_epoch(
        &self,
        epoch: u64,
        lease: &NativeEventPeerPublicationLease,
        draft: NativeEventDraft,
        subject_snapshot: Option<NativeEventSubjectSnapshot>,
    ) -> Option<NativeAuroraEvent> {
        let mut inner = self.inner.lock().expect("native event hub");
        if inner.epoch != epoch || !inner.peer_lease_is_active(lease) {
            return None;
        }
        if !inner.draft_and_snapshot_belong_to_peer(
            &draft,
            subject_snapshot.as_ref(),
            lease.peer_id(),
        ) {
            return None;
        }
        if let Some(snapshot) = subject_snapshot {
            inner.merge_subject_snapshot(snapshot);
        }
        Some(inner.publish_locked(draft, true))
    }

    pub fn publish_now(&self, draft: NativeEventDraft) -> NativeAuroraEvent {
        let mut inner = self.inner.lock().expect("native event hub");
        inner.publish_locked(draft, false)
    }

    pub fn reset_for_profile_change(&self) {
        let mut inner = self.inner.lock().expect("native event hub");
        inner.replay.clear();
        inner.subject_snapshots.clear();
        inner.subject_snapshot_order.clear();
        inner.cleared_subject_sequences.clear();
        inner.cleared_subject_order.clear();
        inner.revoke_all_peer_publication_leases();
        inner.peer_publication_leases.clear();
        inner.epoch = inner.epoch.saturating_add(1);
        inner.prune_dropped_subscribers();
        for subscriber in &inner.subscribers {
            if let Some(subscription) = subscriber.subscription.upgrade() {
                subscription.close_internal();
            }
        }
        inner.subscribers.clear();
    }
}

pub struct NativeEventSubscription {
    state: Arc<NativeEventSubscriptionState>,
}

impl Clone for NativeEventSubscription {
    fn clone(&self) -> Self {
        self.state.handle_count.fetch_add(1, Ordering::AcqRel);
        Self {
            state: self.state.clone(),
        }
    }
}

impl NativeEventSubscription {
    pub async fn recv(&self) -> Option<NativeAuroraEvent> {
        loop {
            let notified = self.state.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(event) = self.try_recv() {
                return Some(event);
            }
            if self.is_closed() {
                return None;
            }
            notified.await;
        }
    }

    pub fn try_recv(&self) -> Option<NativeAuroraEvent> {
        self.state.try_recv()
    }

    pub fn close(&self) {
        if let Some(hub) = self.state.hub.upgrade() {
            hub.lock()
                .expect("native event hub")
                .remove_subscriber(self.state.id);
        }
        self.state.close_internal();
    }

    fn is_closed(&self) -> bool {
        self.state.is_closed()
    }
}

impl Drop for NativeEventSubscription {
    fn drop(&mut self) {
        if self.state.handle_count.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.close();
        }
    }
}

struct NativeEventSubscriptionState {
    id: u64,
    hub: Weak<Mutex<NativeEventHubInner>>,
    notify: Notify,
    handle_count: AtomicUsize,
    inner: Mutex<NativeEventSubscriptionInner>,
}

impl NativeEventSubscriptionState {
    fn try_recv(&self) -> Option<NativeAuroraEvent> {
        self.inner
            .lock()
            .expect("native event subscriber")
            .queue
            .pop_front()
    }

    fn is_closed(&self) -> bool {
        self.inner.lock().expect("native event subscriber").closed
    }

    fn close_internal(&self) {
        let mut inner = self.inner.lock().expect("native event subscriber");
        inner.queue.clear();
        inner.closed = true;
        self.notify.notify_waiters();
    }

    fn close_if_subject_cleared(
        &self,
        subject: &str,
        latest_sequence: u64,
        explicitly_subscribed: bool,
    ) -> bool {
        let mut inner = self.inner.lock().expect("native event subscriber");
        if !explicitly_subscribed
            && !inner
                .queue
                .iter()
                .any(|event| event.subjects.iter().any(|candidate| candidate == subject))
        {
            return false;
        }
        let first_missing = inner
            .queue
            .front()
            .map(|event| event.sequence)
            .unwrap_or_else(|| latest_sequence.saturating_add(1));
        inner.queue.clear();
        inner.queue.push_back(gap_event(
            first_missing.saturating_sub(1),
            first_missing,
            latest_sequence.saturating_add(1),
            "subject_cleared",
        ));
        inner.closed = true;
        self.notify.notify_waiters();
        true
    }

    fn close_if_peer_cleared(
        &self,
        peer_id: &str,
        subjects: &HashSet<String>,
        peer_owned_snapshot_subjects: &HashSet<String>,
        latest_sequence: u64,
        explicitly_subscribed: bool,
    ) -> bool {
        let mut inner = self.inner.lock().expect("native event subscriber");
        if !explicitly_subscribed
            && !inner.queue.iter().any(|event| {
                native_event_matches_cleared_peer_scope(
                    event,
                    peer_id,
                    subjects,
                    peer_owned_snapshot_subjects,
                )
            })
        {
            return false;
        }
        let first_missing = inner
            .queue
            .front()
            .map(|event| event.sequence)
            .unwrap_or_else(|| latest_sequence.saturating_add(1));
        inner.queue.clear();
        inner.queue.push_back(gap_event(
            first_missing.saturating_sub(1),
            first_missing,
            latest_sequence.saturating_add(1),
            "subject_cleared",
        ));
        inner.closed = true;
        self.notify.notify_waiters();
        true
    }

    fn push_or_gap(&self, event: NativeAuroraEvent) -> bool {
        let mut inner = self.inner.lock().expect("native event subscriber");
        if inner.closed {
            return false;
        }
        if inner.queue.len() >= inner.capacity {
            match event.delivery {
                NativeEventDelivery::Guaranteed => {
                    let first_missing = inner
                        .queue
                        .front()
                        .map(|queued| queued.sequence)
                        .unwrap_or(event.sequence);
                    inner.queue.clear();
                    inner.queue.push_back(gap_event(
                        first_missing.saturating_sub(1),
                        first_missing,
                        event.sequence,
                        "subscriber_overrun",
                    ));
                    inner.closed = true;
                    self.notify.notify_waiters();
                    return false;
                }
                NativeEventDelivery::Lossy => {
                    if let Some(index) = inner
                        .queue
                        .iter()
                        .position(|queued| queued.delivery == NativeEventDelivery::Lossy)
                    {
                        inner.queue.remove(index);
                    } else {
                        return true;
                    }
                }
            }
        }
        inner.queue.push_back(event);
        self.notify.notify_one();
        true
    }
}

#[derive(Clone)]
struct NativeEventSubscriber {
    id: u64,
    filter: CompiledNativeEventFilter,
    subscription: Weak<NativeEventSubscriptionState>,
}

struct NativeEventHubInner {
    next_sequence: u64,
    replay_capacity: usize,
    replay: VecDeque<NativeAuroraEvent>,
    subject_snapshot_capacity: usize,
    subject_snapshots: HashMap<String, NativeEventSubjectSnapshot>,
    subject_snapshot_order: VecDeque<String>,
    cleared_subject_sequences: HashMap<String, u64>,
    cleared_subject_order: VecDeque<String>,
    peer_publication_leases: HashMap<String, Vec<Weak<NativeEventPeerPublicationLeaseState>>>,
    epoch: u64,
    subscribers: Vec<NativeEventSubscriber>,
    next_subscriber_id: u64,
}

impl NativeEventHubInner {
    fn publish_locked(
        &mut self,
        draft: NativeEventDraft,
        allow_peer_owned: bool,
    ) -> NativeAuroraEvent {
        self.prune_dropped_subscribers();
        let sequence = self.next_sequence;
        let event = if !allow_peer_owned && Self::draft_peer_owner(&draft).is_some() {
            peer_publication_rejected_event(sequence)
        } else {
            draft.into_event(sequence)
        };
        self.next_sequence = self.next_sequence.saturating_add(1);
        self.push_replay(event.clone());

        let mut dropped = Vec::new();
        for subscriber in &self.subscribers {
            if !subscriber.filter.matches(&event) {
                continue;
            }
            let Some(subscription) = subscriber.subscription.upgrade() else {
                dropped.push(subscriber.id);
                continue;
            };
            if !subscription.push_or_gap(event.clone()) {
                dropped.push(subscriber.id);
            }
        }
        self.subscribers.retain(|subscriber| {
            !dropped.contains(&subscriber.id) && subscriber.subscription.upgrade().is_some()
        });
        event
    }

    fn clear_subject(&mut self, subject: &str) {
        let latest_sequence = self.next_sequence.saturating_sub(1);
        self.remember_cleared_subject(subject.to_owned(), latest_sequence);
        self.remove_subject_snapshot(subject);
        self.replay
            .retain(|event| !event.subjects.iter().any(|candidate| candidate == subject));
        let mut dropped = Vec::new();
        for subscriber in &self.subscribers {
            let Some(subscription) = subscriber.subscription.upgrade() else {
                dropped.push(subscriber.id);
                continue;
            };
            if subscription.close_if_subject_cleared(
                subject,
                latest_sequence,
                subscriber.filter.subjects.contains(subject),
            ) {
                dropped.push(subscriber.id);
            }
        }
        self.subscribers
            .retain(|subscriber| !dropped.contains(&subscriber.id));
    }

    fn clear_peer(&mut self, peer_id: &str) {
        let latest_sequence = self.next_sequence.saturating_sub(1);
        self.revoke_peer_publication_leases(peer_id);
        let mut cleared_subjects = HashSet::from([peer_id.to_owned()]);
        let mut peer_owned_snapshot_subjects = HashSet::new();
        for snapshot in self.subject_snapshots.values() {
            if snapshot.peer_id.as_deref() == Some(peer_id) {
                peer_owned_snapshot_subjects.insert(snapshot.subject.clone());
                cleared_subjects.insert(snapshot.subject.clone());
            }
        }
        for event in &self.replay {
            if native_event_matches_peer(event, peer_id) {
                cleared_subjects.extend(
                    event
                        .subjects
                        .iter()
                        .filter(|subject| self.should_clear_peer_event_subject(peer_id, subject))
                        .cloned(),
                );
            }
        }
        for subject in &cleared_subjects {
            self.remember_cleared_subject(subject.clone(), latest_sequence);
        }
        let cleared_subjects_ref = &cleared_subjects;
        self.subject_snapshots.retain(|subject, snapshot| {
            snapshot.peer_id.as_deref() != Some(peer_id) && subject != peer_id
        });
        self.subject_snapshot_order
            .retain(|subject| self.subject_snapshots.contains_key(subject));
        self.replay.retain(|event| {
            !native_event_matches_cleared_peer_scope(
                event,
                peer_id,
                cleared_subjects_ref,
                &peer_owned_snapshot_subjects,
            )
        });
        let mut dropped = Vec::new();
        for subscriber in &self.subscribers {
            let Some(subscription) = subscriber.subscription.upgrade() else {
                dropped.push(subscriber.id);
                continue;
            };
            if subscription.close_if_peer_cleared(
                peer_id,
                cleared_subjects_ref,
                &peer_owned_snapshot_subjects,
                latest_sequence,
                subscriber
                    .filter
                    .subjects
                    .iter()
                    .any(|subject| cleared_subjects_ref.contains(subject)),
            ) {
                dropped.push(subscriber.id);
            }
        }
        self.subscribers
            .retain(|subscriber| !dropped.contains(&subscriber.id));
    }

    fn issue_peer_publication_lease(&mut self, peer_id: String) -> NativeEventPeerPublicationLease {
        self.prune_peer_publication_leases();
        self.revoke_peer_publication_leases(&peer_id);
        let state = Arc::new(NativeEventPeerPublicationLeaseState {
            revoked: AtomicBool::new(false),
        });
        self.peer_publication_leases
            .entry(peer_id.clone())
            .or_default()
            .push(Arc::downgrade(&state));
        NativeEventPeerPublicationLease { peer_id, state }
    }

    fn peer_lease_is_active(&mut self, lease: &NativeEventPeerPublicationLease) -> bool {
        if lease.is_revoked() {
            return false;
        }
        let lease_ptr = Arc::as_ptr(&lease.state);
        let Some((matched, empty)) =
            self.peer_publication_leases
                .get_mut(lease.peer_id())
                .map(|leases| {
                    let mut matched = false;
                    leases.retain(|weak| {
                        let Some(state) = weak.upgrade() else {
                            return false;
                        };
                        let active = !state.revoked.load(Ordering::Acquire);
                        if active && Arc::as_ptr(&state) == lease_ptr {
                            matched = true;
                        }
                        active
                    });
                    (matched, leases.is_empty())
                })
        else {
            return false;
        };
        if empty {
            self.peer_publication_leases.remove(lease.peer_id());
        }
        matched
    }

    fn revoke_peer_publication_leases(&mut self, peer_id: &str) {
        if let Some(leases) = self.peer_publication_leases.remove(peer_id) {
            for lease in leases {
                if let Some(state) = lease.upgrade() {
                    state.revoked.store(true, Ordering::Release);
                }
            }
        }
    }

    fn revoke_all_peer_publication_leases(&mut self) {
        for leases in self.peer_publication_leases.values() {
            for lease in leases {
                if let Some(state) = lease.upgrade() {
                    state.revoked.store(true, Ordering::Release);
                }
            }
        }
        self.peer_publication_leases.clear();
    }

    fn prune_peer_publication_leases(&mut self) {
        self.peer_publication_leases.retain(|_, leases| {
            leases.retain(|lease| {
                lease
                    .upgrade()
                    .is_some_and(|state| !state.revoked.load(Ordering::Acquire))
            });
            !leases.is_empty()
        });
    }

    fn remember_cleared_subject(&mut self, subject: String, sequence: u64) {
        if !self.cleared_subject_sequences.contains_key(&subject) {
            self.cleared_subject_order.push_back(subject.clone());
        }
        self.cleared_subject_sequences.insert(subject, sequence);
        self.prune_cleared_subject_gaps();
    }

    fn prune_cleared_subject_gaps(&mut self) {
        while self.cleared_subject_order.len() > CLEARED_SUBJECT_GAP_RETENTION_LIMIT {
            let Some(subject) = self.cleared_subject_order.pop_front() else {
                break;
            };
            self.cleared_subject_sequences.remove(&subject);
        }
    }

    fn draft_or_snapshot_is_peer_owned(
        &self,
        draft: &NativeEventDraft,
        snapshot: Option<&NativeEventSubjectSnapshot>,
    ) -> bool {
        Self::draft_peer_owner(draft).is_some()
            || snapshot.and_then(Self::snapshot_peer_owner).is_some()
    }

    fn draft_and_snapshot_belong_to_peer(
        &self,
        draft: &NativeEventDraft,
        snapshot: Option<&NativeEventSubjectSnapshot>,
        peer_id: &str,
    ) -> bool {
        let draft_owner = Self::draft_peer_owner(draft);
        let snapshot_owner = snapshot.and_then(Self::snapshot_peer_owner);
        let has_peer_owner = draft_owner.is_some() || snapshot_owner.is_some();
        has_peer_owner
            && draft_owner.map_or(true, |owner| owner == peer_id)
            && snapshot_owner.map_or(true, |owner| owner == peer_id)
    }

    fn draft_peer_owner(draft: &NativeEventDraft) -> Option<&str> {
        draft
            .audit
            .peer_id
            .as_deref()
            .or(draft.audit.target_peer_id.as_deref())
            .or_else(|| draft.payload.get("peerId").and_then(Value::as_str))
            .or_else(|| draft.payload.get("peer_id").and_then(Value::as_str))
    }

    fn snapshot_peer_owner(snapshot: &NativeEventSubjectSnapshot) -> Option<&str> {
        snapshot.peer_id.as_deref()
    }

    fn should_clear_peer_event_subject(&self, peer_id: &str, subject: &str) -> bool {
        if !subject.starts_with("voice:") {
            return true;
        }
        match self.subject_snapshots.get(subject) {
            Some(snapshot) => snapshot.peer_id.as_deref() == Some(peer_id),
            None => true,
        }
    }

    fn push_replay(&mut self, event: NativeAuroraEvent) {
        self.replay.push_back(event);
        while self.replay.len() > self.replay_capacity {
            self.replay.pop_front();
        }
    }

    fn upsert_subject_snapshot(&mut self, snapshot: NativeEventSubjectSnapshot) {
        if Self::snapshot_peer_owner(&snapshot).is_some() {
            return;
        }
        self.merge_subject_snapshot(snapshot);
    }

    fn merge_subject_snapshot(&mut self, mut snapshot: NativeEventSubjectSnapshot) {
        if let Some(existing) = self.subject_snapshots.get(&snapshot.subject) {
            if snapshot.peer_id.is_none() {
                snapshot.peer_id = existing.peer_id.clone();
            }
            if snapshot.generation.is_none() {
                snapshot.generation = existing.generation;
            }
            if snapshot.session_id.is_none() {
                snapshot.session_id = existing.session_id.clone();
            }
            if snapshot.request_id.is_none() {
                snapshot.request_id = existing.request_id.clone();
            }
            if snapshot.correlation_id.is_none() {
                snapshot.correlation_id = existing.correlation_id.clone();
            }
            if snapshot.conversation_id.is_none() {
                snapshot.conversation_id = existing.conversation_id.clone();
            }
            if snapshot.transcript.is_none() {
                snapshot.transcript = existing.transcript.clone();
                snapshot.transcript_truncated = existing.transcript_truncated;
            }
            if snapshot.accumulated_text.is_none() {
                snapshot.accumulated_text = existing.accumulated_text.clone();
                snapshot.text_truncated = existing.text_truncated;
            }
            if snapshot.persisted.is_none() {
                snapshot.persisted = existing.persisted;
            }
            if snapshot.persistence_error_code.is_none() {
                snapshot.persistence_error_code = existing.persistence_error_code.clone();
            }
        } else {
            self.subject_snapshot_order
                .push_back(snapshot.subject.clone());
        }
        self.subject_snapshots
            .insert(snapshot.subject.clone(), snapshot);
        while self.subject_snapshot_order.len() > self.subject_snapshot_capacity {
            if let Some(subject) = self.subject_snapshot_order.pop_front() {
                self.subject_snapshots.remove(&subject);
            }
        }
    }

    fn remove_subject_snapshot(&mut self, subject: &str) {
        self.subject_snapshots.remove(subject);
        self.subject_snapshot_order
            .retain(|candidate| candidate != subject);
    }

    fn subject_snapshots_for_filter(
        &self,
        filter: &CompiledNativeEventFilter,
    ) -> Vec<NativeEventSubjectSnapshot> {
        self.subject_snapshot_order
            .iter()
            .filter_map(|subject| self.subject_snapshots.get(subject))
            .filter(|snapshot| filter.matches_subject_snapshot(snapshot))
            .cloned()
            .collect()
    }

    fn replay_for_subscription(
        &self,
        filter: &CompiledNativeEventFilter,
        capacity: usize,
    ) -> ReplaySelection {
        if let Some(gap) = self.cursor_gap_for_filter(filter) {
            return ReplaySelection {
                events: vec![gap],
                close_after_delivery: true,
            };
        }
        let replay = self
            .replay
            .iter()
            .filter(|event| filter.matches(event))
            .cloned()
            .collect::<Vec<_>>();
        if replay.len() > capacity {
            let first_missing = replay
                .first()
                .map(|event| event.sequence)
                .unwrap_or_else(|| filter.after_sequence.unwrap_or(0).saturating_add(1));
            return ReplaySelection {
                events: vec![gap_event(
                    first_missing.saturating_sub(1),
                    first_missing,
                    replay
                        .last()
                        .map(|event| event.sequence)
                        .unwrap_or(first_missing),
                    "subscriber_capacity_exceeded",
                )],
                close_after_delivery: true,
            };
        }
        ReplaySelection {
            events: replay,
            close_after_delivery: false,
        }
    }

    fn cursor_gap_for_filter(
        &self,
        filter: &CompiledNativeEventFilter,
    ) -> Option<NativeAuroraEvent> {
        let after_sequence = filter.after_sequence?;
        for subject in &filter.subjects {
            if self
                .cleared_subject_sequences
                .get(subject)
                .is_some_and(|cleared_sequence| after_sequence < *cleared_sequence)
            {
                let cleared_sequence = self.cleared_subject_sequences[subject];
                return Some(gap_event(
                    after_sequence,
                    after_sequence.saturating_add(1),
                    cleared_sequence.saturating_add(1),
                    "subject_cleared",
                ));
            }
        }
        let earliest = self.replay.front()?.sequence;
        if after_sequence.saturating_add(1) < earliest {
            return Some(gap_event(
                after_sequence,
                after_sequence.saturating_add(1),
                earliest,
                "replay_window_expired",
            ));
        }
        None
    }

    fn remove_subscriber(&mut self, id: u64) {
        self.subscribers.retain(|subscriber| subscriber.id != id);
    }

    fn prune_dropped_subscribers(&mut self) {
        self.subscribers
            .retain(|subscriber| subscriber.subscription.upgrade().is_some());
    }
}

fn peer_publication_rejected_event(sequence: u64) -> NativeAuroraEvent {
    NativeEventDraft::new(
        NATIVE_EVENTS_GAP,
        json!({
            "reason": "peer_publication_requires_lease",
            "resumeAfterSequence": sequence.saturating_sub(1),
            "firstMissingSequence": sequence,
            "nextAvailableSequence": sequence.saturating_add(1),
        }),
    )
    .delivery(NativeEventDelivery::Guaranteed)
    .into_event(sequence)
}

fn native_event_matches_peer(event: &NativeAuroraEvent, peer_id: &str) -> bool {
    event.audit.peer_id.as_deref() == Some(peer_id)
        || event.audit.target_peer_id.as_deref() == Some(peer_id)
        || event.subjects.iter().any(|subject| subject == peer_id)
        || event.payload.get("peerId").and_then(Value::as_str) == Some(peer_id)
        || event.payload.get("peer_id").and_then(Value::as_str) == Some(peer_id)
}

fn native_event_matches_cleared_peer_scope(
    event: &NativeAuroraEvent,
    peer_id: &str,
    cleared_subjects: &HashSet<String>,
    peer_owned_snapshot_subjects: &HashSet<String>,
) -> bool {
    native_event_matches_peer(event, peer_id)
        || event.subjects.iter().any(|subject| {
            cleared_subjects.contains(subject)
                && (!subject.starts_with("voice:")
                    || peer_owned_snapshot_subjects.contains(subject))
        })
}

struct ReplaySelection {
    events: Vec<NativeAuroraEvent>,
    close_after_delivery: bool,
}

struct NativeEventSubscriptionInner {
    queue: VecDeque<NativeAuroraEvent>,
    capacity: usize,
    closed: bool,
}

#[derive(Clone, Debug)]
struct CompiledNativeEventFilter {
    kinds: HashSet<String>,
    topics: HashSet<String>,
    subjects: HashSet<String>,
    after_sequence: Option<u64>,
}

impl CompiledNativeEventFilter {
    fn matches(&self, event: &NativeAuroraEvent) -> bool {
        if self
            .after_sequence
            .is_some_and(|after_sequence| event.sequence <= after_sequence)
        {
            return false;
        }
        if !self.kinds.is_empty() && !self.kinds.contains(&event.kind) {
            return false;
        }
        if !self.topics.is_empty() {
            let Some(topic) = event.topic.as_deref().or(event.bus_topic.as_deref()) else {
                return false;
            };
            if !self.topics.contains(topic) {
                return false;
            }
        }
        self.subjects.is_empty()
            || event
                .subjects
                .iter()
                .any(|subject| self.subjects.contains(subject))
    }

    fn matches_subject_snapshot(&self, snapshot: &NativeEventSubjectSnapshot) -> bool {
        (self.kinds.is_empty() || self.kinds.contains(&snapshot.kind))
            && (self.subjects.is_empty() || self.subjects.contains(&snapshot.subject))
    }
}

pub fn global_native_event_hub() -> &'static NativeEventHub {
    static HUB: OnceLock<NativeEventHub> = OnceLock::new();
    HUB.get_or_init(NativeEventHub::default)
}

pub fn reset_global_native_event_hub_for_profile_change() {
    global_native_event_hub().reset_for_profile_change();
}

pub fn upsert_global_native_event_subject_snapshot(snapshot: NativeEventSubjectSnapshot) {
    global_native_event_hub().upsert_subject_snapshot(snapshot);
}

pub fn remove_global_native_event_subject_snapshot(subject: &str) {
    global_native_event_hub().remove_subject_snapshot(subject);
}

pub fn publish_global_native_observation_if_epoch(
    epoch: u64,
    draft: NativeEventDraft,
    subject_snapshot: Option<NativeEventSubjectSnapshot>,
) -> Option<NativeAuroraEvent> {
    global_native_event_hub().publish_observation_if_epoch(epoch, draft, subject_snapshot)
}

pub fn clear_global_native_event_subject(subject: &str) {
    global_native_event_hub().clear_subject(subject);
}

pub fn clear_global_native_event_peer(peer_id: &str) {
    global_native_event_hub().clear_peer(peer_id);
}

pub fn revoke_global_native_event_peer_publication_leases(peer_id: &str) {
    global_native_event_hub().revoke_peer_publication_leases(peer_id);
}

pub fn issue_global_native_event_peer_publication_lease(
    peer_id: impl Into<String>,
) -> NativeEventPeerPublicationLease {
    global_native_event_hub().issue_peer_publication_lease(peer_id)
}

pub fn assistant_terminal_event(
    peer_id: &str,
    request_id: &str,
    frame: &Value,
) -> Option<NativeEventDraft> {
    let frame_type = frame.get("type").and_then(Value::as_str)?;
    let (kind, status, body, redacted_fields) = match frame_type {
        "result" => {
            let (result, redacted_fields) =
                sanitize_assistant_result(frame.get("result").unwrap_or(&Value::Null));
            (
                ASSISTANT_COMPLETED,
                "ok",
                json!({ "result": result }),
                redacted_fields,
            )
        }
        "error" => {
            let (error, redacted_fields) =
                sanitize_assistant_error(frame.get("error").unwrap_or(&Value::Null));
            (
                ASSISTANT_FAILED,
                "error",
                json!({ "error": error }),
                redacted_fields,
            )
        }
        _ => return None,
    };
    let mut payload = json!({
        "requestId": request_id,
        "peerId": peer_id,
    });
    merge_object(&mut payload, assistant_link_payload(frame));
    merge_object(&mut payload, body);
    let subjects = assistant_subjects(request_id, peer_id, frame);
    Some(
        NativeEventDraft::new(kind, payload)
            .topic("Orchestrator.Response")
            .correlation_id(
                assistant_correlation_id(frame)
                    .unwrap_or(request_id)
                    .to_owned(),
            )
            .peer_id(peer_id.to_owned())
            .status(status)
            .redaction(NativeRedactionMetadata::with_fields(redacted_fields))
            .subjects(subjects),
    )
}

pub fn assistant_failure_event(
    peer_id: &str,
    request_id: &str,
    reason_code: impl Into<String>,
) -> NativeEventDraft {
    assistant_failure_event_with_link(peer_id, request_id, reason_code, None, None, None)
}

pub fn assistant_failure_event_with_link(
    peer_id: &str,
    request_id: &str,
    reason_code: impl Into<String>,
    generation: Option<u64>,
    session_id: Option<&str>,
    correlation_id: Option<&str>,
) -> NativeEventDraft {
    let reason_code = reason_code.into();
    let mut payload = json!({
        "requestId": request_id,
        "peerId": peer_id,
        "error": {
            "code": reason_code,
            "redacted": true,
        },
    });
    if let Some(generation) = generation {
        payload["generation"] = Value::Number(generation.into());
    }
    if let Some(session_id) = session_id {
        payload["sessionId"] = Value::String(session_id.to_owned());
    }
    if let Some(correlation_id) = correlation_id {
        payload["correlationId"] = Value::String(correlation_id.to_owned());
    }
    let mut subjects = vec![request_id.to_owned(), peer_id.to_owned()];
    if let Some(generation) = generation {
        subjects.push(format!("voice:{generation}"));
    }
    NativeEventDraft::new(ASSISTANT_FAILED, payload)
        .topic("Orchestrator.Response")
        .correlation_id(correlation_id.unwrap_or(request_id).to_owned())
        .peer_id(peer_id.to_owned())
        .status("error")
        .subjects(subjects)
}

pub fn assistant_observation_event(peer_id: &str, frame: &Value) -> Option<NativeEventDraft> {
    let frame_type = frame.get("type").and_then(Value::as_str)?;
    let event_payload = assistant_event_payload(frame);
    let request_id = assistant_request_id(frame)?;
    let source_kind = frame
        .get("kind")
        .or_else(|| frame.get("event_kind"))
        .or_else(|| event_payload.and_then(|payload| payload.get("kind")))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let kind = match (frame_type, source_kind) {
        ("event", ASSISTANT_DELTA) | (ASSISTANT_DELTA, _) => ASSISTANT_DELTA,
        ("event", ASSISTANT_TOOL) | (ASSISTANT_TOOL, _) => ASSISTANT_TOOL,
        ("event", "tool.requested")
        | ("event", "tool.running")
        | ("event", "tool.completed")
        | ("event", "tool.failed")
        | ("event", "tool.requires_action") => source_kind,
        _ => return None,
    };
    let source = event_payload.unwrap_or(frame);
    let (body, redacted_fields) = sanitize_assistant_observation_frame(source);
    let mut payload = json!({
        "requestId": request_id,
        "peerId": peer_id,
        "observation": body,
    });
    merge_object(&mut payload, assistant_link_payload(frame));
    let subjects = assistant_subjects(request_id, peer_id, frame);
    Some(
        NativeEventDraft::new(kind, payload)
            .topic("Orchestrator.Response")
            .correlation_id(
                assistant_correlation_id(frame)
                    .unwrap_or(request_id)
                    .to_owned(),
            )
            .peer_id(peer_id.to_owned())
            .redaction(NativeRedactionMetadata::with_fields(redacted_fields))
            .subjects(subjects),
    )
}

pub fn mesh_peer_state_event(peer_id: &str, connected: bool, sessions: usize) -> NativeEventDraft {
    let status = if connected {
        "connected"
    } else {
        "disconnected"
    };
    NativeEventDraft::new(
        MESH_PEER_STATE_CHANGED,
        json!({
            "peerId": peer_id,
            "connected": connected,
            "sessions": sessions,
        }),
    )
    .topic("Mesh.PeerState")
    .peer_id(peer_id.to_owned())
    .status(status)
    .subject(peer_id.to_owned())
}

pub fn mesh_peer_state_snapshot(
    peer_id: &str,
    connected: bool,
    _sessions: usize,
) -> NativeEventSubjectSnapshot {
    NativeEventSubjectSnapshot {
        subject: peer_id.to_owned(),
        peer_id: Some(peer_id.to_owned()),
        kind: MESH_PEER_STATE_CHANGED.to_owned(),
        generation: None,
        session_id: None,
        request_id: None,
        correlation_id: None,
        conversation_id: None,
        transcript: None,
        transcript_truncated: false,
        accumulated_text: None,
        text_truncated: false,
        status: if connected {
            "connected"
        } else {
            "disconnected"
        }
        .to_owned(),
        terminal: !connected,
        persisted: None,
        persistence_error_code: None,
        updated_at: now_rfc3339_millis(),
    }
}

pub fn voice_turn_event(
    kind: impl Into<String>,
    generation: Option<u64>,
    status: Value,
    reason_code: Option<String>,
) -> NativeEventDraft {
    let kind = kind.into();
    let mut payload = json!({
        "generation": generation,
        "status": status,
    });
    if let Some(reason_code) = reason_code {
        payload["reasonCode"] = Value::String(reason_code);
    }
    let mut draft = NativeEventDraft::new(kind, payload).topic("Voice.Turn");
    if let Some(generation) = generation {
        let subject = format!("voice:{generation}");
        draft = draft.correlation_id(subject.clone()).subject(subject);
    }
    draft
}

fn assistant_event_payload(frame: &Value) -> Option<&Value> {
    frame
        .get("params")
        .or_else(|| frame.get("payload"))
        .filter(|value| value.is_object())
}

fn assistant_request_id(frame: &Value) -> Option<&str> {
    frame
        .get("request_id")
        .or_else(|| frame.get("requestId"))
        .or_else(|| frame.get("id"))
        .and_then(Value::as_str)
        .or_else(|| {
            assistant_event_payload(frame)
                .and_then(|payload| {
                    payload
                        .get("request_id")
                        .or_else(|| payload.get("requestId"))
                })
                .and_then(Value::as_str)
        })
        .or_else(|| assistant_correlation_id(frame))
}

fn assistant_correlation_id(frame: &Value) -> Option<&str> {
    frame
        .get("correlation_id")
        .or_else(|| frame.get("correlationId"))
        .and_then(Value::as_str)
        .or_else(|| {
            assistant_event_payload(frame)
                .and_then(|payload| {
                    payload
                        .get("correlation_id")
                        .or_else(|| payload.get("correlationId"))
                })
                .and_then(Value::as_str)
        })
}

fn assistant_generation(frame: &Value) -> Option<u64> {
    frame.get("generation").and_then(Value::as_u64).or_else(|| {
        assistant_event_payload(frame)
            .and_then(|payload| payload.get("generation"))
            .and_then(Value::as_u64)
    })
}

fn assistant_string_field<'a>(
    frame: &'a Value,
    snake_key: &str,
    camel_key: &str,
) -> Option<&'a str> {
    frame
        .get(snake_key)
        .or_else(|| frame.get(camel_key))
        .and_then(Value::as_str)
        .or_else(|| {
            assistant_event_payload(frame)
                .and_then(|payload| payload.get(snake_key).or_else(|| payload.get(camel_key)))
                .and_then(Value::as_str)
        })
}

fn assistant_link_payload(frame: &Value) -> Value {
    let mut output = Map::new();
    if let Some(generation) = assistant_generation(frame) {
        output.insert("generation".to_owned(), Value::Number(generation.into()));
    }
    if let Some(session_id) = assistant_string_field(frame, "session_id", "sessionId") {
        output.insert("sessionId".to_owned(), Value::String(session_id.to_owned()));
    }
    if let Some(request_id) = assistant_request_id(frame) {
        output.insert("requestId".to_owned(), Value::String(request_id.to_owned()));
    }
    if let Some(correlation_id) = assistant_correlation_id(frame) {
        output.insert(
            "correlationId".to_owned(),
            Value::String(correlation_id.to_owned()),
        );
    }
    if let Some(conversation_id) =
        assistant_string_field(frame, "conversation_id", "conversationId")
    {
        output.insert(
            "conversationId".to_owned(),
            Value::String(conversation_id.to_owned()),
        );
    }
    Value::Object(output)
}

fn assistant_subjects(request_id: &str, peer_id: &str, frame: &Value) -> Vec<String> {
    let mut subjects = vec![request_id.to_owned(), peer_id.to_owned()];
    if let Some(generation) = assistant_generation(frame) {
        subjects.push(format!("voice:{generation}"));
    }
    subjects
}

fn sanitize_assistant_result(result: &Value) -> (Value, Vec<String>) {
    let mut redacted = Vec::new();
    let mut output = Map::new();
    if let Some(text) = result
        .get("text")
        .or_else(|| result.get("assistantText"))
        .and_then(Value::as_str)
    {
        output.insert("text".to_owned(), Value::String(text.to_owned()));
    }
    copy_string_field(
        result,
        &mut output,
        &mut redacted,
        "session_id",
        "sessionId",
    );
    copy_string_field(result, &mut output, &mut redacted, "sessionId", "sessionId");
    copy_string_field(
        result,
        &mut output,
        &mut redacted,
        "request_id",
        "requestId",
    );
    copy_string_field(result, &mut output, &mut redacted, "requestId", "requestId");
    copy_string_field(
        result,
        &mut output,
        &mut redacted,
        "correlation_id",
        "correlationId",
    );
    copy_string_field(
        result,
        &mut output,
        &mut redacted,
        "correlationId",
        "correlationId",
    );
    redact_unallowlisted_fields(
        result,
        &mut redacted,
        &[
            "text",
            "assistantText",
            "session_id",
            "sessionId",
            "request_id",
            "requestId",
            "correlation_id",
            "correlationId",
            "conversation_id",
            "conversationId",
            "generation",
        ],
        "result",
    );
    (Value::Object(output), redacted)
}

fn sanitize_assistant_error(error: &Value) -> (Value, Vec<String>) {
    let mut redacted = Vec::new();
    let mut output = Map::new();
    copy_string_field(error, &mut output, &mut redacted, "code", "code");
    copy_string_field(error, &mut output, &mut redacted, "status", "status");
    copy_string_field(
        error,
        &mut output,
        &mut redacted,
        "reason_code",
        "reasonCode",
    );
    copy_string_field(
        error,
        &mut output,
        &mut redacted,
        "reasonCode",
        "reasonCode",
    );
    redact_unallowlisted_fields(
        error,
        &mut redacted,
        &["code", "status", "reason_code", "reasonCode"],
        "error",
    );
    if output.is_empty() {
        output.insert("redacted".to_owned(), Value::Bool(true));
    }
    (Value::Object(output), redacted)
}

fn sanitize_assistant_observation_frame(frame: &Value) -> (Value, Vec<String>) {
    let mut redacted = Vec::new();
    let mut output = Map::new();
    copy_string_field(frame, &mut output, &mut redacted, "kind", "kind");
    copy_string_field(frame, &mut output, &mut redacted, "delta", "delta");
    copy_string_field(frame, &mut output, &mut redacted, "text", "text");
    copy_string_field(frame, &mut output, &mut redacted, "tool_id", "toolId");
    copy_string_field(frame, &mut output, &mut redacted, "toolId", "toolId");
    copy_string_field(frame, &mut output, &mut redacted, "name", "name");
    copy_string_field(frame, &mut output, &mut redacted, "status", "status");
    redact_unallowlisted_fields(
        frame,
        &mut redacted,
        &[
            "type",
            "id",
            "correlation_id",
            "correlationId",
            "session_id",
            "sessionId",
            "request_id",
            "requestId",
            "conversation_id",
            "conversationId",
            "generation",
            "sequence",
            "is_final",
            "kind",
            "delta",
            "text",
            "tool_id",
            "toolId",
            "name",
            "status",
        ],
        "frame",
    );
    (Value::Object(output), redacted)
}

fn copy_string_field(
    source: &Value,
    output: &mut Map<String, Value>,
    redacted: &mut Vec<String>,
    source_key: &str,
    output_key: &str,
) {
    let Some(value) = source.get(source_key) else {
        return;
    };
    if secret_key(source_key) {
        redacted.push(source_key.to_owned());
        return;
    }
    if let Some(value) = value.as_str() {
        output.insert(output_key.to_owned(), Value::String(value.to_owned()));
    } else {
        redacted.push(source_key.to_owned());
    }
}

fn redact_unallowlisted_fields(
    source: &Value,
    redacted: &mut Vec<String>,
    allowed: &[&str],
    prefix: &str,
) {
    let Some(object) = source.as_object() else {
        return;
    };
    for key in object.keys() {
        if !allowed.contains(&key.as_str()) || secret_key(key) {
            redacted.push(format!("{prefix}.{key}"));
        }
    }
}

fn secret_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    [
        "authorization",
        "bearer",
        "credential",
        "password",
        "secret",
        "token",
        "api_key",
        "apikey",
        "access_key",
        "refresh",
    ]
    .iter()
    .any(|needle| key.contains(needle))
}

fn merge_object(target: &mut Value, source: Value) {
    let (Some(target), Some(source)) = (target.as_object_mut(), source.as_object()) else {
        return;
    };
    for (key, value) in source {
        target.insert(key.clone(), value.clone());
    }
}

pub fn native_event_timestamp_now() -> String {
    now_rfc3339_millis()
}

fn now_rfc3339_millis() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let millis = duration.subsec_millis();
    let (year, month, day, hour, minute, second) = unix_seconds_to_utc(duration.as_secs());
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

fn unix_seconds_to_utc(seconds: u64) -> (i32, u32, u32, u32, u32, u32) {
    let days = (seconds / 86_400) as i64;
    let seconds_of_day = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    let hour = (seconds_of_day / 3_600) as u32;
    let minute = ((seconds_of_day % 3_600) / 60) as u32;
    let second = (seconds_of_day % 60) as u32;
    (year, month, day, hour, minute, second)
}

fn civil_from_days(days_since_unix_epoch: i64) -> (i32, u32, u32) {
    let z = days_since_unix_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if month <= 2 { 1 } else { 0 };
    (year as i32, month as u32, day as u32)
}

fn gap_event(
    resume_after_sequence: u64,
    first_missing_sequence: u64,
    next_available_sequence: u64,
    reason: &str,
) -> NativeAuroraEvent {
    let payload = json!({
        "reason": reason,
        "resumeAfterSequence": resume_after_sequence,
        "firstMissingSequence": first_missing_sequence,
        "nextAvailableSequence": next_available_sequence,
    });
    let mut event = NativeEventDraft::new(NATIVE_EVENTS_GAP, payload)
        .delivery(NativeEventDelivery::Guaranteed)
        .into_event(resume_after_sequence);
    event.id = Some(format!("native:gap:{first_missing_sequence}"));
    event
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("test runtime")
            .block_on(future)
    }

    #[test]
    fn publishes_monotonic_sequences_and_replays_after_sequence() {
        block_on(async {
            let hub = NativeEventHub::new(8);
            let first = hub
                .publish(NativeEventDraft::new("voice.turn.started", json!({})))
                .await;
            let second = hub
                .publish(NativeEventDraft::new("voice.turn.finalized", json!({})))
                .await;

            assert_eq!(first.sequence, 1);
            assert_eq!(second.sequence, 2);
            assert_eq!(first.id.as_deref(), Some("native:1"));
            assert!(first.received_at.ends_with('Z'));
            assert!(first.received_at.contains('T'));

            let replay = hub.snapshot(NativeEventFilter {
                after_sequence: Some(1),
                ..NativeEventFilter::default()
            });
            assert_eq!(replay, vec![second]);
        });
    }

    #[test]
    fn old_cursor_returns_gap_without_advancing_past_missing_events() {
        block_on(async {
            let hub = NativeEventHub::new(2);
            for index in 0..4 {
                hub.publish(NativeEventDraft::new(
                    "mesh.peer.state_changed",
                    json!({ "index": index }),
                ))
                .await;
            }

            let replay = hub.snapshot(NativeEventFilter {
                after_sequence: Some(1),
                ..NativeEventFilter::default()
            });
            assert_eq!(replay.len(), 1);
            assert_eq!(replay[0].kind, NATIVE_EVENTS_GAP);
            assert_eq!(replay[0].sequence, 1);
            assert_eq!(replay[0].payload["firstMissingSequence"], 2);
            assert_eq!(replay[0].payload["nextAvailableSequence"], 3);
        });
    }

    #[test]
    fn replay_subscribe_capacity_gap_does_not_silently_truncate() {
        block_on(async {
            let hub = NativeEventHub::new(8);
            for index in 0..3 {
                hub.publish(NativeEventDraft::new(
                    "mesh.peer.state_changed",
                    json!({ "index": index }),
                ))
                .await;
            }
            let subscription = hub.subscribe_with_capacity(NativeEventFilter::default(), 2);
            let gap = subscription.try_recv().expect("gap");
            assert_eq!(gap.kind, NATIVE_EVENTS_GAP);
            assert_eq!(gap.payload["reason"], "subscriber_capacity_exceeded");
            assert!(subscription.try_recv().is_none());
        });
    }

    #[test]
    fn filters_by_kind_topic_and_subject() {
        block_on(async {
            let hub = NativeEventHub::new(8);
            hub.publish(
                NativeEventDraft::new("mesh.peer.state_changed", json!({}))
                    .topic("Mesh.PeerState")
                    .subject("peer-a"),
            )
            .await;
            hub.publish(
                NativeEventDraft::new("voice.turn.started", json!({}))
                    .topic("Voice.Turn")
                    .subject("voice:1"),
            )
            .await;

            let replay = hub.snapshot(NativeEventFilter {
                kinds: vec!["mesh.peer.state_changed".to_owned()],
                topics: vec!["Mesh.PeerState".to_owned()],
                subjects: vec!["peer-a".to_owned()],
                after_sequence: None,
            });
            assert_eq!(replay.len(), 1);
            assert_eq!(replay[0].kind, "mesh.peer.state_changed");
        });
    }

    #[test]
    fn dropping_subscription_clone_keeps_receiver_alive() {
        let hub = NativeEventHub::new(8);
        let subscription = hub.subscribe(NativeEventFilter::default());
        let clone = subscription.clone();
        drop(clone);

        hub.publish_now(NativeEventDraft::new("voice.turn.started", json!({})));
        let event = subscription.try_recv().expect("receiver remains open");
        assert_eq!(event.kind, "voice.turn.started");
        assert!(!subscription.is_closed());
    }

    #[test]
    fn dropping_last_subscription_owner_closes_and_unregisters_receiver() {
        let hub = NativeEventHub::new(8);
        let subscription = hub.subscribe(NativeEventFilter::default());
        let state = subscription.state.clone();
        assert_eq!(hub.inner.lock().expect("hub").subscribers.len(), 1);

        drop(subscription);

        assert!(state.is_closed());
        assert_eq!(hub.inner.lock().expect("hub").subscribers.len(), 0);
    }

    #[test]
    fn lossy_delivery_drops_oldest_lossy_for_slow_subscribers() {
        block_on(async {
            let hub = NativeEventHub::new(8);
            let subscription = hub.subscribe_with_capacity(NativeEventFilter::default(), 2);
            for index in 0..3 {
                hub.publish(
                    NativeEventDraft::new("voice.audio.level", json!({ "index": index }))
                        .delivery(NativeEventDelivery::Lossy),
                )
                .await;
            }

            let first = subscription.try_recv().expect("first retained lossy event");
            let second = subscription
                .try_recv()
                .expect("second retained lossy event");
            assert_eq!(first.payload["index"], 1);
            assert_eq!(second.payload["index"], 2);
            assert!(subscription.try_recv().is_none());
        });
    }

    #[test]
    fn lossy_delivery_does_not_evict_queued_guaranteed_event() {
        let hub = NativeEventHub::new(8);
        let subscription = hub.subscribe_with_capacity(NativeEventFilter::default(), 1);
        hub.publish_now(NativeEventDraft::new("voice.turn.started", json!({})));

        let lossy = hub.publish_now(
            NativeEventDraft::new("voice.audio.level", json!({ "index": 1 }))
                .delivery(NativeEventDelivery::Lossy),
        );
        assert_eq!(lossy.sequence, 2);
        let retained = subscription.try_recv().expect("guaranteed event");
        assert_eq!(retained.kind, "voice.turn.started");
        assert!(subscription.try_recv().is_none());
    }

    #[test]
    fn guaranteed_delivery_closes_stalled_subscriber_with_gap_without_blocking_publish() {
        let hub = NativeEventHub::new(8);
        let subscription = hub.subscribe_with_capacity(NativeEventFilter::default(), 1);
        let first = hub.publish_now(NativeEventDraft::new("voice.turn.started", json!({})));
        assert_eq!(first.sequence, 1);

        let second = hub.publish_now(NativeEventDraft::new("voice.turn.finalized", json!({})));
        assert_eq!(second.sequence, 2);
        assert_eq!(hub.next_sequence(), 3);

        let gap = subscription.try_recv().expect("gap");
        assert_eq!(gap.kind, NATIVE_EVENTS_GAP);
        assert_eq!(gap.sequence, 0);
        assert_eq!(gap.payload["firstMissingSequence"], 1);
        assert_eq!(gap.payload["nextAvailableSequence"], 2);
        assert!(subscription.try_recv().is_none());
    }

    #[test]
    fn dropped_subscription_is_not_retained_by_hub() {
        let hub = NativeEventHub::new(8);
        let subscription = hub.subscribe_with_capacity(NativeEventFilter::default(), 1);
        drop(subscription);
        hub.publish_now(NativeEventDraft::new("voice.turn.started", json!({})));
        assert_eq!(
            hub.inner
                .lock()
                .expect("hub")
                .subscribers
                .iter()
                .filter(|subscriber| subscriber.subscription.upgrade().is_some())
                .count(),
            0
        );
    }

    #[test]
    fn profile_reset_preserves_sequence_and_rejects_stale_epoch_publishers() {
        let hub = NativeEventHub::new(8);
        let epoch = hub.source_epoch();
        let first = hub.publish_now(NativeEventDraft::new("voice.turn.started", json!({})));
        assert_eq!(first.sequence, 1);

        hub.reset_for_profile_change();
        assert!(hub
            .publish_if_epoch(epoch, NativeEventDraft::new("voice.turn.failed", json!({})))
            .is_none());
        let next = hub.publish_now(NativeEventDraft::new("voice.turn.started", json!({})));
        assert_eq!(next.sequence, 2);
        assert_ne!(hub.source_epoch(), epoch);
    }

    #[test]
    fn old_peer_disconnect_cannot_repopulate_state_after_profile_change() {
        let hub = NativeEventHub::new(8);
        let binding_epoch = hub.source_epoch();
        hub.reset_for_profile_change();
        assert!(hub
            .publish_observation_if_epoch(
                binding_epoch,
                mesh_peer_state_event("previous-peer", false, 0),
                Some(mesh_peer_state_snapshot("previous-peer", false, 0)),
            )
            .is_none());
        let snapshot = hub.state_snapshot(NativeEventFilter::default());
        assert!(snapshot.events.is_empty());
        assert!(snapshot.subjects.is_empty());
    }

    #[test]
    fn peer_state_snapshot_survives_replay_expiry_for_bootstrap() {
        let hub = NativeEventHub::new(1);
        let epoch = hub.source_epoch();
        let lease = hub.issue_peer_publication_lease("peer-a");
        assert!(hub
            .publish_observation_with_peer_lease_if_epoch(
                epoch,
                &lease,
                mesh_peer_state_event("peer-a", true, 1),
                Some(mesh_peer_state_snapshot("peer-a", true, 1)),
            )
            .is_some());
        hub.publish_now(NativeEventDraft::new("assistant.delta", json!({"n": 1})));

        let snapshot = hub.state_snapshot(NativeEventFilter {
            subjects: vec!["peer-a".to_owned()],
            ..NativeEventFilter::default()
        });

        assert!(snapshot.events.is_empty());
        assert_eq!(snapshot.subjects.len(), 1);
        assert_eq!(snapshot.subjects[0].subject.as_str(), "peer-a");
        assert_eq!(snapshot.subjects[0].peer_id.as_deref(), Some("peer-a"));
        assert_eq!(snapshot.subjects[0].kind.as_str(), MESH_PEER_STATE_CHANGED);
        assert_eq!(snapshot.subjects[0].status.as_str(), "connected");
    }

    #[test]
    fn clearing_subject_removes_retained_state_and_signals_gap_for_that_subject() {
        let hub = NativeEventHub::new(8);
        let subscription = hub.subscribe_with_capacity(
            NativeEventFilter {
                subjects: vec!["peer-a".to_owned()],
                ..NativeEventFilter::default()
            },
            4,
        );
        hub.upsert_subject_snapshot(NativeEventSubjectSnapshot {
            subject: "peer-a".to_owned(),
            peer_id: Some("peer-a".to_owned()),
            kind: MESH_PEER_STATE_CHANGED.to_owned(),
            generation: None,
            session_id: None,
            request_id: None,
            correlation_id: None,
            conversation_id: None,
            transcript: None,
            transcript_truncated: false,
            accumulated_text: None,
            text_truncated: false,
            status: "connected".to_owned(),
            terminal: false,
            persisted: None,
            persistence_error_code: None,
            updated_at: now_rfc3339_millis(),
        });
        hub.publish_now(
            NativeEventDraft::new(ASSISTANT_DELTA, json!({"text": "a"})).subject("peer-a"),
        );

        hub.clear_subject("peer-a");

        let gap = subscription.try_recv().expect("subject cleared gap");
        assert_eq!(gap.kind, NATIVE_EVENTS_GAP);
        assert_eq!(gap.payload["reason"], "subject_cleared");
        let snapshot = hub.state_snapshot(NativeEventFilter {
            subjects: vec!["peer-a".to_owned()],
            after_sequence: Some(0),
            ..NativeEventFilter::default()
        });
        assert!(!snapshot.replay_complete);
        assert!(snapshot.subjects.is_empty());
        assert_eq!(snapshot.events[0].kind, NATIVE_EVENTS_GAP);
        assert_eq!(snapshot.events[0].payload["reason"], "subject_cleared");
    }

    #[test]
    fn profile_reset_discards_events_queued_for_the_previous_profile() {
        let hub = NativeEventHub::new(8);
        let subscription = hub.subscribe(NativeEventFilter::default());
        hub.publish_now(
            NativeEventDraft::new(ASSISTANT_DELTA, json!({"text": "previous account"}))
                .subject("conversation-a"),
        );

        hub.reset_for_profile_change();

        assert!(subscription.try_recv().is_none());
        assert!(subscription.is_closed());
        assert!(hub.snapshot(NativeEventFilter::default()).is_empty());
    }

    #[test]
    fn clearing_subject_discards_broad_subscriber_data_but_preserves_other_subscribers() {
        let hub = NativeEventHub::new(8);
        let broad = hub.subscribe(NativeEventFilter::default());
        let unrelated = hub.subscribe(NativeEventFilter {
            subjects: vec!["peer-b".to_owned()],
            ..NativeEventFilter::default()
        });
        hub.publish_now(
            NativeEventDraft::new(ASSISTANT_DELTA, json!({"text": "a"})).subject("peer-a"),
        );
        hub.publish_now(
            NativeEventDraft::new(ASSISTANT_DELTA, json!({"text": "b"})).subject("peer-b"),
        );

        hub.clear_subject("peer-a");

        let gap = broad.try_recv().expect("cleared subject gap");
        assert_eq!(gap.kind, NATIVE_EVENTS_GAP);
        assert!(broad.try_recv().is_none());
        assert!(broad.is_closed());
        assert_eq!(
            unrelated.try_recv().expect("unrelated peer").subjects,
            vec!["peer-b"]
        );
        assert!(!unrelated.is_closed());
    }

    #[test]
    fn clearing_explicit_subject_signals_gap_even_after_queue_was_consumed() {
        let hub = NativeEventHub::new(8);
        let subscription = hub.subscribe(NativeEventFilter {
            subjects: vec!["peer-a".to_owned()],
            ..NativeEventFilter::default()
        });
        hub.publish_now(
            NativeEventDraft::new(ASSISTANT_DELTA, json!({"text": "a"})).subject("peer-a"),
        );
        assert!(subscription.try_recv().is_some());

        hub.clear_subject("peer-a");

        let gap = subscription.try_recv().expect("cleared subject gap");
        assert_eq!(gap.kind, NATIVE_EVENTS_GAP);
        assert_eq!(gap.payload["reason"], "subject_cleared");
        assert!(subscription.try_recv().is_none());
        assert!(subscription.is_closed());
    }

    #[test]
    fn clearing_peer_removes_request_replay_and_peer_snapshots_without_touching_unrelated_voice() {
        let hub = NativeEventHub::new(16);
        let peer_subscription = hub.subscribe(NativeEventFilter {
            subjects: vec!["peer-a".to_owned()],
            ..NativeEventFilter::default()
        });
        let request_subscription = hub.subscribe(NativeEventFilter {
            subjects: vec!["request-a".to_owned()],
            ..NativeEventFilter::default()
        });
        let epoch = hub.source_epoch();
        let peer_a_lease = hub.issue_peer_publication_lease("peer-a");
        hub.publish_observation_with_peer_lease_if_epoch(
            epoch,
            &peer_a_lease,
            mesh_peer_state_event("peer-a", true, 1),
            Some(mesh_peer_state_snapshot("peer-a", true, 1)),
        );
        let request_a_snapshot = NativeEventSubjectSnapshot {
            subject: "request-a".to_owned(),
            peer_id: Some("peer-a".to_owned()),
            kind: ASSISTANT_COMPLETED.to_owned(),
            generation: Some(42),
            session_id: None,
            request_id: Some("request-a".to_owned()),
            correlation_id: Some("request-a".to_owned()),
            conversation_id: None,
            transcript: None,
            transcript_truncated: false,
            accumulated_text: Some("done".to_owned()),
            text_truncated: false,
            status: "ok".to_owned(),
            terminal: true,
            persisted: Some(true),
            persistence_error_code: None,
            updated_at: now_rfc3339_millis(),
        };
        hub.upsert_subject_snapshot(NativeEventSubjectSnapshot {
            subject: "voice:42".to_owned(),
            peer_id: None,
            kind: "voice.turn.started".to_owned(),
            generation: Some(42),
            session_id: None,
            request_id: None,
            correlation_id: Some("voice:42".to_owned()),
            conversation_id: None,
            transcript: None,
            transcript_truncated: false,
            accumulated_text: None,
            text_truncated: false,
            status: "active".to_owned(),
            terminal: false,
            persisted: None,
            persistence_error_code: None,
            updated_at: now_rfc3339_millis(),
        });
        hub.publish_observation_with_peer_lease_if_epoch(
            epoch,
            &peer_a_lease,
            assistant_terminal_event(
                "peer-a",
                "request-a",
                &json!({
                    "type": "result",
                    "id": "request-a",
                    "generation": 42,
                    "result": {"text": "done"}
                }),
            )
            .expect("assistant terminal event"),
            Some(request_a_snapshot),
        );
        let peer_b_lease = hub.issue_peer_publication_lease("peer-b");
        hub.publish_observation_with_peer_lease_if_epoch(
            hub.source_epoch(),
            &peer_b_lease,
            mesh_peer_state_event("peer-b", true, 1),
            Some(mesh_peer_state_snapshot("peer-b", true, 1)),
        );

        hub.clear_peer("peer-a");

        let peer_gap = peer_subscription.try_recv().expect("peer subscriber gap");
        assert_eq!(peer_gap.kind, NATIVE_EVENTS_GAP);
        assert!(peer_subscription.is_closed());
        let request_gap = request_subscription
            .try_recv()
            .expect("request subscriber gap");
        assert_eq!(request_gap.kind, NATIVE_EVENTS_GAP);
        assert!(request_subscription.is_closed());

        let peer_snapshot = hub.state_snapshot(NativeEventFilter {
            subjects: vec!["peer-a".to_owned()],
            after_sequence: Some(0),
            ..NativeEventFilter::default()
        });
        assert!(!peer_snapshot.replay_complete);
        assert!(peer_snapshot.subjects.is_empty());
        assert_eq!(peer_snapshot.events[0].kind, NATIVE_EVENTS_GAP);

        let request_snapshot = hub.state_snapshot(NativeEventFilter {
            subjects: vec!["request-a".to_owned()],
            after_sequence: Some(0),
            ..NativeEventFilter::default()
        });
        assert!(!request_snapshot.replay_complete);
        assert!(request_snapshot.subjects.is_empty());
        assert_eq!(request_snapshot.events[0].kind, NATIVE_EVENTS_GAP);

        let voice_snapshot = hub.state_snapshot(NativeEventFilter {
            subjects: vec!["voice:42".to_owned()],
            ..NativeEventFilter::default()
        });
        assert_eq!(voice_snapshot.subjects.len(), 1);
        assert_eq!(voice_snapshot.subjects[0].peer_id.as_deref(), None);
        assert!(voice_snapshot.replay_complete);

        let unrelated_snapshot = hub.state_snapshot(NativeEventFilter {
            subjects: vec!["peer-b".to_owned()],
            ..NativeEventFilter::default()
        });
        assert_eq!(unrelated_snapshot.subjects.len(), 1);
        assert_eq!(
            unrelated_snapshot.subjects[0].peer_id.as_deref(),
            Some("peer-b")
        );
        assert_eq!(unrelated_snapshot.events.len(), 1);
        assert_eq!(
            unrelated_snapshot.events[0].audit.peer_id.as_deref(),
            Some("peer-b")
        );
    }

    #[test]
    fn clearing_peer_closes_peer_owned_voice_subject_but_preserves_peerless_voice_subject() {
        let hub = NativeEventHub::new(16);
        let peer_owned_voice = hub.subscribe(NativeEventFilter {
            subjects: vec!["voice:7".to_owned()],
            ..NativeEventFilter::default()
        });
        let peerless_voice = hub.subscribe(NativeEventFilter {
            subjects: vec!["voice:8".to_owned()],
            ..NativeEventFilter::default()
        });
        let peer_owned_voice_from_event = hub.subscribe(NativeEventFilter {
            subjects: vec!["voice:9".to_owned()],
            ..NativeEventFilter::default()
        });
        let peer_a_lease = hub.issue_peer_publication_lease("peer-a");
        hub.publish_observation_with_peer_lease_if_epoch(
            hub.source_epoch(),
            &peer_a_lease,
            assistant_observation_event(
                "peer-a",
                &json!({
                    "type": "event",
                    "id": "request-a",
                    "generation": 7,
                    "payload": {"kind": ASSISTANT_DELTA, "textDelta": "from peer"}
                }),
            )
            .expect("assistant observation event"),
            Some(NativeEventSubjectSnapshot {
                subject: "voice:7".to_owned(),
                peer_id: Some("peer-a".to_owned()),
                kind: ASSISTANT_DELTA.to_owned(),
                generation: Some(7),
                session_id: None,
                request_id: Some("request-a".to_owned()),
                correlation_id: Some("request-a".to_owned()),
                conversation_id: None,
                transcript: None,
                transcript_truncated: false,
                accumulated_text: Some("from peer".to_owned()),
                text_truncated: false,
                status: "streaming".to_owned(),
                terminal: false,
                persisted: None,
                persistence_error_code: None,
                updated_at: now_rfc3339_millis(),
            }),
        );
        hub.upsert_subject_snapshot(NativeEventSubjectSnapshot {
            subject: "voice:8".to_owned(),
            peer_id: None,
            kind: "voice.turn.started".to_owned(),
            generation: Some(8),
            session_id: None,
            request_id: None,
            correlation_id: Some("voice:8".to_owned()),
            conversation_id: None,
            transcript: None,
            transcript_truncated: false,
            accumulated_text: None,
            text_truncated: false,
            status: "active".to_owned(),
            terminal: false,
            persisted: None,
            persistence_error_code: None,
            updated_at: now_rfc3339_millis(),
        });
        hub.publish_observation_with_peer_lease_if_epoch(
            hub.source_epoch(),
            &peer_a_lease,
            assistant_terminal_event(
                "peer-a",
                "request-event-owned",
                &json!({
                    "type": "result",
                    "id": "request-event-owned",
                    "generation": 9,
                    "result": {"text": "done"}
                }),
            )
            .expect("assistant terminal event"),
            None,
        );

        hub.clear_peer("peer-a");

        let gap = peer_owned_voice.try_recv().expect("peer-owned voice gap");
        assert_eq!(gap.kind, NATIVE_EVENTS_GAP);
        assert!(peer_owned_voice.is_closed());
        assert!(peerless_voice.try_recv().is_none());
        assert!(!peerless_voice.is_closed());
        let event_owned_gap = peer_owned_voice_from_event
            .try_recv()
            .expect("event-owned voice gap");
        assert_eq!(event_owned_gap.kind, NATIVE_EVENTS_GAP);
        assert!(peer_owned_voice_from_event.is_closed());
        let peer_owned_snapshot = hub.state_snapshot(NativeEventFilter {
            subjects: vec!["voice:7".to_owned()],
            after_sequence: Some(0),
            ..NativeEventFilter::default()
        });
        assert!(!peer_owned_snapshot.replay_complete);
        assert!(peer_owned_snapshot.subjects.is_empty());
        assert_eq!(peer_owned_snapshot.events[0].kind, NATIVE_EVENTS_GAP);
        let peerless_snapshot = hub.state_snapshot(NativeEventFilter {
            subjects: vec!["voice:8".to_owned()],
            ..NativeEventFilter::default()
        });
        assert!(peerless_snapshot.replay_complete);
        assert_eq!(peerless_snapshot.subjects.len(), 1);
        assert_eq!(peerless_snapshot.subjects[0].peer_id.as_deref(), None);
        let event_owned_snapshot = hub.state_snapshot(NativeEventFilter {
            subjects: vec!["voice:9".to_owned()],
            after_sequence: Some(0),
            ..NativeEventFilter::default()
        });
        assert!(!event_owned_snapshot.replay_complete);
        assert!(event_owned_snapshot.subjects.is_empty());
        assert_eq!(event_owned_snapshot.events[0].kind, NATIVE_EVENTS_GAP);
    }

    #[test]
    fn issuing_peer_lease_prunes_dropped_lease_registry_entries() {
        let hub = NativeEventHub::new(16);
        {
            let _lease = hub.issue_peer_publication_lease("peer-dropped");
        }
        assert!(hub
            .inner
            .lock()
            .expect("hub")
            .peer_publication_leases
            .contains_key("peer-dropped"));

        let _next_lease = hub.issue_peer_publication_lease("peer-next");

        let inner = hub.inner.lock().expect("hub");
        assert!(!inner.peer_publication_leases.contains_key("peer-dropped"));
        assert!(inner.peer_publication_leases.contains_key("peer-next"));
    }

    #[test]
    fn clearing_peer_revokes_old_lease_and_new_lease_can_reuse_subjects() {
        let hub = NativeEventHub::new(16);
        let epoch = hub.source_epoch();
        let old_lease = hub.issue_peer_publication_lease("peer-a");
        assert!(hub
            .publish_observation_with_peer_lease_if_epoch(
                epoch,
                &old_lease,
                mesh_peer_state_event("peer-a", true, 1),
                Some(mesh_peer_state_snapshot("peer-a", true, 1)),
            )
            .is_some());

        hub.clear_peer("peer-a");

        assert!(old_lease.is_revoked());
        assert!(hub
            .publish_observation_with_peer_lease_if_epoch(
                epoch,
                &old_lease,
                mesh_peer_state_event("peer-a", true, 1),
                Some(mesh_peer_state_snapshot("peer-a", true, 1)),
            )
            .is_none());
        assert!(hub
            .publish_observation_with_peer_lease_if_epoch(
                epoch,
                &old_lease,
                assistant_terminal_event(
                    "peer-a",
                    "request-after-revoke",
                    &json!({
                        "type": "result",
                        "id": "request-after-revoke",
                        "result": {"text": "late"}
                    }),
                )
                .expect("assistant terminal event"),
                None,
            )
            .is_none());
        let peer_snapshot = hub.state_snapshot(NativeEventFilter {
            subjects: vec!["peer-a".to_owned()],
            ..NativeEventFilter::default()
        });
        assert!(peer_snapshot.subjects.is_empty());
        assert!(peer_snapshot.events.is_empty());

        let new_lease = hub.issue_peer_publication_lease("peer-a");
        assert!(hub
            .publish_observation_with_peer_lease_if_epoch(
                hub.source_epoch(),
                &new_lease,
                mesh_peer_state_event("peer-a", true, 1),
                Some(mesh_peer_state_snapshot("peer-a", true, 1)),
            )
            .is_some());
        let restored_snapshot = hub.state_snapshot(NativeEventFilter {
            subjects: vec!["peer-a".to_owned()],
            ..NativeEventFilter::default()
        });
        assert_eq!(restored_snapshot.subjects.len(), 1);
    }

    #[test]
    fn clearing_peer_keeps_epoch_for_peerless_and_unrelated_peer_publishers() {
        let hub = NativeEventHub::new(16);
        let epoch = hub.source_epoch();
        let peer_a_lease = hub.issue_peer_publication_lease("peer-a");
        let peer_b_lease = hub.issue_peer_publication_lease("peer-b");
        assert!(hub
            .publish_observation_with_peer_lease_if_epoch(
                epoch,
                &peer_a_lease,
                mesh_peer_state_event("peer-a", true, 1),
                Some(mesh_peer_state_snapshot("peer-a", true, 1)),
            )
            .is_some());

        hub.clear_peer("peer-a");

        assert_eq!(hub.source_epoch(), epoch);
        assert!(peer_a_lease.is_revoked());
        assert!(hub
            .publish_if_epoch(
                epoch,
                NativeEventDraft::new("voice.turn.started", json!({"source": "local"}))
                    .subject("voice:local"),
            )
            .is_some());
        assert!(hub
            .publish_observation_with_peer_lease_if_epoch(
                epoch,
                &peer_b_lease,
                mesh_peer_state_event("peer-b", true, 1),
                Some(mesh_peer_state_snapshot("peer-b", true, 1)),
            )
            .is_some());
    }

    #[test]
    fn cleared_subject_gap_eviction_does_not_grant_direct_peer_publication() {
        let hub = NativeEventHub::new(16);
        for index in 0..=CLEARED_SUBJECT_GAP_RETENTION_LIMIT {
            let subject = format!("stale-{index}");
            hub.publish_now(
                NativeEventDraft::new(ASSISTANT_DELTA, json!({"text": subject.clone()}))
                    .subject(subject.clone()),
            );
            hub.clear_subject(&subject);
        }

        let evicted_snapshot = hub.state_snapshot(NativeEventFilter {
            subjects: vec!["stale-0".to_owned()],
            after_sequence: Some(0),
            ..NativeEventFilter::default()
        });
        assert!(evicted_snapshot.replay_complete);
        assert!(evicted_snapshot.subjects.is_empty());

        let direct_event = hub.publish_now(mesh_peer_state_event("stale-0", true, 1));
        assert_eq!(direct_event.kind, NATIVE_EVENTS_GAP);
        hub.upsert_subject_snapshot(mesh_peer_state_snapshot("stale-0", true, 1));
        let after_direct_publish = hub.state_snapshot(NativeEventFilter {
            subjects: vec!["stale-0".to_owned()],
            ..NativeEventFilter::default()
        });
        assert!(after_direct_publish.subjects.is_empty());
    }

    #[test]
    fn clearing_peer_blocks_direct_peer_publish_and_snapshot_upsert() {
        let hub = NativeEventHub::new(16);
        let lease = hub.issue_peer_publication_lease("peer-a");
        hub.publish_observation_with_peer_lease_if_epoch(
            hub.source_epoch(),
            &lease,
            mesh_peer_state_event("peer-a", true, 1),
            Some(mesh_peer_state_snapshot("peer-a", true, 1)),
        );

        hub.clear_peer("peer-a");

        let direct_event = hub.publish_now(mesh_peer_state_event("peer-a", true, 2));
        assert_eq!(direct_event.kind, NATIVE_EVENTS_GAP);
        hub.upsert_subject_snapshot(mesh_peer_state_snapshot("peer-a", true, 2));
        let peer_snapshot = hub.state_snapshot(NativeEventFilter {
            subjects: vec!["peer-a".to_owned()],
            ..NativeEventFilter::default()
        });
        assert!(peer_snapshot.subjects.is_empty());
        assert!(peer_snapshot
            .events
            .iter()
            .all(|event| event.kind == NATIVE_EVENTS_GAP));
    }

    #[test]
    fn assistant_terminal_builder_redacts_arbitrary_peer_payload() {
        let draft = assistant_terminal_event(
            "peer-a",
            "request-1",
            &json!({
                "type": "result",
                "id": "request-1",
                "result": {
                    "text": "done",
                    "access_token": "secret-token",
                    "credentials": {"password": "secret-password"}
                }
            }),
        )
        .expect("terminal draft");
        let event = draft.into_event(7);
        let serialized = serde_json::to_string(&event).expect("event JSON");

        assert_eq!(event.kind, ASSISTANT_COMPLETED);
        assert_eq!(event.audit.transport.as_deref(), Some("native"));
        assert_eq!(event.audit.correlation_id.as_deref(), Some("request-1"));
        assert_eq!(event.audit.peer_id.as_deref(), Some("peer-a"));
        assert_eq!(event.redaction.secrets_redacted, true);
        assert!(event
            .redaction
            .redacted_fields
            .iter()
            .any(|field| { field.contains("access_token") || field.contains("credentials") }));
        assert!(event.subjects.contains(&"request-1".to_owned()));
        assert!(!serialized.contains("secret-token"));
        assert!(!serialized.contains("secret-password"));
    }

    #[test]
    fn assistant_observation_builder_drops_raw_tool_arguments() {
        let draft = assistant_observation_event(
            "peer-a",
            &json!({
                "type": "event",
                "id": "request-1",
                "kind": "tool.requested",
                "tool_id": "tool-a",
                "args": {"api_key": "secret-key"}
            }),
        )
        .expect("observation draft");
        let event = draft.into_event(8);
        let serialized = serde_json::to_string(&event).expect("event JSON");

        assert_eq!(event.kind, "tool.requested");
        assert!(event
            .redaction
            .redacted_fields
            .iter()
            .any(|field| field.contains("args")));
        assert!(!serialized.contains("secret-key"));
    }
}
