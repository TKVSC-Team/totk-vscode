"""TOTK game-dictionary ZSTD (ZsDic.pack.zs) for .pack.zs, .byml.zs, etc."""

import os
import sys
from functools import lru_cache
from pathlib import Path

import zstandard as zstd
import oead

_ZSTD_MAGIC = b'\x28\xb5\x2f\xfd'
_YAZ0_MAGIC = b'Yaz0'

_ROMFS_HELP = (
    'Set totk-editor.romfsPath to your extracted game RomFS folder '
    '(must contain Pack/ZsDic.pack.zs).'
)


def zsdic_pack_path(romfs_path: str) -> str:
    return os.path.join(romfs_path, 'Pack', 'ZsDic.pack.zs')


def _ensure_vendor_zstd() -> None:
    vendor = Path(__file__).parent / 'vendor' / 'asb-toolkit'
    vendor_str = str(vendor)
    if vendor_str not in sys.path:
        sys.path.insert(0, vendor_str)


@lru_cache(maxsize=4)
def _get_zstd_context(zsdic_pack: str):
    _ensure_vendor_zstd()
    from zstd import ZstdDecompContext

    return ZstdDecompContext(zsdic_pack)


def _logical_path_lower(logical_path: str) -> str:
    return logical_path.lower().replace('\\', '/')


def _pick_decompressor(ctx, logical_path: str):
    lower = _logical_path_lower(logical_path)
    if lower.endswith('.pack.zs'):
        return ctx.pack
    if lower.endswith('.bcett.byml.zs'):
        return ctx.bcett
    if lower.endswith('.mc'):
        return ctx.mc
    return ctx.zs


def _pick_compressor(ctx, logical_path: str):
    lower = _logical_path_lower(logical_path)
    if lower.endswith('.pack.zs'):
        return ctx.pack_compress
    if lower.endswith('.bcett.byml.zs'):
        return ctx.bcett_compress
    return ctx.zs_compress


def _decompress_with_fallback(ctx, data: bytes, logical_path: str) -> bytes:
    """Try the expected dictionary, then fall back to other TOTK dictionaries."""
    lower = _logical_path_lower(logical_path)
    primary = _pick_decompressor(ctx, logical_path)
    candidates = [primary]
    if primary is not ctx.zs:
        candidates.append(ctx.zs)
    if lower.endswith('.pack.zs') and ctx.pack not in candidates:
        candidates.append(ctx.pack)

    last_error: Exception | None = None
    for dec in candidates:
        try:
            return dec._decompress(data)
        except zstd.ZstdError as error:
            last_error = error
    if last_error is not None:
        raise last_error
    return primary._decompress(data)


def decompress_container(
    file_data: bytes,
    logical_path: str = '',
    romfs_path: str = '',
) -> tuple[bytes, bool, bool]:
    """Decompress .zs (ZSTD) or Yaz0 wrappers. Returns (payload, was_zstd, was_yaz0)."""
    if file_data.startswith(_ZSTD_MAGIC):
        zsdic = zsdic_pack_path(romfs_path) if romfs_path else ''
        if zsdic and os.path.isfile(zsdic):
            ctx = _get_zstd_context(zsdic)
            return _decompress_with_fallback(ctx, file_data, logical_path or 'file.zs'), True, False

        try:
            return zstd.ZstdDecompressor().decompress(file_data), True, False
        except zstd.ZstdError as e:
            raise ValueError(
                f'Cannot decompress .zs data (dictionary mismatch). {_ROMFS_HELP}'
            ) from e

    if file_data.startswith(_YAZ0_MAGIC):
        return oead.yaz0.decompress(file_data), False, True

    return file_data, False, False


def compress_container(
    file_data: bytes,
    logical_path: str,
    romfs_path: str,
    was_zstd: bool,
    was_yaz0: bool,
) -> bytes:
    if was_yaz0:
        return oead.yaz0.compress(file_data)
    if not was_zstd:
        return file_data

    zsdic = zsdic_pack_path(romfs_path) if romfs_path else ''
    if not zsdic or not os.path.isfile(zsdic):
        raise ValueError(f'Cannot recompress .zs data. {_ROMFS_HELP}')

    ctx = _get_zstd_context(zsdic)
    comp = _pick_compressor(ctx, logical_path or 'file.zs')
    return comp._compress(file_data)
