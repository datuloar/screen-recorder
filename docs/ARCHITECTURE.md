# Architecture

The app separates capture, editing state and export. Capture continues independently of the WebView, and editing never rewrites the source recording.

| Component | Responsibility |
| --- | --- |
| `crates/core` | Settings, capture geometry, project validation, timeline ranges and recording journals |
| `crates/platform` | Native screen and audio capture, hardware encoding and capture statistics |
| `crates/media` | Media probing, thumbnails, MP4 export and recovery through FFmpeg/FFprobe |
| `apps/desktop` | Tauri commands, tray, global shortcuts, file dialogs and window lifecycle |
| `ui` | Static HTML/CSS/JavaScript recording controls and nondestructive editor |

Windows uses Windows Graphics Capture, D3D11 conversion from BGRA to NV12, Media Foundation hardware H.264 and WASAPI audio capture. System audio and microphone are written as separate AAC files.

macOS uses a Swift bridge for ScreenCaptureKit, AVFoundation, VideoToolbox-backed encoding and audio capture. The release combines native arm64 and x86_64 builds into one universal app bundle.

Recordings use fragmented MP4 to allow recovery of complete fragments after interruption. A journal records session state. The editor stores retained source ranges, crop and audio mix in a JSON sidecar; export resolves those ranges, crops the frame and mixes enabled tracks into a separate MP4.

The Tauri interface uses the system WebView rather than bundling a browser. Video decoding and filmstrip thumbnails are requested by the editor. The thumbnail cache is bounded to 48 frames, with at most 24 thumbnails per pass. Capture cost still depends on resolution, frame rate, audio, drivers and screen content.

Global shortcuts are registered by the native shell. Shortcut assignment temporarily routes existing app shortcuts to the picker to prevent accidental capture. Duplicate assignments are rejected, and a failed registration restores previous bindings.
