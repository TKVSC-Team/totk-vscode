"""Reader/renderer for TOTK TXTG (TexToGo) textures."""

from __future__ import annotations

import zstandard as zstd
from bntx_renderer import (
    _apply_channel_swizzle,
    _decode_pixels,
    _deswizzle_block_linear,
    _deswizzle_pitch_linear,
)

_TXTG_MAGIC = b"6PK0"

_FORMAT_MAP: dict[int, tuple[str, int, int, int, str]] = {
    0x101: ("ASTC_4x4_UNORM", 16, 4, 4, "astc"),
    0x102: ("ASTC_8x8_UNORM", 16, 8, 8, "astc"),
    0x105: ("ASTC_8x8_SRGB", 16, 8, 8, "astc"),
    0x109: ("ASTC_4x4_SRGB", 16, 4, 4, "astc"),
    0x202: ("BC1_UNORM", 8, 4, 4, "bc1"),
    0x203: ("BC1_SRGB", 8, 4, 4, "bc1"),
    0x302: ("BC1_UNORM", 8, 4, 4, "bc1"),
    0x303: ("BC1_SRGB", 8, 4, 4, "bc1"),
    0x505: ("BC3_SRGB", 16, 4, 4, "bc3"),
    0x602: ("BC4_UNORM", 8, 4, 4, "bc4"),
    0x606: ("BC4_UNORM", 8, 4, 4, "bc4"),
    0x607: ("BC4_UNORM", 8, 4, 4, "bc4"),
    0x702: ("BC5_UNORM", 16, 4, 4, "bc5"),
    0x703: ("BC5_UNORM", 16, 4, 4, "bc5"),
    0x707: ("BC5_UNORM", 16, 4, 4, "bc5"),
    0x901: ("BC7_UNORM", 16, 4, 4, "bc7"),
    0x0B0B: ("R8G8B8A8_UNORM", 4, 1, 1, "rgba8"),
    0x0C0C: ("B8G8R8A8_UNORM", 4, 1, 1, "bgra8"),
}


def is_txtg(data: bytes) -> bool:
    return len(data) >= 8 and data[4:8] == _TXTG_MAGIC


def _u8(data: bytes, offset: int) -> int:
    return data[offset] if offset < len(data) else 0


def _u16(data: bytes, offset: int) -> int:
    if offset + 2 > len(data):
        return 0
    return int.from_bytes(data[offset : offset + 2], "little")


def _u32(data: bytes, offset: int) -> int:
    if offset + 4 > len(data):
        return 0
    return int.from_bytes(data[offset : offset + 4], "little")


def _decompress_surface(data: bytes) -> bytes:
    try:
        return zstd.ZstdDecompressor().decompress(data)
    except Exception:
        return data


def _read_surface_data(data: bytes, header_size: int, surface_count: int) -> list[bytes]:
    if surface_count <= 0:
        return []

    cursor = header_size
    index_table_size = surface_count * 4
    size_table_size = surface_count * 8
    if cursor + index_table_size + size_table_size > len(data):
        return []

    cursor += index_table_size

    sizes: list[int] = []
    for _ in range(surface_count):
        size = _u32(data, cursor)
        sizes.append(size)
        cursor += 8

    surfaces: list[bytes] = []
    for size in sizes:
        if size <= 0 or cursor + size > len(data):
            surfaces.append(b"")
            continue
        compressed = data[cursor : cursor + size]
        cursor += size
        surfaces.append(_decompress_surface(compressed))
    return surfaces


def _resolve_format(format_id: int, texture_setting2: int) -> tuple[str, int, int, int, str]:
    fmt = _FORMAT_MAP.get(format_id)
    if not fmt:
        return (f"Unknown(0x{format_id:04X})", 0, 1, 1, "unknown")

    if format_id == 0x101 and texture_setting2 == 32628:
        return ("ASTC_8x5_UNORM", 16, 8, 5, "astc")
    if format_id == 0x101 and texture_setting2 == 32631:
        return ("ASTC_8x8_UNORM", 16, 8, 8, "astc")
    return fmt


def _iter_block_height_candidates(texture_setting4: int) -> list[int]:
    b0 = texture_setting4 & 0xFF
    b1 = (texture_setting4 >> 8) & 0xFF
    b2 = (texture_setting4 >> 16) & 0xFF

    candidates: list[int] = []
    for value in (b0, b1, b2, 4, 5, 3, 2, 1, 0):
        if 0 <= value <= 5 and value not in candidates:
            candidates.append(value)
    return candidates


def _image_quality_score(pixels: bytes, width: int, height: int, raw_mode: str) -> float:
    if width < 4 or height < 4 or len(pixels) < width * height * 4:
        return 1e12

    try:
        from PIL import Image

        img = Image.frombytes("RGBA", (width, height), pixels, "raw", raw_mode)
        lum = img.convert("L").tobytes()
    except Exception:
        return 1e12

    y_step = max(1, height // 64)
    total_adj = 0
    total_count = 0
    for y in range(0, height, y_step):
        row_off = y * width
        for x in range(1, width):
            total_adj += abs(lum[row_off + x] - lum[row_off + x - 1])
            total_count += 1

    base = total_adj / max(1, total_count)

    seam_penalty = 0.0
    for period in (4, 8, 16, 32):
        if width <= period:
            continue
        seam_sum = 0
        seam_count = 0
        for y in range(0, height, y_step):
            row_off = y * width
            for x in range(period, width, period):
                seam_sum += abs(lum[row_off + x] - lum[row_off + x - 1])
                seam_count += 1
        if seam_count:
            seam_avg = seam_sum / seam_count
            seam_penalty += max(0.0, seam_avg - base)

    return seam_penalty + base * 0.05


def read_txtg_texture_result(txtg_data: bytes, texture_name: str) -> dict:
    if not is_txtg(txtg_data):
        raise ValueError("Not a TXTG file.")

    header_size = _u16(txtg_data, 0x00) or 0x50
    width = _u16(txtg_data, 0x08)
    height = _u16(txtg_data, 0x0A)
    array_count = max(_u16(txtg_data, 0x0C), 1)
    mip_count = max(_u8(txtg_data, 0x0E), 1)
    comp_r = _u8(txtg_data, 0x18)
    comp_g = _u8(txtg_data, 0x19)
    comp_b = _u8(txtg_data, 0x1A)
    comp_a = _u8(txtg_data, 0x1B)
    format_id = _u16(txtg_data, 0x3C)
    texture_setting2 = _u32(txtg_data, 0x44)
    texture_setting4 = _u32(txtg_data, 0x4C)
    block_height_log2 = texture_setting4 & 0xFF

    fmt_name, bpp, blk_w, blk_h, decoder_key = _resolve_format(format_id, texture_setting2)
    surfaces = _read_surface_data(txtg_data, header_size, mip_count * array_count)
    image_data = surfaces[0] if surfaces else b""

    decode_error: str | None = None
    png_path = None

    # TOTK textures sometimes disguise ASTC 8x8 as ASTC 4x4. We use ASTC 4x4 block size to decode.
    is_astc_8x8 = False
    if "ASTC_8x8" in fmt_name and decoder_key == "astc":
        is_astc_8x8 = True
        blk_w = 4
        blk_h = 4

    if not image_data:
        decode_error = "TXTG has no readable surface payload."
    elif width <= 0 or height <= 0:
        decode_error = f"Invalid texture dimensions ({width}x{height})."
    elif decoder_key == "unknown" or bpp <= 0:
        decode_error = f"Unsupported TXTG format id 0x{format_id:04X}."
    else:
        render_width = width // 2 if is_astc_8x8 else width
        render_height = height // 2 if is_astc_8x8 else height

        decode_inputs: list[tuple[str, bytes, int]] = []
        for bh in _iter_block_height_candidates(texture_setting4):
            try:
                linear = _deswizzle_block_linear(
                    render_width,
                    render_height,
                    blk_w,
                    blk_h,
                    bpp,
                    bh,
                    image_data,
                )
                decode_inputs.append((f"block-linear(bh={bh})", linear, bh))
            except Exception:
                pass
        try:
            linear_pitch = _deswizzle_pitch_linear(
                render_width, render_height, blk_w, blk_h, bpp, image_data
            )
            decode_inputs.append(("pitch-linear", linear_pitch, block_height_log2))
        except Exception:
            pass
        decode_inputs.append(("direct", image_data, block_height_log2))

        best_candidate: tuple[float, bytes, int, str] | None = None
        for label, payload, bh_used in decode_inputs:
            try:
                pixels, raw_mode = _decode_pixels(
                    payload, render_width, render_height, decoder_key, blk_w, blk_h
                )
                if pixels is None:
                    decode_error = f"Decode failed via {label} path ({decoder_key})."
                    continue

                # TXTG component selectors use:
                # 0=Red, 1=Green, 2=Blue, 3=Alpha, 4=Zero, 5=One.
                # bntx_renderer swizzle helper expects:
                # 0=Zero, 1=One, 2=Red, 3=Green, 4=Blue, 5=Alpha.
                selector_to_bntx = {0: 2, 1: 3, 2: 4, 3: 5, 4: 0, 5: 1}
                ch_r = selector_to_bntx.get(comp_r, 2)
                ch_g = selector_to_bntx.get(comp_g, 3)
                ch_b = selector_to_bntx.get(comp_b, 4)
                ch_a = selector_to_bntx.get(comp_a, 5)
                pixels, raw_mode = _apply_channel_swizzle(
                    pixels,
                    raw_mode,
                    render_width,
                    render_height,
                    ch_r,
                    ch_g,
                    ch_b,
                    ch_a,
                )
                score = _image_quality_score(pixels, render_width, render_height, raw_mode)
                if best_candidate is None or score < best_candidate[0]:
                    best_candidate = (score, pixels, bh_used, raw_mode)
                    decode_error = None
            except Exception as error:
                decode_error = f"Decode failed via {label} path: {error}"

        if best_candidate is not None:
            _, best_pixels, best_bh, best_raw_mode = best_candidate
            block_height_log2 = best_bh
            from PIL import Image

            image = Image.frombytes(
                "RGBA", (render_width, render_height), best_pixels, "raw", best_raw_mode
            )
            if is_astc_8x8:
                image = image.resize((width, height), Image.NEAREST)
            import os
            import tempfile

            safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in texture_name)
            fd, tmp_path = tempfile.mkstemp(prefix="totk-txtg-", suffix=f"-{safe}.png")
            try:
                image.save(tmp_path, "PNG")
                png_path = tmp_path
            except Exception:
                pass
            finally:
                os.close(fd)

    channel_map = {
        0: "Red",
        1: "Green",
        2: "Blue",
        3: "Alpha",
        4: "Zero",
        5: "One",
    }

    result: dict = {
        "bntxTexture": True,
        "metadata": {
            "name": texture_name,
            "channels": {
                "red": channel_map.get(comp_r, f"Unknown({comp_r})"),
                "green": channel_map.get(comp_g, f"Unknown({comp_g})"),
                "blue": channel_map.get(comp_b, f"Unknown({comp_b})"),
                "alpha": channel_map.get(comp_a, f"Unknown({comp_a})"),
            },
            "imageInfo": {
                "width": width,
                "height": height,
                "mipCount": mip_count,
                "format": fmt_name,
                "formatId": f"0x{format_id:04X}",
                "useSRGB": "True" if "SRGB" in fmt_name else "False",
                "name": texture_name,
                "accessFlags": "Texture",
            },
            "misc": {
                "depth": 1,
                "tileMode": "Default",
                "swizzle": 0,
                "alignment": 0x200,
                "pitch": 0,
                "dims": "Dim2D",
                "surfaceShape": "Dim2D",
                "flags": 0,
                "imageSize": len(image_data),
                "sampleCount": 1,
            },
            "width": width,
            "height": height,
            "format": fmt_name,
            "formatId": f"0x{format_id:04X}",
            "mipCount": mip_count,
            "dataSize": len(image_data),
            "tileMode": "Default",
            "blockH": 1 << max(0, min(block_height_log2, 5)),
            "blockHLog2": block_height_log2,
        },
    }

    if png_path is not None:
        result["pngPath"] = png_path
    elif decode_error:
        result["error"] = decode_error
    return result


"""Editor for TOTK TXTG (TexToGo) textures."""

import struct


class TxtgEditor:
    def __init__(self, data: bytes):
        if not is_txtg(data):
            raise ValueError("Not a valid TXTG file.")
        self._data = bytearray(data)

    @property
    def header_size(self) -> int:
        val = struct.unpack_from("<H", self._data, 0x00)[0]
        return val if val else 0x50

    @property
    def width(self) -> int:
        return struct.unpack_from("<H", self._data, 0x08)[0]

    @width.setter
    def width(self, value: int):
        struct.pack_into("<H", self._data, 0x08, value)

    @property
    def height(self) -> int:
        return struct.unpack_from("<H", self._data, 0x0A)[0]

    @height.setter
    def height(self, value: int):
        struct.pack_into("<H", self._data, 0x0A, value)

    @property
    def array_count(self) -> int:
        return max(struct.unpack_from("<H", self._data, 0x0C)[0], 1)

    @array_count.setter
    def array_count(self, value: int):
        struct.pack_into("<H", self._data, 0x0C, value)

    @property
    def mip_count(self) -> int:
        return max(self._data[0x0E], 1)

    @mip_count.setter
    def mip_count(self, value: int):
        self._data[0x0E] = value

    @property
    def comp_r(self) -> int:
        return self._data[0x18]

    @comp_r.setter
    def comp_r(self, value: int):
        self._data[0x18] = value

    @property
    def comp_g(self) -> int:
        return self._data[0x19]

    @comp_g.setter
    def comp_g(self, value: int):
        self._data[0x19] = value

    @property
    def comp_b(self) -> int:
        return self._data[0x1A]

    @comp_b.setter
    def comp_b(self, value: int):
        self._data[0x1A] = value

    @property
    def comp_a(self) -> int:
        return self._data[0x1B]

    @comp_a.setter
    def comp_a(self, value: int):
        self._data[0x1B] = value

    @property
    def format_id(self) -> int:
        return struct.unpack_from("<H", self._data, 0x3C)[0]

    @format_id.setter
    def format_id(self, value: int):
        struct.pack_into("<H", self._data, 0x3C, value)

    @property
    def texture_setting2(self) -> int:
        if len(self._data) < 0x48:
            return 0
        return struct.unpack_from("<I", self._data, 0x44)[0]

    @texture_setting2.setter
    def texture_setting2(self, value: int):
        if len(self._data) >= 0x48:
            struct.pack_into("<I", self._data, 0x44, value)

    @property
    def texture_setting4(self) -> int:
        if len(self._data) < 0x50:
            return 0
        return struct.unpack_from("<I", self._data, 0x4C)[0]

    @texture_setting4.setter
    def texture_setting4(self, value: int):
        if len(self._data) >= 0x50:
            struct.pack_into("<I", self._data, 0x4C, value)

    def replace_image_data(self, raw_surfaces: list[bytes]):
        """
        Replaces the compressed surfaces.
        raw_surfaces should be a list of uncompressed image payloads (e.g. mips/arrays).
        """
        header = self._data[: self.header_size]

        cctx = zstd.ZstdCompressor()

        size_table = []
        payload_data = bytearray()

        surface_count = len(raw_surfaces)

        for surface in raw_surfaces:
            compressed = cctx.compress(surface)
            size_table.append(len(compressed))
            payload_data.extend(compressed)

        index_bytes = bytearray(surface_count * 4)  # usually zeroed out or offsets
        # TXTG format index table isn't strictly required to have offsets, often zeroes,
        # but let's just make it zeroes for now.

        size_bytes = bytearray()
        for size in size_table:
            size_bytes.extend(struct.pack("<Q", size))

        new_data = bytearray(header)
        new_data.extend(index_bytes)
        new_data.extend(size_bytes)
        new_data.extend(payload_data)

        self._data = new_data

    def to_bytes(self) -> bytes:
        return bytes(self._data)
