//! Shared terminal-close ownership for native mobile voice sessions.
//!
//! This reports only Rust-local callback completion and worker-thread joining.
//! It does not prove that a platform audio engine or a remote provider stopped.

use aurora_voice_core::{
    CancellationToken, CleanupCallbackOutcome, Generation, VoiceCleanupReport,
};
use std::future::Future;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;
use thiserror::Error;
use tokio::sync::watch;

/// Fixed native-local result for a terminal mobile session close.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum MobileSessionCloseError {
    #[error("voice session is unavailable")]
    Unavailable,
    #[error("voice session shutdown could not be confirmed")]
    ShutdownFailed,
    #[error("voice session cleanup could not be confirmed")]
    CleanupFailed,
    #[error("voice session worker failed")]
    WorkerFailed,
    #[error("voice session worker exit could not be confirmed")]
    JoinUnconfirmed,
    #[error("voice session close deadline expired")]
    DeadlineExpired,
}

#[derive(Clone)]
pub(crate) struct MobileSessionLifecycle {
    shared: Arc<Shared>,
}

struct Shared {
    state: Mutex<State>,
    changed: Condvar,
    terminal: watch::Sender<Option<Result<(), MobileSessionCloseError>>>,
    #[cfg(test)]
    after_cleanup_hook: Mutex<Option<Box<AfterCleanupHook>>>,
    #[cfg(test)]
    before_terminal_publish_hook: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    #[cfg(test)]
    blocking_wait_entered: Mutex<Option<mpsc::Sender<()>>>,
    #[cfg(test)]
    unexpected_channel_close: Mutex<Option<mpsc::Sender<()>>>,
}

#[cfg(test)]
type AfterCleanupHook = dyn FnMut(Generation, Option<VoiceCleanupReport>) + Send;

struct State {
    retired: bool,
    active: Option<(Generation, CancellationToken)>,
    last_generation: u64,
    cleanup_count: u64,
    failure: Option<MobileSessionCloseError>,
    result: Option<Result<(), MobileSessionCloseError>>,
}

impl MobileSessionLifecycle {
    pub(crate) fn new() -> Self {
        let (terminal, receiver) = watch::channel(None);
        drop(receiver);
        Self {
            shared: Arc::new(Shared {
                state: Mutex::new(State {
                    retired: false,
                    active: None,
                    last_generation: 0,
                    cleanup_count: 0,
                    failure: None,
                    result: None,
                }),
                changed: Condvar::new(),
                terminal,
                #[cfg(test)]
                after_cleanup_hook: Mutex::new(None),
                #[cfg(test)]
                before_terminal_publish_hook: Mutex::new(None),
                #[cfg(test)]
                blocking_wait_entered: Mutex::new(None),
                #[cfg(test)]
                unexpected_channel_close: Mutex::new(None),
            }),
        }
    }

    #[cfg(test)]
    pub(crate) fn set_after_cleanup_hook(
        &self,
        hook: impl FnMut(Generation, Option<VoiceCleanupReport>) + Send + 'static,
    ) {
        if let Ok(mut slot) = self.shared.after_cleanup_hook.lock() {
            *slot = Some(Box::new(hook));
        }
    }

    #[cfg(test)]
    fn set_before_terminal_publish_hook(&self, hook: impl FnOnce() + Send + 'static) {
        if let Ok(mut slot) = self.shared.before_terminal_publish_hook.lock() {
            *slot = Some(Box::new(hook));
        }
    }

    #[cfg(test)]
    fn set_blocking_wait_entered(&self, entered: mpsc::Sender<()>) {
        if let Ok(mut slot) = self.shared.blocking_wait_entered.lock() {
            *slot = Some(entered);
        }
    }

    #[cfg(test)]
    pub(crate) fn set_unexpected_channel_close_hook(&self, observed: mpsc::Sender<()>) {
        if let Ok(mut slot) = self.shared.unexpected_channel_close.lock() {
            *slot = Some(observed);
        }
    }

    /// Runs a synchronous enqueue operation under the admission barrier.
    pub(crate) fn admit(
        &self,
        enqueue: impl FnOnce() -> bool,
    ) -> Result<(), MobileSessionCloseError> {
        let mut state = match self.shared.state.lock() {
            Ok(state) => state,
            Err(poisoned) => {
                let mut state = poisoned.into_inner();
                state.retired = true;
                set_first_failure(&mut state, MobileSessionCloseError::Unavailable);
                return Err(MobileSessionCloseError::Unavailable);
            }
        };
        if state.retired {
            return Err(MobileSessionCloseError::ShutdownFailed);
        }
        if enqueue() {
            Ok(())
        } else {
            state.retired = true;
            if let Some((_, cancellation)) = state.active.as_ref() {
                cancellation.cancel();
            }
            set_first_failure(&mut state, MobileSessionCloseError::ShutdownFailed);
            Err(MobileSessionCloseError::ShutdownFailed)
        }
    }

    /// Installs the actual core generation before its future can be polled.
    pub(crate) fn begin_generation(
        &self,
        generation: Generation,
        cancellation: CancellationToken,
    ) -> Result<(), MobileSessionCloseError> {
        let mut state = match self.shared.state.lock() {
            Ok(state) => state,
            Err(poisoned) => {
                let mut state = poisoned.into_inner();
                state.retired = true;
                set_first_failure(&mut state, MobileSessionCloseError::Unavailable);
                return Err(MobileSessionCloseError::Unavailable);
            }
        };
        if state.retired || state.active.is_some() || generation.0 <= state.last_generation {
            return Err(MobileSessionCloseError::ShutdownFailed);
        }
        state.last_generation = generation.0;
        state.active = Some((generation, cancellation));
        Ok(())
    }

    /// Closes admission, cancels the actual active generation, and enqueues one shutdown.
    /// The returned generation is interrupted by the caller after this lock is released.
    pub(crate) fn request_retirement(
        &self,
        enqueue_shutdown: impl FnOnce() -> bool,
    ) -> Option<Generation> {
        let mut state = match self.shared.state.lock() {
            Ok(state) => state,
            Err(poisoned) => {
                let mut state = poisoned.into_inner();
                set_first_failure(&mut state, MobileSessionCloseError::Unavailable);
                state
            }
        };
        if state.retired {
            return state.active.as_ref().map(|(generation, _)| *generation);
        }
        state.retired = true;
        if let Some((_, cancellation)) = state.active.as_ref() {
            cancellation.cancel();
        }
        if !enqueue_shutdown() {
            set_first_failure(&mut state, MobileSessionCloseError::ShutdownFailed);
        }
        state.active.as_ref().map(|(generation, _)| *generation)
    }

    /// Latches retirement observed by the worker (shutdown or channel closure).
    pub(crate) fn worker_retire(&self) -> Option<Generation> {
        let mut state = match self.shared.state.lock() {
            Ok(state) => state,
            Err(poisoned) => {
                let mut state = poisoned.into_inner();
                set_first_failure(&mut state, MobileSessionCloseError::Unavailable);
                state
            }
        };
        state.retired = true;
        if let Some((_, cancellation)) = state.active.as_ref() {
            cancellation.cancel();
        }
        state.active.as_ref().map(|(generation, _)| *generation)
    }

    pub(crate) fn unexpected_channel_close(&self) -> Option<Generation> {
        let generation = self.worker_retire();
        if let Ok(mut state) = self.shared.state.lock() {
            set_first_failure(&mut state, MobileSessionCloseError::ShutdownFailed);
        }
        #[cfg(test)]
        if let Ok(mut hook) = self.shared.unexpected_channel_close.lock() {
            if let Some(observed) = hook.take() {
                let _ = observed.send(());
            }
        }
        generation
    }

    pub(crate) fn is_retired(&self) -> bool {
        self.shared
            .state
            .lock()
            .map(|state| state.retired)
            .unwrap_or(true)
    }

    /// Records the actual report immediately after the matching core invocation.
    pub(crate) fn record_cleanup(&self, expected: Generation, report: Option<VoiceCleanupReport>) {
        let mut state = match self.shared.state.lock() {
            Ok(state) => state,
            Err(poisoned) => {
                let mut state = poisoned.into_inner();
                state.retired = true;
                set_first_failure(&mut state, MobileSessionCloseError::Unavailable);
                state
            }
        };
        let valid = report.is_some_and(|report| {
            if report.generation() != expected {
                return false;
            }
            let outcomes = [
                report.wake_cancel(),
                report.stt_cancel(),
                report.tts_cancel(),
                report.transport_cancel(),
                report.output_stop(),
                report.capture_stop(),
                report.capture_lease_release(),
                report.state_reset(),
            ];
            let no_callback_error = outcomes
                .iter()
                .all(|outcome| *outcome != CleanupCallbackOutcome::ReturnedError);
            let required_release =
                report.capture_lease_release() == CleanupCallbackOutcome::ReturnedOk;
            let required_capture_stop = !report.capture_start_attempted()
                || report.capture_stop() == CleanupCallbackOutcome::ReturnedOk;
            no_callback_error && required_release && required_capture_stop
        });
        state.cleanup_count = match state.cleanup_count.checked_add(1) {
            Some(value) => value,
            None => {
                set_first_failure(&mut state, MobileSessionCloseError::CleanupFailed);
                return;
            }
        };
        let active_matches = state
            .active
            .as_ref()
            .is_some_and(|(generation, _)| *generation == expected);
        if !valid || !active_matches {
            set_first_failure(&mut state, MobileSessionCloseError::CleanupFailed);
        }
        if active_matches {
            state.active = None;
        }
        drop(state);
        self.shared.changed.notify_all();
        #[cfg(test)]
        if let Ok(mut hook) = self.shared.after_cleanup_hook.lock() {
            if let Some(hook) = hook.as_mut() {
                hook(expected, report);
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn wait_for_cleanup_count(&self, expected: u64) -> bool {
        let started = std::time::Instant::now();
        let mut state = match self.shared.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        while state.cleanup_count < expected {
            let remaining = Duration::from_secs(5).saturating_sub(started.elapsed());
            if remaining.is_zero() {
                return false;
            }
            let (next, timed_out) = match self.shared.changed.wait_timeout(state, remaining) {
                Ok(result) => result,
                Err(poisoned) => poisoned.into_inner(),
            };
            state = next;
            if timed_out.timed_out() && state.cleanup_count < expected {
                return false;
            }
        }
        true
    }

    pub(crate) fn record_failure(&self, error: MobileSessionCloseError) {
        let mut state = match self.shared.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        set_first_failure(&mut state, error);
    }

    pub(crate) fn complete_join(&self, result: Result<(), MobileSessionCloseError>) {
        self.finish_join(result);
    }

    pub(crate) fn request_worker_shutdown(
        &self,
        enqueue_shutdown: impl FnOnce() -> bool,
    ) -> Option<Generation> {
        self.request_retirement(enqueue_shutdown)
    }

    pub(crate) fn wait_closed(
        &self,
    ) -> impl Future<Output = Result<(), MobileSessionCloseError>> + Send + 'static {
        let mut terminal = self.shared.terminal.subscribe();
        async move {
            loop {
                if let Some(result) = *terminal.borrow_and_update() {
                    return result;
                }
                if terminal.changed().await.is_err() {
                    return Err(MobileSessionCloseError::Unavailable);
                }
            }
        }
    }

    pub(crate) fn close_checked(&self) -> Result<(), MobileSessionCloseError> {
        let mut state = match self.shared.state.lock() {
            Ok(state) => state,
            Err(poisoned) => {
                let mut state = poisoned.into_inner();
                set_first_failure(&mut state, MobileSessionCloseError::Unavailable);
                state
            }
        };
        while state.result.is_none() {
            #[cfg(test)]
            if let Ok(mut observer) = self.shared.blocking_wait_entered.lock() {
                if let Some(entered) = observer.take() {
                    let _ = entered.send(());
                }
            }
            state = match self.shared.changed.wait(state) {
                Ok(state) => state,
                Err(poisoned) => {
                    let mut state = poisoned.into_inner();
                    set_first_failure(&mut state, MobileSessionCloseError::Unavailable);
                    state
                }
            };
        }
        state
            .result
            .unwrap_or(Err(MobileSessionCloseError::Unavailable))
    }

    pub(crate) fn close_checked_timeout(
        &self,
        timeout: Duration,
    ) -> Result<(), MobileSessionCloseError> {
        let started = std::time::Instant::now();
        let mut state = match self.shared.state.lock() {
            Ok(state) => state,
            Err(poisoned) => {
                let mut state = poisoned.into_inner();
                set_first_failure(&mut state, MobileSessionCloseError::Unavailable);
                state
            }
        };
        loop {
            if let Some(result) = state.result {
                return result;
            }
            let remaining = timeout.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                set_first_failure(&mut state, MobileSessionCloseError::DeadlineExpired);
                return Err(state
                    .failure
                    .unwrap_or(MobileSessionCloseError::DeadlineExpired));
            }
            let (next, timed_out) = match self.shared.changed.wait_timeout(state, remaining) {
                Ok(result) => result,
                Err(poisoned) => {
                    let (mut recovered, timed_out) = poisoned.into_inner();
                    set_first_failure(&mut recovered, MobileSessionCloseError::Unavailable);
                    (recovered, timed_out)
                }
            };
            state = next;
            if timed_out.timed_out() && state.result.is_none() {
                set_first_failure(&mut state, MobileSessionCloseError::DeadlineExpired);
                return Err(state
                    .failure
                    .unwrap_or(MobileSessionCloseError::DeadlineExpired));
            }
        }
    }

    fn finish_join(&self, result: Result<(), MobileSessionCloseError>) {
        let terminal_result = {
            let mut state = match self.shared.state.lock() {
                Ok(state) => state,
                Err(poisoned) => {
                    let mut state = poisoned.into_inner();
                    set_first_failure(&mut state, MobileSessionCloseError::Unavailable);
                    state
                }
            };
            if let Some(existing) = state.result {
                existing
            } else {
                if !state.retired {
                    state.retired = true;
                    set_first_failure(&mut state, MobileSessionCloseError::ShutdownFailed);
                }
                if state.active.is_some() {
                    set_first_failure(&mut state, MobileSessionCloseError::CleanupFailed);
                }
                if let Err(error) = result {
                    set_first_failure(&mut state, error);
                }
                let terminal_result = state.failure.map_or(Ok(()), Err);
                state.result = Some(terminal_result);
                terminal_result
            }
        };
        #[cfg(test)]
        {
            let hook = match self.shared.before_terminal_publish_hook.lock() {
                Ok(mut slot) => slot.take(),
                Err(poisoned) => poisoned.into_inner().take(),
            };
            if let Some(hook) = hook {
                hook();
            }
        }
        self.shared.terminal.send_replace(Some(terminal_result));
        self.shared.changed.notify_all();
    }
}

/// Starts the independent join driver. On spawn failure, ownership of the worker
/// handle is returned so the synchronous constructor can retire and join it.
pub(crate) fn start_join_driver(
    lifecycle: &MobileSessionLifecycle,
    worker: thread::JoinHandle<()>,
) -> Result<(), thread::JoinHandle<()>> {
    start_join_driver_with(lifecycle, worker, |task| {
        thread::Builder::new()
            .name("aurora-mobile-voice-join".to_owned())
            .spawn(task)
    })
}

/// Handles the synchronous constructor rollback when the retained join driver
/// cannot be created. The worker remains owned and joined before this returns.
pub(crate) fn rollback_failed_join_driver(
    lifecycle: &MobileSessionLifecycle,
    worker: thread::JoinHandle<()>,
    enqueue_shutdown: impl FnOnce() -> bool,
    interrupt_generation: impl FnOnce(Generation),
    close_rust_queues: impl FnOnce(),
) {
    if let Some(generation) = lifecycle.request_worker_shutdown(enqueue_shutdown) {
        interrupt_generation(generation);
    }
    close_rust_queues();
    lifecycle.record_failure(MobileSessionCloseError::Unavailable);
    lifecycle.complete_join(join_worker(worker));
}

fn join_worker(worker: thread::JoinHandle<()>) -> Result<(), MobileSessionCloseError> {
    match worker.join() {
        Ok(()) => Ok(()),
        Err(payload) => {
            dispose_panic_payload(payload);
            Err(MobileSessionCloseError::WorkerFailed)
        }
    }
}

fn start_join_driver_with(
    lifecycle: &MobileSessionLifecycle,
    worker: thread::JoinHandle<()>,
    spawn: impl FnOnce(Box<dyn FnOnce() + Send + 'static>) -> std::io::Result<thread::JoinHandle<()>>,
) -> Result<(), thread::JoinHandle<()>> {
    let driver_lifecycle = lifecycle.clone();
    let (start_driver, worker_receiver): (
        mpsc::SyncSender<thread::JoinHandle<()>>,
        mpsc::Receiver<thread::JoinHandle<()>>,
    ) = mpsc::sync_channel(0);
    let task = Box::new(move || {
        let mut completion = JoinDriverCompletion {
            lifecycle: driver_lifecycle,
            worker_joined: false,
            published: false,
        };
        let result = match worker_receiver.recv() {
            Ok(worker) => {
                // `join` returned, so the worker has actually exited even if
                // its execution panicked. Mark this before inspecting payload.
                let joined = worker.join();
                completion.worker_joined = true;
                match joined {
                    Ok(()) => Ok(()),
                    Err(payload) => {
                        dispose_panic_payload(payload);
                        Err(MobileSessionCloseError::WorkerFailed)
                    }
                }
            }
            Err(_) => Err(MobileSessionCloseError::JoinUnconfirmed),
        };
        completion.lifecycle.finish_join(result);
        completion.published = true;
    });
    match spawn(task) {
        Ok(_driver) => start_driver
            .send(worker)
            .map_or_else(|failure| Err(failure.0), |_| Ok(())),
        Err(_) => Err(worker),
    }
}

struct JoinDriverCompletion {
    lifecycle: MobileSessionLifecycle,
    worker_joined: bool,
    published: bool,
}

impl Drop for JoinDriverCompletion {
    fn drop(&mut self) {
        if self.published {
            return;
        }
        let error = if self.worker_joined {
            MobileSessionCloseError::WorkerFailed
        } else {
            MobileSessionCloseError::JoinUnconfirmed
        };
        let _ = catch_unwind(AssertUnwindSafe(|| {
            self.lifecycle.complete_join(Err(error));
        }));
    }
}

fn dispose_panic_payload(payload: Box<dyn std::any::Any + Send + 'static>) {
    if let Err(secondary_payload) = catch_unwind(AssertUnwindSafe(|| drop(payload))) {
        // A panic payload's destructor is user code. Do not let it strand all
        // close observers while unwinding the retained join-driver thread.
        std::mem::forget(secondary_payload);
    }
}

fn set_first_failure(state: &mut State, error: MobileSessionCloseError) {
    if state.failure.is_none() {
        state.failure = Some(error);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::task::{Context, Poll, Wake, Waker};

    struct TestWake;

    impl Wake for TestWake {
        fn wake(self: Arc<Self>) {}
    }

    fn test_waker() -> Waker {
        Waker::from(Arc::new(TestWake))
    }

    struct CountingWake {
        count: Mutex<usize>,
        changed: Condvar,
    }

    impl CountingWake {
        fn new() -> Self {
            Self {
                count: Mutex::new(0),
                changed: Condvar::new(),
            }
        }

        fn wait_for_wake(&self) -> bool {
            let state = match self.count.lock() {
                Ok(state) => state,
                Err(poisoned) => poisoned.into_inner(),
            };
            let (state, _) =
                match self
                    .changed
                    .wait_timeout_while(state, Duration::from_secs(2), |count| *count == 0)
                {
                    Ok(result) => result,
                    Err(poisoned) => poisoned.into_inner(),
                };
            *state > 0
        }
    }

    impl Wake for CountingWake {
        fn wake(self: Arc<Self>) {
            self.wake_by_ref();
        }

        fn wake_by_ref(self: &Arc<Self>) {
            let mut count = match self.count.lock() {
                Ok(count) => count,
                Err(poisoned) => poisoned.into_inner(),
            };
            *count += 1;
            self.changed.notify_all();
        }
    }

    #[test]
    fn dropped_polled_waiter_and_recreated_waiter_share_actual_worker_join() {
        let lifecycle = MobileSessionLifecycle::new();
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            let _ = started_tx.send(());
            let _ = release_rx.recv();
        });
        start_join_driver(&lifecycle, worker).expect("join driver");
        started_rx.recv().expect("worker entered");
        lifecycle.request_retirement(|| true);

        for _ in 0..32 {
            let first_waker = test_waker();
            let second_waker = test_waker();
            let mut first_context = Context::from_waker(&first_waker);
            let mut second_context = Context::from_waker(&second_waker);
            let mut waiter = Box::pin(lifecycle.wait_closed());
            assert!(matches!(
                waiter.as_mut().poll(&mut first_context),
                Poll::Pending
            ));
            assert!(matches!(
                waiter.as_mut().poll(&mut second_context),
                Poll::Pending
            ));
            drop(waiter);
        }

        release_tx.send(()).expect("release worker");
        assert_eq!(
            lifecycle.close_checked_timeout(Duration::from_secs(2)),
            Ok(())
        );
        let mut second_wait = Box::pin(lifecycle.wait_closed());
        let waker = test_waker();
        let mut context = Context::from_waker(&waker);
        assert!(matches!(
            second_wait.as_mut().poll(&mut context),
            Poll::Ready(Ok(()))
        ));
    }

    #[test]
    fn timeout_before_join_remains_sticky_after_worker_exit() {
        let lifecycle = MobileSessionLifecycle::new();
        let (release_tx, release_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            let _ = release_rx.recv();
        });
        start_join_driver(&lifecycle, worker).expect("join driver");
        lifecycle.request_retirement(|| true);
        assert_eq!(
            lifecycle.close_checked_timeout(Duration::ZERO),
            Err(MobileSessionCloseError::DeadlineExpired)
        );
        release_tx.send(()).expect("release worker");
        assert_eq!(
            lifecycle.close_checked(),
            Err(MobileSessionCloseError::DeadlineExpired)
        );
    }

    #[test]
    fn successful_join_is_immutable_before_zero_deadline_observation() {
        let lifecycle = MobileSessionLifecycle::new();
        let worker = thread::spawn(|| {});
        lifecycle.request_retirement(|| true);
        start_join_driver(&lifecycle, worker).expect("join driver");
        assert_eq!(lifecycle.close_checked(), Ok(()));
        assert_eq!(lifecycle.close_checked_timeout(Duration::ZERO), Ok(()));
    }

    #[test]
    fn interrupted_terminal_publication_retries_watch_and_condvar_notifications() {
        let lifecycle = MobileSessionLifecycle::new();
        lifecycle.set_before_terminal_publish_hook(|| {
            panic!("interrupt after retaining the joined result");
        });
        let (worker_started_tx, worker_started_rx) = mpsc::channel();
        let (release_worker_tx, release_worker_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            worker_started_tx.send(()).expect("worker started");
            release_worker_rx.recv().expect("worker release");
        });
        start_join_driver(&lifecycle, worker).expect("actual join driver");
        worker_started_rx.recv().expect("real worker entered");
        lifecycle.request_retirement(|| true);

        let waker = test_waker();
        let mut context = Context::from_waker(&waker);
        let mut async_waiter = Box::pin(lifecycle.wait_closed());
        assert!(matches!(
            async_waiter.as_mut().poll(&mut context),
            Poll::Pending
        ));

        let (blocking_wait_entered_tx, blocking_wait_entered_rx) = mpsc::channel();
        lifecycle.set_blocking_wait_entered(blocking_wait_entered_tx);
        let blocking_lifecycle = lifecycle.clone();
        let (blocking_result_tx, blocking_result_rx) = mpsc::channel();
        let blocking_waiter = thread::spawn(move || {
            blocking_result_tx
                .send(blocking_lifecycle.close_checked())
                .expect("blocking observer result");
        });
        blocking_wait_entered_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("synchronous observer entered its condvar wait");

        release_worker_tx.send(()).expect("release joined worker");
        assert_eq!(
            blocking_result_rx.recv_timeout(Duration::from_secs(2)),
            Ok(Ok(()))
        );
        blocking_waiter.join().expect("blocking observer returned");
        assert!(matches!(
            async_waiter.as_mut().poll(&mut context),
            Poll::Ready(Ok(()))
        ));
    }

    #[test]
    fn join_driver_spawn_failure_returns_the_still_owned_worker() {
        let lifecycle = MobileSessionLifecycle::new();
        let (started_tx, started_rx) = mpsc::channel();
        let (shutdown_tx, shutdown_rx) = mpsc::channel();
        let (exited_tx, exited_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            let _ = started_tx.send(());
            let _ = shutdown_rx.recv();
            let _ = exited_tx.send(());
        });
        started_rx.recv().expect("real worker entered");
        let returned = start_join_driver_with(&lifecycle, worker, |_task| {
            Err(std::io::Error::other("injected"))
        });
        let worker = returned.expect_err("spawn failure");
        shutdown_tx.send(()).expect("retire returned worker");
        assert!(worker.join().is_ok());
        exited_rx.recv().expect("real worker exited before return");
    }

    #[test]
    fn constructor_rollback_joins_the_real_worker_before_returning() {
        let lifecycle = MobileSessionLifecycle::new();
        let (shutdown_tx, shutdown_rx) = mpsc::channel();
        let (started_tx, started_rx) = mpsc::channel();
        let (exited_tx, exited_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            started_tx.send(()).expect("worker started");
            shutdown_rx.recv().expect("constructor shutdown");
            exited_tx.send(()).expect("worker exited");
        });
        started_rx.recv().expect("worker startup reached");
        let close_called = std::sync::atomic::AtomicBool::new(false);
        rollback_failed_join_driver(
            &lifecycle,
            worker,
            || shutdown_tx.send(()).is_ok(),
            |_| {},
            || close_called.store(true, std::sync::atomic::Ordering::SeqCst),
        );
        exited_rx
            .recv()
            .expect("worker joined before constructor return");
        assert!(close_called.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(
            lifecycle.close_checked_timeout(Duration::ZERO),
            Err(MobileSessionCloseError::Unavailable)
        );
    }

    #[test]
    fn failed_shutdown_enqueue_remains_sticky_after_actual_join() {
        let lifecycle = MobileSessionLifecycle::new();
        let (shutdown_tx, shutdown_rx) = tokio::sync::mpsc::unbounded_channel();
        drop(shutdown_rx);
        assert_eq!(
            lifecycle.request_retirement(|| shutdown_tx.send(()).is_ok()),
            None
        );
        let worker = thread::spawn(|| {});
        start_join_driver(&lifecycle, worker).expect("join driver");
        assert_eq!(
            lifecycle.close_checked_timeout(Duration::from_secs(2)),
            Err(MobileSessionCloseError::ShutdownFailed)
        );
    }

    #[test]
    fn startup_failure_is_retained_until_actual_worker_join() {
        let lifecycle = MobileSessionLifecycle::new();
        lifecycle.record_failure(MobileSessionCloseError::Unavailable);
        let (release_tx, release_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            let _ = release_rx.recv();
        });
        start_join_driver(&lifecycle, worker).expect("join driver");
        lifecycle.request_retirement(|| true);
        release_tx.send(()).expect("finish failed-start worker");
        assert_eq!(
            lifecycle.close_checked_timeout(Duration::from_secs(2)),
            Err(MobileSessionCloseError::Unavailable)
        );
    }

    #[test]
    fn active_generation_without_actual_cleanup_report_cannot_join_successfully() {
        let lifecycle = MobileSessionLifecycle::new();
        lifecycle
            .begin_generation(Generation(1), CancellationToken::new())
            .expect("active generation");
        lifecycle.request_retirement(|| true);
        let worker = thread::spawn(|| {});
        start_join_driver(&lifecycle, worker).expect("join driver");
        assert_eq!(
            lifecycle.close_checked_timeout(Duration::from_secs(2)),
            Err(MobileSessionCloseError::CleanupFailed)
        );
    }

    #[test]
    fn worker_panic_is_reported_only_after_join() {
        let lifecycle = MobileSessionLifecycle::new();
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            let _ = started_tx.send(());
            let _ = release_rx.recv();
            panic!("private worker test");
        });
        start_join_driver(&lifecycle, worker).expect("join driver");
        started_rx.recv().expect("worker entered");
        lifecycle.request_retirement(|| true);
        release_tx.send(()).expect("release worker");
        assert_eq!(
            lifecycle.close_checked_timeout(Duration::from_secs(2)),
            Err(MobileSessionCloseError::WorkerFailed)
        );
    }

    struct PanicWhenDropped(Arc<std::sync::atomic::AtomicBool>);

    impl Drop for PanicWhenDropped {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
            panic!("private panic-payload destructor test");
        }
    }

    #[test]
    fn panic_payload_destructor_cannot_strand_join_observers() {
        let lifecycle = MobileSessionLifecycle::new();
        let payload_dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let worker_payload_dropped = Arc::clone(&payload_dropped);
        let worker = thread::spawn(move || {
            std::panic::panic_any(PanicWhenDropped(worker_payload_dropped));
        });
        lifecycle.request_retirement(|| true);
        start_join_driver(&lifecycle, worker).expect("join driver");
        assert_eq!(
            lifecycle.close_checked_timeout(Duration::from_secs(2)),
            Err(MobileSessionCloseError::WorkerFailed)
        );
        assert!(payload_dropped.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn concurrent_async_observers_receive_join_notification_without_runtime() {
        let lifecycle = MobileSessionLifecycle::new();
        let (release_tx, release_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            let _ = release_rx.recv();
        });
        start_join_driver(&lifecycle, worker).expect("join driver");
        lifecycle.request_retirement(|| true);

        let (polled_tx, polled_rx) = mpsc::channel();
        let mut observers = Vec::new();
        for _ in 0..2 {
            let lifecycle = lifecycle.clone();
            let polled = polled_tx.clone();
            observers.push(thread::spawn(move || {
                let wake = Arc::new(CountingWake::new());
                let waker = Waker::from(Arc::clone(&wake));
                let mut context = Context::from_waker(&waker);
                let mut waiter = Box::pin(lifecycle.wait_closed());
                assert!(matches!(waiter.as_mut().poll(&mut context), Poll::Pending));
                polled.send(()).expect("observer polled");
                assert!(wake.wait_for_wake());
                assert!(matches!(
                    waiter.as_mut().poll(&mut context),
                    Poll::Ready(Ok(()))
                ));
            }));
        }
        drop(polled_tx);
        polled_rx.recv().expect("first observer pending");
        polled_rx.recv().expect("second observer pending");
        release_tx.send(()).expect("release worker");
        for observer in observers {
            observer.join().expect("observer completed");
        }
    }

    #[test]
    fn retirement_closes_admission_and_cancels_the_actual_generation() {
        let lifecycle = MobileSessionLifecycle::new();
        let cancellation = CancellationToken::new();
        lifecycle
            .begin_generation(Generation(1), cancellation.clone())
            .expect("active generation");
        assert_eq!(lifecycle.request_retirement(|| true), Some(Generation(1)));
        assert!(cancellation.is_cancelled());
        let mut enqueued = false;
        assert_eq!(
            lifecycle.admit(|| {
                enqueued = true;
                true
            }),
            Err(MobileSessionCloseError::ShutdownFailed)
        );
        assert!(!enqueued);
    }
}
