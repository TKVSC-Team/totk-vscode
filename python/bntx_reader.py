"""Read-only BNTX (Binary NX TeXture) container support.

Lists texture names and extracts raw (swizzled) texture data from .bntx files.
All Int64 pointer fields store absolute file offsets (not self-relative).
"""

import struct
import sys

_BNTX_MAGIC = b'BNTX\x00\x00\x00\x00'
_BRTI_MAGIC = b'BRTI'


def _log(msg: str) -> None:
    print(f'[bntx] {msg}', file=sys.stderr)


def is_bntx(data: bytes) -> bool:
    return len(data) >= 8 and data[:8] == _BNTX_MAGIC


def _read_i64(data: bytes, offset: int, le: bool) -> int:
    fmt = '<q' if le else '>q'
    return struct.unpack_from(fmt, data, offset)[0]


def _read_i32(data: bytes, offset: int, le: bool) -> int:
    fmt = '<i' if le else '>i'
    return struct.unpack_from(fmt, data, offset)[0]


def _read_u32(data: bytes, offset: int, le: bool) -> int:
    fmt = '<I' if le else '>I'
    return struct.unpack_from(fmt, data, offset)[0]


def _read_u16(data: bytes, offset: int, le: bool) -> int:
    fmt = '<H' if le else '>H'
    return struct.unpack_from(fmt, data, offset)[0]


def _read_cstring(data: bytes, offset: int) -> str:
    if offset < 0 or offset >= len(data):
        return ''
    end = data.find(b'\x00', offset)
    if end < 0:
        end = min(offset + 256, len(data))
    return data[offset:end].decode('utf-8', errors='replace')


class BntxTexture:
    """Minimal parsed texture metadata."""
    __slots__ = ('name', 'width', 'height', 'format_id', 'mip_count',
                 'data_offset', 'data_size')

    def __init__(self, name: str, width: int, height: int, format_id: int,
                 mip_count: int, data_offset: int, data_size: int):
        self.name = name
        self.width = width
        self.height = height
        self.format_id = format_id
        self.mip_count = mip_count
        self.data_offset = data_offset
        self.data_size = data_size


def _parse_textures(data: bytes) -> list[BntxTexture]:
    file_len = len(data)
    if file_len < 0x58:
        _log(f'File too small ({file_len} bytes)')
        return []
    if data[:8] != _BNTX_MAGIC:
        _log(f'Bad magic: {data[:8]!r}')
        return []

    bom_bytes = data[0x0C:0x0E]
    le = bom_bytes == b'\xFF\xFE'
    _log(f'BNTX {file_len} bytes, {"LE" if le else "BE"} (BOM {bom_bytes.hex()})')

    target = data[0x20:0x24]
    _log(f'Target platform: {target!r}')

    tex_count = _read_i32(data, 0x24, le)
    _log(f'Texture count: {tex_count}')
    if tex_count <= 0:
        return []

    info_ptrs_addr = _read_i64(data, 0x28, le)
    _log(f'InfoPtrsAddr: 0x{info_ptrs_addr:X}')

    if info_ptrs_addr < 0 or info_ptrs_addr + 8 * tex_count > file_len:
        _log(f'InfoPtrsAddr out of range (file is {file_len} bytes)')
        return []

    textures: list[BntxTexture] = []
    for i in range(tex_count):
        ptr_offset = info_ptrs_addr + 8 * i
        brti_abs = _read_i64(data, ptr_offset, le)
        _log(f'  Texture {i}: BRTI at 0x{brti_abs:X}')

        if brti_abs < 0 or brti_abs + 0x70 > file_len:
            _log(f'  Texture {i}: BRTI offset out of range, skipping')
            continue
        if data[brti_abs:brti_abs + 4] != _BRTI_MAGIC:
            _log(f'  Texture {i}: Bad BRTI magic {data[brti_abs:brti_abs + 4]!r}, skipping')
            continue

        # TextureInfo data starts after the 16-byte block header
        d = brti_abs + 0x10

        mip_count = _read_u16(data, d + 0x06, le)
        format_id = _read_u32(data, d + 0x0C, le)
        width = _read_i32(data, d + 0x14, le)
        height = _read_i32(data, d + 0x18, le)
        image_size = _read_u32(data, d + 0x40, le)

        name_addr = _read_i64(data, d + 0x50, le)
        _log(f'  Texture {i}: nameAddr=0x{name_addr:X}, {width}x{height}, fmt=0x{format_id:04X}')

        if 0 < name_addr < file_len:
            # name_addr points to string-table entry: UInt16 length prefix + null-terminated string
            name = _read_cstring(data, name_addr + 2)
        else:
            name = f'texture_{i}'
            _log(f'  Texture {i}: nameAddr out of range, using fallback name')

        ptrs_addr = _read_i64(data, d + 0x60, le)
        if 0 < ptrs_addr < file_len:
            first_mip_offset = _read_i64(data, ptrs_addr, le)
        else:
            first_mip_offset = 0

        _log(f'  Texture {i}: name={name!r}')

        textures.append(BntxTexture(
            name=name,
            width=width,
            height=height,
            format_id=format_id,
            mip_count=mip_count,
            data_offset=first_mip_offset,
            data_size=image_size,
        ))

    _log(f'Parsed {len(textures)} textures')
    return textures


def list_textures(data: bytes) -> list[str]:
    """Return a list of texture names inside a BNTX buffer."""
    return [t.name for t in _parse_textures(data)]


def read_texture_data(data: bytes, texture_name: str) -> bytes:
    """Return the raw (swizzled) image bytes for a named texture."""
    for tex in _parse_textures(data):
        if tex.name == texture_name:
            if tex.data_offset <= 0 or tex.data_size <= 0:
                raise ValueError(f'Texture {texture_name!r} has no extractable data')
            return data[tex.data_offset:tex.data_offset + tex.data_size]
    raise FileNotFoundError(f'Texture not found in BNTX: {texture_name!r}')
