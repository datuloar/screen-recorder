import hashlib
import json
from pathlib import Path
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def prepare():
    spec = json.loads((ROOT / "scripts/media-source.json").read_text())
    vendor = ROOT / "vendor"
    vendor.mkdir(exist_ok=True)
    archive = vendor / f"ffmpeg-{spec['version']}.tar.xz"
    if not archive.exists():
        request = urllib.request.Request(spec["url"], headers={"User-Agent": "ScreenRecorder-Build"})
        with urllib.request.urlopen(request, timeout=60) as response, archive.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
    digest = hashlib.file_digest(archive.open("rb"), "sha256").hexdigest()
    if digest != spec["sha256"]:
        raise RuntimeError("FFmpeg archive checksum mismatch")
    source = vendor / f"ffmpeg-{spec['version']}"
    if not source.exists():
        with tarfile.open(archive) as bundle:
            bundle.extractall(vendor, filter="data")
    print(source)


if __name__ == "__main__":
    prepare()
