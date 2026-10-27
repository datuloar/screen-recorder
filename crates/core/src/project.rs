use crate::{PixelRect, TimeRange};
use serde::{Deserialize, Serialize};
use std::path::{Component, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditProject {
    pub schema_version: u32,
    pub source: PathBuf,
    pub source_duration_us: u64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub keep: Vec<TimeRange>,
    pub crop: Option<PixelRect>,
    pub muted: bool,
    #[serde(default)]
    pub audio: Vec<crate::AudioMix>,
}

impl EditProject {
    pub fn new(duration_us: u64, width: u32, height: u32, fps: u32) -> Result<Self, String> {
        Ok(Self {
            schema_version: 1,
            source: "source.mp4".into(),
            source_duration_us: duration_us,
            width,
            height,
            fps,
            keep: vec![TimeRange::new(0, duration_us)?],
            crop: None,
            muted: false,
            audio: Vec::new(),
        })
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err("Unknown project version".into());
        }
        if self.source.as_os_str().is_empty()
            || self.source.is_absolute()
            || self
                .source
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err("The source video must be inside the project folder".into());
        }
        if self.width < 2 || self.height < 2 || self.fps == 0 || self.keep.is_empty() {
            return Err("Invalid project settings".into());
        }
        let mut previous_end = 0;
        for r in &self.keep {
            if r.start_us < previous_end
                || r.start_us >= r.end_us
                || r.end_us > self.source_duration_us
            {
                return Err("Invalid edit boundaries".into());
            }
            previous_end = r.end_us;
        }
        if let Some(crop) = self.crop {
            crop.validate(self.width, self.height)?;
        }
        if self
            .audio
            .iter()
            .any(|track| !track.gain_db.is_finite() || !(-60.0..=20.0).contains(&track.gain_db))
        {
            return Err("Track gain must be between -60 and +20 dB".into());
        }
        let mut ids = std::collections::HashSet::new();
        if self
            .audio
            .iter()
            .any(|track| track.track_id.is_empty() || !ids.insert(&track.track_id))
        {
            return Err("Audio track IDs must be unique".into());
        }
        Ok(())
    }

    pub fn duration_us(&self) -> u64 {
        self.keep.iter().map(|r| r.duration_us()).sum()
    }

    pub fn source_time(&self, mut edited_us: u64) -> u64 {
        for range in &self.keep {
            if edited_us < range.duration_us() {
                return range.start_us + edited_us;
            }
            edited_us = edited_us.saturating_sub(range.duration_us());
        }
        self.keep.last().map_or(0, |r| r.end_us.saturating_sub(1))
    }

    pub fn cut(&mut self, range: TimeRange) -> Result<(), String> {
        let keep: Vec<_> = self.keep.iter().flat_map(|r| r.subtract(range)).collect();
        if keep.is_empty() {
            return Err("Keep at least one part of the video".into());
        }
        self.keep = keep;
        self.validate()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn edited_cursor_crosses_a_cut_without_showing_removed_frames() {
        let mut project = EditProject::new(10_000_000, 640, 360, 30).unwrap();
        project
            .cut(TimeRange::new(2_000_000, 5_000_000).unwrap())
            .unwrap();
        assert_eq!(project.source_time(1_999_999), 1_999_999);
        assert_eq!(project.source_time(2_000_000), 5_000_000);
        assert_eq!(project.source_time(7_000_000), 9_999_999);
    }
}
