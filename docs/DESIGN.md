# Design

Screen Recorder is a small desktop recording and editing tool. Its owner requested Lightshot-style area selection, mouse-based editing, and the warm, restrained visual language of Claude Code. The interface uses that color direction with native-style controls and layouts built around screen recording.

Design read: a desktop creative utility for people making short recordings, with warm solid surfaces, clear text and direct manipulation. ENERGY 1 / RHYTHM 1 / MOTION 1.

| Decision | Reason |
| --- | --- |
| Warm paper and charcoal surfaces | Follow the requested direction while keeping long editing sessions readable |
| Terracotta primary action | Identify recording and export without coloring every control |
| System typeface | Keep labels familiar and avoid shipping a font or a decorative terminal style |
| Tabular numbers | Keep clocks and time positions stable as values change |
| Preview, timeline, optional tools | Keep direct editing close to the video; secondary tools follow on narrow windows |
| Export in the editor heading | Keep the final action visible without opening or scrolling the inspector |
| Minimum 220 px preview height on wide windows | Prevent ordinary laptop heights from reducing video to a thumbnail |
| Collapsible exact coordinates and tools | Preserve precision without making numeric input the normal workflow |
| Rectangular capture outline | Repeat the actual shape being selected as the interface's main visual motif |
| 44 px controls and visible focus | Support pointer accuracy, touch and keyboard access |
| Solid panels, small radii and one menu shadow | Separate work areas; reserve elevation for a transient context menu |
| No decorative motion | Let playback, progress and real recording state carry the movement |

Light, dark and system appearance share the same roles. Selection and crop outlines use a high-contrast boundary because they can cross arbitrary video content. State is always named in text. The current recording circle is a functional app/tray symbol, not a separate brand illustration.

The frontend reflows at content widths of 980 and 700 CSS pixels. Below the wide layout, video, timeline and tools follow in that order. Text can grow to 200%; long paths and errors wrap. Keyboard alternatives cover direct area selection, crop and timeline adjustments.
