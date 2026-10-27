import contextlib
import copy
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import package
import release


@contextlib.contextmanager
def repository():
    old_root, old_release_root, old_cwd = package.ROOT, release.ROOT, Path.cwd()
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        try:
            package.ROOT = root
            release.ROOT = root
            os.chdir(root)
            (root / "Cargo.toml").write_text('[workspace]\nmembers = ["app"]\n[workspace.package]\nversion = "0.1.0"\n')
            (root / "app").mkdir()
            (root / "app/Cargo.toml").write_text('[package]\nname = "screen-recorder"\nversion.workspace = true\n')
            (root / "Cargo.lock").write_text('version = 4\n\n[[package]]\nname = "screen-recorder"\nversion = "0.1.0"\n\n[[package]]\nname = "dependency"\nversion = "0.1.0"\n')
            (root / "dist").mkdir()
            subprocess.run(["git", "init", "-b", "main"], check=True, capture_output=True)
            subprocess.run(["git", "add", "Cargo.toml", "Cargo.lock", "app/Cargo.toml"], check=True)
            subprocess.run(["git", "-c", "user.name=Release Test", "-c", "user.email=release-test@example.invalid", "commit", "-m", "feat: record a region"], check=True, capture_output=True)
            subprocess.run(["git", "tag", "v0.1.0"], check=True)
            yield root
        finally:
            package.ROOT = old_root
            release.ROOT = old_release_root
            os.chdir(old_cwd)


class ReleaseTests(unittest.TestCase):
    def test_package_includes_user_docs_and_excludes_development_journals(self):
        with repository() as root:
            for name in ("README.md", "LICENSE", "THIRDPARTY-NOTICES.md", "docs/USAGE.md", "docs/BUILDING.md",
                         "docs/ARCHITECTURE.md", "docs/DESIGN.md", "docs/PERFORMANCE.md", "docs/benchmarks/windows-1080p.json",
                         "docs/STATUS.md", "docs/ui-checks.json", "docs/screenshots/record.png",
                         "vendor/ffmpeg-8.0.tar.xz", "vendor/ffmpeg-configure.txt", "scripts/media-source.json"):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("package fixture")
            (root / "scripts/license-sources.json").write_text("{}")
            (root / "scripts/build-media.sh").write_text("build fixture")
            (root / "vendor/ffmpeg-configure.txt").write_text('./configure --prefix=/private/build/media --disable-network\n')
            stage = root / "dist/package"
            stage.mkdir()
            with patch.object(package.subprocess, "check_output", return_value='{"packages": []}'):
                package.common_files(stage, ["x86_64-pc-windows-msvc"])
            self.assertTrue((stage / "docs/USAGE.md").is_file())
            self.assertTrue((stage / "docs/BUILDING.md").is_file())
            self.assertTrue((stage / "docs/ARCHITECTURE.md").is_file())
            self.assertTrue((stage / "docs/benchmarks/windows-1080p.json").is_file())
            self.assertTrue((stage / "docs/screenshots/record.png").is_file())
            self.assertFalse((stage / "docs/STATUS.md").exists())
            self.assertFalse((stage / "docs/ui-checks.json").exists())

    def test_media_configuration_preserves_flags_without_build_directory(self):
        with repository() as root:
            source = root / "configure.txt"
            destination = root / "normalized.txt"
            source.write_text('./configure --prefix=/private/My\\ Build/media --disable-network --extra-ldflags=-static\\ -static-libgcc\n')
            package.copy_media_configuration(source, destination)
            text = destination.read_text()
            self.assertEqual(text, './configure --prefix="${PREFIX}" --disable-network --extra-ldflags=-static\\ -static-libgcc\n')

    def test_windows_archive_preserves_version_and_platform(self):
        with repository() as root:
            for name in ("target/release/screen-recorder.exe", "vendor/media/bin/ffmpeg.exe",
                         "vendor/media/bin/ffprobe.exe", "vendor/media/licenses/libgcc/COPYING.RUNTIME"):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"package fixture")
                os.utime(path, (0, 0))
            with patch.object(package, "common_files"):
                package.windows()
            archive = root / "dist/ScreenRecorder-0.1.0-windows-x64.zip"
            with zipfile.ZipFile(archive) as bundle:
                self.assertEqual(len(bundle.namelist()), 4)
                self.assertIn("ScreenRecorder-0.1.0-windows-x64/media/ffprobe.exe", bundle.namelist())
                self.assertIn("ScreenRecorder-0.1.0-windows-x64/third-party/mingw-runtime/libgcc/COPYING.RUNTIME", bundle.namelist())

    def test_missing_platform_prevents_release_notes(self):
        with repository() as root:
            (root / "dist/windows.zip").write_bytes(b"windows fixture")
            (root / "dist/another-windows.zip").write_bytes(b"another fixture")
            with self.assertRaisesRegex(RuntimeError, "exactly two"):
                package.notes("v0.1.0")
            self.assertFalse((root / "dist/release-notes.md").exists())

    def test_failed_package_does_not_leave_a_release_archive(self):
        with repository() as root:
            for name in ("target/release/screen-recorder.exe", "vendor/media/bin/ffmpeg.exe",
                         "vendor/media/bin/ffprobe.exe"):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"package fixture")
            with patch.object(package, "common_files", side_effect=RuntimeError("Missing license")):
                with self.assertRaisesRegex(RuntimeError, "Missing license"):
                    package.windows()
            self.assertEqual(list((root / "dist").iterdir()), [])

    def test_both_packages_produce_grouped_changelog_and_checksums(self):
        with repository() as root:
            (root / "dist/ScreenRecorder-0.1.0-windows-x64.zip").write_bytes(b"windows fixture")
            (root / "dist/ScreenRecorder-0.1.0-macos-universal.dmg").write_bytes(b"macos fixture")
            package.notes("v0.1.0")
            notes = (root / "dist/release-notes.md").read_text(encoding="utf-8")
            self.assertIn("Added", notes)
            self.assertIn("- record a region", notes)
            self.assertIn("Windows 11 x64", notes)
            self.assertIn("Apple Silicon and Intel", notes)
            self.assertEqual(notes.count("`"), 4)

    def test_wrong_version_asset_names_are_rejected(self):
        with repository() as root:
            (root / "dist/ScreenRecorder-9.0.0-windows-x64.zip").write_bytes(b"windows fixture")
            (root / "dist/ScreenRecorder-9.0.0-macos-universal.dmg").write_bytes(b"macos fixture")
            with self.assertRaisesRegex(RuntimeError, "names must match"):
                package.notes("v0.1.0")

    def test_version_mismatch_is_rejected(self):
        with repository():
            with self.assertRaisesRegex(RuntimeError, "does not match"):
                package.notes("v9.0.0")

    def test_version_selection_preserves_first_and_explicit_versions(self):
        self.assertEqual(release.next_version("0.1.0", []), "0.1.0")
        self.assertEqual(release.next_version("0.1.0", ["v0.1.0"]), "0.1.1")
        self.assertEqual(release.next_version("0.1.0", ["v0.2.9", "v0.1.0", "v9.0.0-rc.1"]), "0.2.10")
        self.assertEqual(release.next_version("1.0.0", ["v0.1.0"]), "1.0.0")
        with self.assertRaises(ValueError):
            release.next_version("0.1.0\ninvalid", [])

    def test_workspace_and_lock_versions_change_together(self):
        with repository() as root:
            release.set_version("0.2.0")
            self.assertEqual(package.version(), "0.2.0")
            lock = (root / "Cargo.lock").read_text()
            self.assertIn('name = "screen-recorder"\nversion = "0.2.0"', lock)
            self.assertIn('name = "dependency"\nversion = "0.1.0"', lock)

    def test_prepare_reuses_source_tag_on_rerun(self):
        with repository():
            source = release.git("rev-parse", "HEAD")
            tag = release.prepare(source)
            self.assertEqual(tag, "v0.1.1")
            self.assertEqual(package.version(), "0.1.1")
            self.assertEqual(release.prepare(source), tag)
            self.assertEqual(release.git("status", "--porcelain"), "")
            self.assertIn(f"Source commit: {source}", release.git("for-each-ref", f"refs/tags/{tag}", "--format=%(contents)"))

    def test_first_release_uses_manifest_version(self):
        with repository():
            release.git("tag", "-d", "v0.1.0")
            source = release.git("rev-parse", "HEAD")
            self.assertEqual(release.prepare(source), "v0.1.0")
            self.assertEqual(release.git("rev-parse", "HEAD"), source)

    def test_atomic_push_does_not_tag_an_outdated_main(self):
        with repository() as root, tempfile.TemporaryDirectory() as remote:
            release.git("init", "--bare", remote)
            release.git("remote", "add", "origin", remote)
            release.git("push", "origin", "main")
            old = release.git("rev-parse", "HEAD")
            release.git("-c", "user.name=Release Test", "-c", "user.email=release-test@example.invalid", "commit", "--allow-empty", "-m", "fix: newer main update")
            newer = release.git("rev-parse", "HEAD")
            release.git("push", "origin", "main")
            release.git("checkout", "--detach", old)
            with self.assertRaises(subprocess.CalledProcessError):
                release.prepare(old, push=True)
            self.assertEqual(release.git("ls-remote", "origin", "refs/tags/v0.1.1"), "")
            self.assertTrue(release.git("ls-remote", "origin", "refs/heads/main").startswith(newer))

    def test_publish_verifies_both_assets_before_publishing(self):
        with repository() as root:
            self.release_files(root)
            github = FakeGitHub()
            release.publish("v0.1.0", github)
            self.assertFalse(github.release["draft"])
            self.assertEqual(len(github.release["assets"]), 2)
            mutations = len([call for call in github.calls if call[0] != "GET"])
            release.publish("v0.1.0", github)
            self.assertEqual(len([call for call in github.calls if call[0] != "GET"]), mutations)

    def test_failed_asset_verification_leaves_a_draft(self):
        with repository() as root:
            self.release_files(root)
            github = FakeGitHub(corrupt=True)
            with self.assertRaisesRegex(RuntimeError, "verification failed"):
                release.publish("v0.1.0", github)
            self.assertTrue(github.release["draft"])
            self.assertFalse(any(call[0] == "PATCH" and call[2].get("draft") is False for call in github.calls))

    def test_retry_replaces_incomplete_draft_assets(self):
        with repository() as root:
            self.release_files(root)
            github = FakeGitHub(corrupt=True)
            with self.assertRaises(RuntimeError):
                release.publish("v0.1.0", github)
            github.corrupt = False
            release.publish("v0.1.0", github)
            self.assertFalse(github.release["draft"])
            self.assertEqual(len(github.release["assets"]), 2)

    def test_retry_of_older_release_does_not_replace_latest(self):
        with repository() as root:
            self.release_files(root)
            github = FakeGitHub(published=[{"tag_name": "v0.2.0", "draft": False, "prerelease": False}])
            release.publish("v0.1.0", github)
            published = [call[2] for call in github.calls if call[0] == "PATCH" and call[2].get("draft") is False]
            self.assertEqual(published, [{"draft": False, "make_latest": "false"}])

    def test_newer_stable_release_becomes_latest(self):
        with repository() as root:
            self.release_files(root)
            github = FakeGitHub(published=[{"tag_name": "v0.0.9", "draft": False, "prerelease": False},
                                           {"tag_name": "v9.0.0", "draft": True, "prerelease": False}])
            release.publish("v0.1.0", github)
            published = [call[2] for call in github.calls if call[0] == "PATCH" and call[2].get("draft") is False]
            self.assertEqual(published, [{"draft": False, "make_latest": "true"}])

    def test_first_published_notes_include_features_from_failed_reserved_tag(self):
        with repository() as root:
            release.set_version("0.1.1")
            release.git("add", "Cargo.toml", "Cargo.lock")
            release.git("-c", "user.name=Release Test", "-c", "user.email=release-test@example.invalid", "commit", "-m", "fix: repair package build")
            release.git("tag", "v0.1.1")
            self.release_files(root, "0.1.1")
            release.notes("v0.1.1", FakeGitHub())
            notes = (root / "dist/release-notes.md").read_text()
            self.assertIn("- record a region", notes)
            self.assertIn("- repair package build", notes)
            self.assertNotIn("Previous version:", notes)

    def test_notes_start_after_last_published_ancestor_and_include_reserved_versions(self):
        with repository() as root:
            release.git("-c", "user.name=Release Test", "-c", "user.email=release-test@example.invalid", "commit", "--allow-empty", "-m", "feat: add crop handles")
            release.git("tag", "v0.1.1")
            release.set_version("0.1.2")
            release.git("add", "Cargo.toml", "Cargo.lock")
            release.git("-c", "user.name=Release Test", "-c", "user.email=release-test@example.invalid", "commit", "-m", "fix: repair universal package")
            release.git("tag", "v0.1.2")
            self.release_files(root, "0.1.2")
            github = FakeGitHub(published=[{"tag_name": "v0.1.0", "draft": False, "prerelease": False},
                                           {"tag_name": "v0.1.1", "draft": True, "prerelease": False}])
            release.notes("v0.1.2", github)
            notes = (root / "dist/release-notes.md").read_text()
            self.assertIn("- add crop handles", notes)
            self.assertIn("- repair universal package", notes)
            self.assertNotIn("- record a region", notes)
            self.assertIn("Previous version: v0.1.0", notes)

    def test_published_version_listing_paginates_and_excludes_drafts_and_prereleases(self):
        github = FakeGitHub()
        first = [{"tag_name": f"v0.1.{index}", "draft": True} for index in range(100)]
        second = [{"tag_name": "v1.0.0", "draft": False}, {"tag_name": "v2.0.0-rc.1", "draft": False, "prerelease": True}]
        with patch.object(github, "request", side_effect=[first, second]) as requests:
            self.assertEqual(release.published_versions(github), {"v1.0.0": (1, 0, 0)})
        self.assertEqual(requests.call_args_list[1].args, ("GET", "/releases?per_page=100&page=2"))

    @staticmethod
    def release_files(root, value="0.1.0"):
        (root / f"dist/ScreenRecorder-{value}-windows-x64.zip").write_bytes(b"windows fixture")
        (root / f"dist/ScreenRecorder-{value}-macos-universal.dmg").write_bytes(b"macos fixture")
        (root / "dist/release-notes.md").write_text(f"Screen Recorder v{value}\n")


class FakeGitHub:
    def __init__(self, corrupt=False, published=None):
        self.release = None
        self.corrupt = corrupt
        self.calls = []
        self.published = published or []

    def request(self, method, path, data=None, content_type=None):
        self.calls.append((method, path, copy.deepcopy(data)))
        if method == "GET" and path.startswith("/releases?"):
            return copy.deepcopy(self.published + ([self.release] if self.release else []))
        if method == "GET":
            return copy.deepcopy(self.release)
        if method == "POST" and path == "/releases":
            self.release = {**data, "id": 1, "assets": [], "html_url": "https://github.com/example/recorder/releases/tag/v0.1.0", "upload_url": "https://uploads.github.com/repos/example/recorder/releases/1/assets{?name,label}"}
        elif method == "PATCH":
            self.release.update(data)
        elif method == "DELETE":
            asset_id = int(path.rsplit("/", 1)[1])
            self.release["assets"] = [asset for asset in self.release["assets"] if asset["id"] != asset_id]
            return None
        elif method == "POST":
            name = path.split("?name=", 1)[1]
            asset = {"id": len(self.release["assets"]) + 1, "name": name, "state": "uploaded", "size": len(data), "digest": "sha256:" + hashlib.sha256(data).hexdigest()}
            if self.corrupt:
                asset["digest"] = "sha256:incorrect"
            self.release["assets"].append(asset)
            return copy.deepcopy(asset)
        return copy.deepcopy(self.release)


if __name__ == "__main__":
    unittest.main()
