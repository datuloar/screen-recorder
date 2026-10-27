use anyhow::{Context, bail};
mod fragment;
mod recovery;
pub use fragment::*;
use recorder_core::{AudioRole, EditProject, PixelRect};
pub use recovery::*;
use std::{
    ffi::OsString,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
};

#[derive(Debug, Clone)]
pub struct MediaTools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct MediaInfo {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub duration_us: u64,
    pub audio: Vec<AudioTrack>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AudioTrack {
    pub id: String,
    pub label: String,
    pub path: PathBuf,
    pub stream: usize,
}

#[derive(Debug, Clone)]
pub struct Preview {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

fn command(path: &Path) -> Command {
    let command = Command::new(path);
    #[cfg(windows)]
    let command = {
        use std::os::windows::process::CommandExt;
        let mut command = command;
        command.creation_flags(0x08000000);
        command
    };
    command
}

impl MediaTools {
    pub fn discover() -> anyhow::Result<Self> {
        let executable = std::env::current_exe()?;
        let parent = executable
            .parent()
            .context("Application folder unavailable")?;
        let ext = if cfg!(windows) { ".exe" } else { "" };
        let ffmpeg_name = format!("ffmpeg{ext}");
        let candidates = [
            std::env::var_os("SCREEN_RECORDER_MEDIA_DIR").map(PathBuf::from),
            Some(parent.join("media")),
            Some(parent.join("../Resources/media")),
            Some(parent.to_path_buf()),
        ];
        for candidate in candidates.into_iter().flatten() {
            let ffmpeg = candidate.join(&ffmpeg_name);
            let ffprobe = candidate.join(format!("ffprobe{ext}"));
            if ffmpeg.is_file() && ffprobe.is_file() {
                return Ok(Self { ffmpeg, ffprobe });
            }
        }
        bail!(
            "FFmpeg and FFprobe were not found. Extract the complete application package or set SCREEN_RECORDER_MEDIA_DIR."
        )
    }

    pub fn probe(&self, path: &Path) -> anyhow::Result<MediaInfo> {
        let output = command(&self.ffprobe)
            .args([
                "-v",
                "error",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
            ])
            .arg(path)
            .output()?;
        if !output.status.success() {
            bail!(
                "Could not read video: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let data: serde_json::Value = serde_json::from_slice(&output.stdout)?;
        let streams = data["streams"]
            .as_array()
            .context("The file has no media streams")?;
        let video = streams
            .iter()
            .find(|s| s["codec_type"] == "video")
            .context("The file has no video stream")?;
        let duration = video["duration"]
            .as_str()
            .or_else(|| data["format"]["duration"].as_str())
            .context("Could not determine video duration")?;
        let duration_seconds = duration.parse::<f64>()?;
        if !duration_seconds.is_finite() || duration_seconds <= 0.0 || duration_seconds > 604_800.0
        {
            bail!("Unsupported video duration");
        }
        let duration_us = (duration_seconds * 1_000_000.0).round() as u64;
        let rate = video["avg_frame_rate"].as_str().unwrap_or("30/1");
        let (num, den) = rate.split_once('/').unwrap_or(("30", "1"));
        let rate = num.parse::<f64>().unwrap_or(30.0) / den.parse::<f64>().unwrap_or(1.0);
        let fps = if rate.is_finite() && rate > 0.0 {
            rate.round().clamp(1.0, 240.0) as u32
        } else {
            30
        };
        let mut audio: Vec<_> = streams
            .iter()
            .filter(|s| s["codec_type"] == "audio")
            .enumerate()
            .map(|(index, _)| AudioTrack {
                id: format!("embedded:{index}"),
                label: format!("Video audio {}", index + 1),
                path: path.into(),
                stream: index,
            })
            .collect();
        let mut warnings = Vec::new();
        for role in [AudioRole::System, AudioRole::Microphone] {
            let asset = role.asset_path(path);
            if asset.is_file() {
                let output = command(&self.ffprobe)
                    .args([
                        "-v",
                        "error",
                        "-select_streams",
                        "a:0",
                        "-show_entries",
                        "stream=codec_type",
                        "-of",
                        "json",
                    ])
                    .arg(&asset)
                    .output()?;
                let value: serde_json::Value =
                    serde_json::from_slice(&output.stdout).unwrap_or_default();
                if !output.status.success() || value["streams"][0]["codec_type"] != "audio" {
                    warnings.push(format!("Could not read {}. Video opened without this track; the original audio file is unchanged.",role.label()));
                    continue;
                }
                audio.push(AudioTrack {
                    id: role.id().into(),
                    label: role.label().into(),
                    path: asset,
                    stream: 0,
                });
            }
        }
        Ok(MediaInfo {
            width: video["width"].as_u64().context("Video width is missing")? as u32,
            height: video["height"]
                .as_u64()
                .context("Video height is missing")? as u32,
            fps,
            duration_us,
            audio,
            warnings,
        })
    }

    pub fn preview(&self, path: &Path, at_us: u64, info: &MediaInfo) -> anyhow::Result<Preview> {
        self.preview_crop(path, at_us, info, None)
    }

    pub fn preview_crop(
        &self,
        path: &Path,
        at_us: u64,
        info: &MediaInfo,
        crop: Option<PixelRect>,
    ) -> anyhow::Result<Preview> {
        let rect = crop.unwrap_or(PixelRect {
            x: 0,
            y: 0,
            width: info.width,
            height: info.height,
        });
        rect.validate(info.width, info.height)
            .map_err(anyhow::Error::msg)?;
        let width = (rect.width.min(720) & !1).max(2);
        let height =
            (((rect.height as f64 * width as f64 / rect.width as f64).round() as u32) & !1).max(2);
        let filter = format!(
            "crop={}:{}:{}:{},scale={width}:{height}",
            rect.width, rect.height, rect.x, rect.y
        );
        let output = command(&self.ffmpeg)
            .args(["-v", "error", "-nostdin", "-ss", &seconds(at_us)])
            .arg("-i")
            .arg(path)
            .args([
                "-an",
                "-vf",
                &filter,
                "-frames:v",
                "1",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgba",
                "pipe:1",
            ])
            .output()?;
        if !output.status.success() || output.stdout.len() != (width * height * 4) as usize {
            bail!(
                "Could not prepare frame: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        Ok(Preview {
            rgba: output.stdout,
            width,
            height,
        })
    }

    pub fn export(
        &self,
        source: &Path,
        project: &EditProject,
        destination: &Path,
        bitrate: u32,
        cancelled: Arc<AtomicBool>,
        progress: mpsc::Sender<u64>,
    ) -> anyhow::Result<()> {
        project.validate().map_err(anyhow::Error::msg)?;
        if destination.exists() {
            bail!("File already exists. Choose another name.");
        }
        let info = self.probe(source)?;
        let args = export_arguments(source, project, &info, bitrate)?;
        let parent = destination.parent().context("No export folder selected")?;
        std::fs::create_dir_all(parent)?;
        let temporary = tempfile::Builder::new()
            .prefix(".recorder-export-")
            .suffix(".mp4")
            .tempfile_in(parent)?;
        let temporary_path = temporary.path().to_path_buf();
        let mut child = command(&self.ffmpeg)
            .args(args)
            .arg(&temporary_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let stdout = child
            .stdout
            .take()
            .context("Export progress stream is unavailable")?;
        let stderr = child
            .stderr
            .take()
            .context("Export error stream is unavailable")?;
        let progress_reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(value) = line
                    .strip_prefix("out_time_us=")
                    .and_then(|v| v.parse().ok())
                {
                    let _ = progress.send(value);
                }
            }
        });
        let error_reader = std::thread::spawn(move || {
            let mut tail = std::collections::VecDeque::new();
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if tail.len() == 30 {
                    tail.pop_front();
                }
                tail.push_back(line);
            }
            tail.into_iter().collect::<Vec<_>>().join("\n")
        });
        let status = loop {
            if cancelled.load(Ordering::Acquire) {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            if let Some(status) = child.try_wait()? {
                break Some(status);
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        };
        let _ = progress_reader.join();
        let error = error_reader.join().unwrap_or_default();
        let Some(status) = status else {
            bail!("Export cancelled. The source file is unchanged.");
        };
        if !status.success() {
            bail!("Export failed: {error}");
        }
        self.probe(&temporary_path)
            .context("Verifying exported MP4")?;
        temporary
            .persist_noclobber(destination)
            .map_err(|e| anyhow::anyhow!("Could not save exported video: {e}"))?;
        Ok(())
    }
}

pub fn seconds(us: u64) -> String {
    format!("{}.{:06}", us / 1_000_000, us % 1_000_000)
}

pub fn parse_seconds(input: &str) -> Result<u64, String> {
    let value = input.trim().replace(',', ".");
    let (seconds, fraction) = value.split_once('.').unwrap_or((&value, ""));
    if seconds.is_empty()
        || !seconds.bytes().all(|c| c.is_ascii_digit())
        || fraction.len() > 6
        || !fraction.bytes().all(|c| c.is_ascii_digit())
    {
        return Err("Enter seconds, for example 12.5".into());
    }
    let seconds: u64 = seconds.parse().map_err(|_| "Time value is too large")?;
    let mut micros = fraction.to_string();
    while micros.len() < 6 {
        micros.push('0');
    }
    seconds
        .checked_mul(1_000_000)
        .and_then(|v| v.checked_add(micros.parse().unwrap_or(0)))
        .ok_or_else(|| "Time value is too large".into())
}

fn export_arguments(
    source: &Path,
    project: &EditProject,
    info: &MediaInfo,
    bitrate: u32,
) -> anyhow::Result<Vec<OsString>> {
    project.validate().map_err(anyhow::Error::msg)?;
    for track in &project.audio {
        anyhow::ensure!(
            project.muted || track.muted || info.audio.iter().any(|a| a.id == track.track_id),
            "Track {} was not found. Restore its audio file to the project folder or disable the track.",
            track.track_id
        );
    }
    let tracks: Vec<_> = info
        .audio
        .iter()
        .filter_map(|track| {
            let mix = project.audio.iter().find(|a| a.track_id == track.id);
            (!project.muted && !mix.is_some_and(|m| m.muted))
                .then_some((track, mix.map_or(0.0, |m| m.gain_db)))
        })
        .collect();
    let audio = !tracks.is_empty();
    let mut args: Vec<OsString> = ["-v", "warning", "-nostdin", "-y", "-i"]
        .into_iter()
        .map(Into::into)
        .collect();
    args.push(source.as_os_str().into());
    let mut filters = Vec::new();
    let mut next_input = 1;
    let mut mixed = String::new();
    for (i, (track, gain)) in tracks.iter().enumerate() {
        let index = if track.path == source {
            0
        } else {
            args.push("-i".into());
            args.push(track.path.as_os_str().into());
            next_input += 1;
            next_input - 1
        };
        filters.push(format!("[{index}:a:{}]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume={gain}dB,apad,atrim=duration={}[track{i}]",track.stream,seconds(info.duration_us)));
        mixed.push_str(&format!("[track{i}]"));
    }
    if audio {
        filters.push(format!("{mixed}amix=inputs={}:duration=longest:normalize=0,alimiter=limit=0.95:level=0:latency=1[mix]",tracks.len()));
        if project.keep.len() > 1 {
            filters.push(format!(
                "[mix]asplit={}{}",
                project.keep.len(),
                (0..project.keep.len())
                    .map(|i| format!("[mix{i}]"))
                    .collect::<String>()
            ));
        }
    }
    let mut inputs = String::new();
    for (i, r) in project.keep.iter().enumerate() {
        filters.push(format!(
            "[0:v:0]trim=start={}:end={},setpts=PTS-STARTPTS[v{i}]",
            seconds(r.start_us),
            seconds(r.end_us)
        ));
        inputs.push_str(&format!("[v{i}]"));
        if audio {
            filters.push(format!(
                "[{}]atrim=start={}:end={},asetpts=PTS-STARTPTS[a{i}]",
                if project.keep.len() > 1 {
                    format!("mix{i}")
                } else {
                    "mix".into()
                },
                seconds(r.start_us),
                seconds(r.end_us)
            ));
            inputs.push_str(&format!("[a{i}]"));
        }
    }
    filters.push(format!(
        "{inputs}concat=n={}:v=1:a={}[joined]{}",
        project.keep.len(),
        u8::from(audio),
        if audio { "[sound]" } else { "" }
    ));
    let video = if let Some(r) = project.crop {
        filters.push(format!(
            "[joined]crop={}:{}:{}:{}[picture]",
            r.width & !1,
            r.height & !1,
            r.x,
            r.y
        ));
        "[picture]"
    } else {
        "[joined]"
    };
    for arg in ["-filter_complex", &filters.join(";"), "-map", video] {
        args.push(arg.into());
    }
    if audio {
        args.extend(["-map", "[sound]", "-c:a", "aac", "-b:a", "192k"].map(OsString::from));
    } else {
        args.push("-an".into());
    }
    #[cfg(windows)]
    args.extend(["-c:v", "h264_mf", "-hw_encoding", "1"].map(OsString::from));
    #[cfg(target_os = "macos")]
    args.extend(["-c:v", "h264_videotoolbox", "-allow_sw", "0"].map(OsString::from));
    args.extend(
        [
            "-b:v",
            &bitrate.to_string(),
            "-pix_fmt",
            "nv12",
            "-movflags",
            "+faststart",
            "-progress",
            "pipe:1",
        ]
        .map(OsString::from),
    );
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_input_preserves_microseconds_without_floats() {
        assert_eq!(parse_seconds("123,000007").unwrap(), 123_000_007);
        assert_eq!(seconds(123_000_007), "123.000007");
        assert!(parse_seconds("-1").is_err());
        assert!(parse_seconds("NaN").is_err());
        assert!(parse_seconds("18446744073709551615").is_err());
    }

    #[test]
    fn export_trims_both_tracks_and_never_invokes_shell() {
        let mut project = EditProject::new(10_000_000, 1920, 1080, 30).unwrap();
        project
            .cut(recorder_core::TimeRange::new(2_000_000, 4_000_000).unwrap())
            .unwrap();
        let info = MediaInfo {
            warnings: Vec::new(),
            width: 1920,
            height: 1080,
            fps: 30,
            duration_us: 10_000_000,
            audio: vec![AudioTrack {
                id: "embedded:0".into(),
                label: "Audio".into(),
                path: "input $(secret).mp4".into(),
                stream: 0,
            }],
        };
        let args =
            export_arguments(Path::new("input $(secret).mp4"), &project, &info, 8_000_000).unwrap();
        assert!(args.contains(&OsString::from("input $(secret).mp4")));
        let graph =
            args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1].to_string_lossy();
        assert!(graph.contains("atrim=start=4.000000:end=10.000000"));
        assert!(graph.contains("concat=n=2:v=1:a=1"));
    }
}
