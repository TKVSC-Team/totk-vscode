"""Rebuild Nintendo BARS archives with replaced BWAV entries.

BARS layout (little endian, version 1.2 as shipped with TOTK):
  0x00  4  "BARS"
  0x04  4  file size
  0x08  2  BOM
  0x0A  2  version
  0x0C  4  asset count
  0x10     asset name CRC32 hash table (u32 * count, sorted ascending)
  ....     offset pair table (amta_offset u32 + bwav_offset s32, per asset,
           in hash-table order; bwav offset may be -1/0 for stream-only)
  ....     AMTA blocks (packed, unaligned)
  ....     BWAV blocks (each 0x40-aligned, zero padding between)

Everything before the BWAV region (header, hash table, pair table, AMTA
blocks and padding) is preserved verbatim — those offsets never move. BWAV
blocks are sized by the distance to the next block (or end of file), so any
padding or reserved space the original tool left is carried over unchanged.
With no replacements the output is byte-identical to the input.
"""

from __future__ import annotations

import struct

_BARS_MAGIC = b"BARS"
_BWAV_MAGIC = b"BWAV"


def _u32(data: bytes, offset: int) -> int:
    return struct.unpack_from("<I", data, offset)[0]


def _i32(data: bytes, offset: int) -> int:
    return struct.unpack_from("<i", data, offset)[0]


def _align(value: int, alignment: int) -> int:
    return (value + alignment - 1) // alignment * alignment


def rebuild_bars(data: bytes, replacements: dict[int, bytes]) -> bytes:
    """Rebuild a (decompressed) BARS file, replacing the embedded BWAV blocks
    of the entry indices given in ``replacements`` (index -> new BWAV bytes).
    """
    if data[:4] != _BARS_MAGIC:
        raise ValueError(f"Not a BARS file (got magic {data[:4]!r})")

    count = _u32(data, 0xC)
    pairs_start = 0x10 + count * 4

    entries: list[tuple[int, int]] = []  # (amta_offset, raw bwav offset)
    for i in range(count):
        amta = _u32(data, pairs_start + i * 8)
        bwav = _i32(data, pairs_start + i * 8 + 4)
        entries.append((amta, bwav))

    for idx, blob in replacements.items():
        if idx < 0 or idx >= count:
            raise IndexError(f"Entry index {idx} out of range (BARS has {count} entries)")
        if blob[:4] != _BWAV_MAGIC:
            raise ValueError(f"Replacement for entry {idx} is not a BWAV")
        orig = entries[idx][1]
        if orig in (-1, 0):
            raise ValueError(
                f"Entry {idx} has no embedded BWAV to replace "
                "(stream-only entry; replace the romfs .bwav instead)"
            )

    # Unique BWAV block offsets in ascending order. Blocks are sized by the
    # distance to the next block (or end of file) so original padding and any
    # unreferenced data between blocks are preserved verbatim.
    bwav_order = sorted({b for _, b in entries if b not in (-1, 0)})
    if not bwav_order:
        return bytes(data) if not replacements else _raise_no_bwavs()

    region_start = bwav_order[0]
    blobs: dict[int, bytes] = {}
    for off, nxt in zip(bwav_order, bwav_order[1:] + [len(data)]):
        if data[off : off + 4] != _BWAV_MAGIC:
            raise ValueError(f"No BWAV magic at offset {off:#x}")
        blobs[off] = data[off:nxt]

    # Apply replacements. Entries sharing an original block share the new one.
    replaced = set()
    for idx, blob in replacements.items():
        orig = entries[idx][1]
        blobs[orig] = blob
        replaced.add(orig)

    # Lay out the BWAV region. Untouched blocks keep their original (already
    # aligned, padding-included) bytes; replaced blocks get zero padding up to
    # the next 0x40 boundary.
    new_offsets: dict[int, int] = {}
    region = bytearray()
    for off in bwav_order:
        pad = _align(region_start + len(region), 0x40) - (region_start + len(region))
        region += b"\x00" * pad
        new_offsets[off] = region_start + len(region)
        region += blobs[off]

    out = bytearray(data[:region_start])
    out += region
    struct.pack_into("<I", out, 0x4, len(out))
    for i, (_, bwav) in enumerate(entries):
        if bwav not in (-1, 0):
            struct.pack_into("<i", out, pairs_start + i * 8 + 4, new_offsets[bwav])
    return bytes(out)


def _raise_no_bwavs():
    raise ValueError("BARS has no embedded BWAV blocks to replace")
