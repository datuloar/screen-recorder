"""Exercise the real export pipeline with known tones, gains, cuts and a short track.

Pass a disposable >= 3 second H.264 recording, the recorder executable, FFmpeg,
and a new scratch folder. Nothing is sent outside the machine.
"""
import argparse
from array import array
import json
import math
from pathlib import Path
import shutil
import subprocess
import wave

parser = argparse.ArgumentParser()
parser.add_argument("--source", type=Path, required=True)
parser.add_argument("--app", type=Path, required=True)
parser.add_argument("--ffmpeg", type=Path, required=True)
parser.add_argument("--scratch", type=Path, required=True)
args = parser.parse_args()
scratch = args.scratch.resolve()
scratch.mkdir(parents=True, exist_ok=False)
source = scratch / "source $(test).mp4"
shutil.copyfile(args.source, source)


def run(command):
    return subprocess.run([str(p) for p in command], check=True, capture_output=True).stdout


for role, frequency, length in [("system", 440, 4), ("microphone", 880, 1)]:
    wav = scratch / f"{role}.wav"
    samples = array("h")
    for i in range(48_000 * length):
        sample = round(32767 * 0.1 * math.sin(2 * math.pi * frequency * i / 48_000))
        samples.extend((sample, sample))
    with wave.open(str(wav), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(48_000)
        output.writeframes(samples.tobytes())
    run([args.ffmpeg, "-v", "error", "-i", wav, "-c:a", "aac", "-b:a", "192k", source.with_suffix(f".{role}.m4a")])

probe = args.ffmpeg.with_name("ffprobe" + args.ffmpeg.suffix)
info = json.loads(run([probe, "-v", "error", "-show_streams", "-of", "json", source]))
video = next(s for s in info["streams"] if s["codec_type"] == "video")
project = {
    "schema_version": 1, "source": source.name,
    "source_duration_us": round(float(video["duration"]) * 1_000_000),
    "width": video["width"], "height": video["height"], "fps": 30,
    "keep": [{"start_us": 0, "end_us": 1_000_000}, {"start_us": 2_000_000, "end_us": 3_000_000}],
    "crop": None, "muted": False,
    "audio": [{"track_id": "system", "gain_db": -6, "muted": False}, {"track_id": "microphone", "gain_db": 0, "muted": False}],
}
project_path = scratch / "edit.json"
project_path.write_text(json.dumps(project), encoding="utf-8")
result = scratch / "edited.mp4"
run([args.app, "--export-project", source, project_path, result])
result_info = json.loads(run([probe, "-v", "error", "-show_streams", "-of", "json", result]))
video_result = next(s for s in result_info["streams"] if s["codec_type"] == "video")
assert abs(float(video_result["duration"]) - 2) < 0.04
pcm = array("f")
pcm.frombytes(run([args.ffmpeg, "-v", "error", "-i", result, "-vn", "-ac", "2", "-ar", "48000", "-f", "f32le", "pipe:1"]))
pcm = pcm[::2]


def amplitude(frequency, start, end):
    chunk = pcm[round(start * 48_000):round(end * 48_000)]
    real = sum(v * math.cos(2 * math.pi * frequency * i / 48_000) for i, v in enumerate(chunk))
    imag = sum(v * math.sin(2 * math.pi * frequency * i / 48_000) for i, v in enumerate(chunk))
    return 2 * math.hypot(real, imag) / len(chunk)


measurements = {"system_first": amplitude(440, 0.25, 0.75), "mic_first": amplitude(880, 0.25, 0.75),
                "system_after_cut": amplitude(440, 1.25, 1.75), "mic_after_end": amplitude(880, 1.25, 1.75)}
for key in ("system_first", "system_after_cut"):
    assert abs(measurements[key] - 0.1 * 10 ** (-6 / 20)) < 0.012, measurements
assert abs(measurements["mic_first"] - 0.1) < 0.02, measurements
assert measurements["mic_after_end"] < 0.006, measurements
project["muted"] = True
project_path.write_text(json.dumps(project), encoding="utf-8")
silent = scratch / "muted.mp4"
run([args.app, "--export-project", source, project_path, silent])
silent_info = json.loads(run([probe, "-v", "error", "-show_streams", "-of", "json", silent]))
assert all(s["codec_type"] != "audio" for s in silent_info["streams"])
print(json.dumps(measurements, indent=2))
print("PASS: real gain/mix, short-track silence, cut timing and global mute")
