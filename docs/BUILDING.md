# Build and release

## Requirements

- Rust 1.97.1, pinned by `rust-toolchain.toml`.
- Windows: MSVC C++ Build Tools, Windows SDK, and WebView2.
- macOS: macOS 14 or later and Xcode Command Line Tools.
- Python 3.12 or later for media preparation and packaging.
- Node.js 22 or later for frontend tests only.

## Application

```sh
cargo build --release --locked -p screen-recorder
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
node --test ui/test/*.test.js
python scripts/test_release.py
```

The static frontend is embedded by Cargo; no JavaScript bundler is required. Set `SCREEN_RECORDER_CONFIG_DIR` to use an isolated settings directory during development.

## Media tools

```sh
python scripts/prepare_media.py
bash scripts/build-media.sh
python scripts/verify_media.py vendor/media/bin
```

Windows media builds run in MSYS2 MINGW64 with GCC, make, pkg-config and diffutils. The workflow shows the exact setup. The build uses pinned FFmpeg sources, without GPL, nonfree or optional external codec libraries.

Set `SCREEN_RECORDER_MEDIA_DIR` to a directory containing FFmpeg and FFprobe during development. Packages place them in `media/` on Windows and `Contents/Resources/media/` on macOS. Windows capture itself uses Media Foundation.

## Browser checks

```sh
cd scripts
npm ci
npx playwright install chromium
cd ..
node scripts/test-ui.cjs target/ui-checks scripts/fixtures/browser.mp4
```

The committed synthetic fixture contains four seconds of 640×360 video at 30 FPS with an audio track. CI uses Chrome already installed in the Ubuntu runner. Set `PLAYWRIGHT_CHANNEL=msedge` or `chrome` to use an installed browser instead of bundled Chromium. Browser checks exercise the real frontend with a simulated native bridge; they do not replace native capture tests. See the [fixture notes](https://github.com/datuloar/screen-recorder/tree/main/scripts/fixtures) for generation commands.

## Packages

After building the application and media tools:

```sh
python scripts/package.py windows
```

This writes `dist/ScreenRecorder-VERSION-windows-x64.zip`. An existing package is never overwritten. Packages include user documentation, original license texts and the FFmpeg source archive.

The macOS workflow compiles the application, Swift bridge and media tools separately for arm64 and x86_64. `scripts/package.py macos` combines those binaries with `lipo`, verifies both architectures and signs the bundle ad-hoc. The workflow then creates a DMG. Developer ID signing and notarization are not configured.

## Automatic releases

Push to `main` to create a release. The workflow reserves a version tag, runs checks, builds Windows and both macOS architectures, and publishes both packages together after verifying their uploaded SHA-256 digests.

The first release uses `workspace.package.version`. Later pushes with that version unchanged increment its patch component. To select a minor or major version, set a version higher than existing release tags before pushing. Pull after a completed release so your local branch includes the automatic version commit and updated lockfile.

A failed build can leave a reserved tag without a published release. Re-run the failed workflow to reuse its version. Publication retries resume an existing draft; they never overwrite a published release. Version commits made with the workflow token do not recursively start another workflow.

Release notes group `feat` and `fix` commit subjects, list other changes and include the two package checksums. Keep commit subjects in English and describe the change to the application.
