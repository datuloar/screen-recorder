#[cfg(target_os = "macos")]
mod mac;
#[cfg(windows)]
mod win;

#[cfg(target_os = "macos")]
pub use mac::*;
#[cfg(windows)]
pub use win::*;

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc,
};

#[derive(Debug, Clone, Default)]
pub struct RecordingStats {
    pub frames: Arc<AtomicU64>,
    pub dropped_frames: Arc<AtomicU64>,
    pub paused: Arc<AtomicBool>,
    clock: Arc<Mutex<recorder_core::RecordingClock>>,
    pub encoder_name: Arc<Mutex<Option<String>>>,
    pub ready: Arc<AtomicBool>,
    stopping: Arc<AtomicBool>,
    pub audio_warning: Arc<Mutex<Option<String>>>,
    pub audio_failure: Arc<Mutex<Option<String>>>,
    pub system_level: Arc<std::sync::atomic::AtomicU32>,
    pub microphone_level: Arc<std::sync::atomic::AtomicU32>,
}

pub struct RecordingSession {
    stop: Option<Box<dyn FnOnce() + Send>>,
    pub stats: RecordingStats,
    finished: mpsc::Receiver<Result<(), String>>,
}

impl RecordingSession {
    pub fn elapsed(&self) -> std::time::Duration {
        self.stats.clock.lock().unwrap().elapsed()
    }
    pub fn pause(&self, paused: bool) {
        let mut clock = self.stats.clock.lock().unwrap();
        if paused {
            clock.pause();
        } else {
            clock.resume();
        }
        self.stats.paused.store(paused, Ordering::Release);
    }
    pub fn request_stop(&mut self) {
        if let Some(stop) = self.stop.take() {
            self.stats.clock.lock().unwrap().pause();
            self.stats.stopping.store(true, Ordering::Release);
            stop();
        }
    }
    pub fn poll_finished(&self) -> Option<Result<(), String>> {
        match self.finished.try_recv() {
            Ok(result) => Some(result),
            Err(mpsc::TryRecvError::Empty) => None,
            Err(mpsc::TryRecvError::Disconnected) => {
                Some(Err("Recording thread ended without a result".into()))
            }
        }
    }
}

impl Drop for RecordingSession {
    fn drop(&mut self) {
        self.request_stop();
    }
}
