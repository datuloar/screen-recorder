"""Recover disposable copies of native fragmented MP4, including a torn last fragment."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import struct
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("--source", type=Path, required=True)
parser.add_argument("--audio", type=Path, required=True)
parser.add_argument("--app", type=Path, required=True)
parser.add_argument("--ffmpeg", type=Path, required=True)
parser.add_argument("--scratch", type=Path, required=True)
args = parser.parse_args()
args.scratch.mkdir(parents=True, exist_ok=False)
probe = args.ffmpeg.with_name("ffprobe" + args.ffmpeg.suffix)


def run(command, success=True):
    result = subprocess.run([str(p) for p in command], capture_output=True, timeout=120)
    if success:
        assert result.returncode == 0, result.stderr.decode("utf-8", errors="replace")
    else:
        assert result.returncode != 0, "Expected a failure"
    return result.stdout


def boxes(path):
    data = path.read_bytes()
    offset = 0
    result = []
    while offset + 8 <= len(data):
        size, kind = struct.unpack_from(">I4s", data, offset)
        if size == 1:
            size = struct.unpack_from(">Q", data, offset + 8)[0]
        if not size or offset + size > len(data):
            break
        result.append((kind, offset, size))
        offset += size
    return result


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tear_last_mdat(path):
    mdats = [b for b in boxes(path) if b[0] == b"mdat"]
    assert len(mdats) >= 2, "Need at least two native fragments"
    _, offset, size = mdats[-1]
    with path.open("r+b") as output:
        output.truncate(offset + size // 2)


def recover(source, root, *options, success=True):
    output = run([args.app, "--recover-test", source, root, *options], success)
    return json.loads(output) if success else None


durations = {}
for name, torn in [("intact", False), ("torn", True)]:
    folder = args.scratch / name / "recording-123"
    folder.mkdir(parents=True)
    source = folder / "source.mp4"
    audio = folder / "source.system.m4a"
    broken_audio = folder / "source.microphone.m4a"
    project = folder / "source.recorder.json"
    shutil.copyfile(args.source, source)
    shutil.copyfile(args.audio, audio)
    broken_audio.write_bytes(b"interrupted before initialization")
    project.write_text('{"prior_edits":true}', encoding="utf-8")
    if torn:
        tear_last_mdat(source)
        tear_last_mdat(audio)
    originals = {p: digest(p) for p in folder.iterdir()}
    root = folder.parent / "recovered"
    result = recover(source, root)
    restored = Path(result["folder"])
    restored_video = restored / "source.mp4"
    assert all(digest(path) == sha for path, sha in originals.items()), "Original changed"
    assert (restored / "original.recorder.json").read_bytes() == project.read_bytes()
    assert (restored / "source.system.m4a").is_file()
    assert not (restored / "source.microphone.m4a").exists()
    assert any("microphone" in warning.lower() for warning in result["warnings"])
    assert not any(p.name.startswith(".") for p in restored.iterdir()), "Temporary file leaked"
    journal = json.loads((restored / "session.json").read_text(encoding="utf-8"))
    assert journal["state"] == "recovered"
    assert Path(journal["recovered_from"]) == source.resolve()
    assert b"moov" in [b[0] for b in boxes(restored_video)]
    assert b"moof" not in [b[0] for b in boxes(restored_video)], "Still fragmented"
    for media in [restored_video, restored / "source.system.m4a"]:
        run([args.ffmpeg, "-v", "error", "-xerror", "-i", media, "-f", "null", "-"])
    metadata = json.loads(run([probe, "-v", "error", "-count_frames", "-show_streams", "-of", "json", restored_video]))
    video = next(stream for stream in metadata["streams"] if stream["codec_type"] == "video")
    durations[name] = float(video["duration"])
    assert int(video["nb_read_frames"]) > 0
    assert result["info"]["duration_us"] / 1_000_000 == durations[name]
    catalog = json.loads(run([args.app, "--scan-recordings", root]))
    assert len(catalog) == 1 and not catalog[0]["needs_recovery"]
    before = set(root.iterdir())
    recover(source, root, "--cancel-immediately", success=False)
    assert set(root.iterdir()) == before, "Cancelled recovery leaked a folder"
    assert all(digest(path) == sha for path, sha in originals.items())

assert 0 < durations["torn"] < durations["intact"], durations
empty = args.scratch / "recording-empty"
empty.mkdir()
source = empty / "source.mp4"
data = args.source.read_bytes()
moov = next(box for box in boxes(args.source) if box[0] == b"moov")
source.write_bytes(data[:moov[1] + moov[2]])
failed_root = args.scratch / "failed-recovery"
recover(source, failed_root, success=False)
assert not failed_root.exists() or not list(failed_root.iterdir())
print(json.dumps(durations, indent=2))
print("PASS: intact/torn recovery, audio isolation, original hashes, cancellation, catalog and missing fragments")
