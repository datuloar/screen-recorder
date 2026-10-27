"""Version main builds and publish both platform packages as one release."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tomllib
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
VERSION = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")


def git(*arguments):
    return subprocess.check_output(["git", *arguments], cwd=ROOT, text=True).strip()


def version_tuple(value):
    match = VERSION.fullmatch(value)
    if not match:
        raise ValueError(f"Expected a stable semantic version, got {value!r}")
    return tuple(map(int, match.groups()))


def next_version(current, tags):
    current_parts = version_tuple(current)
    versions = [version_tuple(tag[1:]) for tag in tags if tag.startswith("v") and VERSION.fullmatch(tag[1:])]
    if not versions or current_parts > max(versions):
        return current
    major, minor, patch = max(versions)
    return f"{major}.{minor}.{patch + 1}"


def set_version(value):
    version_tuple(value)
    manifest = ROOT / "Cargo.toml"
    text = manifest.read_text(encoding="utf-8")
    old = tomllib.loads(text)["workspace"]["package"]["version"]
    updated, count = re.subn(r'(?m)^(version\s*=\s*)"' + re.escape(old) + '"', rf'\g<1>"{value}"', text, count=1)
    if count != 1:
        raise RuntimeError("Workspace version field not found")
    members = tomllib.loads(updated)["workspace"]["members"]
    names = {tomllib.loads((ROOT / member / "Cargo.toml").read_text(encoding="utf-8"))["package"]["name"] for member in members}
    lock = ROOT / "Cargo.lock"
    text = lock.read_text(encoding="utf-8")
    for name in names:
        pattern = r'(?m)^(name = "' + re.escape(name) + r'"\nversion = )"[^"]+"'
        text, count = re.subn(pattern, rf'\g<1>"{value}"', text)
        if count != 1:
            raise RuntimeError(f"Expected one workspace lock entry for {name}")
    manifest.write_text(updated, encoding="utf-8")
    lock.write_text(text, encoding="utf-8")


def prepare(source, push=False):
    source = git("rev-parse", f"{source}^{{commit}}")
    tags = git("tag", "--list", "v*").splitlines()
    marker = f"Source commit: {source}"
    matches = [tag for tag in tags if marker in git("for-each-ref", f"refs/tags/{tag}", "--format=%(contents)").splitlines()]
    if len(matches) > 1:
        raise RuntimeError("More than one release tag refers to this source commit")
    if matches:
        return matches[0]
    if git("status", "--porcelain"):
        raise RuntimeError("Release preparation requires a clean working tree")
    if git("rev-parse", "HEAD") != source:
        raise RuntimeError("Checkout must point to the source commit")
    current = tomllib.loads((ROOT / "Cargo.toml").read_text(encoding="utf-8"))["workspace"]["package"]["version"]
    value = next_version(current, tags)
    set_version(value)
    if git("status", "--porcelain"):
        git("add", "Cargo.toml", "Cargo.lock")
        git("-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
            "commit", "-m", f"chore(release): {value}")
    tag = f"v{value}"
    git("-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
        "tag", "-a", tag, "-m", f"Screen Recorder {tag}\n\n{marker}")
    if push:
        # A concurrent update to main rejects the entire push, including the tag.
        git("push", "--atomic", "origin", "HEAD:refs/heads/main", f"refs/tags/{tag}")
    return tag


class GitHub:
    def __init__(self, repository, token):
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
            raise ValueError("Invalid GitHub repository")
        self.base = f"https://api.github.com/repos/{repository}"
        self.token = token

    def request(self, method, path, data=None, content_type="application/json"):
        url = path if path.startswith("https://") else self.base + path
        if urllib.parse.urlsplit(url).hostname not in {"api.github.com", "uploads.github.com"}:
            raise ValueError("Unexpected GitHub API host")
        if data is not None and not isinstance(data, bytes):
            data = json.dumps(data).encode()
        request = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": f"Bearer {self.token}", "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28", "Content-Type": content_type,
            "User-Agent": "ScreenRecorder-Release",
        })
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                result = response.read()
            return json.loads(result) if result else None
        except urllib.error.HTTPError as error:
            if error.code == 404 and method == "GET":
                return None
            raise RuntimeError(f"GitHub API {method} failed with HTTP {error.code}") from error


def publish(tag, github):
    value = tomllib.loads((ROOT / "Cargo.toml").read_text(encoding="utf-8"))["workspace"]["package"]["version"]
    if tag != f"v{value}":
        raise RuntimeError("Release tag does not match workspace version")
    names = [f"ScreenRecorder-{value}-windows-x64.zip", f"ScreenRecorder-{value}-macos-universal.dmg"]
    files = [ROOT / "dist" / name for name in names]
    if not all(file.is_file() and file.stat().st_size > 0 for file in files):
        raise RuntimeError("Both platform packages must exist and be non-empty")
    expected = {}
    for file in files:
        with file.open("rb") as stream:
            expected[file.name] = (file.stat().st_size, "sha256:" + hashlib.file_digest(stream, "sha256").hexdigest())
    release = github.request("GET", f"/releases/tags/{tag}")
    if release and not release["draft"]:
        if {asset["name"] for asset in release["assets"]} != set(names):
            raise RuntimeError("Published release has unexpected assets; it will not be modified")
        print(f"Already published: {release['html_url']}")
        return
    body = (ROOT / "dist/release-notes.md").read_text(encoding="utf-8")
    if not release:
        release = github.request("POST", "/releases", {"tag_name": tag, "name": f"Screen Recorder {tag}", "body": body, "draft": True})
    else:
        github.request("PATCH", f"/releases/{release['id']}", {"name": f"Screen Recorder {tag}", "body": body})
        for asset in release["assets"]:
            github.request("DELETE", f"/releases/assets/{asset['id']}")
    upload = release["upload_url"].split("{", 1)[0]
    for file in files:
        result = github.request("POST", upload + "?" + urllib.parse.urlencode({"name": file.name}), file.read_bytes(), "application/octet-stream")
        size, digest = expected[file.name]
        if result.get("state") != "uploaded" or result.get("size") != size or result.get("digest") != digest:
            raise RuntimeError(f"Uploaded asset verification failed: {file.name}. Release remains a draft.")
    release = github.request("GET", f"/releases/{release['id']}")
    if {asset["name"] for asset in release["assets"]} != set(names):
        raise RuntimeError("Release asset set is incomplete. Release remains a draft.")
    result = github.request("PATCH", f"/releases/{release['id']}", {"draft": False, "make_latest": "true"})
    print(f"Published: {result['html_url']}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    plan = commands.add_parser("prepare")
    plan.add_argument("--source", required=True)
    plan.add_argument("--push", action="store_true")
    release = commands.add_parser("publish")
    release.add_argument("--tag", required=True)
    arguments = parser.parse_args()
    if arguments.action == "prepare":
        tag = prepare(arguments.source, arguments.push)
        print(tag)
        if output := os.environ.get("GITHUB_OUTPUT"):
            with open(output, "a", encoding="utf-8") as stream:
                stream.write(f"tag={tag}\n")
    else:
        publish(arguments.tag, GitHub(os.environ["GITHUB_REPOSITORY"], os.environ["GH_TOKEN"]))
