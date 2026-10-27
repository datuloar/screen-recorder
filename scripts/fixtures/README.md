# Browser video fixture

`browser.mp4` is synthetic test data: four seconds of 640×360 H.264 at 30 FPS, with a 440 Hz AAC audio track. It contains no captured desktop or personal information. The browser checks use it for decoding, playback, thumbnails and editing interactions.

Generate it on Windows with an FFmpeg development build that includes Media Foundation and lavfi:

```sh
ffmpeg -f lavfi -i testsrc2=size=640x360:rate=30 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 4 -c:v h264_mf -hw_encoding 1 -b:v 512k -pix_fmt nv12 -c:a aac -b:a 64k -movflags +faststart browser.mp4
```

On macOS, use `-c:v h264_videotoolbox` in place of `-c:v h264_mf -hw_encoding 1`. The release media tools do not need the fixture-generation source filters. This file is test input and is excluded from application packages.
