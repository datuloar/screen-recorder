# Recording measurements

These Windows measurements were recorded on October 23, 2026 with an optimized development build. They cover native video capture through the command line, with the interface, microphone and system audio disabled. The workload was the observed desktop.

The test machine ran Windows 11 build 26200 with an AMD Ryzen 7 9700X, 16 logical processors and a Radeon RX 7800 XT. The [raw results](benchmarks/windows-1080p.json) identify the tested executable by SHA-256. That hash identifies the measured build; the results do not establish performance for later releases.

| Measurement | 1080p at 30 FPS | 1080p at 60 FPS |
|---|---:|---:|
| Video duration | 20.000 s | 20.000 s |
| Decoded frames | 600 | 1,200 |
| Reported dropped frames | 0 | 0 |
| CPU, one logical processor = 100% | 4.60% | 7.36% |
| CPU, entire machine = 100% | 0.29% | 0.46% |
| Peak process working set | 81.25 MiB | 81.08 MiB |
| Actual video bitrate | 3.01 Mbps | 7.70 Mbps |
| File size | 7,548,518 bytes | 19,261,564 bytes |

Both runs requested 8 Mbps. Hardware H.264 encoding uses variable bitrate, so file size depends on the captured content.

## Reproduce

Build the release executable and media tools, then run from the repository root on Windows:

```powershell
python scripts/benchmark_recording.py --app target/release/screen-recorder.exe --ffprobe vendor/media/bin/ffprobe.exe --output benchmark-results --seconds 20 --size 1920x1080
```

Choose a new output directory. The script records from position 100, 100 on the first display, which must be large enough for the requested area. Hardware H.264 encoding is required. Finish building before starting the benchmark because Windows locks running executables.

The script samples `GetProcessMemoryInfo` and reads `GetProcessTimes`. CPU measurements include process startup and shutdown. After each recording, FFprobe independently decodes the video to count frames. Keep the generated `results.json` with the tested executable hash when comparing builds.

## Limits

These two short runs measure process CPU, memory and output timing. They leave GPU load, video memory, game frame rates, interface overhead, long recordings and audio synchronization unmeasured. A zero dropped-frame counter means the recording timer reported no backlog. Repeated frames can still occur when Windows Graphics Capture has no new image. No macOS performance measurements are available.
