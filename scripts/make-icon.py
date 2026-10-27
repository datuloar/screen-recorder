"""Build the temporary recording glyph used by the Windows executable."""
from pathlib import Path
import struct

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
