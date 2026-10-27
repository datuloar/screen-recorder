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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum Language {
    #[default]
    System,
    English,
    Russian,
}

impl Language {
    pub fn resolve(self, system: &str) -> &'static str {
        match self {
            Self::Russian => "ru",
            Self::English => "en",
            Self::System
                if system
                    .split(['-', '_'])
                    .next()
                    .is_some_and(|s| s.eq_ignore_ascii_case("ru")) =>
            {
                "ru"
            }
            Self::System => "en",
        }
    }
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
    pub language: Language,
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
            language: Language::System,
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

#[cfg(test)]
mod language_tests {
    use super::*;

    #[test]
    fn older_settings_default_to_system_language_without_resetting_preferences() {
        let settings: AppSettings =
            serde_json::from_str(r#"{"fps":60,"appearance":"Dark","hotkey":"Control+F8"}"#)
                .unwrap();
        assert_eq!(settings.language, Language::System);
        assert_eq!(settings.fps, 60);
        assert_eq!(settings.appearance, Appearance::Dark);
        assert_eq!(settings.hotkey, "Control+F8");
    }

    #[test]
    fn language_uses_system_ui_locale_with_explicit_overrides_and_english_fallback() {
        for locale in ["ru", "ru-RU", "RU_ru", "ru-BY"] {
            assert_eq!(Language::System.resolve(locale), "ru");
            assert_eq!(Language::English.resolve(locale), "en");
        }
        for locale in ["en-US", "pl-PL", "uk-UA", "", "russian"] {
            assert_eq!(Language::System.resolve(locale), "en");
            assert_eq!(Language::Russian.resolve(locale), "ru");
        }
        let settings = AppSettings {
            language: Language::Russian,
            ..Default::default()
        };
        let saved = serde_json::to_string(&settings).unwrap();
        assert_eq!(
            serde_json::from_str::<AppSettings>(&saved)
                .unwrap()
                .language,
            Language::Russian
        );
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
