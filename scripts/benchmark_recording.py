"""Measure native recording on Windows; this does not measure UI, GPU or game impact."""
import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import time


class MemoryCounters(ctypes.Structure):
    _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
        (name, ctypes.c_size_t) for name in (
            "PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage",
            "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage",
            "PagefileUsage", "PeakPagefileUsage",
        )
    ]


def benchmark(app, probe, output, fps, duration, size):
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel.GetProcessTimes.restype = wintypes.BOOL
    psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(MemoryCounters), wintypes.DWORD]
    psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
    started = time.perf_counter()
    process = subprocess.Popen(
        [str(app), "--record-test", str(output), str(duration), "--fps", str(fps), "--size", size],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW,
    )
    handle = wintypes.HANDLE(int(process._handle))
    peak_memory = 0
    try:
        while process.poll() is None:
            counters = MemoryCounters()
            counters.cb = ctypes.sizeof(counters)
            if psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
                peak_memory = max(peak_memory, counters.PeakWorkingSetSize)
            if time.perf_counter() - started > duration + 40:
                raise TimeoutError("Recorder did not finish")
            time.sleep(0.1)
        elapsed = time.perf_counter() - started
        times = [wintypes.FILETIME() for _ in range(4)]
        if not kernel.GetProcessTimes(handle, *(ctypes.byref(value) for value in times)):
            raise ctypes.WinError(ctypes.get_last_error())
        cpu_seconds = sum((value.dwHighDateTime << 32) + value.dwLowDateTime for value in times[2:]) / 10_000_000
        stdout, stderr = process.communicate(timeout=5)
        if process.returncode:
            raise RuntimeError(stderr.decode(errors="replace"))
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate()
    metadata = json.loads(subprocess.check_output([
        str(probe), "-v", "error", "-count_frames", "-show_streams", "-of", "json", str(output),
    ]))
    video = next(stream for stream in metadata["streams"] if stream["codec_type"] == "video")
    return {
        "requested_fps": fps, "requested_seconds": duration, "size": size,
        "wall_seconds": round(elapsed, 3), "cpu_seconds": round(cpu_seconds, 3),
        "cpu_percent_one_core": round(cpu_seconds / elapsed * 100, 2),
        "cpu_percent_machine": round(cpu_seconds / elapsed / (os.cpu_count() or 1) * 100, 2),
        "peak_working_set_mib": round(peak_memory / 1024**2, 2),
        "video_duration": video["duration"], "video_fps": video["avg_frame_rate"],
        "video_bit_rate": video.get("bit_rate"), "requested_bit_rate": 8_000_000,
        "decoded_frames": video["nb_read_frames"], "bytes": output.stat().st_size,
        "recorder_output": stdout.decode(errors="replace").strip(),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--ffprobe", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seconds", type=int, choices=range(1, 61), default=20)
    parser.add_argument("--size", default="1920x1080")
    args = parser.parse_args()
    if platform.system() != "Windows":
        raise SystemExit("This benchmark measures Windows process counters")
    args.output.mkdir(parents=True, exist_ok=False)
    with args.app.open("rb") as binary:
        binary_digest = hashlib.file_digest(binary, "sha256").hexdigest()
    report = {"binary_sha256": binary_digest, "system": platform.platform(), "processor": platform.processor(),
              "logical_processors": os.cpu_count(), "scope": "Native video capture only; no UI or audio; observed desktop workload", "runs": []}
    for rate in (30, 60):
        result = benchmark(args.app.resolve(), args.ffprobe.resolve(), args.output.resolve() / f"capture-{rate}.mp4", rate, args.seconds, args.size)
        report["runs"].append(result)
        (args.output / "results.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False), flush=True)
