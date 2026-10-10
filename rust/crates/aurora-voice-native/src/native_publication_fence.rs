//! Portable admission fence for native-owned policy/profile publication work.
//!
//! This is an in-process prerequisite, not proof of Tauri/WebView caller
//! provenance. A trusted native adapter owns registrations and issues opaque
//! tickets before queuing work. Reservation happens only at the final storage
//! boundary, after its queues and locks have been acquired.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::{Arc, Mutex};
use thiserror::Error;
use tokio::sync::watch;

const MAX_ACTIVE_REGISTRATIONS: usize = 256;
const MAX_UNRESERVED_TICKETS_PER_REGISTRATION: usize = 128;

/// Fixed, content-free failures from the native publication fence.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum NativePublicationFenceError {
    /// The registration is closed, stale, or does not belong to this fence.
    #[error("native publication registration is unavailable")]
    RegistrationUnavailable,
    /// The operation ticket is foreign, stale, revoked, or already consumed.
    #[error("native publication ticket is unavailable")]
    TicketUnavailable,
    /// A bounded epoch, ticket, registration, or operation counter is exhausted.
    #[error("native publication fence is unavailable")]
    CounterExhausted,
    /// The bounded registration or unreserved-ticket capacity is full.
    #[error("native publication fence capacity is full")]
    CapacityExceeded,
    /// A reserved operation did not settle cleanly before revocation completed.
    #[error("native publication operation did not settle cleanly")]
    OperationFailed,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct Progress {
    revoked: bool,
    outstanding: usize,
    failed: bool,
}

struct RegistrationState {
    epoch: u64,
    next_ticket: Option<u64>,
    live_tickets: HashSet<u64>,
    outstanding: usize,
    revoked: bool,
    failed: bool,
    progress: watch::Sender<Progress>,
}

struct FenceState {
    next_registration: Option<u64>,
    registrations: HashMap<u64, RegistrationState>,
}

struct FenceInner {
    state: Mutex<FenceState>,
}

/// In-process registry for native-issued publication tickets.
///
/// The fence mutex protects only bounded counters and ticket state; it is never
/// held across an await or backend callback. It is independent from owner,
/// coordinator, draft, and filesystem locks.
#[derive(Clone)]
pub struct NativePublicationFence {
    inner: Arc<FenceInner>,
}

impl fmt::Debug for NativePublicationFence {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("NativePublicationFence(<private>)")
    }
}

/// Opaque native lifecycle registration. It is not serializable and is not a
/// renderer identity or authorization credential.
pub struct NativePublicationRegistration {
    inner: Arc<FenceInner>,
    id: u64,
    progress: watch::Receiver<Progress>,
}

impl fmt::Debug for NativePublicationRegistration {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("NativePublicationRegistration(<opaque>)")
    }
}

/// Opaque single-use ticket captured before asynchronous work is queued.
pub struct NativePublicationTicket {
    inner: Arc<FenceInner>,
    registration_id: u64,
    epoch: u64,
    sequence: u64,
    armed: bool,
}

impl fmt::Debug for NativePublicationTicket {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("NativePublicationTicket(<opaque>)")
    }
}

/// Wait handle for a registration's revocation and all operations that had
/// already reserved before revocation. Cloning or dropping a waiter does not
/// change the operation or its terminal outcome.
#[derive(Clone)]
pub struct NativePublicationRevocation {
    progress: watch::Receiver<Progress>,
}

impl fmt::Debug for NativePublicationRevocation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("NativePublicationRevocation(<opaque>)")
    }
}

/// Guard for one reserved operation. Dropping it without explicit settlement
/// records failure, including panic unwinding and abandoned backend work.
pub struct NativePublicationReservation {
    inner: Arc<FenceInner>,
    registration_id: u64,
    settled: bool,
}

impl fmt::Debug for NativePublicationReservation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("NativePublicationReservation(<active>)")
    }
}

impl NativePublicationFence {
    /// Create an empty fence. This does not establish framework caller origin.
    pub fn new() -> Self {
        Self {
            inner: Arc::new(FenceInner {
                state: Mutex::new(FenceState {
                    next_registration: Some(1),
                    registrations: HashMap::new(),
                }),
            }),
        }
    }

    /// Register one trusted native lifecycle scope.
    pub fn register(&self) -> Result<NativePublicationRegistration, NativePublicationFenceError> {
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| NativePublicationFenceError::RegistrationUnavailable)?;
        if state.registrations.len() >= MAX_ACTIVE_REGISTRATIONS {
            return Err(NativePublicationFenceError::CapacityExceeded);
        }
        let id = state
            .next_registration
            .ok_or(NativePublicationFenceError::CounterExhausted)?;
        let next = id
            .checked_add(1)
            .ok_or(NativePublicationFenceError::CounterExhausted)?;
        let (progress, receiver) = watch::channel(Progress::default());
        state.next_registration = Some(next);
        state.registrations.insert(
            id,
            RegistrationState {
                epoch: 1,
                next_ticket: Some(1),
                live_tickets: HashSet::new(),
                outstanding: 0,
                revoked: false,
                failed: false,
                progress,
            },
        );
        Ok(NativePublicationRegistration {
            inner: Arc::clone(&self.inner),
            id,
            progress: receiver,
        })
    }

    /// Close admission for one registration and return a retained wait handle.
    ///
    /// This only takes the independent short fence lock. Operations already
    /// reserved may finish once; completion is reported after their actual
    /// backend outcome settles. A request to revoke does not promise that no
    /// rename can occur afterward.
    pub fn revoke(
        &self,
        registration: &NativePublicationRegistration,
    ) -> Result<NativePublicationRevocation, NativePublicationFenceError> {
        if !Arc::ptr_eq(&self.inner, &registration.inner) {
            return Err(NativePublicationFenceError::RegistrationUnavailable);
        }
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| NativePublicationFenceError::RegistrationUnavailable)?;
        if let Some(registration_state) = state.registrations.get_mut(&registration.id) {
            if !registration_state.revoked {
                registration_state.revoked = true;
                if let Some(next_epoch) = registration_state.epoch.checked_add(1) {
                    registration_state.epoch = next_epoch;
                }
                registration_state.next_ticket = None;
                registration_state.live_tickets.clear();
                publish_progress(registration_state);
            }
            let finished = registration_state.outstanding == 0;
            if finished {
                state.registrations.remove(&registration.id);
            }
        } else if !registration.progress.borrow().revoked {
            return Err(NativePublicationFenceError::RegistrationUnavailable);
        }
        Ok(NativePublicationRevocation {
            progress: registration.progress.clone(),
        })
    }

    /// Reserve a previously issued ticket at the final mutation boundary.
    ///
    /// Call this only after all applicable asynchronous queues and owner locks
    /// have been acquired. The ticket is consumed exactly once.
    pub fn reserve(
        &self,
        mut ticket: NativePublicationTicket,
    ) -> Result<NativePublicationReservation, NativePublicationFenceError> {
        if !Arc::ptr_eq(&self.inner, &ticket.inner) {
            return Err(NativePublicationFenceError::TicketUnavailable);
        }
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| NativePublicationFenceError::TicketUnavailable)?;
        let registration_state = state
            .registrations
            .get_mut(&ticket.registration_id)
            .ok_or(NativePublicationFenceError::TicketUnavailable)?;
        if registration_state.revoked
            || registration_state.epoch != ticket.epoch
            || !registration_state.live_tickets.remove(&ticket.sequence)
        {
            return Err(NativePublicationFenceError::TicketUnavailable);
        }
        let Some(outstanding) = registration_state.outstanding.checked_add(1) else {
            registration_state.revoked = true;
            registration_state.failed = true;
            registration_state.next_ticket = None;
            registration_state.live_tickets.clear();
            publish_progress(registration_state);
            return Err(NativePublicationFenceError::CounterExhausted);
        };
        registration_state.outstanding = outstanding;
        publish_progress(registration_state);
        ticket.armed = false;
        Ok(NativePublicationReservation {
            inner: Arc::clone(&self.inner),
            registration_id: ticket.registration_id,
            settled: false,
        })
    }
}

impl Default for NativePublicationFence {
    fn default() -> Self {
        Self::new()
    }
}

impl NativePublicationRegistration {
    /// Issue one ticket bound to the current live epoch. Issue before queuing
    /// work; reservation must still happen after queues and locks.
    pub fn issue_ticket(&self) -> Result<NativePublicationTicket, NativePublicationFenceError> {
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| NativePublicationFenceError::RegistrationUnavailable)?;
        let registration_state = state
            .registrations
            .get_mut(&self.id)
            .ok_or(NativePublicationFenceError::RegistrationUnavailable)?;
        if registration_state.revoked {
            return Err(NativePublicationFenceError::RegistrationUnavailable);
        }
        if registration_state.live_tickets.len() >= MAX_UNRESERVED_TICKETS_PER_REGISTRATION {
            return Err(NativePublicationFenceError::CapacityExceeded);
        }
        let sequence = registration_state
            .next_ticket
            .ok_or(NativePublicationFenceError::CounterExhausted)?;
        let Some(next) = sequence.checked_add(1) else {
            registration_state.revoked = true;
            if let Some(next_epoch) = registration_state.epoch.checked_add(1) {
                registration_state.epoch = next_epoch;
            }
            registration_state.live_tickets.clear();
            registration_state.failed = true;
            publish_progress(registration_state);
            return Err(NativePublicationFenceError::CounterExhausted);
        };
        registration_state.next_ticket = Some(next);
        registration_state.live_tickets.insert(sequence);
        Ok(NativePublicationTicket {
            inner: Arc::clone(&self.inner),
            registration_id: self.id,
            epoch: registration_state.epoch,
            sequence,
            armed: true,
        })
    }

    /// Observe this registration's retirement without changing its state.
    /// Dropping this registration closes admission; the returned handle can
    /// then wait for operations that reserved before the drop to settle.
    pub fn retirement_waiter(&self) -> NativePublicationRevocation {
        NativePublicationRevocation {
            progress: self.progress.clone(),
        }
    }
}

impl Drop for NativePublicationRegistration {
    fn drop(&mut self) {
        retire_registration(&self.inner, self.id);
    }
}

impl Drop for NativePublicationTicket {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let Ok(mut state) = self.inner.state.lock() else {
            return;
        };
        if let Some(registration) = state.registrations.get_mut(&self.registration_id) {
            if registration.epoch == self.epoch {
                registration.live_tickets.remove(&self.sequence);
            }
        }
        self.armed = false;
    }
}

impl NativePublicationRevocation {
    /// Wait until all previously reserved operations settle. Any failed,
    /// indeterminate, panicked, or abandoned operation yields one sticky fixed
    /// failure for this registration.
    pub async fn wait(mut self) -> Result<(), NativePublicationFenceError> {
        loop {
            let current = *self.progress.borrow();
            if current.revoked && current.outstanding == 0 {
                return if current.failed {
                    Err(NativePublicationFenceError::OperationFailed)
                } else {
                    Ok(())
                };
            }
            if self.progress.changed().await.is_err() {
                let current = *self.progress.borrow();
                if current.revoked && current.outstanding == 0 {
                    return if current.failed {
                        Err(NativePublicationFenceError::OperationFailed)
                    } else {
                        Ok(())
                    };
                }
                return Err(NativePublicationFenceError::OperationFailed);
            }
        }
    }
}

impl NativePublicationReservation {
    /// Record the actual completed operation outcome. A failed operation is
    /// sticky for the registration's eventual revocation result.
    pub fn settle(mut self, succeeded: bool) -> Result<(), NativePublicationFenceError> {
        self.settled = true;
        settle_reservation(&self.inner, self.registration_id, !succeeded)
    }
}

impl Drop for NativePublicationReservation {
    fn drop(&mut self) {
        if !self.settled {
            self.settled = true;
            let _ = settle_reservation(&self.inner, self.registration_id, true);
        }
    }
}

fn settle_reservation(
    inner: &Arc<FenceInner>,
    registration_id: u64,
    failed: bool,
) -> Result<(), NativePublicationFenceError> {
    let mut state = inner
        .state
        .lock()
        .map_err(|_| NativePublicationFenceError::RegistrationUnavailable)?;
    let registration_state = state
        .registrations
        .get_mut(&registration_id)
        .ok_or(NativePublicationFenceError::RegistrationUnavailable)?;
    if failed {
        if !registration_state.revoked {
            if let Some(next_epoch) = registration_state.epoch.checked_add(1) {
                registration_state.epoch = next_epoch;
            }
        }
        registration_state.revoked = true;
        registration_state.next_ticket = None;
        registration_state.live_tickets.clear();
    }
    if let Some(outstanding) = registration_state.outstanding.checked_sub(1) {
        registration_state.outstanding = outstanding;
    } else {
        registration_state.revoked = true;
        registration_state.next_ticket = None;
        registration_state.live_tickets.clear();
        registration_state.failed = true;
    }
    registration_state.failed |= failed;
    publish_progress(registration_state);
    let finished = registration_state.revoked && registration_state.outstanding == 0;
    if finished {
        state.registrations.remove(&registration_id);
    }
    Ok(())
}

fn retire_registration(inner: &Arc<FenceInner>, registration_id: u64) {
    let Ok(mut state) = inner.state.lock() else {
        return;
    };
    let Some(registration_state) = state.registrations.get_mut(&registration_id) else {
        return;
    };
    if !registration_state.revoked {
        registration_state.revoked = true;
        if let Some(next_epoch) = registration_state.epoch.checked_add(1) {
            registration_state.epoch = next_epoch;
        }
        registration_state.next_ticket = None;
        registration_state.live_tickets.clear();
        publish_progress(registration_state);
    }
    let finished = registration_state.outstanding == 0;
    if finished {
        state.registrations.remove(&registration_id);
    }
}

fn publish_progress(registration: &RegistrationState) {
    registration.progress.send_replace(Progress {
        revoked: registration.revoked,
        outstanding: registration.outstanding,
        failed: registration.failed,
    });
}

#[cfg(test)]
mod tests {
    use super::{NativePublicationFence, NativePublicationFenceError};
    #[tokio::test]
    async fn queued_ticket_loses_to_revoke_and_backend_boundary_is_never_entered() {
        let fence = NativePublicationFence::new();
        let registration = fence.register().expect("registration");
        let ticket = registration.issue_ticket().expect("ticket");
        let wait = fence.revoke(&registration).expect("revocation");

        assert_eq!(wait.clone().wait().await, Ok(()));
        assert_eq!(
            fence.reserve(ticket).err(),
            Some(NativePublicationFenceError::TicketUnavailable)
        );
    }

    #[tokio::test]
    async fn admitted_operation_keeps_revocation_pending_until_actual_settlement() {
        let fence = NativePublicationFence::new();
        let registration = fence.register().expect("registration");
        let ticket = registration.issue_ticket().expect("ticket");
        let reservation = fence.reserve(ticket).expect("reservation");
        let waiter = fence.revoke(&registration).expect("revocation");
        let mut waiter = Box::pin(waiter.wait());
        tokio::select! {
            biased;
            result = &mut waiter => panic!("revocation completed before settlement: {result:?}"),
            () = tokio::task::yield_now() => {}
        }
        reservation.settle(true).expect("settle");
        assert_eq!(waiter.await, Ok(()));
    }

    #[tokio::test]
    async fn early_failure_closes_admission_and_waits_for_all_reserved_work() {
        let fence = NativePublicationFence::new();
        let registration = fence.register().expect("registration");
        let queued_ticket = registration.issue_ticket().expect("queued ticket");
        let first = fence
            .reserve(registration.issue_ticket().expect("first ticket"))
            .expect("first reservation");
        let second = fence
            .reserve(registration.issue_ticket().expect("second ticket"))
            .expect("second reservation");
        let revocation = fence
            .revoke(&registration)
            .expect("revoke with work active");

        let mut first_waiter = Box::pin(revocation.clone().wait());
        tokio::select! {
            biased;
            result = &mut first_waiter => panic!("revocation completed before settlement: {result:?}"),
            () = tokio::task::yield_now() => {}
        }
        drop(first_waiter);

        first.settle(false).expect("first operation fails");
        assert_eq!(
            registration.issue_ticket().err(),
            Some(NativePublicationFenceError::RegistrationUnavailable)
        );
        assert_eq!(
            fence.reserve(queued_ticket).err(),
            Some(NativePublicationFenceError::TicketUnavailable)
        );

        let mut recreated_waiter = Box::pin(revocation.wait());
        tokio::select! {
            biased;
            result = &mut recreated_waiter => panic!("revocation completed before remaining work settled: {result:?}"),
            () = tokio::task::yield_now() => {}
        }
        second.settle(true).expect("second operation settles");
        assert_eq!(
            recreated_waiter.await,
            Err(NativePublicationFenceError::OperationFailed)
        );
    }

    #[tokio::test]
    async fn dropped_waiter_and_recreated_waiter_preserve_sticky_failure() {
        let fence = NativePublicationFence::new();
        let registration = fence.register().expect("registration");
        let reservation = fence
            .reserve(registration.issue_ticket().expect("ticket"))
            .expect("reservation");
        let first = fence.revoke(&registration).expect("revocation");
        let second = fence.revoke(&registration).expect("same revocation");
        drop(first);

        reservation.settle(false).expect("failed operation settles");
        assert_eq!(
            second.wait().await,
            Err(NativePublicationFenceError::OperationFailed)
        );
        assert_eq!(
            fence
                .revoke(&registration)
                .expect("recreated waiter")
                .wait()
                .await,
            Err(NativePublicationFenceError::OperationFailed)
        );
    }

    #[tokio::test]
    async fn abandoned_reservation_is_sticky_and_tickets_are_single_use() {
        let fence = NativePublicationFence::new();
        let registration = fence.register().expect("registration");
        let ticket = registration.issue_ticket().expect("ticket");
        let queued_ticket = registration.issue_ticket().expect("queued ticket");
        let reservation = fence.reserve(ticket).expect("reservation");
        // The reservation itself cannot be copied, so a second reservation
        // must be represented by a distinct ticket.
        drop(reservation);
        assert_eq!(
            registration.issue_ticket().err(),
            Some(NativePublicationFenceError::RegistrationUnavailable)
        );
        assert_eq!(
            fence.reserve(queued_ticket).err(),
            Some(NativePublicationFenceError::TicketUnavailable)
        );
        let waiter = fence.revoke(&registration).expect("revocation");
        assert_eq!(
            waiter.wait().await,
            Err(NativePublicationFenceError::OperationFailed)
        );
    }

    #[tokio::test]
    async fn panic_during_reserved_work_is_reported_as_unclean_settlement() {
        let fence = NativePublicationFence::new();
        let registration = fence.register().expect("registration");
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _reservation = fence
                .reserve(registration.issue_ticket().expect("ticket"))
                .expect("reservation");
            panic!("injected backend panic");
        }));
        assert!(result.is_err());

        assert_eq!(
            fence
                .revoke(&registration)
                .expect("revoke panicked operation")
                .wait()
                .await,
            Err(NativePublicationFenceError::OperationFailed)
        );
    }

    #[tokio::test]
    async fn foreign_retired_and_later_registration_tickets_are_isolated() {
        let first_fence = NativePublicationFence::new();
        let second_fence = NativePublicationFence::new();
        let first = first_fence.register().expect("first registration");
        let foreign_ticket = first.issue_ticket().expect("foreign ticket");
        assert_eq!(
            second_fence.reserve(foreign_ticket).err(),
            Some(NativePublicationFenceError::TicketUnavailable)
        );

        let old_ticket = first.issue_ticket().expect("old ticket");
        assert_eq!(
            first_fence
                .revoke(&first)
                .expect("revoke first")
                .wait()
                .await,
            Ok(())
        );
        let later = first_fence.register().expect("later registration");
        assert_eq!(
            first_fence.reserve(old_ticket).err(),
            Some(NativePublicationFenceError::TicketUnavailable)
        );
        let live_ticket = later.issue_ticket().expect("live ticket");
        first_fence
            .reserve(live_ticket)
            .expect("later registration remains usable")
            .settle(true)
            .expect("settle later registration");
    }

    #[tokio::test]
    async fn foreign_registration_cannot_revoke_another_fence() {
        let fence = NativePublicationFence::new();
        let other = NativePublicationFence::new();
        let registration = other.register().expect("foreign registration");
        assert_eq!(
            fence.revoke(&registration).err(),
            Some(NativePublicationFenceError::RegistrationUnavailable)
        );
    }

    #[tokio::test]
    async fn dropping_registration_retires_queued_tickets_and_waits_for_reserved_work() {
        let fence = NativePublicationFence::new();
        let registration = fence.register().expect("registration");
        let queued_ticket = registration.issue_ticket().expect("queued ticket");
        let reservation = fence
            .reserve(registration.issue_ticket().expect("reserved ticket"))
            .expect("reservation");
        let waiter = registration.retirement_waiter();

        drop(registration);
        assert_eq!(
            fence.reserve(queued_ticket).err(),
            Some(NativePublicationFenceError::TicketUnavailable)
        );
        let mut waiter = Box::pin(waiter.wait());
        tokio::select! {
            biased;
            result = &mut waiter => panic!("retirement completed before reserved work settled: {result:?}"),
            () = tokio::task::yield_now() => {}
        }

        reservation.settle(true).expect("settle reserved operation");
        assert_eq!(waiter.await, Ok(()));

        let later = fence.register().expect("later registration");
        let later_ticket = later.issue_ticket().expect("later ticket");
        fence
            .reserve(later_ticket)
            .expect("later registration is live")
            .settle(true)
            .expect("later operation settles");
    }

    #[test]
    fn unreserved_ticket_accounting_is_bounded_and_released_on_drop() {
        let fence = NativePublicationFence::new();
        let registration = fence.register().expect("registration");
        let mut tickets: Vec<_> = (0..128)
            .map(|_| registration.issue_ticket().expect("bounded ticket"))
            .collect();
        assert_eq!(
            registration.issue_ticket().err(),
            Some(NativePublicationFenceError::CapacityExceeded)
        );
        drop(tickets.pop());
        assert!(registration.issue_ticket().is_ok());
    }
}
