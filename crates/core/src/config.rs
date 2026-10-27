use crate::PixelRect;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum Appearance {
    #[default]
    System,
    Light,
    Dark,
}

impl std::fmt::Display for Appearance {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::System => "System",
            Self::Light => "Light",
            Self::Dark => "Dark",
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub schema_version: u32,
    pub fps: u32,
    pub bitrate_mbps: u32,
    pub show_cursor: bool,
    pub countdown_seconds: u32,
    pub output_dir: PathBuf,
    pub appearance: Appearance,
    pub hotkey: String,
    pub stop_hotkey: String,
    pub pause_hotkey: String,
    pub start_in_tray: bool,
    pub autostart: bool,
    pub open_editor: bool,
    pub audio: crate::AudioSettings,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            schema_version: 1,
            fps: 30,
            bitrate_mbps: 12,
            show_cursor: true,
            countdown_seconds: 3,
            output_dir: PathBuf::new(),
            appearance: Appearance::System,
            hotkey: "Control+Shift+F9".into(),
            stop_hotkey: "Control+Shift+F10".into(),
            pause_hotkey: "Control+Shift+F11".into(),
            start_in_tray: true,
            autostart: false,
            open_editor: true,
            audio: crate::AudioSettings::default(),
        }
    }
}

impl AppSettings {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err("Unknown settings version".into());
        }
        if ![15, 24, 30, 60].contains(&self.fps) {
            return Err("Supported frame rates: 15, 24, 30, 60 FPS".into());
        }
        if !(1..=100).contains(&self.bitrate_mbps) {
            return Err("Bitrate must be between 1 and 100 Mbps".into());
        }
        if self.countdown_seconds > 10 {
            return Err("Countdown must be between 0 and 10 seconds".into());
        }
        if !self.output_dir.as_os_str().is_empty() && !self.output_dir.is_absolute() {
            return Err("Enter an absolute path for the recording folder".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DisplayInfo {
    pub id: u64,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub scale: f64,
}

impl std::fmt::Display for DisplayInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} · {} × {}", self.name, self.width, self.height)
    }
}

impl PartialEq for DisplayInfo {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}

#[derive(Debug, Clone)]
pub struct RecordingConfig {
    pub display: DisplayInfo,
    pub region: PixelRect,
    pub fps: u32,
    pub bitrate: u32,
    pub show_cursor: bool,
    pub output: PathBuf,
    pub audio: crate::AudioSettings,
}
