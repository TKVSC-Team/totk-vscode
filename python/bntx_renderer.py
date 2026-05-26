"""Render BNTX textures to PNG files.

Pipeline: parse BNTX → deswizzle (block-linear) → decode (BCn/ASTC/raw) → PNG.
Uses texture2ddecoder for BCn/ASTC and Pillow for PNG output.
Deswizzle uses a pure-Python Tegra X1 block-linear implementation.
"""

import os
import sys
import tempfile

from bntx_reader import _parse_textures, _log

# ---------------------------------------------------------------------------
#  Format table: BNTX format_id → (name, bpp, blk_w, blk_h, decoder_key)
#  Format type is in bits 8..15 of the format_id.
# ---------------------------------------------------------------------------
_FORMAT_TABLE: dict[int, tuple[str, int, int, int, str]] = {
    0x01: ('R4G4_UNORM',    1, 1, 1, 'r8'),
    0x02: ('R8_UNORM',      1, 1, 1, 'r8'),
    0x03: ('R4G4B4A4',      2, 1, 1, 'rgba4'),
    0x04: ('A4B4G4R4',      2, 1, 1, 'rgba4'),
    0x05: ('R5G5B5A1',      2, 1, 1, 'rgb565'),
    0x06: ('A1B5G5R5',      2, 1, 1, 'rgb565'),
    0x07: ('R5G6B5_UNORM',  2, 1, 1, 'rgb565'),
    0x08: ('B5G6R5_UNORM',  2, 1, 1, 'rgb565'),
    0x09: ('R8G8_UNORM',    2, 1, 1, 'rg8'),
    0x0B: ('R8G8B8A8',      4, 1, 1, 'rgba8'),
    0x0C: ('B8G8R8A8',      4, 1, 1, 'bgra8'),
    0x0E: ('R10G10B10A2',   4, 1, 1, 'rgba8'),
    0x1A: ('BC1',            8, 4, 4, 'bc1'),
    0x1B: ('BC2',           16, 4, 4, 'bc3'),
    0x1C: ('BC3',           16, 4, 4, 'bc3'),
    0x1D: ('BC4',            8, 4, 4, 'bc4'),
    0x1E: ('BC5',           16, 4, 4, 'bc5'),
    0x1F: ('BC6H',          16, 4, 4, 'bc6'),
    0x20: ('BC7',           16, 4, 4, 'bc7'),
    0x2D: ('ASTC_4x4',     16, 4, 4, 'astc'),
    0x2E: ('ASTC_5x4',     16, 5, 4, 'astc'),
    0x2F: ('ASTC_5x5',     16, 5, 5, 'astc'),
    0x30: ('ASTC_6x5',     16, 6, 5, 'astc'),
    0x31: ('ASTC_6x6',     16, 6, 6, 'astc'),
    0x32: ('ASTC_8x5',     16, 8, 5, 'astc'),
    0x33: ('ASTC_8x6',     16, 8, 6, 'astc'),
    0x34: ('ASTC_8x8',     16, 8, 8, 'astc'),
    0x35: ('ASTC_10x5',    16, 10, 5, 'astc'),
    0x36: ('ASTC_10x6',    16, 10, 6, 'astc'),
    0x37: ('ASTC_10x8',    16, 10, 8, 'astc'),
    0x38: ('ASTC_10x10',   16, 10, 10, 'astc'),
    0x39: ('ASTC_12x10',   16, 12, 10, 'astc'),
    0x3A: ('ASTC_12x12',   16, 12, 12, 'astc'),
    0x3B: ('B5G5R5A1',      2, 1, 1, 'rgb565'),
}

_SRGB_VARIANTS = {0x06}  # variant byte indicating SRGB


def _fmt_info(format_id: int) -> tuple[str, int, int, int, str]:
    key = format_id >> 8
    variant = format_id & 0xFF
    entry = _FORMAT_TABLE.get(key)
    if entry:
        name, bpp, bw, bh, dec = entry
        if variant in _SRGB_VARIANTS:
            name += '_SRGB'
        elif variant == 0x02:
            name += '_SNORM'
        elif variant == 0x01:
            name += '_UNORM'
        return name, bpp, bw, bh, dec
    return (f'Unknown(0x{format_id:04X})', 4, 1, 1, 'unknown')


# ---------------------------------------------------------------------------
#  Pure-Python Tegra X1 block-linear deswizzle
#  Adapted from aboood40091's public implementation.
# ---------------------------------------------------------------------------

def _div_round_up(x: int, d: int) -> int:
    return (x + d - 1) // d


def _round_up(x: int, y: int) -> int:
    return ((x - 1) | (y - 1)) + 1


def _get_addr_block_linear(x: int, y: int, image_width_in_bytes: int, bytes_per_pixel: int, block_height: int) -> int:
    image_width_in_gobs = _div_round_up(image_width_in_bytes, 64)
    gob_address = (
        (y // (8 * block_height)) * 512 * block_height * image_width_in_gobs
        + (x * bytes_per_pixel // 64) * 512 * block_height
        + (y % (8 * block_height) // 8) * 512
    )
    x_byte = x * bytes_per_pixel
    address = gob_address + ((x_byte % 64) // 32) * 256 + ((y % 8) // 2) * 64 + ((x_byte % 32) // 16) * 32 + (y % 2) * 16 + (x_byte % 16)
    return address


def _deswizzle_block_linear(width: int, height: int, blk_w: int, blk_h: int,
                            bpp: int, block_height_log2: int, data: bytes) -> bytes:
    block_height = 1 << block_height_log2
    width_in_blocks = _div_round_up(width, blk_w)
    height_in_blocks = _div_round_up(height, blk_h)

    try:
        from py_tegra_swizzle import deswizzle_block_linear
        _log('Using py_tegra_swizzle (Rust) for deswizzle')
        return deswizzle_block_linear(
            width_in_blocks, height_in_blocks, 1,
            bytes(data), block_height, bpp,
        )
    except ImportError:
        pass

    _log('Using pure-Python deswizzle (may be slow for large textures)')
    pitch = _round_up(width_in_blocks * bpp, 64)

    result = bytearray(width_in_blocks * height_in_blocks * bpp)

    for y in range(height_in_blocks):
        for x in range(width_in_blocks):
            src = _get_addr_block_linear(x, y, pitch, bpp, block_height)
            dst = (y * width_in_blocks + x) * bpp
            if src + bpp <= len(data) and dst + bpp <= len(result):
                result[dst:dst + bpp] = data[src:src + bpp]

    return bytes(result)


def _deswizzle_pitch_linear(width: int, height: int, blk_w: int, blk_h: int,
                            bpp: int, data: bytes) -> bytes:
    width_in_blocks = _div_round_up(width, blk_w)
    height_in_blocks = _div_round_up(height, blk_h)

    pitch = _round_up(width_in_blocks * bpp, 32)
    result = bytearray(width_in_blocks * height_in_blocks * bpp)

    for y in range(height_in_blocks):
        for x in range(width_in_blocks):
            src = y * pitch + x * bpp
            dst = (y * width_in_blocks + x) * bpp
            if src + bpp <= len(data) and dst + bpp <= len(result):
                result[dst:dst + bpp] = data[src:src + bpp]

    return bytes(result)


# ---------------------------------------------------------------------------
#  Decode compressed / raw pixels to RGBA8888
# ---------------------------------------------------------------------------

def _decode_pixels(linear_data: bytes, width: int, height: int,
                   decoder_key: str, blk_w: int, blk_h: int) -> tuple[bytes | None, str]:
    """Decode linear compressed/raw data to pixel bytes.

    Returns (pixel_data, pillow_raw_mode). pixel_data is None on failure.
    texture2ddecoder outputs BGRA; uncompressed formats are returned in their native order.
    """
    pixel_count = width * height

    if decoder_key == 'rgba8':
        return linear_data[:pixel_count * 4], 'RGBA'

    if decoder_key == 'bgra8':
        return linear_data[:pixel_count * 4], 'BGRA'

    if decoder_key == 'r8':
        out = bytearray(pixel_count * 4)
        for i in range(min(pixel_count, len(linear_data))):
            v = linear_data[i]
            off = i * 4
            out[off] = v; out[off + 1] = v; out[off + 2] = v; out[off + 3] = 255
        return bytes(out), 'RGBA'

    if decoder_key == 'rg8':
        out = bytearray(pixel_count * 4)
        for i in range(min(pixel_count, len(linear_data) // 2)):
            r, g = linear_data[i * 2], linear_data[i * 2 + 1]
            off = i * 4
            out[off] = r; out[off + 1] = g; out[off + 2] = 0; out[off + 3] = 255
        return bytes(out), 'RGBA'

    if decoder_key == 'rgb565':
        out = bytearray(pixel_count * 4)
        for i in range(min(pixel_count, len(linear_data) // 2)):
            val = linear_data[i * 2] | (linear_data[i * 2 + 1] << 8)
            r = ((val >> 11) & 0x1F) * 255 // 31
            g = ((val >> 5) & 0x3F) * 255 // 63
            b = (val & 0x1F) * 255 // 31
            off = i * 4
            out[off] = r; out[off + 1] = g; out[off + 2] = b; out[off + 3] = 255
        return bytes(out), 'RGBA'

    try:
        import texture2ddecoder as t2d
    except ImportError:
        _log('texture2ddecoder not installed - cannot decode compressed texture')
        return None, 'BGRA'

    decoded: bytes | None = None
    if decoder_key == 'bc1':
        decoded = t2d.decode_bc1(linear_data, width, height)
    elif decoder_key == 'bc3':
        decoded = t2d.decode_bc3(linear_data, width, height)
    elif decoder_key == 'bc4':
        decoded = _bc4_to_grayscale(t2d.decode_bc4(linear_data, width, height), pixel_count)
        return decoded, 'RGBA'
    elif decoder_key == 'bc5':
        decoded = _bc5_to_normal(t2d.decode_bc5(linear_data, width, height), pixel_count)
        return decoded, 'RGBA'
    elif decoder_key == 'bc6':
        decoded = t2d.decode_bc6(linear_data, width, height)
    elif decoder_key == 'bc7':
        decoded = t2d.decode_bc7(linear_data, width, height)
    elif decoder_key == 'astc':
        decoded = t2d.decode_astc(linear_data, width, height, blk_w, blk_h)

    if decoded is not None:
        return decoded, 'BGRA'
    return None, 'BGRA'


def _bc4_to_grayscale(bgra: bytes, pixel_count: int) -> bytes:
    """BC4 decodes to a single channel in BGRA. Map it to grayscale RGBA."""
    out = bytearray(pixel_count * 4)
    for i in range(min(pixel_count, len(bgra) // 4)):
        v = bgra[i * 4 + 2]  # red channel in BGRA layout (B=0, G=1, R=2, A=3)
        off = i * 4
        out[off] = v; out[off + 1] = v; out[off + 2] = v; out[off + 3] = 255
    return bytes(out)


def _bc5_to_normal(bgra: bytes, pixel_count: int) -> bytes:
    """BC5 decodes to RG channels. Show as normal-map style RGB."""
    out = bytearray(pixel_count * 4)
    for i in range(min(pixel_count, len(bgra) // 4)):
        b, g, r, a = bgra[i*4], bgra[i*4+1], bgra[i*4+2], bgra[i*4+3]
        off = i * 4
        out[off] = r; out[off + 1] = g; out[off + 2] = 255; out[off + 3] = 255
    return bytes(out)


# ---------------------------------------------------------------------------
#  Public API
# ---------------------------------------------------------------------------

_CHANNEL_NAMES = {0: 'Zero', 1: 'One', 2: 'Red', 3: 'Green', 4: 'Blue', 5: 'Alpha'}
_DIM_NAMES = {1: 'Dim1D', 2: 'Dim2D', 3: 'Dim3D', 6: 'DimCube'}
_ACCESS_FLAG_NAMES = {0x20: 'Texture'}


def _channel_name(val: int) -> str:
    return _CHANNEL_NAMES.get(val, f'Unknown({val})')


def _dim_name(val: int) -> str:
    return _DIM_NAMES.get(val, f'Unknown({val})')


def _access_flags_str(val: int) -> str:
    name = _ACCESS_FLAG_NAMES.get(val)
    return name if name else f'0x{val:02X}'


def get_texture_metadata(bntx_data: bytes, texture_name: str) -> dict | None:
    """Return structured metadata for a BNTX texture, grouped like Switch Toolbox."""
    for tex in _parse_textures(bntx_data):
        if tex.name == texture_name:
            fmt_name, bpp, blk_w, blk_h, _ = _fmt_info(tex.format_id)
            is_srgb = (tex.format_id & 0xFF) in _SRGB_VARIANTS
            tile_label = 'Linear' if tex.tile_mode == 1 else 'Default'
            dim_label = _dim_name(tex.dims)
            return {
                'name': tex.name,
                'channels': {
                    'red': _channel_name(tex.channel_r),
                    'green': _channel_name(tex.channel_g),
                    'blue': _channel_name(tex.channel_b),
                    'alpha': _channel_name(tex.channel_a),
                },
                'imageInfo': {
                    'width': tex.width,
                    'height': tex.height,
                    'mipCount': tex.mip_count,
                    'format': fmt_name,
                    'formatId': f'0x{tex.format_id:04X}',
                    'useSRGB': 'True' if is_srgb else 'False',
                    'name': tex.name,
                    'accessFlags': _access_flags_str(tex.access_flags),
                },
                'misc': {
                    'depth': tex.depth,
                    'tileMode': tile_label,
                    'swizzle': tex.swizzle,
                    'alignment': tex.alignment,
                    'pitch': tex.pitch,
                    'dims': dim_label,
                    'surfaceShape': dim_label,
                    'flags': tex.flags,
                    'imageSize': tex.image_size,
                    'sampleCount': tex.sample_count,
                },
                'width': tex.width,
                'height': tex.height,
                'format': fmt_name,
                'formatId': f'0x{tex.format_id:04X}',
                'mipCount': tex.mip_count,
                'dataSize': tex.data_size,
                'tileMode': tile_label,
                'blockH': 1 << tex.block_height_log2,
                'blockHLog2': tex.block_height_log2,
            }
    return None


def _apply_channel_swizzle(
    pixels: bytes, raw_mode: str, width: int, height: int,
    ch_r: int, ch_g: int, ch_b: int, ch_a: int,
) -> tuple[bytes, str]:
    """Remap decoded pixels according to the BNTX channel source metadata.

    Channel values: 0=Zero, 1=One, 2=Red, 3=Green, 4=Blue, 5=Alpha.
    Standard mapping (R=2, G=3, B=4, A=5) is a no-op.
    """
    if ch_r == 2 and ch_g == 3 and ch_b == 4 and ch_a == 5:
        return pixels, raw_mode

    pixel_count = width * height
    if raw_mode == 'BGRA':
        src_off = {2: 2, 3: 1, 4: 0, 5: 3}
    else:
        src_off = {2: 0, 3: 1, 4: 2, 5: 3}

    out = bytearray(pixel_count * 4)
    mapping = [(ch_r, 0), (ch_g, 1), (ch_b, 2), (ch_a, 3)]
    n = min(pixel_count, len(pixels) // 4)

    for i in range(n):
        base = i * 4
        for ch_val, dst in mapping:
            if ch_val == 0:
                out[base + dst] = 0
            elif ch_val == 1:
                out[base + dst] = 255
            elif ch_val in src_off:
                out[base + dst] = pixels[base + src_off[ch_val]]

    return bytes(out), 'RGBA'


def render_texture_to_png(bntx_data: bytes, texture_name: str) -> str | None:
    """Render a BNTX texture to a temp PNG file. Returns the path, or None on failure."""
    textures = _parse_textures(bntx_data)
    tex = None
    for t in textures:
        if t.name == texture_name:
            tex = t
            break
    if tex is None:
        _log(f'Texture not found: {texture_name}')
        return None

    fmt_name, bpp, blk_w, blk_h, decoder_key = _fmt_info(tex.format_id)
    _log(f'Rendering {tex.name} ({tex.width}x{tex.height}, {fmt_name}, '
         f'tile={tex.tile_mode}, bh={tex.block_height_log2})')

    if decoder_key == 'unknown':
        _log(f'Unsupported format: {fmt_name}')
        return None

    if tex.data_offset <= 0 or tex.data_size <= 0:
        _log('No texture data')
        return None

    raw_data = bntx_data[tex.data_offset:tex.data_offset + tex.data_size]

    if tex.tile_mode == 1:
        linear = _deswizzle_pitch_linear(tex.width, tex.height, blk_w, blk_h, bpp, raw_data)
    else:
        linear = _deswizzle_block_linear(tex.width, tex.height, blk_w, blk_h, bpp,
                                         tex.block_height_log2, raw_data)

    _log(f'Deswizzled {len(raw_data)} → {len(linear)} bytes')

    pixels, raw_mode = _decode_pixels(linear, tex.width, tex.height, decoder_key, blk_w, blk_h)
    if pixels is None:
        _log('Decode failed')
        return None

    pixels, raw_mode = _apply_channel_swizzle(
        pixels, raw_mode, tex.width, tex.height,
        tex.channel_r, tex.channel_g, tex.channel_b, tex.channel_a,
    )

    try:
        from PIL import Image
    except ImportError:
        _log('Pillow not installed - cannot save PNG')
        return None

    img = Image.frombytes('RGBA', (tex.width, tex.height), pixels, 'raw', raw_mode)
    safe = ''.join(c if c.isalnum() or c in '._-' else '_' for c in tex.name)
    fd, tmp_path = tempfile.mkstemp(prefix='totk-tex-', suffix=f'-{safe}.png')
    try:
        img.save(tmp_path, 'PNG')
    finally:
        os.close(fd)

    _log(f'Saved PNG: {tmp_path}')
    return tmp_path
