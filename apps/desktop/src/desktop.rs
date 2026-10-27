use crate::shell::{self, Shell, ShellEvent};
use recorder_core::{
    AppSettings, AudioDeviceInfo, AudioMix, AudioRole, DisplayInfo, EditProject, PixelRect,
    RecordingConfig, RecordingEntry, SessionJournal, SessionState,
};
use recorder_media::{MediaInfo, MediaTools};
use recorder_platform::RecordingSession;
use serde::Serialize;
use std::{
    cell::RefCell,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

thread_local! {static SHELL:RefCell<Option<Shell>>=const{RefCell::new(None)};}

#[derive(Clone, Serialize)]
struct EditorDocument {
    document_id: u64,
    source: PathBuf,
    info: MediaInfo,
    project: EditProject,
    warnings: Vec<String>,
}

struct Engine {
    settings: AppSettings,
    settings_path: PathBuf,
    first_run: bool,
    session: Option<RecordingSession>,
    phase: String,
    error: Option<String>,
    shell_warning: Option<String>,
    last_source: Option<PathBuf>,
    document: Option<EditorDocument>,
    export_cancel: Option<Arc<AtomicBool>>,
    last_export: Option<PathBuf>,
    recovery_cancel: Option<Arc<AtomicBool>>,
    next_document_id: u64,
    pending_recovery: bool,
    cancel_start: bool,
    pending_open: Option<PathBuf>,
    recording_warnings: Vec<String>,
}

type Shared = Mutex<Engine>;
type UiResult<T> = Result<T, String>;
fn failure(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[derive(Serialize)]
struct Bootstrap {
    version: &'static str,
    system_language: &'static str,
    settings: AppSettings,
    displays: Vec<DisplayInfo>,
    system_devices: Vec<AudioDeviceInfo>,
    microphone_devices: Vec<AudioDeviceInfo>,
    error: Option<String>,
    document: Option<EditorDocument>,
    recordings: Vec<RecordingEntry>,
    pending_open: bool,
}

#[derive(Serialize, Clone, Default)]
struct CaptureStatus {
    phase: String,
    elapsed_ms: u64,
    frames: u64,
    dropped_frames: u64,
    encoder: Option<String>,
    system_level: u32,
    microphone_level: u32,
    error: Option<String>,
}

impl Engine {
    fn new() -> anyhow::Result<Self> {
        let dirs = directories::ProjectDirs::from("dev", "ScreenRecorder", "ScreenRecorder")
            .ok_or_else(|| anyhow::anyhow!("Settings directory not found"))?;
        let settings_path = std::env::var_os("SCREEN_RECORDER_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| dirs.config_dir().into())
            .join("settings.json");
        let first_run = !settings_path.exists();
        let mut error = None;
        let mut settings = if first_run {
            AppSettings::default()
        } else {
            recorder_core::load_json(&settings_path).unwrap_or_else(|e| {
                error = Some(e);
                AppSettings::default()
            })
        };
        if let Err(e) = settings.validate() {
            error = Some(e);
            settings = AppSettings::default();
        }
        if settings.output_dir.as_os_str().is_empty() {
            settings.output_dir = directories::UserDirs::new()
                .and_then(|d| d.video_dir().map(PathBuf::from))
                .unwrap_or_else(|| dirs.data_dir().into())
                .join("Screen Recorder");
        }
        if first_run {
            recorder_core::save_json(&settings_path, &settings).map_err(anyhow::Error::msg)?;
        }
        let entries = recorder_core::recordings(&settings.output_dir).unwrap_or_default();
        let last_source = entries
            .iter()
            .find(|r| !r.needs_recovery && r.source_exists)
            .map(|r| settings.output_dir.join(&r.id).join("source.mp4"));
        let pending_recovery = entries
            .iter()
            .any(|r| r.needs_recovery && r.recovery_copy.is_none());
        Ok(Self {
            settings,
            settings_path,
            first_run,
            session: None,
            phase: "idle".into(),
            error,
            shell_warning: None,
            last_source,
            document: None,
            export_cancel: None,
            last_export: None,
            recovery_cancel: None,
            next_document_id: 0,
            pending_recovery,
            cancel_start: false,
            pending_open: None,
            recording_warnings: Vec::new(),
        })
    }

    fn status(&self) -> CaptureStatus {
        let mut status = CaptureStatus {
            phase: self.phase.clone(),
            error: self.error.clone().or_else(|| self.shell_warning.clone()),
            ..Default::default()
        };
        if let Some(session) = &self.session {
            let stats = &session.stats;
            status.elapsed_ms = session.elapsed().as_millis() as u64;
            status.frames = stats.frames.load(Ordering::Relaxed);
            status.dropped_frames = stats.dropped_frames.load(Ordering::Relaxed);
            status.encoder = stats.encoder_name.lock().unwrap().clone();
            status.system_level = stats.system_level.load(Ordering::Relaxed);
            status.microphone_level = stats.microphone_level.load(Ordering::Relaxed);
            if stats.paused.load(Ordering::Acquire) && self.phase != "saving" {
                status.phase = "paused".into();
            } else if !stats.ready.load(Ordering::Acquire) && self.phase == "recording" {
                status.phase = "preparing".into();
            }
        }
        status
    }
}

#[tauri::command]
async fn bootstrap(state: State<'_, Shared>) -> UiResult<Bootstrap> {
    let (settings, mut error, document, pending_open) = {
        let engine = state.lock().unwrap();
        (
            engine.settings.clone(),
            engine
                .error
                .clone()
                .or_else(|| engine.shell_warning.clone()),
            engine.document.clone(),
            engine.pending_open.is_some(),
        )
    };
    tauri::async_runtime::spawn_blocking(move || {
        let recordings =
            recorder_core::recordings(&settings.output_dir).unwrap_or_else(|failure| {
                error = Some(format!(
                    "Cannot list recordings: {failure}. Check the recording folder in Settings."
                ));
                Vec::new()
            });
        Ok(Bootstrap {
            version: env!("CARGO_PKG_VERSION"),
            system_language: crate::language::system_language(),
            settings,
            error,
            document,
            recordings,
            pending_open,
            displays: recorder_platform::displays().map_err(failure)?,
            system_devices: recorder_platform::audio_devices(AudioRole::System).unwrap_or_default(),
            microphone_devices: recorder_platform::audio_devices(AudioRole::Microphone)
                .unwrap_or_default(),
        })
    })
    .await
    .map_err(failure)?
}

#[tauri::command]
fn capture_status(state: State<'_, Shared>) -> CaptureStatus {
    state.lock().unwrap().status()
}

#[tauri::command]
fn capture_shortcut(
    window: tauri::Window,
    state: State<'_, Shared>,
    enabled: bool,
) -> UiResult<()> {
    if window.label() != "main" {
        return Err("Open Settings in the main window".into());
    }
    if enabled && (state.lock().unwrap().phase != "idle" || !window.is_focused().unwrap_or(false)) {
        return Err("Stop recording before changing settings".into());
    }
    shell::capture_keys(enabled);
    Ok(())
}

#[tauri::command]
async fn save_settings(
    app: AppHandle,
    state: State<'_, Shared>,
    settings: AppSettings,
) -> UiResult<()> {
    settings.validate()?;
    let (old, path) = {
        let mut engine = state.lock().unwrap();
        if engine.phase != "idle" {
            return Err("Settings can be changed after recording stops".into());
        }
        engine.phase = "configuring".into();
        (engine.settings.clone(), engine.settings_path.clone())
    };
    let mut login_rollback = None;
    let mut result = async {
        let login = crate::startup::LoginItem::new().map_err(failure)?;
        let snapshot = login.snapshot().map_err(failure)?;
        let status = login.status().map_err(failure)?;
        rebind(&app, settings.clone()).await?;
        if status.registered != settings.autostart
            || (settings.autostart && !status.current_executable)
        {
            login
                .set(settings.autostart)
                .map_err(|error| format!("Could not change launch-at-login setting: {error}"))?;
            login_rollback = Some((login, snapshot));
        }
        recorder_core::save_json(&path, &settings)
    }
    .await;
    if result.is_err() {
        if let Some((login, snapshot)) = login_rollback
            && let Err(error) = login.restore(&snapshot)
        {
            result = Err(format!(
                "{}\nCould not restore the previous launch-at-login setting: {error}",
                result.as_ref().unwrap_err()
            ));
        }
        if let Err(error) = rebind(&app, old).await {
            result = Err(format!(
                "{}\nCould not restore the previous shortcuts: {error}",
                result.as_ref().unwrap_err()
            ));
        }
    }
    let mut engine = state.lock().unwrap();
    engine.phase = "idle".into();
    if result.is_ok() {
        engine.settings = settings;
        engine.shell_warning = None;
    }
    result
}

#[tauri::command]
async fn login_status() -> UiResult<crate::startup::LoginStatus> {
    tauri::async_runtime::spawn_blocking(|| crate::startup::LoginItem::new()?.status())
        .await
        .map_err(failure)?
        .map_err(|error| format!("Could not read launch-at-login setting: {error}"))
}

#[tauri::command]
fn show_main_window(app: AppHandle) {
    show_main(&app);
}

#[tauri::command]
fn hide_main(app: AppHandle, state: State<'_, Shared>) -> UiResult<()> {
    if !SHELL.with(|shell| shell.borrow().is_some()) {
        return Err("The tray is unavailable. Keep this window open or use Quit to exit.".into());
    }
    let recording = matches!(
        state.lock().unwrap().phase.as_str(),
        "recording" | "paused" | "preparing"
    );
    if recording {
        return show_capture_controls(&app);
    }
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(failure)?;
    }
    Ok(())
}

async fn rebind(app: &AppHandle, settings: AppSettings) -> UiResult<()> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let keys = settings;
    app.run_on_main_thread(move || {
        let result = SHELL
            .with(|shell| {
                let mut shell = shell.borrow_mut();
                if let Some(shell) = shell.as_mut() {
                    shell.rebind(&keys)
                } else {
                    let value = Shell::new(&keys)?;
                    let warning = value.warning().map(str::to_owned);
                    *shell = Some(value);
                    if let Some(warning) = warning {
                        anyhow::bail!(warning);
                    }
                    Ok(())
                }
            })
            .map_err(failure);
        let _ = tx.send(result);
    })
    .map_err(failure)?;
    rx.await.map_err(failure)?
}

#[tauri::command]
async fn choose_folder() -> UiResult<Option<PathBuf>> {
    Ok(rfd::AsyncFileDialog::new()
        .pick_folder()
        .await
        .map(|f| f.path().into()))
}

#[tauri::command]
async fn select_area(
    app: AppHandle,
    state: State<'_, Shared>,
    display_id: u64,
    region: Option<PixelRect>,
) -> UiResult<()> {
    {
        let engine = state.lock().unwrap();
        if engine.phase != "idle" {
            return Err("Stop the current recording first".into());
        }
    }
    let display = recorder_platform::displays()
        .map_err(failure)?
        .into_iter()
        .find(|d| d.id == display_id)
        .ok_or("Display disconnected")?;
    if let Some(region) = region {
        region.validate(display.width, display.height)?;
    }
    if let Some(existing) = app.get_webview_window("selection") {
        existing.close().map_err(failure)?;
    }
    let query = format!(
        "index.html?overlay=1&display={display_id}&width={}&height={}&scale={}&x={}&y={}&w={}&h={}&language={}",
        display.width,
        display.height,
        display.scale,
        region.map_or(0, |r| r.x),
        region.map_or(0, |r| r.y),
        region.map_or(0, |r| r.width),
        region.map_or(0, |r| r.height),
        state
            .lock()
            .unwrap()
            .settings
            .language
            .resolve(crate::language::system_language())
    );
    let window =
        tauri::WebviewWindowBuilder::new(&app, "selection", tauri::WebviewUrl::App(query.into()))
            .title(crate::language::text(
                state.lock().unwrap().settings.language,
                "Select area",
                "Выбрать область",
            ))
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .resizable(false)
            .visible(false)
            .build()
            .map_err(failure)?;
    window
        .set_position(tauri::PhysicalPosition::new(display.x, display.y))
        .map_err(failure)?;
    window
        .set_size(tauri::PhysicalSize::new(display.width, display.height))
        .map_err(failure)?;
    protect(&window);
    window.show().map_err(failure)?;
    window.set_focus().map_err(failure)?;
    if let Some(main) = app.get_webview_window("main") {
        main.hide().map_err(failure)?;
    }
    Ok(())
}

#[tauri::command]
fn apply_region(
    app: AppHandle,
    state: State<'_, Shared>,
    display_id: u64,
    region: PixelRect,
    start_recording: Option<bool>,
) -> UiResult<()> {
    if state.lock().unwrap().phase != "idle" {
        return Err("Finish the current operation first".into());
    }
    let display = recorder_platform::displays()
        .map_err(failure)?
        .into_iter()
        .find(|d| d.id == display_id)
        .ok_or("Display disconnected")?;
    let region = region.even_size().validate(display.width, display.height)?;
    if let Some(window) = app.get_webview_window("selection") {
        window.close().map_err(failure)?;
    }
    show_main(&app);
    app.emit_to(
        "main",
        "region-selected",
        serde_json::json!({"display_id":display_id,"region":region,"start_recording":start_recording.unwrap_or(false)}),
    )
    .map_err(failure)?;
    Ok(())
}

#[tauri::command]
fn cancel_selection(app: AppHandle) -> UiResult<()> {
    if let Some(window) = app.get_webview_window("selection") {
        window.close().map_err(failure)?;
    }
    show_main(&app);
    Ok(())
}

#[tauri::command]
async fn start_capture(
    app: AppHandle,
    state: State<'_, Shared>,
    display_id: u64,
    region: PixelRect,
) -> UiResult<()> {
    let settings = {
        let mut engine = state.lock().unwrap();
        if engine.phase != "idle" || engine.export_cancel.is_some() {
            return Err("Wait for recording or export to finish".into());
        }
        engine.phase = "preparing".into();
        engine.error = None;
        engine.cancel_start = false;
        engine.recording_warnings.clear();
        engine.settings.clone()
    };
    if let Err(error) = show_capture_controls(&app) {
        state.lock().unwrap().phase = "idle".into();
        show_main(&app);
        return Err(error);
    }
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let display = recorder_platform::displays()?
            .into_iter()
            .find(|d| d.id == display_id)
            .ok_or_else(|| anyhow::anyhow!("Display disconnected"))?;
        let region = region
            .even_size()
            .validate(display.width, display.height)
            .map_err(anyhow::Error::msg)?;
        std::fs::create_dir_all(&settings.output_dir)?;
        let required = (settings.bitrate_mbps as u64 * 1_000_000 / 8 * 60).max(256 * 1024 * 1024);
        anyhow::ensure!(
            fs2::available_space(&settings.output_dir)? > required,
            "Not enough disk space to record. Choose another folder or free up space."
        );
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let folder = settings.output_dir.join(format!("recording-{stamp}"));
        std::fs::create_dir(&folder)?;
        let source = folder.join("source.mp4");
        recorder_core::save_json(&folder.join("session.json"), &SessionJournal::new(stamp))
            .map_err(anyhow::Error::msg)?;
        let mut session = recorder_platform::start_recording(RecordingConfig {
            display,
            region,
            fps: settings.fps,
            bitrate: settings.bitrate_mbps * 1_000_000,
            show_cursor: settings.show_cursor,
            output: source.clone(),
            audio: settings.audio,
        })?;
        let shared = handle.state::<Shared>();
        let mut engine = shared.lock().unwrap();
        if engine.cancel_start {
            session.request_stop();
        }
        engine.session = Some(session);
        engine.last_source = Some(source);
        engine.phase = if engine.cancel_start {
            "saving"
        } else {
            "recording"
        }
        .into();
        Ok::<_, anyhow::Error>(())
    })
    .await
    .map_err(failure)
    .and_then(|result| result.map_err(|e| format!("{e:#}")));
    if let Err(e) = &result {
        let mut engine = state.lock().unwrap();
        engine.phase = "idle".into();
        engine.error = Some(e.clone());
        drop(engine);
        show_main(&app);
    }
    result
}

#[tauri::command]
fn stop_capture(state: State<'_, Shared>) -> UiResult<()> {
    let mut engine = state.lock().unwrap();
    if let Some(session) = &mut engine.session {
        session.request_stop();
        engine.phase = "saving".into();
    } else if engine.phase == "preparing" {
        engine.cancel_start = true;
    }
    Ok(())
}

#[tauri::command]
fn pause_capture(state: State<'_, Shared>) -> UiResult<()> {
    if let Some(session) = &state.lock().unwrap().session {
        session.pause(!session.stats.paused.load(Ordering::Acquire));
    }
    Ok(())
}

fn load_document(app: &AppHandle, source: PathBuf) -> anyhow::Result<EditorDocument> {
    let source = std::path::absolute(source)?;
    let tools = MediaTools::discover()?;
    let info = tools.probe(&source)?;
    let project_path = source.with_extension("recorder.json");
    let mut project: EditProject = if project_path.exists() {
        recorder_core::load_json(&project_path).map_err(anyhow::Error::msg)?
    } else {
        EditProject::new(info.duration_us, info.width, info.height, info.fps)
            .map_err(anyhow::Error::msg)?
    };
    project.source = source
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("No source video selected"))?
        .into();
    validate_project(&project, &info).map_err(anyhow::Error::msg)?;
    for track in &info.audio {
        if !project.audio.iter().any(|t| t.track_id == track.id) {
            project.audio.push(AudioMix {
                track_id: track.id.clone(),
                gain_db: 0.0,
                muted: false,
            });
        }
    }
    app.asset_protocol_scope().allow_file(&source)?;
    for track in &info.audio {
        app.asset_protocol_scope().allow_file(&track.path)?;
    }
    let mut warnings = info.warnings.clone();
    if !project_path.exists()
        && let Err(error) = recorder_core::save_json(&project_path, &project)
    {
        warnings.push(format!("Could not save the project beside the source: {error}. You can export MP4 to another folder."));
    }
    if let Ok(journal) =
        recorder_core::load_json::<SessionJournal>(&source.with_file_name("session.json"))
    {
        warnings.extend(journal.warnings);
    }
    let shared = app.state::<Shared>();
    let mut engine = shared.lock().unwrap();
    engine.next_document_id += 1;
    let document = EditorDocument {
        document_id: engine.next_document_id,
        source,
        info,
        project,
        warnings,
    };
    engine.document = Some(document.clone());
    Ok(document)
}

fn validate_project(project: &EditProject, info: &MediaInfo) -> UiResult<()> {
    project.validate()?;
    if project.width != info.width
        || project.height != info.height
        || project.source_duration_us.abs_diff(info.duration_us) > 100_000
    {
        return Err("Source video properties do not match the project".into());
    }
    Ok(())
}

#[tauri::command]
async fn open_video(
    app: AppHandle,
    state: State<'_, Shared>,
    last: bool,
) -> UiResult<Option<EditorDocument>> {
    {
        reserve(&mut state.lock().unwrap(), "opening")?;
    }
    let source = if last {
        state.lock().unwrap().last_source.clone()
    } else {
        rfd::AsyncFileDialog::new()
            .add_filter("Video", &["mp4", "mov", "mkv"])
            .pick_file()
            .await
            .map(|f| f.path().into())
    };
    let Some(source) = source else {
        state.lock().unwrap().phase = "idle".into();
        return Ok(None);
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        load_document(&app, source)
            .map(Some)
            .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(failure)
    .and_then(|r| r);
    state.lock().unwrap().phase = "idle".into();
    result
}

fn reserve(engine: &mut Engine, phase: &str) -> UiResult<()> {
    if engine.phase != "idle" || engine.export_cancel.is_some() || engine.recovery_cancel.is_some()
    {
        return Err("Wait for the current operation to finish".into());
    }
    engine.phase = phase.into();
    Ok(())
}

#[tauri::command]
async fn open_pending(
    app: AppHandle,
    state: State<'_, Shared>,
) -> UiResult<Option<EditorDocument>> {
    let source = {
        let mut engine = state.lock().unwrap();
        reserve(&mut engine, "opening")?;
        engine.pending_open.take()
    };
    let result = if let Some(source) = source {
        tauri::async_runtime::spawn_blocking(move || {
            load_document(&app, source)
                .map(Some)
                .map_err(|e| format!("{e:#}"))
        })
        .await
        .map_err(failure)
        .and_then(|r| r)
    } else {
        Ok(None)
    };
    state.lock().unwrap().phase = "idle".into();
    result
}

#[tauri::command]
async fn recent_recordings(state: State<'_, Shared>) -> UiResult<Vec<RecordingEntry>> {
    let root = {
        let engine = state.lock().unwrap();
        if engine.phase != "idle" {
            return Err("Recordings are available after the current operation finishes".into());
        }
        engine.settings.output_dir.clone()
    };
    tauri::async_runtime::spawn_blocking(move || recorder_core::recordings(&root))
        .await
        .map_err(failure)?
}

#[tauri::command]
async fn open_recording(
    app: AppHandle,
    state: State<'_, Shared>,
    id: String,
) -> UiResult<EditorDocument> {
    let root = {
        let mut engine = state.lock().unwrap();
        reserve(&mut engine, "opening")?;
        engine.settings.output_dir.clone()
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let folder = recorder_core::recording_folder(&root, &id)?;
        load_document(&app, folder.join("source.mp4")).map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(failure)
    .and_then(|r| r);
    state.lock().unwrap().phase = "idle".into();
    result
}

#[tauri::command]
async fn recover_entry(
    app: AppHandle,
    state: State<'_, Shared>,
    id: String,
) -> UiResult<EditorDocument> {
    let cancel = Arc::new(AtomicBool::new(false));
    let root = {
        let mut engine = state.lock().unwrap();
        reserve(&mut engine, "recovering")?;
        engine.recovery_cancel = Some(cancel.clone());
        engine.settings.output_dir.clone()
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let folder = recorder_core::recording_folder(&root, &id).map_err(anyhow::Error::msg)?;
        let recovered =
            MediaTools::discover()?.recover_recording(&folder.join("source.mp4"), &root, cancel)?;
        let mut warning = None;
        if let Ok(mut journal) =
            recorder_core::load_json::<SessionJournal>(&folder.join("session.json"))
        {
            journal.recovery_copy = recovered
                .folder
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_owned);
            if let Err(error) = recorder_core::save_json(&folder.join("session.json"), &journal) {
                warning = Some(format!(
                    "Copy recovered, but the original journal could not be updated: {error}"
                ));
            }
        }
        let source = recovered.folder.join("source.mp4");
        let mut document = load_document(&app, source.clone())?;
        if let Some(warning) = warning {
            document.warnings.push(warning);
        }
        app.state::<Shared>().lock().unwrap().last_source = Some(source);
        Ok::<_, anyhow::Error>(document)
    })
    .await
    .map_err(failure)
    .and_then(|r| r.map_err(|e| format!("{e:#}")));
    let mut engine = state.lock().unwrap();
    engine.phase = "idle".into();
    engine.recovery_cancel = None;
    result
}

#[tauri::command]
fn cancel_recovery(state: State<'_, Shared>) {
    if let Some(cancel) = &state.lock().unwrap().recovery_cancel {
        cancel.store(true, Ordering::Release);
    }
}

#[tauri::command]
fn reveal_recording(state: State<'_, Shared>, id: String) -> UiResult<()> {
    let folder = recorder_core::recording_folder(&state.lock().unwrap().settings.output_dir, &id)?;
    open::that(folder).map_err(failure)
}

#[tauri::command]
fn save_project(state: State<'_, Shared>, document_id: u64, project: EditProject) -> UiResult<()> {
    let mut engine = state.lock().unwrap();
    let doc = engine.document.as_mut().ok_or("Open a video first")?;
    if doc.document_id != document_id {
        return Err("A different video is open. Edits were not applied.".into());
    }
    validate_project(&project, &doc.info)?;
    if project.source != doc.project.source {
        return Err("Editing cannot change the source path".into());
    }
    recorder_core::save_json(&doc.source.with_extension("recorder.json"), &project)?;
    doc.project = project;
    Ok(())
}

#[tauri::command]
async fn export_video(
    app: AppHandle,
    state: State<'_, Shared>,
    document_id: u64,
    project: EditProject,
    selection: Option<bool>,
) -> UiResult<Option<PathBuf>> {
    let (source, bitrate) = {
        let mut engine = state.lock().unwrap();
        if engine.phase != "idle" || engine.export_cancel.is_some() {
            return Err("Wait for the current operation to finish".into());
        }
        let doc = engine.document.as_ref().ok_or("Open a video first")?;
        if doc.document_id != document_id {
            return Err("A different video is open. Export cancelled.".into());
        }
        validate_project(&project, &doc.info)?;
        let source = doc.source.clone();
        reserve(&mut engine, "choosing_export")?;
        (source, engine.settings.bitrate_mbps * 1_000_000)
    };
    let destination = rfd::AsyncFileDialog::new()
        .set_file_name(export_filename(&source, selection.unwrap_or(false)))
        .set_directory(source.parent().unwrap_or(Path::new(".")))
        .add_filter("MP4", &["mp4"])
        .save_file()
        .await
        .map(|f| f.path().into());
    let Some(destination): Option<PathBuf> = destination else {
        state.lock().unwrap().phase = "idle".into();
        return Ok(None);
    };
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut engine = state.lock().unwrap();
        if engine.export_cancel.is_some() {
            return Err("An export is already running".into());
        }
        engine.export_cancel = Some(cancel.clone());
        engine.phase = "exporting".into();
    }
    let handle = app.clone();
    let result_path = destination.clone();
    let worker_cancel = cancel.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let total = project.duration_us();
        let progress = std::thread::spawn(move || {
            while let Ok(us) = rx.recv() {
                let _ = handle.emit(
                    "export-progress",
                    (us as f64 / total as f64).clamp(0.0, 1.0),
                );
            }
        });
        let result = MediaTools::discover()
            .and_then(|tools| {
                tools.export(&source, &project, &destination, bitrate, worker_cancel, tx)
            })
            .map_err(|e| format!("{e:#}"));
        let _ = progress.join();
        result
    })
    .await
    .map_err(failure)
    .and_then(|r| r);
    let mut engine = state.lock().unwrap();
    engine.export_cancel = None;
    engine.phase = "idle".into();
    if result.is_ok() {
        engine.last_export = Some(result_path.clone());
    } else if cancel.load(Ordering::Acquire) {
        return Ok(None);
    }
    result.map(|_| Some(result_path))
}

fn export_filename(source: &Path, selection: bool) -> String {
    let stem = source.file_stem().unwrap_or_default().to_string_lossy();
    let suffix = if selection { "clip" } else { "edited" };
    format!("{stem}-{suffix}.mp4")
}

#[tauri::command]
fn open_export(state: State<'_, Shared>, folder: bool) -> UiResult<()> {
    let path = state
        .lock()
        .unwrap()
        .last_export
        .clone()
        .ok_or("Export an MP4 first")?;
    if !path.is_file() {
        return Err("The exported video was moved or deleted. Export the MP4 again.".into());
    }
    let target = if folder {
        path.parent().ok_or("Export folder not found")?
    } else {
        &path
    };
    open::that(target).map_err(failure)
}

#[tauri::command]
fn cancel_export(state: State<'_, Shared>) {
    if let Some(cancel) = &state.lock().unwrap().export_cancel {
        cancel.store(true, Ordering::Release);
    }
}

#[tauri::command]
fn reveal_project(state: State<'_, Shared>) -> UiResult<()> {
    let engine = state.lock().unwrap();
    let path = engine
        .document
        .as_ref()
        .map(|d| &d.source)
        .or(engine.last_source.as_ref())
        .ok_or("No recordings yet")?;
    open::that(path.parent().ok_or("Recording folder not found")?).map_err(failure)
}

#[tauri::command]
fn quit(app: AppHandle, state: State<'_, Shared>) -> UiResult<()> {
    let engine = state.lock().unwrap();
    if engine.phase != "idle" || engine.export_cancel.is_some() {
        return Err("Finish recording or export first".into());
    }
    drop(engine);
    app.exit(0);
    Ok(())
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("capture-controls") {
        let _ = window.hide();
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn capture_controls_state(state: State<'_, Shared>) -> serde_json::Value {
    let engine = state.lock().unwrap();
    serde_json::json!({
        "status": engine.status(),
        "appearance": engine.settings.appearance,
        "language": engine.settings.language,
        "system_language": crate::language::system_language(),
        "stop_hotkey": engine.settings.stop_hotkey,
        "pause_hotkey": engine.settings.pause_hotkey,
    })
}

#[tauri::command]
fn expand_capture(app: AppHandle) {
    show_main(&app);
}

#[tauri::command]
async fn compact_capture(app: AppHandle, state: State<'_, Shared>) -> UiResult<()> {
    if !matches!(
        state.lock().unwrap().phase.as_str(),
        "preparing" | "recording" | "paused" | "saving"
    ) {
        return Err("Compact controls are available while recording".into());
    }
    show_capture_controls(&app)
}

fn show_capture_controls(app: &AppHandle) -> UiResult<()> {
    let window = if let Some(window) = app.get_webview_window("capture-controls") {
        window
    } else {
        let window = tauri::WebviewWindowBuilder::new(
            app,
            "capture-controls",
            tauri::WebviewUrl::App("capture.html".into()),
        )
        .title(crate::language::text(
            app.state::<Shared>().lock().unwrap().settings.language,
            "Recording controls",
            "Управление записью",
        ))
        .inner_size(480.0, 152.0)
        .min_inner_size(360.0, 152.0)
        .always_on_top(true)
        .skip_taskbar(true)
        .maximizable(false)
        .minimizable(false)
        .visible(false)
        .focused(false)
        .center()
        .build()
        .map_err(failure)?;
        protect(&window);
        window
    };
    window
        .set_title(crate::language::text(
            app.state::<Shared>().lock().unwrap().settings.language,
            "Recording controls",
            "Управление записью",
        ))
        .map_err(failure)?;
    app.emit_to("capture-controls", "capture-controls-refresh", ())
        .map_err(failure)?;
    window.show().map_err(failure)?;
    if let Some(main) = app.get_webview_window("main") {
        main.hide().map_err(failure)?;
    }
    Ok(())
}

fn protect(window: &tauri::WebviewWindow) {
    if std::env::var_os("SCREEN_RECORDER_UI_TEST").is_none() {
        let _ = window.set_content_protected(true);
    }
}

fn background(app: AppHandle) {
    std::thread::spawn(move || {
        let mut tick = 0u64;
        loop {
            std::thread::sleep(Duration::from_millis(100));
            tick += 1;
            let shared = app.state::<Shared>();
            let mut engine = shared.lock().unwrap();
            if engine.session.is_none() {
                continue;
            }
            let finished = engine.session.as_ref().and_then(|s| s.poll_finished());
            if let Some(warning) = engine
                .session
                .as_ref()
                .and_then(|s| s.stats.audio_warning.lock().unwrap().take())
            {
                if !engine.recording_warnings.contains(&warning) {
                    engine.recording_warnings.push(warning.clone());
                }
                engine.error = Some(warning);
            }
            if tick.is_multiple_of(20)
                && let Some(path) = &engine.last_source
                && fs2::available_space(path.parent().unwrap_or(Path::new(".")))
                    .is_ok_and(|free| free < 32 * 1024 * 1024)
            {
                let warning = "Recording stopped: less than 32 MB of disk space remains".to_owned();
                if !engine.recording_warnings.contains(&warning) {
                    engine.recording_warnings.push(warning.clone());
                }
                engine.error = Some(warning);
                if let Some(session) = &mut engine.session {
                    session.request_stop();
                    engine.phase = "saving".into();
                }
            }
            let mut status = engine.status();
            if (tick.is_multiple_of(20) || finished.is_some())
                && let Some(source) = &engine.last_source
            {
                let journal = source.with_file_name("session.json");
                if let Ok(mut record) = recorder_core::load_json::<SessionJournal>(&journal) {
                    record.elapsed_ms = status.elapsed_ms;
                    record.warnings = engine.recording_warnings.clone();
                    record.state = if engine.phase == "saving" {
                        SessionState::Finalizing
                    } else {
                        SessionState::Recording
                    };
                    if let Err(error) = recorder_core::save_json(&journal, &record) {
                        engine.error = Some(format!("Recording journal was not updated: {error}"));
                    }
                }
            }
            if let Some(result) = finished {
                let error = result.err();
                engine.session = None;
                engine.phase = "idle".into();
                status.phase = "idle".into();
                if error.is_some() {
                    engine.error = error.clone();
                }
                if let Some(source) = &engine.last_source {
                    let journal = source.with_file_name("session.json");
                    if let Ok(mut record) = recorder_core::load_json::<SessionJournal>(&journal) {
                        record.state = if error.is_none() {
                            SessionState::Finished
                        } else {
                            SessionState::Interrupted
                        };
                        record.elapsed_ms = status.elapsed_ms;
                        record.error = error.clone();
                        if let Err(error) = recorder_core::save_json(&journal, &record) {
                            engine.error = Some(format!(
                                "Video saved, but the journal was not updated: {error}"
                            ));
                        }
                    }
                }
                let _ = app.emit(
                    "recording-finished",
                    serde_json::json!({"error":error,"open_editor":engine.settings.open_editor}),
                );
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || show_main(&handle));
            }
            let _ = app.emit("capture-status", status);
        }
    });
}

pub fn run() -> anyhow::Result<()> {
    #[cfg(windows)]
    recorder_platform::identify_desktop_app()?;
    let engine = Engine::new()?;
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            if args.iter().any(|a| a == "--background") {
                return;
            }
            show_main(app);
            if let Some(path) = args
                .iter()
                .position(|arg| arg == "--open")
                .and_then(|i| args.get(i + 1))
            {
                let path = PathBuf::from(path);
                let path = if path.is_absolute() {
                    path
                } else {
                    PathBuf::from(cwd).join(path)
                };
                app.state::<Shared>().lock().unwrap().pending_open = Some(path);
                let _ = app.emit_to("main", "external-open-request", ());
            }
        }))
        .manage(Mutex::new(engine))
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            capture_status,
            save_settings,
            login_status,
            show_main_window,
            hide_main,
            capture_shortcut,
            choose_folder,
            select_area,
            apply_region,
            cancel_selection,
            start_capture,
            stop_capture,
            pause_capture,
            capture_controls_state,
            compact_capture,
            expand_capture,
            open_video,
            open_pending,
            recent_recordings,
            open_recording,
            recover_entry,
            cancel_recovery,
            reveal_recording,
            save_project,
            export_video,
            open_export,
            cancel_export,
            reveal_project,
            quit
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let initial = std::env::args()
                .position(|arg| arg == "--open")
                .and_then(|i| std::env::args().nth(i + 1));
            if let Some(path) = initial
                && let Err(error) = load_document(&handle, PathBuf::from(path))
            {
                app.state::<Shared>().lock().unwrap().error = Some(format!("{error:#}"));
            }
            let shared = app.state::<Shared>();
            let mut engine = shared.lock().unwrap();
            match Shell::new(&engine.settings) {
                Ok(shell) => {
                    if let Some(warning) = shell.warning() {
                        engine.shell_warning =
                            Some(format!("Tray or keyboard shortcut: {warning}"));
                    }
                    SHELL.with(|value| *value.borrow_mut() = Some(shell));
                }
                Err(e) => engine.shell_warning = Some(format!("Tray or keyboard shortcut: {e}")),
            }
            let shell_ok = SHELL.with(|s| s.borrow().is_some());
            let background_requested = std::env::args().any(|a| a == "--background");
            let needs_attention = engine.first_run
                || engine.error.is_some()
                || engine.shell_warning.is_some()
                || !shell_ok
                || engine.pending_recovery
                || engine.document.is_some();
            let visible = crate::startup::show_on_launch(
                background_requested,
                engine.settings.start_in_tray,
                needs_attention,
            );
            drop(engine);
            if let Some(main) = app.get_webview_window("main") {
                protect(&main);
                if visible {
                    main.show()?;
                }
            }
            let event_app = handle.clone();
            tauri::async_runtime::spawn(async move {
                let mut receiver = shell::events().subscribe();
                while let Ok(event) = receiver.recv().await {
                    let app = event_app.clone();
                    let window_app = app.clone();
                    let _ = app.run_on_main_thread(move || match event {
                        ShellEvent::Show => show_main(&window_app),
                        ShellEvent::Recent | ShellEvent::Settings => {
                            show_main(&window_app);
                            let page = if matches!(event, ShellEvent::Recent) {
                                "recordings"
                            } else {
                                "settings"
                            };
                            let _ = window_app.emit_to("main", "navigate", page);
                        }
                        ShellEvent::Last => {
                            show_main(&window_app);
                            let _ = window_app.emit_to("main", "open-last", ());
                        }
                        ShellEvent::Select => {
                            show_main(&window_app);
                            let _ = window_app.emit_to("main", "new-recording", ());
                        }
                        ShellEvent::Pause => {
                            let _ = pause_capture(window_app.state());
                        }
                        ShellEvent::Stop => {
                            let _ = stop_capture(window_app.state());
                        }
                        ShellEvent::Quit => {
                            let _ = window_app.emit_to("main", "quit-request", ());
                        }
                        ShellEvent::HotkeyCaptured(key) => {
                            let _ =
                                window_app.emit_to("main", "shortcut-captured", key.into_string());
                        }
                    });
                }
            });
            background(handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. })
                && window.label() == "selection"
            {
                show_main(window.app_handle());
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && window.label() == "capture-controls"
            {
                api.prevent_close();
                show_main(window.app_handle());
            }
            if window.label() == "main"
                && matches!(
                    event,
                    tauri::WindowEvent::Focused(false)
                        | tauri::WindowEvent::CloseRequested { .. }
                        | tauri::WindowEvent::Destroyed
                )
            {
                shell::capture_keys(false);
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && window.label() == "main"
            {
                api.prevent_close();
                let _ = window.emit("close-request", ());
            }
        })
        .run(tauri::generate_context!())
        .map_err(Into::into)
}
