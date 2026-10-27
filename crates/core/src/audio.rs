use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AudioRole {
    System,
    Microphone,
}

impl AudioRole {
    pub fn id(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Microphone => "microphone",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::System => "System audio",
            Self::Microphone => "Microphone",
        }
    }
    pub fn asset_path(self, source: &Path) -> PathBuf {
        source.with_extension(format!("{}.m4a", self.id()))
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AudioSettings {
    pub system: bool,
    pub microphone: bool,
    pub system_device: Option<String>,
    pub microphone_device: Option<String>,
}

impl AudioSettings {
    pub fn enabled(&self) -> impl Iterator<Item = AudioRole> {
        [
            (self.system, AudioRole::System),
            (self.microphone, AudioRole::Microphone),
        ]
        .into_iter()
        .filter_map(|(enabled, role)| enabled.then_some(role))
    }
    pub fn device(&self, role: AudioRole) -> Option<&str> {
        match role {
            AudioRole::System => self.system_device.as_deref(),
            AudioRole::Microphone => self.microphone_device.as_deref(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct AudioDeviceInfo {
    pub id: String,
    pub name: String,
}

impl std::fmt::Display for AudioDeviceInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.name)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioMix {
    pub track_id: String,
    pub gain_db: f32,
    pub muted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SamplePlacement {
    pub gap_frames: u64,
    pub skip_frames: u64,
    pub write_frames: u64,
}

pub fn place_samples(next_frame: u64, start_frame: u64, frames: u64) -> SamplePlacement {
    let skip_frames = next_frame.saturating_sub(start_frame).min(frames);
    SamplePlacement {
        gap_frames: start_frame.saturating_sub(next_frame),
        skip_frames,
        write_frames: frames - skip_frames,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn device_gap_preserves_time_and_overlap_is_not_repeated() {
        assert_eq!(
            place_samples(480, 960, 480),
            SamplePlacement {
                gap_frames: 480,
                skip_frames: 0,
                write_frames: 480
            }
        );
        assert_eq!(
            place_samples(960, 480, 960),
            SamplePlacement {
                gap_frames: 0,
                skip_frames: 480,
                write_frames: 480
            }
        );
        assert_eq!(place_samples(960, 0, 480).write_frames, 0);
    }
}
