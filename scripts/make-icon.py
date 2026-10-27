"""Build the recording glyph used by the desktop application."""
from pathlib import Path
import struct
import zlib

size = 32
pixels = bytearray()
for y in reversed(range(size)):
    for x in range(size):
        pixels.extend((53, 46, 181, 255) if (x - 15.5) ** 2 + (y - 15.5) ** 2 < 144 else (0, 0, 0, 0))
bitmap = struct.pack("<IIIHHIIIIII", 40, size, size * 2, 1, 32, 0, len(pixels), 0, 0, 0, 0)
bitmap += pixels + bytes(size * 4)
icon = struct.pack("<HHH", 0, 1, 1) + struct.pack("<BBBBHHII", size, size, 0, 0, 1, 32, len(bitmap), 22) + bitmap
path = Path(__file__).resolve().parents[1] / "apps/desktop/icons/icon.ico"
path.parent.mkdir(parents=True, exist_ok=True)
path.write_bytes(icon)


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


rows = bytearray()
for y in range(size):
    rows.append(0)
    for x in range(size):
        offset = ((size - 1 - y) * size + x) * 4
        blue, green, red, alpha = pixels[offset:offset + 4]
        rows.extend((red, green, blue, alpha))
png = b"\x89PNG\r\n\x1a\n"
png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(rows, level=9))
png += chunk(b"IEND", b"")
path.with_suffix(".png").write_bytes(png)
