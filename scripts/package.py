import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import tempfile
import tomllib
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def version():
    return tomllib.loads((ROOT / "Cargo.toml").read_text(encoding="utf-8"))["workspace"]["package"]["version"]


def copy_media_configuration(source, destination):
    text = source.read_text(encoding="utf-8")
    text, count = re.subn(r'--prefix=(?:\\.|[^\s])+', '--prefix="${PREFIX}"', text)
    if count != 1:
        raise RuntimeError("Expected one FFmpeg installation prefix")
    destination.write_text(text, encoding="utf-8")


def common_files(stage, targets):
    for name in ("README.md", "LICENSE", "THIRDPARTY-NOTICES.md"):
        shutil.copy2(ROOT / name, stage / name)
    (stage / "docs").mkdir()
    for name in ("USAGE.md", "BUILDING.md", "ARCHITECTURE.md", "DESIGN.md", "PERFORMANCE.md"):
        shutil.copy2(ROOT / "docs" / name, stage / "docs" / name)
    shutil.copytree(ROOT / "docs/benchmarks", stage / "docs/benchmarks")
    screenshots = ROOT / "docs/screenshots"
    if screenshots.exists():
        shutil.copytree(screenshots, stage / "docs/screenshots")
    source = stage / "third-party"
    source.mkdir()
    shutil.copy2(ROOT / "vendor/ffmpeg-8.0.tar.xz", source)
    copy_media_configuration(ROOT / "vendor/ffmpeg-configure.txt", source / "ffmpeg-configure.txt")
    shutil.copy2(ROOT / "scripts/media-source.json", source)
    shutil.copy2(ROOT / "scripts/build-media.sh", source)
    packages = {}
    for target in targets:
        metadata = json.loads(subprocess.check_output(["cargo", "metadata", "--locked", "--format-version", "1", "--filter-platform", target], cwd=ROOT, encoding="utf-8"))
        packages.update({package["id"]: package for package in metadata["packages"]})
    supplemental = json.loads((ROOT / "scripts/license-sources.json").read_text(encoding="utf-8"))
    rust_licenses = source / "rust"
    rust_licenses.mkdir()
    index = []
    for package in sorted(packages.values(), key=lambda package: (package["name"], package["version"])):
        if package["source"] is None:
            continue
        name = f"{package['name']}-{package['version']}"
        directory = Path(package["manifest_path"]).parent
        destination = rust_licenses / name
        files = [p for p in directory.iterdir() if p.is_file() and p.name.upper().startswith(("LICENSE", "LICENCE", "COPYING", "NOTICE", "AUTHORS", "COPYRIGHT"))]
        destination.mkdir()
        for file in files:
            shutil.copy2(file, destination / file.name)
        if not files:
            key = f"{package['name']}@{package['version']}"
            if key not in supplemental:
                raise RuntimeError(f"Missing original license text for {key}; add a pinned source to license-sources.json")
            spec = supplemental[key]
            cache = ROOT / "vendor/license-texts" / f"{spec['sha256']}.txt"
            if cache.exists():
                data = cache.read_bytes()
            else:
                request = urllib.request.Request(spec["url"], headers={"User-Agent": "ScreenRecorder-Build"})
                with urllib.request.urlopen(request, timeout=60) as response:
                    data = response.read()
            if hashlib.sha256(data).hexdigest() != spec["sha256"]:
                raise RuntimeError(f"License checksum mismatch: {key}")
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_bytes(data)
            (destination / "LICENSE.txt").write_bytes(data)
            (destination / "license-source.json").write_text(json.dumps(spec, indent=2) + "\n", encoding="utf-8")
        if package["license"] and "MPL-2.0" in package["license"]:
            shutil.copytree(directory, source / "rust-source" / name, ignore=shutil.ignore_patterns(".cargo-ok"))
        index.append({"name": package["name"], "version": package["version"], "license": package["license"], "repository": package["repository"]})
    (rust_licenses / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def windows():
    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    name = f"ScreenRecorder-{version()}-windows-x64"
    archive = dist / f"{name}.zip"
    if archive.exists() or (dist / name).exists():
        raise FileExistsError(f"Package already exists: {name}")
    with tempfile.TemporaryDirectory(prefix=".package-", dir=dist) as temporary:
        stage = Path(temporary) / name
        stage.mkdir()
        shutil.copy2(ROOT / "target/release/screen-recorder.exe", stage / "ScreenRecorder.exe")
        media = stage / "media"
        media.mkdir()
        for binary in ("ffmpeg.exe", "ffprobe.exe"):
            shutil.copy2(ROOT / "vendor/media/bin" / binary, media / binary)
        common_files(stage, ["x86_64-pc-windows-msvc"])
        shutil.copytree(ROOT / "vendor/media/licenses", stage / "third-party/mingw-runtime")
        pending_archive = Path(temporary) / archive.name
        with zipfile.ZipFile(pending_archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9, strict_timestamps=False) as output:
            for file in sorted(stage.rglob("*")):
                if file.is_file():
                    output.write(file, Path(stage.name) / file.relative_to(stage))
        stage.rename(dist / name)
        pending_archive.rename(archive)
    print(archive)


def macos():
    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    contents = dist / "Screen Recorder.app/Contents"
    for part in ("MacOS", "Frameworks", "Resources/media"):
        (contents / part).mkdir(parents=True, exist_ok=True)
    binaries = [
        ("screen-recorder", contents / "MacOS/screen-recorder"),
        ("libRecorderBridge.dylib", contents / "Frameworks/libRecorderBridge.dylib"),
        ("ffmpeg", contents / "Resources/media/ffmpeg"),
        ("ffprobe", contents / "Resources/media/ffprobe"),
    ]
    for name, target in binaries:
        subprocess.run(["lipo", "-create", str(ROOT / "vendor/macos-arm64" / name), str(ROOT / "vendor/macos-x64" / name), "-output", str(target)], check=True)
        target.chmod(0o755)
        subprocess.run(["lipo", str(target), "-verify_arch", "arm64", "x86_64"], check=True)
    with (contents / "Info.plist").open("wb") as output:
        plistlib.dump({
            "CFBundleIdentifier": "dev.screenrecorder.desktop",
            "CFBundleName": "Screen Recorder",
            "CFBundleDisplayName": "Screen Recorder",
            "CFBundleExecutable": "screen-recorder",
            "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": version(),
            "CFBundleVersion": version(),
            "LSMinimumSystemVersion": "14.0",
            "NSHighResolutionCapable": True,
            "NSScreenCaptureUsageDescription": "Record the screen area you select.",
            "NSMicrophoneUsageDescription": "Record your voice with the screen when you enable the microphone.",
        }, output)
    common_files(contents / "Resources", ["aarch64-apple-darwin", "x86_64-apple-darwin"])
    for architecture in ("arm64", "x64"):
        copy_media_configuration(ROOT / f"vendor/macos-{architecture}/configure.txt",
                                 contents / f"Resources/third-party/ffmpeg-configure-{architecture}.txt")
    # Ad-hoc signing permits local integrity checks; Developer ID/notarization is not configured.
    subprocess.run(["codesign", "--force", "--deep", "--sign", "-", str(contents.parent)], check=True)
    print(contents.parent)


def notes(tag, previous=None):
    if tag != f"v{version()}":
        raise RuntimeError(f"Tag {tag} does not match Cargo version {version()}")
    rev = f"{previous}..{tag}" if previous else tag
    log = subprocess.check_output(["git", "log", "--format=%s", rev], encoding="utf-8")
    groups = {"Added": [], "Fixed": [], "Changed": []}
    for subject in log.splitlines():
        if subject.startswith("chore(release):"):
            continue
        match = re.match(r"(\w+)(?:\([^)]*\))?!?:\s*(.+)", subject)
        kind, summary = match.groups() if match else ("", subject)
        group = "Added" if kind == "feat" else "Fixed" if kind == "fix" else "Changed"
        groups[group].append(summary.replace("<", "&lt;").replace(">", "&gt;"))
    output = [f"Screen Recorder {tag}", "", "Local screen recording and basic video editing for Windows and macOS.", "",
              "| Package | Platform | SHA-256 |", "|---|---|---|"]
    windows_assets = sorted((ROOT / "dist").glob("*.zip"))
    macos_assets = sorted((ROOT / "dist").glob("*.dmg"))
    assets = windows_assets + macos_assets
    if len(windows_assets) != 1 or len(macos_assets) != 1:
        raise RuntimeError("A release must contain exactly two platform packages")
    expected = {f"ScreenRecorder-{version()}-windows-x64.zip", f"ScreenRecorder-{version()}-macos-universal.dmg"}
    if {asset.name for asset in assets} != expected:
        raise RuntimeError("Release package names must match the current version and platform")
    for asset in assets:
        with asset.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        platform = "Windows 11 x64" if asset.suffix == ".zip" else "macOS 14+, Apple Silicon and Intel"
        output.append(f"| {asset.name} | {platform} | `{digest}` |")
    for title, subjects in groups.items():
        if subjects:
            output.extend(["", f"### {title}", ""] + [f"- {s}" for s in subjects])
    if previous:
        output.extend(["", f"Previous version: {previous}"])
    output.extend(["", "Packages are unsigned. The macOS app is ad-hoc signed and is not notarized."])
    (ROOT / "dist/release-notes.md").write_text("\n".join(output) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["windows", "macos", "notes", "check-version"])
    parser.add_argument("--tag")
    parser.add_argument("--previous", help="Previous published release tag; omit for the first release")
    args = parser.parse_args()
    if args.action == "windows": windows()
    elif args.action == "macos": macos()
    elif args.action == "notes": notes(args.tag, args.previous)
    elif args.tag != f"v{version()}": raise SystemExit("Tag must match workspace.package.version")
