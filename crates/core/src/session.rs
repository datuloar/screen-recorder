use crate::{AudioRole, load_json};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Recording,
    Finalizing,
    Finished,
    Interrupted,
    Recovered,
    Failed,
}

impl SessionState {
    pub fn needs_recovery(self) -> bool {
        matches!(
            self,
            Self::Recording | Self::Finalizing | Self::Interrupted | Self::Failed
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionJournal {
    pub schema_version: u32,
    pub state: SessionState,
    pub source: PathBuf,
    pub started_ms: u64,
    pub elapsed_ms: u64,
    pub error: Option<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub recovered_from: Option<PathBuf>,
    #[serde(default)]
    pub recovery_copy: Option<String>,
}

impl SessionJournal {
    pub fn new(started_ms: u64) -> Self {
        Self {
            schema_version: 1,
            state: SessionState::Recording,
            source: "source.mp4".into(),
            started_ms,
            elapsed_ms: 0,
            error: None,
            warnings: Vec::new(),
            recovered_from: None,
            recovery_copy: None,
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err("Unknown recording journal version".into());
        }
        if self.source != Path::new("source.mp4") {
            return Err("Invalid source path in the recording journal".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RecordingEntry {
    pub id: String,
    pub started_ms: u64,
    pub elapsed_ms: u64,
    pub bytes: u64,
    pub needs_recovery: bool,
    pub source_exists: bool,
    pub warning: Option<String>,
    pub recovery_copy: Option<String>,
}

pub fn recording_folder(root: &Path, id: &str) -> Result<PathBuf, String> {
    let mut components = Path::new(id).components();
    if !id.starts_with("recording-")
        || id.len() > 160
        || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        || !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
    {
        return Err("Invalid recording ID".into());
    }
    let folder = root.join(id);
    let metadata = fs::symlink_metadata(&folder).map_err(|e| e.to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("Recording folder is unavailable".into());
    }
    Ok(folder)
}

pub fn recordings(root: &Path) -> Result<Vec<RecordingEntry>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for item in fs::read_dir(root).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        let Some(id) = item.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Ok(folder) = recording_folder(root, &id) else {
            continue;
        };
        let journal = folder.join("session.json");
        if !journal.is_file() && !folder.join("source.mp4").is_file() {
            continue;
        }
        let journal: Result<SessionJournal, _> = if !journal.is_file() {
            Err("Recording journal is missing. Open the source video or try recovery.".into())
        } else if fs::metadata(&journal).is_ok_and(|m| m.len() <= 256 * 1024) {
            load_json(&journal).and_then(|value: SessionJournal| {
                value.validate()?;
                Ok(value)
            })
        } else {
            Err("Recording journal is too large".into())
        };
        let (started_ms, elapsed_ms, needs_recovery, warning, recovery_copy) = match journal {
            Ok(journal) => (
                journal.started_ms,
                journal.elapsed_ms,
                journal.state.needs_recovery(),
                journal.error,
                journal.recovery_copy.filter(|id| {
                    recording_folder(root, id)
                        .is_ok_and(|folder| folder.join("source.mp4").is_file())
                }),
            ),
            Err(error) => (
                id.strip_prefix("recording-")
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0),
                0,
                true,
                Some(format!("Could not read the recording journal: {error}")),
                None,
            ),
        };
        let source = folder.join("source.mp4");
        let source_exists = source.is_file();
        let mut bytes = fs::metadata(&source).map_or(0, |m| m.len());
        for role in [AudioRole::System, AudioRole::Microphone] {
            bytes =
                bytes.saturating_add(fs::metadata(role.asset_path(&source)).map_or(0, |m| m.len()));
        }
        result.push(RecordingEntry {
            id,
            started_ms,
            elapsed_ms,
            bytes,
            needs_recovery,
            source_exists,
            warning,
            recovery_copy,
        });
    }
    result.sort_by(|a, b| {
        b.started_ms
            .cmp(&a.started_ms)
            .then_with(|| b.id.cmp(&a.id))
    });
    result.truncate(100);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::save_json;
    #[test]
    fn library_includes_legacy_recordings_but_rejects_unrelated_folders() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("recording-123");
        fs::create_dir(&folder).unwrap();
        let journal = SessionJournal::new(123);
        save_json(&folder.join("session.json"), &journal).unwrap();
        fs::write(folder.join("source.mp4"), b"incomplete").unwrap();
        fs::create_dir(root.path().join("other-files")).unwrap();
        let entries = recordings(root.path()).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].needs_recovery);
        assert_eq!(entries[0].bytes, 10);
        let legacy = root.path().join("recording-124");
        fs::create_dir(&legacy).unwrap();
        fs::write(legacy.join("source.mp4"), b"legacy").unwrap();
        let entries = recordings(root.path()).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].started_ms, 124);
        assert!(entries[0].warning.is_some());
        assert!(recording_folder(root.path(), "../recording-123").is_err());
        assert!(recording_folder(root.path(), "recording-123/..").is_err());
    }
    #[test]
    fn journal_cannot_redirect_recovery_outside_its_folder() {
        let mut journal = SessionJournal::new(123);
        journal.source = "../source.mp4".into();
        assert!(journal.validate().is_err());
        journal.source = "source.mp4".into();
        journal.state = SessionState::Recovered;
        assert!(!journal.state.needs_recovery());
        assert!(journal.validate().is_ok());
    }
}
