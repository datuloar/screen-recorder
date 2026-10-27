#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod desktop;
mod language;
mod shell;

fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).is_some_and(|v| v == "--recover-test") {
        let source = std::path::PathBuf::from(
            args.get(2)
                .ok_or_else(|| anyhow::anyhow!("Expected source"))?,
        );
        let root = std::path::PathBuf::from(
            args.get(3)
                .ok_or_else(|| anyhow::anyhow!("Expected output folder"))?,
        );
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(
            args.iter().any(|arg| arg == "--cancel-immediately"),
        ));
        let result =
            recorder_media::MediaTools::discover()?.recover_recording(&source, &root, cancel)?;
        println!("{}", serde_json::to_string(&result)?);
        return Ok(());
    }
    if args.get(1).is_some_and(|v| v == "--scan-recordings") {
        let root = std::path::PathBuf::from(
            args.get(2)
                .ok_or_else(|| anyhow::anyhow!("Expected recordings folder"))?,
        );
        println!(
            "{}",
            serde_json::to_string(&recorder_core::recordings(&root).map_err(anyhow::Error::msg)?)?
        );
        return Ok(());
    }
    if args.get(1).is_some_and(|v| v == "--version") {
        println!("Screen Recorder {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    if args.get(1).is_some_and(|v| v == "--displays") {
        for display in recorder_platform::displays()? {
            println!("{display:?}");
        }
        return Ok(());
    }
    if args.get(1).is_some_and(|v| v == "--audio-devices") {
        for role in [
            recorder_core::AudioRole::System,
            recorder_core::AudioRole::Microphone,
        ] {
            println!(
                "{}: {:?}",
                role.label(),
                recorder_platform::audio_devices(role)?
            );
        }
        return Ok(());
    }
    if args
        .get(1)
        .is_some_and(|v| v == "--record-test" || v == "--pause-test")
    {
        let output = std::path::PathBuf::from(
            args.get(2)
                .ok_or_else(|| anyhow::anyhow!("Expected output path"))?,
        );
        let display = recorder_platform::displays()?
            .into_iter()
            .next()
            .ok_or_else(|| anyhow::anyhow!("No display"))?;
        let option = |name: &str| {
            args.iter()
                .position(|arg| arg == name)
                .and_then(|index| args.get(index + 1))
        };
        let fps = option("--fps")
            .map(|value| value.parse::<u32>())
            .transpose()?
            .unwrap_or(30);
        anyhow::ensure!(
            [15, 24, 30, 60].contains(&fps),
            "Expected FPS: 15, 24, 30 or 60"
        );
        let (width, height) = if let Some(size) = option("--size") {
            let (width, height) = size
                .split_once('x')
                .ok_or_else(|| anyhow::anyhow!("Expected WIDTHxHEIGHT"))?;
            (width.parse::<u32>()?, height.parse::<u32>()?)
        } else {
            (640, 360)
        };
        let region = recorder_core::PixelRect {
            x: 100,
            y: 100,
            width,
            height,
        }
        .validate(display.width, display.height)
        .map_err(anyhow::Error::msg)?;
        let mut session = recorder_platform::start_recording(recorder_core::RecordingConfig {
            region,
            display,
            fps,
            bitrate: 8_000_000,
            show_cursor: false,
            output,
            audio: recorder_core::AudioSettings {
                system: args.iter().any(|v| v == "--system-audio"),
                microphone: args.iter().any(|v| v == "--microphone"),
                ..Default::default()
            },
        })?;
        let duration = args
            .get(3)
            .filter(|v| !v.starts_with("--"))
            .map(|v| v.parse::<u64>())
            .transpose()?
            .unwrap_or(4)
            .clamp(1, 60);
        if args[1] == "--pause-test" {
            std::thread::sleep(std::time::Duration::from_secs(2));
            session.pause(true);
            std::thread::sleep(std::time::Duration::from_secs(2));
            session.pause(false);
            std::thread::sleep(std::time::Duration::from_secs(2));
        } else {
            std::thread::sleep(std::time::Duration::from_secs(duration));
        }
        session.request_stop();
        for _ in 0..200 {
            if let Some(result) = session.poll_finished() {
                result.map_err(anyhow::Error::msg)?;
                println!(
                    "Frames: {}",
                    session
                        .stats
                        .frames
                        .load(std::sync::atomic::Ordering::Relaxed)
                );
                println!("Encoder: {:?}", session.stats.encoder_name.lock().unwrap());
                println!(
                    "Dropped frames: {}",
                    session
                        .stats
                        .dropped_frames
                        .load(std::sync::atomic::Ordering::Relaxed)
                );
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        anyhow::bail!("Recording stop timed out");
    }
    if args.get(1).is_some_and(|v| v == "--smoke-media") {
        let source = std::path::PathBuf::from(
            args.get(2)
                .ok_or_else(|| anyhow::anyhow!("Expected source"))?,
        );
        let destination = std::path::PathBuf::from(
            args.get(3)
                .ok_or_else(|| anyhow::anyhow!("Expected destination"))?,
        );
        let tools = recorder_media::MediaTools::discover()?;
        let info = tools.probe(&source)?;
        let preview = tools.preview(&source, 500_000, &info)?;
        println!("Preview: {}x{}", preview.width, preview.height);
        let mut project =
            recorder_core::EditProject::new(info.duration_us, info.width, info.height, info.fps)
                .map_err(anyhow::Error::msg)?;
        project.keep =
            vec![recorder_core::TimeRange::new(500_000, 2_500_000).map_err(anyhow::Error::msg)?];
        project.crop = Some(recorder_core::PixelRect {
            x: 20,
            y: 20,
            width: 320,
            height: 180,
        });
        let (tx, _rx) = std::sync::mpsc::channel();
        tools.export(
            &source,
            &project,
            &destination,
            4_000_000,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tx,
        )?;
        let result = tools.probe(&destination)?;
        anyhow::ensure!(
            result.width == 320 && result.height == 180,
            "Crop dimensions mismatch"
        );
        anyhow::ensure!(
            result.duration_us.abs_diff(2_000_000) < 150_000,
            "Trim duration mismatch: {}",
            result.duration_us
        );
        println!("Export verified: {result:?}");
        return Ok(());
    }
    if args.get(1).is_some_and(|v| v == "--export-project") {
        let source = std::path::PathBuf::from(
            args.get(2)
                .ok_or_else(|| anyhow::anyhow!("Expected source"))?,
        );
        let project_path = std::path::PathBuf::from(
            args.get(3)
                .ok_or_else(|| anyhow::anyhow!("Expected project"))?,
        );
        let destination = std::path::PathBuf::from(
            args.get(4)
                .ok_or_else(|| anyhow::anyhow!("Expected destination"))?,
        );
        let project: recorder_core::EditProject =
            recorder_core::load_json(&project_path).map_err(anyhow::Error::msg)?;
        let (tx, _rx) = std::sync::mpsc::channel();
        recorder_media::MediaTools::discover()?.export(
            &source,
            &project,
            &destination,
            4_000_000,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tx,
        )?;
        return Ok(());
    }
    desktop::run()?;
    Ok(())
}
