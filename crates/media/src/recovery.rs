use crate::{MediaInfo, MediaTools, command, complete_fragment_prefix};
use anyhow::{Context, bail};
use recorder_core::{AudioRole, SessionJournal, SessionState, save_json};
use std::{
    fs::File,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Debug, serde::Serialize)]
pub struct RecoveredRecording {
    pub folder: PathBuf,
    pub info: MediaInfo,
    pub warnings: Vec<String>,
}

impl MediaTools {
    pub fn recover_recording(
        &self,
        source: &Path,
        output_root: &Path,
        cancel: Arc<AtomicBool>,
    ) -> anyhow::Result<RecoveredRecording> {
        let prefix = complete_fragment_prefix(source)?;
        std::fs::create_dir_all(output_root)?;
        let mut size = std::fs::metadata(source)?.len();
        for role in [AudioRole::System, AudioRole::Microphone] {
            size = size
                .saturating_add(std::fs::metadata(role.asset_path(source)).map_or(0, |m| m.len()));
        }
        anyhow::ensure!(
            fs2::available_space(output_root)?
                > size.saturating_mul(2).saturating_add(64 * 1024 * 1024),
            "Not enough disk space for a recovery copy. Choose another folder."
        );
        let folder = tempfile::Builder::new()
            .prefix("recording-recovered-")
            .tempdir_in(output_root)?;
        let destination = folder.path().join("source.mp4");
        self.recover_file(source, &destination, true, &cancel)?;
        let mut warnings = Vec::new();
        if prefix.discarded_bytes > 0 {
            warnings.push(format!("Recovered {} complete video fragments. The incomplete tail ({} bytes) was not copied.",prefix.fragments,prefix.discarded_bytes));
        }
        for role in [AudioRole::System, AudioRole::Microphone] {
            let input = role.asset_path(source);
            if input.is_file()
                && let Err(error) =
                    self.recover_file(&input, &role.asset_path(&destination), false, &cancel)
            {
                if cancel.load(Ordering::Acquire) {
                    bail!("Recovery cancelled. The source file is unchanged.");
                }
                warnings.push(format!(
                    "Could not recover {}: {error:#}. The original track is still in its folder.",
                    role.label()
                ));
            }
        }
        let old_project = source.with_extension("recorder.json");
        if old_project.is_file() {
            match std::fs::copy(&old_project,folder.path().join("original.recorder.json")) {
                Ok(_)=>warnings.push("Previous edits copied to original.recorder.json. A new project matches the recovered duration.".into()),
                Err(error)=>warnings.push(format!("The previous project remains in the original folder: {error}")),
            }
        }
        let info = self.probe(&destination)?;
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let mut journal = SessionJournal::new(stamp);
        journal.state = SessionState::Recovered;
        journal.elapsed_ms = info.duration_us / 1000;
        journal.warnings = warnings.clone();
        journal.recovered_from = Some(std::path::absolute(source)?);
        save_json(&folder.path().join("session.json"), &journal).map_err(anyhow::Error::msg)?;
        anyhow::ensure!(
            !cancel.load(Ordering::Acquire),
            "Recovery cancelled. The source file is unchanged."
        );
        let folder = folder.keep();
        Ok(RecoveredRecording {
            folder,
            info,
            warnings,
        })
    }

    fn recover_file(
        &self,
        source: &Path,
        destination: &Path,
        video: bool,
        cancel: &AtomicBool,
    ) -> anyhow::Result<()> {
        let prefix = complete_fragment_prefix(source)?;
        let parent = destination
            .parent()
            .context("No recovery folder selected")?;
        let mut input = File::open(source)?.take(prefix.bytes);
        let mut bounded = tempfile::Builder::new()
            .prefix(".whole-fragments-")
            .suffix(".mp4")
            .tempfile_in(parent)?;
        let mut buffer = vec![0; 128 * 1024];
        loop {
            anyhow::ensure!(
                !cancel.load(Ordering::Acquire),
                "Recovery cancelled. The source file is unchanged."
            );
            let count = input.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            bounded.write_all(&buffer[..count])?;
        }
        bounded.flush()?;
        let output = tempfile::Builder::new()
            .prefix(".restored-")
            .suffix(if video { ".mp4" } else { ".m4a" })
            .tempfile_in(parent)?;
        let mut child = command(&self.ffmpeg)
            .args(["-v", "warning", "-nostdin", "-y", "-i"])
            .arg(bounded.path())
            .args([
                "-map",
                "0",
                "-c",
                "copy",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
            ])
            .arg(output.path())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()?;
        let stderr = child
            .stderr
            .take()
            .context("Recovery diagnostics stream is unavailable")?;
        let errors = std::thread::spawn(move || {
            let mut tail = std::collections::VecDeque::new();
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if tail.len() == 20 {
                    tail.pop_front();
                }
                tail.push_back(line);
            }
            tail.into_iter().collect::<Vec<_>>().join("\n")
        });
        let started = Instant::now();
        let status = loop {
            if cancel.load(Ordering::Acquire) || started.elapsed() > Duration::from_secs(600) {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) => {}
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = errors.join();
                    return Err(error.into());
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        let errors = errors.join().unwrap_or_default();
        let Some(status) = status else {
            bail!("Recovery was cancelled or exceeded ten minutes. The source file is unchanged.");
        };
        anyhow::ensure!(
            status.success(),
            "Could not rebuild the recovered file: {errors}"
        );
        let check = command(&self.ffprobe)
            .args([
                "-v",
                "error",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
            ])
            .arg(output.path())
            .output()?;
        let data: serde_json::Value = serde_json::from_slice(&check.stdout)?;
        let kind = if video { "video" } else { "audio" };
        let stream = data["streams"]
            .as_array()
            .and_then(|streams| streams.iter().find(|s| s["codec_type"] == kind))
            .context("The recovered file is missing the expected track")?;
        let duration = stream["duration"]
            .as_str()
            .or_else(|| data["format"]["duration"].as_str())
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0);
        anyhow::ensure!(
            check.status.success() && duration.is_finite() && duration > 0.0,
            "The recovered file failed verification"
        );
        anyhow::ensure!(
            !cancel.load(Ordering::Acquire),
            "Recovery cancelled. The source file is unchanged."
        );
        output.as_file().sync_all()?;
        output
            .persist_noclobber(destination)
            .map_err(|e| anyhow::anyhow!("Could not save the recovered copy: {e}"))?;
        Ok(())
    }
}
