use crate::{RecordingSession, RecordingStats};
use recorder_core::{AudioDeviceInfo, AudioRole, DisplayInfo, RecordingConfig};
use std::{
    ffi::{CStr, CString, c_char, c_void},
    sync::{atomic::Ordering, mpsc},
};

unsafe extern "C" {
    fn sr_displays() -> *mut c_char;
    fn sr_audio_devices(microphone: bool) -> *mut c_char;
    fn sr_free_string(value: *mut c_char);
    fn sr_create(
        display: u32,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
        cursor: bool,
        path: *const c_char,
        audio: *const c_char,
        context: *mut c_void,
        callback: extern "C" fn(*mut c_void, i32, *const c_char),
    ) -> *mut c_void;
    fn sr_pause(session: *mut c_void, paused: bool);
    fn sr_stop(session: *mut c_void);
    fn sr_destroy(session: *mut c_void);
}

pub fn audio_devices(role: AudioRole) -> anyhow::Result<Vec<AudioDeviceInfo>> {
    let pointer = unsafe { sr_audio_devices(role == AudioRole::Microphone) };
    anyhow::ensure!(!pointer.is_null(), "Could not list audio devices");
    let text = unsafe { CStr::from_ptr(pointer) }
        .to_string_lossy()
        .into_owned();
    unsafe {
        sr_free_string(pointer);
    }
    Ok(serde_json::from_str(&text)?)
}

pub fn displays() -> anyhow::Result<Vec<DisplayInfo>> {
    let pointer = unsafe { sr_displays() };
    if pointer.is_null() {
        anyhow::bail!("Could not list displays");
    }
    let text = unsafe { CStr::from_ptr(pointer) }
        .to_string_lossy()
        .into_owned();
    unsafe {
        sr_free_string(pointer);
    }
    let values: Vec<serde_json::Value> = serde_json::from_str(&text)?;
    values
        .into_iter()
        .map(|v| {
            Ok(DisplayInfo {
                id: v["id"].as_u64().unwrap_or(0),
                name: v["name"].as_str().unwrap_or("Display").into(),
                width: v["width"].as_u64().unwrap_or(0) as u32,
                height: v["height"].as_u64().unwrap_or(0) as u32,
                x: v["x"].as_i64().unwrap_or(0) as i32,
                y: v["y"].as_i64().unwrap_or(0) as i32,
                scale: v["scale"].as_f64().unwrap_or(1.0),
            })
        })
        .collect()
}

struct Context {
    stats: RecordingStats,
    result: mpsc::Sender<Result<(), String>>,
}

extern "C" fn callback(context: *mut c_void, kind: i32, message: *const c_char) {
    // The context stays allocated until the terminal callback has been consumed.
    let context = unsafe { &*(context as *const Context) };
    if matches!(kind, 2 | 3 | 4 | 10) {
        let text = if message.is_null() {
            String::new()
        } else {
            unsafe { CStr::from_ptr(message) }
                .to_string_lossy()
                .into_owned()
        };
        match kind {
            2 => context
                .stats
                .system_level
                .store(text.parse().unwrap_or(0), Ordering::Relaxed),
            3 => context
                .stats
                .microphone_level
                .store(text.parse().unwrap_or(0), Ordering::Relaxed),
            4 => {
                context
                    .stats
                    .dropped_frames
                    .fetch_add(text.parse().unwrap_or(0), Ordering::Relaxed);
            }
            _ => {
                *context.stats.audio_warning.lock().unwrap() = Some(text);
            }
        }
        return;
    }
    if kind == 1 {
        if !context.stats.ready.load(Ordering::Acquire) {
            *context.stats.clock.lock().unwrap() = recorder_core::RecordingClock::default();
        }
        if !context.stats.ready.swap(true, Ordering::AcqRel) {
            *context.stats.encoder_name.lock().unwrap() = Some("VideoToolbox H.264".into());
        }
        context.stats.frames.fetch_add(1, Ordering::Relaxed);
        return;
    }
    let result = if kind == 0 {
        Ok(())
    } else {
        Err(if message.is_null() {
            "macOS recording failed".into()
        } else {
            unsafe { CStr::from_ptr(message) }
                .to_string_lossy()
                .into_owned()
        })
    };
    let _ = context.result.send(result);
}

pub fn start_recording(config: RecordingConfig) -> anyhow::Result<RecordingSession> {
    config
        .region
        .validate(config.display.width, config.display.height)
        .map_err(anyhow::Error::msg)?;
    let path = CString::new(
        config
            .output
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("Invalid file path"))?,
    )?;
    let stats = RecordingStats::default();
    let audio = CString::new(serde_json::to_string(&config.audio)?)?;
    let (native_tx, native_rx) = mpsc::channel();
    let context = Box::into_raw(Box::new(Context {
        stats: stats.clone(),
        result: native_tx,
    }));
    let r = config.region;
    let pointer = unsafe {
        sr_create(
            config.display.id as u32,
            r.x,
            r.y,
            r.width,
            r.height,
            config.fps,
            config.bitrate,
            config.show_cursor,
            path.as_ptr(),
            audio.as_ptr(),
            context.cast(),
            callback,
        )
    };
    if pointer.is_null() {
        unsafe {
            drop(Box::from_raw(context));
        }
        anyhow::bail!("Could not create a macOS recording session");
    }
    let (stop_tx, stop_rx) = mpsc::channel();
    let (finished_tx, finished_rx) = mpsc::channel();
    let pointer = pointer as usize;
    let context = context as usize;
    let worker_stats = stats.clone();
    std::thread::spawn(move || {
        let mut stopping = false;
        let mut paused = false;
        loop {
            if let Ok(result) = native_rx.try_recv() {
                let _ = finished_tx.send(result);
                break;
            }
            let now = worker_stats.paused.load(Ordering::Acquire);
            if now != paused {
                unsafe {
                    sr_pause(pointer as *mut c_void, now);
                }
                paused = now;
            }
            if !stopping && stop_rx.try_recv().is_ok() {
                stopping = true;
                unsafe {
                    sr_stop(pointer as *mut c_void);
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        unsafe {
            sr_destroy(pointer as *mut c_void);
            drop(Box::from_raw(context as *mut Context));
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
