# Using Screen Recorder

## Language

The default language is **Automatic (system)**. Screen Recorder uses the Windows UI language or the first macOS preferred language: Russian for `ru` locales, English for other languages. Existing settings adopt this default without resetting your recording preferences.

To override it, open **Settings → Language**, choose **Русский**, **English** or **Automatic (system)**, then save settings. The interface and tray menu update without restarting. Language affects the main window, screen-area selection, floating controls and editor. Source filenames, paths and device names are preserved. Technical diagnostics from system codecs can remain in their original language.

## Recording

1. Select a display and choose **Select area**, or press **Ctrl+Shift+F9**.
2. Drag across the screen. Move the area or resize its handles as needed.
3. Press **Enter** or **Record area** to start. **Use area** returns to the main window so you can change settings first.
4. Use **Stop and save** or **Ctrl+Shift+F10** to finish. **Ctrl+Shift+F11** pauses or resumes.

Escape cancels area selection and the countdown. While selecting an area, arrow keys move it by one pixel, Shift increases the step, and Alt + arrow keys resize it. Exact coordinates are available for occasional precise adjustments.

Print Screen is free by default so another screenshot tool can keep using it. Assign it in Settings if available. Click a shortcut, press the new combination, then save settings. Escape cancels shortcut input. Duplicate shortcuts and combinations registered by other apps show an error.

FPS, target bitrate, cursor, countdown and audio devices are configured in Settings. Hardware encoding uses variable bitrate, so file size depends on movement and screen content. Higher settings can increase capture cost and file size.

## Floating controls

The main window hides when recording begins. The floating panel shows elapsed recorded time, pause, stop and expand. Paused time is excluded. Closing the panel expands the main window without stopping; **Compact controls** opens the panel again.

## Editing with the mouse

Click the ruler to place the playhead. Drag across the clips to select a range; drag either selection handle to refine it. Clicking a clip selects that clip. The ruler shows time in the edited video; clip captions show times in the source.

- **Delete selection** removes the selected part and closes the gap.
- **Keep selection** retains only the selected range.
- **Split at playhead** divides a clip without deleting anything.
- **Preview selection** plays the selected range and stops at its end.
- **Loop** repeats that range during selection preview. Turn it off to stop at the next end, or press Pause to stop immediately. Changing or clearing the selection pauses playback.
- **Export selection** saves that range as a separate MP4 without changing the full edit.

Snap aligns selection edges with cuts and the playhead. Hold Alt to disable it temporarily. Ctrl/Command + wheel zooms around the pointer. **Fit** shows the entire edit; **Selection** fits the selected range. Dragging near a zoomed timeline edge scrolls it. Right-click or Shift+F10 opens edit commands.

**Preview speed** offers 0.5×, 1×, 1.5× and 2× playback, including audio. Export keeps the video's original speed. During playback, a zoomed timeline scrolls to keep the playhead visible.

Double-click the preview or choose **Crop video** to draw a crop over the frame. Move or resize it, then choose **Apply**. **Reset crop** restores the full image. Crop, range edits and audio changes support Undo and Redo.

| Editor shortcut | Action |
| --- | --- |
| Space | Play or pause |
| Left / Right | Previous or next frame |
| Shift + Left / Right | Move 10 frames |
| S | Split at playhead |
| I / O | Set selection start or end |
| Delete / Backspace | Delete selection |
| Escape | Clear selection or close a dialog |
| Home / End | Video start or end |
| Ctrl/Command + A | Select the entire edit |
| Ctrl/Command + S | Save project |
| Ctrl/Command + Shift + S | Export MP4 |
| Ctrl/Command + Z | Undo |
| Ctrl/Command + Shift + Z | Redo |

Shortcuts use physical keys, including when another keyboard layout is active. Timeline selection handles also support arrow keys, Home and End.

## Files and recovery

Each recording has its own folder containing `source.mp4`, `session.json`, optional `source.system.m4a` and `source.microphone.m4a`, and a `source.recorder.json` project. Keep the folder together when moving a project. All recordings stay local; no account is required.

The editor saves changes beside the source. If saving fails, it preserves current edits and offers **Retry save**. You can still export those edits to another folder. Export refuses to overwrite an existing file.

Recordings lists the latest 100 recording folders. Interrupted recordings offer **Recover copy**, which writes a separate MP4 from complete fragments. The final incomplete fragment can be lost. Damaged audio does not prevent recovery of valid video. Keep the original folder until you have checked the result.

`--open PATH` opens a video or passes it to the running instance. `--background` starts in the tray. `--version` prints the application version.

## Known limits

Hardware H.264 encoding is required for Windows recording. Preview depends on the system WebView and media decoders. With multiple audio streams embedded in an imported video, preview plays the first stream; export mixes all enabled tracks. Multimonitor DPI combinations, long recording sessions and physical macOS capture need wider testing.
