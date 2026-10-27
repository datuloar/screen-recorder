#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
source_dir="$root/vendor/ffmpeg-8.0"
prefix="$root/vendor/media"
case "${RUNNER_OS:-$(uname -s)}" in
    Windows|MINGW*|MSYS*) windows_build=1 ;;
    macOS|Darwin) windows_build=0 ;;
    *) echo "FFmpeg packaging supports Windows and macOS" >&2; exit 1 ;;
esac
cd "$source_dir"
args=(
    --prefix="$prefix" --disable-doc --disable-debug --disable-shared --enable-static
    --disable-autodetect --disable-everything --disable-x86asm --disable-network
    --enable-ffmpeg --enable-ffprobe --enable-swscale --enable-swresample
    --enable-protocol=file,pipe
    --enable-demuxer=mov,matroska,wav,avi
    --enable-decoder=h264,hevc,aac,pcm_s16le,pcm_f32le,prores,mpeg4,vp9,av1
    --enable-encoder=aac,rawvideo,mpeg4
    --enable-parser=h264,hevc,aac,mpeg4video,vp9,av1
    --enable-muxer=mp4,mov,rawvideo,wav
    --enable-filter=scale,format,trim,atrim,setpts,asetpts,concat,anull,volume,amix,aresample,anullsrc,fps,crop,setsar,null,aformat,apad,alimiter,asplit
)
if [[ "$windows_build" == 1 ]]; then
    args+=(--target-os=mingw32 --arch=x86_64 --enable-w32threads --enable-mediafoundation --enable-d3d11va --enable-encoder=h264_mf '--extra-ldflags=-static -static-libgcc')
else
    args+=(--enable-videotoolbox --enable-audiotoolbox --enable-encoder=h264_videotoolbox --extra-cflags=-mmacosx-version-min=14.0 --extra-ldflags=-mmacosx-version-min=14.0)
fi
printf '%q ' ./configure "${args[@]}" > "$root/vendor/ffmpeg-configure.txt"
printf '\n' >> "$root/vendor/ffmpeg-configure.txt"
./configure "${args[@]}"
make -j 3
make install
if [[ "$windows_build" == 1 ]]; then
    for runtime in crt headers libgcc libwinpthread; do
        mkdir -p "$prefix/licenses/$runtime"
        cp -R "${MINGW_PREFIX:?}/share/licenses/$runtime/." "$prefix/licenses/$runtime/"
    done
fi
