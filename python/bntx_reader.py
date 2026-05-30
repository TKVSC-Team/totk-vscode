"""Read-only BNTX (Binary NX TeXture) container support.

Lists texture names and extracts raw (swizzled) texture data from .bntx files.
All Int64 pointer fields store absolute file offsets (not self-relative).
"""

import struct
import sys

_BNTX_MAGIC = b"BNTX\x00\x00\x00\x00"
_BRTI_MAGIC = b"BRTI"


def _log(msg: str) -> None:
    print(f"[bntx] {msg}", file=sys.stderr)


def is_bntx(data: bytes) -> bool:
    return len(data) >= 8 and data[:8] == _BNTX_MAGIC


def _read_i64(data: bytes, offset: int, le: bool) -> int:
    fmt = "<q" if le else ">q"
    return struct.unpack_from(fmt, data, offset)[0]


def _read_i32(data: bytes, offset: int, le: bool) -> int:
    fmt = "<i" if le else ">i"
    return struct.unpack_from(fmt, data, offset)[0]


def _read_u32(data: bytes, offset: int, le: bool) -> int:
    fmt = "<I" if le else ">I"
    return struct.unpack_from(fmt, data, offset)[0]


def _read_u16(data: bytes, offset: int, le: bool) -> int:
    fmt = "<H" if le else ">H"
    return struct.unpack_from(fmt, data, offset)[0]


def _format_channel(ch: int) -> str:
    mapping = {0: "Zero", 1: "One", 2: "Red", 3: "Green", 4: "Blue", 5: "Alpha"}
    return mapping.get(ch, "Red")


def _read_bntx_string(data: bytes, offset: int, le: bool) -> str:
    if offset < 0 or offset >= len(data):
        return ""

    # If the pointer is literally pointing at the NX block header, it's an empty Nintendo string
    if data[offset:offset+3] == b"NX ":
        return ""

    # Try reading as a length-prefixed string (Switch Toolbox style)
    if offset + 2 <= len(data):
        str_len = _read_u16(data, offset, le)
        # Check if length is reasonable and null-terminated exactly at the end
        if 0 <= str_len <= 256 and offset + 2 + str_len < len(data):
            if data[offset + 2 + str_len] == 0:
                return data[offset + 2 : offset + 2 + str_len].decode("utf-8", errors="replace")

    # Fallback: treat as a standard C-string starting at offset
    end = data.find(b"\x00", offset)
    if end < 0:
        end = min(offset + 256, len(data))
    return data[offset:end].decode("utf-8", errors="replace")

class BntxTexture:
    """Parsed texture metadata matching Switch Toolbox's property set."""

    __slots__ = (
        "name",
        "path",
        "width",
        "height",
        "format_id",
        "mip_count",
        "data_offset",
        "data_size",
        "tile_mode",
        "block_height_log2",
        "depth",
        "flags",
        "dims",
        "swizzle",
        "sample_count",
        "access_flags",
        "array_count",
        "alignment",
        "channel_r",
        "channel_g",
        "channel_b",
        "channel_a",
        "pitch",
        "image_size",
    )

    def __init__(
        self,
        name: str,
        path: str,
        width: int,
        height: int,
        format_id: int,
        mip_count: int,
        data_offset: int,
        data_size: int,
        tile_mode: int = 0,
        block_height_log2: int = 4,
        depth: int = 1,
        flags: int = 0,
        dims: int = 2,
        swizzle: int = 0,
        sample_count: int = 1,
        access_flags: int = 0,
        array_count: int = 1,
        alignment: int = 512,
        channel_r: int = 0,
        channel_g: int = 0,
        channel_b: int = 0,
        channel_a: int = 0,
        pitch: int = 0,
        image_size: int = 0,
    ):
        self.name = name
        self.path = path
        self.width = width
        self.height = height
        self.format_id = format_id
        self.mip_count = mip_count
        self.data_offset = data_offset
        self.data_size = data_size
        self.tile_mode = tile_mode
        self.block_height_log2 = block_height_log2
        self.depth = depth
        self.flags = flags
        self.dims = dims
        self.swizzle = swizzle
        self.sample_count = sample_count
        self.access_flags = access_flags
        self.array_count = array_count
        self.alignment = alignment
        self.channel_r = channel_r
        self.channel_g = channel_g
        self.channel_b = channel_b
        self.channel_a = channel_a
        self.pitch = pitch
        self.image_size = image_size


def _parse_textures(data: bytes) -> list[BntxTexture]:
    file_len = len(data)
    if file_len < 0x58:
        _log(f"File too small ({file_len} bytes)")
        return []
    if data[:8] != _BNTX_MAGIC:
        _log(f"Bad magic: {data[:8]!r}")
        return []

    bom_bytes = data[0x0C:0x0E]
    le = bom_bytes == b"\xff\xfe"
    _log(f"BNTX {file_len} bytes, {'LE' if le else 'BE'} (BOM {bom_bytes.hex()})")

    target = data[0x20:0x24]
    _log(f"Target platform: {target!r}")

    tex_count = _read_i32(data, 0x24, le)
    _log(f"Texture count: {tex_count}")
    if tex_count <= 0:
        return []

    info_ptrs_addr = _read_i64(data, 0x28, le)
    _log(f"InfoPtrsAddr: 0x{info_ptrs_addr:X}")

    if info_ptrs_addr < 0 or info_ptrs_addr + 8 * tex_count > file_len:
        _log(f"InfoPtrsAddr out of range (file is {file_len} bytes)")
        return []

    textures: list[BntxTexture] = []
    for i in range(tex_count):
        ptr_offset = info_ptrs_addr + 8 * i
        brti_abs = _read_i64(data, ptr_offset, le)
        _log(f"  Texture {i}: BRTI at 0x{brti_abs:X}")

        if brti_abs < 0 or brti_abs + 0x70 > file_len:
            _log(f"  Texture {i}: BRTI offset out of range, skipping")
            continue
        if data[brti_abs : brti_abs + 4] != _BRTI_MAGIC:
            _log(f"  Texture {i}: Bad BRTI magic {data[brti_abs : brti_abs + 4]!r}, skipping")
            continue

        # TextureInfo data starts after the 16-byte block header
        d = brti_abs + 0x10

        flags = data[d + 0x00] if d < file_len else 0
        dims = data[d + 0x01] if d + 1 < file_len else 2
        tile_mode = _read_u16(data, d + 0x02, le)
        swizzle = _read_u16(data, d + 0x04, le)
        mip_count = _read_u16(data, d + 0x06, le)
        sample_count = _read_u16(data, d + 0x08, le)
        format_id = _read_u32(data, d + 0x0C, le)
        access_flags = _read_u32(data, d + 0x10, le)
        width = _read_i32(data, d + 0x14, le)
        height = _read_i32(data, d + 0x18, le)
        depth = _read_i32(data, d + 0x1C, le)
        array_count = _read_i32(data, d + 0x20, le)
        layout = _read_u32(data, d + 0x24, le)
        block_height_log2 = layout & 0x07
        image_size = _read_u32(data, d + 0x40, le)
        alignment = _read_u32(data, d + 0x44, le)

        # Channel sources: 5 bytes at d+0x48 (R, G, B, A, padding)
        ch_r = data[d + 0x48] if d + 0x48 < file_len else 0
        ch_g = data[d + 0x49] if d + 0x49 < file_len else 0
        ch_b = data[d + 0x4A] if d + 0x4A < file_len else 0
        ch_a = data[d + 0x4B] if d + 0x4B < file_len else 0

        pitch = 0
        if tile_mode == 1 and width > 0:
            (format_id >> 8) & 0xFF
            fmt_bpp_lookup = {
                0x01: 1,
                0x02: 1,
                0x03: 2,
                0x04: 2,
                0x05: 2,
                0x06: 2,
                0x07: 2,
                0x08: 2,
                0x09: 2,
                0x0B: 4,
                0x0C: 4,
                0x0E: 4,
            }
            pixel_bpp = fmt_bpp_lookup.get(format_id >> 8, 4)
            pitch = width * pixel_bpp

        name_addr = _read_i64(data, d + 0x50, le)
        _log(f"  Texture {i}: nameAddr=0x{name_addr:X}, {width}x{height}, fmt=0x{format_id:04X}")

        if 0 < name_addr < file_len:
            name = _read_bntx_string(data, name_addr, le)
        else:
            name = f"texture_{i}"
            _log(f"  Texture {i}: nameAddr out of range, using fallback name")

        path_addr = _read_i64(data, d + 0x58, le)
        if 0 < path_addr < file_len:
            path = _read_bntx_string(data, path_addr, le)
        else:
            path = ""

        ptrs_addr = _read_i64(data, d + 0x60, le)
        if 0 < ptrs_addr < file_len:
            first_mip_offset = _read_i64(data, ptrs_addr, le)
        else:
            first_mip_offset = 0

        _log(f"  Texture {i}: name={name!r}")

        textures.append(
            BntxTexture(
                name=name,
                path=path,
                width=width,
                height=height,
                format_id=format_id,
                mip_count=mip_count,
                data_offset=first_mip_offset,
                data_size=image_size,
                tile_mode=tile_mode,
                block_height_log2=block_height_log2,
                depth=depth,
                flags=flags,
                dims=dims,
                swizzle=swizzle,
                sample_count=sample_count,
                access_flags=access_flags,
                array_count=array_count,
                alignment=alignment,
                channel_r=ch_r,
                channel_g=ch_g,
                channel_b=ch_b,
                channel_a=ch_a,
                pitch=pitch,
                image_size=image_size,
            )
        )

    _log(f"Parsed {len(textures)} textures")
    return textures


def list_textures(data: bytes) -> list[str]:
    """Return a list of texture names inside a BNTX buffer."""
    return [t.name for t in _parse_textures(data)]


def read_texture_data(data: bytes, texture_name: str) -> bytes:
    """Return the raw (swizzled) image bytes for a named texture."""
    for tex in _parse_textures(data):
        if tex.name == texture_name:
            if tex.data_offset <= 0 or tex.data_size <= 0:
                raise ValueError(f"Texture {texture_name!r} has no extractable data")
            return data[tex.data_offset : tex.data_offset + tex.data_size]
    raise FileNotFoundError(f"Texture not found in BNTX: {texture_name!r}")
"""BNTX (Binary NX TeXture) container editor."""



def bit_length(n: int) -> int:
    return n.bit_length()

