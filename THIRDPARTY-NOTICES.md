# Third-party components

The application is written in Rust under the MIT license. Rust dependencies and exact versions are recorded in Cargo.lock; their original authors retain their copyrights and licenses.

Platform packages include original dependency license texts and a package index under third-party/rust. Supplemental texts are fetched from sources pinned by SHA-256 in scripts/license-sources.json. Source files for dependencies declaring MPL-2.0 are included under third-party/rust-source with their original notices.

The release workflow builds FFmpeg 8.0 from the unmodified source archive distributed with each platform package. It enables no GPL or nonfree components and links no optional external codec libraries. FFmpeg uses the LGPL version 2.1 or later; its source archive contains COPYING.LGPLv2.1 and the remaining license texts. FFmpeg and FFprobe run as separate processes. Packages record the build configuration in third-party/ffmpeg-configure.txt and include the build script at third-party/build-media.sh (scripts/build-media.sh in the source repository).

FFmpeg source: https://ffmpeg.org/releases/ffmpeg-8.0.tar.xz

Users may replace the FFmpeg and FFprobe executables in the media directory with compatible versions. The application does not prohibit reverse engineering of those components for debugging modifications.

The Windows module uses windows-capture (MIT) and Microsoft windows-rs bindings (MIT or Apache-2.0). The macOS adapter calls frameworks supplied with macOS. The interface uses Tauri, global-hotkey, and tray-icon (MIT or Apache-2.0). Tauri uses the system WebView: Microsoft Edge WebView2 on Windows and WebKit on macOS. The frontend contains no third-party JavaScript libraries.

Local development may use a separately obtained FFmpeg build. Those development binaries are ignored by Git and are not the source of the release artifacts.

Windows FFmpeg executables also contain statically linked MinGW runtime components. Their original license texts, including the GCC Runtime Library Exception, are included under third-party/mingw-runtime.
