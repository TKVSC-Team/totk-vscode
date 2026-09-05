"""Compression backend dispatch for TKVSC game profiles."""

from __future__ import annotations

import os


def get_compression_backend_id() -> str:
    return os.environ.get("TKVSC_COMPRESSION_BACKEND", "totk-zstd").strip() or "totk-zstd"


def decompress_container(
    file_data: bytes,
    logical_path: str = "",
    romfs_path: str = "",
) -> tuple[bytes, bool, bool]:
    backend = get_compression_backend_id()
    if backend == "plain-zstd-yaz0":
        from compression.backends.plain import decompress_container as impl
    else:
        from compression.backends.totk import decompress_container as impl
    return impl(file_data, logical_path, romfs_path)


def compress_container(
    file_data: bytes,
    logical_path: str,
    romfs_path: str,
    was_zstd: bool,
    was_yaz0: bool,
) -> bytes:
    backend = get_compression_backend_id()
    if backend == "plain-zstd-yaz0":
        from compression.backends.plain import compress_container as impl
    else:
        from compression.backends.totk import compress_container as impl
    return impl(file_data, logical_path, romfs_path, was_zstd, was_yaz0)
