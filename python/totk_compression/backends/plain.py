"""Plain ZSTD / Yaz0 compression without a game dictionary (Splatoon-style games)."""

import oead
import zstandard as zstd

_ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"
_YAZ0_MAGIC = b"Yaz0"


def decompress_container(
    file_data: bytes,
    logical_path: str = "",
    romfs_path: str = "",
) -> tuple[bytes, bool, bool]:
    if file_data.startswith(_ZSTD_MAGIC):
        return zstd.ZstdDecompressor().decompress(file_data), True, False
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
    if was_zstd:
        return zstd.ZstdCompressor().compress(file_data)
    return file_data
