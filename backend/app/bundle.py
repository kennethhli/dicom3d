"""Length-prefixed container for shipping many DICOM files in one response.

Layout (little-endian):
    4 bytes  magic  b"D3DB"
    uint32   version (1)
    uint32   file count N
    N x { uint32 byte length L, L bytes of a DICOM Part 10 file }
"""

from __future__ import annotations

import struct
from collections.abc import Iterable

MAGIC = b"D3DB"
VERSION = 1
MEDIA_TYPE = "application/vnd.dicom3d.bundle"


def encode_bundle(files: Iterable[bytes]) -> bytes:
    items = list(files)
    parts = [MAGIC, struct.pack("<II", VERSION, len(items))]
    for item in items:
        parts.append(struct.pack("<I", len(item)))
        parts.append(item)
    return b"".join(parts)


def decode_bundle(payload: bytes) -> list[bytes]:
    if payload[:4] != MAGIC:
        raise ValueError("not a DICOM3D bundle")
    version, count = struct.unpack_from("<II", payload, 4)
    if version != VERSION:
        raise ValueError(f"unsupported bundle version {version}")
    offset = 12
    out: list[bytes] = []
    for _ in range(count):
        (length,) = struct.unpack_from("<I", payload, offset)
        offset += 4
        out.append(payload[offset : offset + length])
        offset += length
    return out
