"""Read/write Nintendo AAMP via oead."""

import json
import os
from pathlib import Path

import oead
from zstd_totk import compress_container, decompress_container

_EXTENSIONS_PATH = Path(__file__).parent.parent / "config" / "aamp-extensions.json"
AAMP_EXTENSIONS = frozenset(json.loads(_EXTENSIONS_PATH.read_text(encoding="utf-8")))


def get_extra_aamp_extensions() -> frozenset[str]:
    raw = os.environ.get("TOTK_EXTRA_AAMP_EXTS", "").strip()
    if not raw:
        return frozenset()
    return frozenset(ext.strip().lower().lstrip(".") for ext in raw.split(",") if ext.strip())


def all_aamp_extensions() -> frozenset[str]:
    return AAMP_EXTENSIONS | get_extra_aamp_extensions()


def file_extension(logical_path: str) -> str:
    lower = logical_path.lower().replace("\\", "/")
    if lower.endswith(".zs"):
        lower = lower[:-3]
    if "." not in lower:
        return ""
    return lower.rsplit(".", 1)[-1]


def is_aamp_extension(logical_path: str) -> bool:
    return file_extension(logical_path) in all_aamp_extensions()


def _decompress_aamp(
    file_data: bytes, logical_path: str, romfs_path: str
) -> tuple[bytes, bool, bool]:
    return decompress_container(file_data, logical_path, romfs_path)


def _recompress_aamp(
    file_data: bytes,
    logical_path: str,
    romfs_path: str,
    was_zstd: bool,
    was_yaz0: bool,
) -> bytes:
    return compress_container(file_data, logical_path, romfs_path, was_zstd, was_yaz0)


def is_aamp_binary(file_data: bytes) -> bool:
    if len(file_data) >= 4 and file_data[:4] == b"AAMP":
        return True
    try:
        oead.aamp.ParameterIO.from_binary(file_data)
        return True
    except Exception:
        return False


def read_aamp_content(file_data: bytes, logical_path: str = "", romfs_path: str = "") -> str:
    file_data, _, _ = _decompress_aamp(file_data, logical_path, romfs_path)
    if len(file_data) == 0:
        try:
            return oead.aamp.ParameterIO().to_text()
        except Exception:
            return ""
    if not is_aamp_binary(file_data):
        magic = file_data[:4]
        return f"<Not AAMP (expected AAMP magic, got {magic!r}): {len(file_data)} bytes>"
    pio = oead.aamp.ParameterIO.from_binary(file_data)
    return pio.to_text()


def write_aamp_bytes(
    orig_file_data: bytes, editor_text: str, logical_path: str = "", romfs_path: str = ""
) -> bytes:
    orig_file_data, is_zstd, is_yaz0 = _decompress_aamp(orig_file_data, logical_path, romfs_path)
    if logical_path.lower().endswith(".zs"):
        is_zstd = True
    pio = oead.aamp.ParameterIO.from_text(editor_text)
    new_bytes = pio.to_binary()
    return _recompress_aamp(new_bytes, logical_path, romfs_path, is_zstd, is_yaz0)
