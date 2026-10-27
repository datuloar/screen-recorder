mod audio;
mod encoder;

use crate::{RecordingSession, RecordingStats};
use anyhow::anyhow;
use recorder_core::{DisplayInfo, RecordingConfig};
use std::sync::{Arc, Mutex, atomic::Ordering, mpsc};
use windows::Win32::{
    Graphics::Gdi::{GetMonitorInfoW, MONITORINFO},
    UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI},
};
use windows_capture::{
    capture::{Context, GraphicsCaptureApiHandler},
    frame::Frame,
    graphics_capture_api::InternalCaptureControl,
    monitor::Monitor,
    settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    },
};

fn instant_from_qpc(timestamp: u64) -> anyhow::Result<std::time::Instant> {
    use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
    let mut count = 0i64;
    let mut frequency = 0i64;
    unsafe {
        QueryPerformanceCounter(&mut count)?;
        QueryPerformanceFrequency(&mut frequency)?;
    }
    let now = std::time::Instant::now();
    anyhow::ensure!(frequency > 0, "System clock frequency is unavailable");
    let qpc = (count as u128 * 10_000_000 / frequency as u128) as u64;
    Ok(now
        .checked_sub(std::time::Duration::from_nanos(
            qpc.saturating_sub(timestamp).saturating_mul(100),
        ))
        .unwrap_or(now))
}

fn initialize_media_foundation() -> anyhow::Result<()> {
    use windows::Win32::Media::MediaFoundation::*;
    static STARTUP: std::sync::OnceLock<Result<(), String>> = std::sync::OnceLock::new();
    STARTUP
        .get_or_init(|| unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) }.map_err(|e| e.to_string()))
        .as_ref()
        .map_err(|e| anyhow!("{e}"))?;
    Ok(())
}

pub use audio::audio_devices;

pub fn exclude_window(handle: isize) -> anyhow::Result<()> {
    use windows::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE},
    };
    unsafe {
        SetWindowDisplayAffinity(HWND(handle as *mut _), WDA_EXCLUDEFROMCAPTURE)?;
    }
    Ok(())
}

pub fn position_overlay(handle: isize, display: &DisplayInfo) -> anyhow::Result<()> {
    use windows::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{HWND_TOPMOST, SWP_SHOWWINDOW, SetWindowPos},
    };
    unsafe {
        SetWindowPos(
            HWND(handle as *mut _),
            Some(HWND_TOPMOST),
            display.x,
            display.y,
            display.width as i32,
            display.height as i32,
            SWP_SHOWWINDOW,
        )?;
    }
    if std::env::var_os("SCREEN_RECORDER_UI_TEST").is_some() {
        Ok(())
    } else {
        exclude_window(handle)
    }
}

pub fn displays() -> anyhow::Result<Vec<DisplayInfo>> {
    Monitor::enumerate()?
        .into_iter()
        .map(|monitor| {
            let mut info = MONITORINFO {
                cbSize: size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            let handle = windows::Win32::Graphics::Gdi::HMONITOR(monitor.as_raw_hmonitor());
            unsafe { GetMonitorInfoW(handle, &mut info) }.ok()?;
            let mut dx = 96;
            let mut dy = 96;
            let _ = unsafe { GetDpiForMonitor(handle, MDT_EFFECTIVE_DPI, &mut dx, &mut dy) };
            Ok(DisplayInfo {
                id: monitor.index()? as u64,
                name: monitor.name()?,
                width: monitor.width()?,
                height: monitor.height()?,
                x: info.rcMonitor.left,
                y: info.rcMonitor.top,
                scale: dx as f64 / 96.0,
            })
        })
        .collect()
}

struct Handler {
    config: RecordingConfig,
    encoder: Option<encoder::Encoder>,
    stats: RecordingStats,
    previous_time: Option<i64>,
    error: Arc<Mutex<Option<String>>>,
    audio: Option<audio::AudioGroup>,
}

struct Flags {
    config: RecordingConfig,
    stats: RecordingStats,
    error: Arc<Mutex<Option<String>>>,
}

impl Handler {
    fn tick(&mut self) -> anyhow::Result<()> {
        if let Some(error) = self.stats.audio_failure.lock().unwrap().take() {
            anyhow::bail!("{error}");
        }
        if self.stats.paused.load(Ordering::Acquire) {
            return Ok(());
        }
        if let Some(encoder) = &mut self.encoder {
            let (count, dropped) = encoder.tick(self.stats.clock.lock().unwrap().elapsed())?;
            self.stats.frames.fetch_add(count, Ordering::Relaxed);
            self.stats
                .dropped_frames
                .fetch_add(dropped, Ordering::Relaxed);
        }
        Ok(())
    }
    fn finish(&mut self) -> anyhow::Result<()> {
        self.stats.clock.lock().unwrap().pause();
        let audio = self.audio.take().map_or(Ok(()), |audio| audio.finish());
        let video = self
            .encoder
            .take()
            .map_or(Ok(()), |encoder| encoder.finish());
        audio.and(video)
    }
}

impl GraphicsCaptureApiHandler for Handler {
    type Flags = Flags;
    type Error = anyhow::Error;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let encoder = encoder::Encoder::new(&ctx.flags.config, &ctx.device)?;
        let audio = audio::AudioGroup::start(&ctx.flags.config, &ctx.flags.stats)?;
        *ctx.flags.stats.encoder_name.lock().unwrap() = Some(encoder.name.clone());
        Ok(Self {
            config: ctx.flags.config,
            encoder: Some(encoder),
            stats: ctx.flags.stats,
            previous_time: None,
            error: ctx.flags.error,
            audio: Some(audio),
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if self.stats.stopping.load(Ordering::Acquire) {
            control.stop();
            return Ok(());
        }
        if self.stats.paused.load(Ordering::Acquire) {
            return Ok(());
        }
        if !self.stats.ready.load(Ordering::Acquire) {
            let epoch = instant_from_qpc(frame.timestamp()?.Duration as u64)?;
            *self.stats.clock.lock().unwrap() = recorder_core::RecordingClock::starting_at(epoch);
            self.stats.ready.store(true, Ordering::Release);
        }
        let time = self.stats.clock.lock().unwrap().elapsed().as_nanos() as i64 / 100;
        let interval = 10_000_000 / self.config.fps as i64;
        if self.previous_time.is_some_and(|t| time - t < interval) {
            return Ok(());
        }
        if let Some(encoder) = &mut self.encoder
            && let Err(error) = encoder.update(frame)
        {
            *self.error.lock().unwrap() = Some(format!("{error:#}"));
            control.stop();
            return Err(error);
        }
        self.previous_time = Some(time);
        self.tick()
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        self.finish()
    }
}

pub fn start_recording(config: RecordingConfig) -> anyhow::Result<RecordingSession> {
    config
        .region
        .validate(config.display.width, config.display.height)
        .map_err(|e| anyhow!(e))?;
    let monitor = Monitor::enumerate()?
        .into_iter()
        .find(|m| m.index().ok() == Some(config.display.id as usize))
        .ok_or_else(|| anyhow!("The selected display was disconnected"))?;
    let stats = RecordingStats::default();
    let error = Arc::new(Mutex::new(None));
    let settings = Settings::new(
        monitor,
        if config.show_cursor {
            CursorCaptureSettings::WithCursor
        } else {
            CursorCaptureSettings::WithoutCursor
        },
        DrawBorderSettings::Default,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        Flags {
            config,
            stats: stats.clone(),
            error: error.clone(),
        },
    );
    let capture = Handler::start_free_threaded(settings).map_err(|e| anyhow!("{e:?}"))?;
    let handler = capture.callback();
    let (stop_tx, stop_rx) = mpsc::channel();
    let (finished_tx, finished_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let apartment = unsafe {
            windows::Win32::System::Com::CoInitializeEx(
                None,
                windows::Win32::System::Com::COINIT_MULTITHREADED,
            )
        };
        while !capture.is_finished() {
            if stop_rx
                .recv_timeout(std::time::Duration::from_millis(10))
                .is_ok()
            {
                break;
            }
            if let Err(e) = handler.lock().tick() {
                *error.lock().unwrap() = Some(format!("{e:#}"));
                break;
            }
        }
        let result = capture
            .stop()
            .map_err(|e| format!("{e:?}"))
            .and_then(|_| handler.lock().finish().map_err(|e| e.to_string()));
        let result = error.lock().unwrap().take().map_or(result, Err);
        let _ = finished_tx.send(result);
        if apartment.is_ok() {
            unsafe {
                windows::Win32::System::Com::CoUninitialize();
            }
        }
    });
    Ok(RecordingSession {
        stop: Some(Box::new(move || {
            let _ = stop_tx.send(());
        })),
        stats,
        finished: finished_rx,
    })
}
pub fn identify_desktop_app() -> anyhow::Result<()> {
    unsafe {
        windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(windows::core::w!(
            "dev.screenrecorder.desktop"
        ))?;
    }
    Ok(())
}
