"""Validate the binaries that will be bundled, without requiring a GPU or screen access."""
import argparse
import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile
import wave


def run(binary, *arguments):
    environment = os.environ.copy()
    if platform.system() == "Windows":
        environment["PATH"] = str(Path(os.environ["SystemRoot"]) / "System32")
    result = subprocess.run([str(binary), *map(str, arguments)], capture_output=True, timeout=60, env=environment)
    if result.returncode:
        raise RuntimeError(f"{binary.name} exited with code {result.returncode}: "
                           + result.stderr.decode("utf-8", errors="replace"))
    return result.stdout


def verify(folder):
    folder = Path(folder).resolve()
    extension = ".exe" if platform.system() == "Windows" else ""
    ffmpeg, ffprobe = (folder / (name + extension) for name in ("ffmpeg", "ffprobe"))
    spec = json.loads((Path(__file__).parent / "media-source.json").read_text())
    version = run(ffmpeg, "-version").decode()
    if not version.startswith(f"ffmpeg version {spec['version']} "):
        raise RuntimeError("Bundled FFmpeg version differs from media-source.json")
    if any(flag in version for flag in ("--enable-gpl", "--enable-nonfree", "--enable-version3")):
        raise RuntimeError("Unexpected license configuration in bundled FFmpeg")
    required_encoder = "h264_mf" if platform.system() == "Windows" else "h264_videotoolbox"
    if required_encoder not in run(ffmpeg, "-hide_banner", "-encoders").decode():
        raise RuntimeError(f"Missing platform encoder: {required_encoder}")
    filters = run(ffmpeg, "-hide_banner", "-filters").decode()
    for name in ("scale", "trim", "atrim", "setpts", "asetpts", "concat", "volume", "amix", "aresample", "crop", "aformat", "apad", "alimiter", "asplit"):
        if not any(len(parts := line.split()) > 1 and parts[1] == name for line in filters.splitlines()):
            raise RuntimeError(f"Missing export filter: {name}")
    with tempfile.TemporaryDirectory(prefix="recorder-media-check-") as temporary:
        root = Path(temporary)
        raw = root / "input.wav"
        encoded = root / "tone.m4a"
        remuxed = root / "copy.m4a"
        with wave.open(str(raw), "wb") as audio:
            audio.setnchannels(2)
            audio.setsampwidth(2)
            audio.setframerate(48_000)
            audio.writeframes(b"\x00\x00\x00\x00" * 48_000)
        run(ffmpeg, "-v", "error", "-i", raw, "-af", "volume=-6dB,apad=whole_dur=1,alimiter=limit=0.95", "-t", "1", "-c:a", "aac", "-f", "mp4", encoded)
        run(ffmpeg, "-v", "error", "-i", encoded, "-c", "copy", "-movflags", "+faststart", "-f", "mp4", remuxed)
        metadata = json.loads(run(ffprobe, "-v", "error", "-show_streams", "-of", "json", remuxed))
        audio = next(stream for stream in metadata["streams"] if stream["codec_type"] == "audio")
        if audio["codec_name"] != "aac" or abs(float(audio["duration"]) - 1) > 0.03:
            raise RuntimeError("Bundled AAC encode/remux smoke test failed")
    print(f"PASS: FFmpeg {spec['version']}, {required_encoder}, export filters and AAC round trip")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("folder", type=Path)
    verify(parser.parse_args().folder)
