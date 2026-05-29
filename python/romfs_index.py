"""Build a searchable RomFS file index as a SQLite database."""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

from archive_resolve import list_archive_files

_ARCHIVE_EXTENSIONS = (
    ".pack",
    ".sarc",
    ".genvb",
    ".blarc",
    ".bfarc",
    ".bntx",
    ".pack.zs",
    ".sarc.zs",
    ".genvb.zs",
    ".blarc.zs",
    ".bfarc.zs",
    ".bntx.zs",
)


def _normalize_rel(path_value: str) -> str:
    return path_value.replace("\\", "/").strip("/")


def _is_archive_file(name: str) -> bool:
    lower = name.lower()
    return any(lower.endswith(ext) for ext in _ARCHIVE_EXTENSIONS)


def build_romfs_index(romfs_path: str, output_path: str) -> dict:
    if not romfs_path:
        raise ValueError("TOTK_EDITOR_ROMFS is not set.")

    romfs_root = Path(romfs_path)
    if not romfs_root.is_dir():
        raise ValueError(f"RomFS path does not exist: {romfs_path}")

    out_file = Path(output_path)
    out_file.parent.mkdir(parents=True, exist_ok=True)

    if out_file.exists():
        out_file.unlink()

    conn = sqlite3.connect(str(out_file))
    conn.execute("PRAGMA journal_mode = OFF")
    conn.execute("PRAGMA synchronous = OFF")
    conn.execute("PRAGMA page_size = 4096")

    conn.execute("""
        CREATE TABLE meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE files (
            path TEXT NOT NULL
        )
    """)

    normalized_root = _normalize_rel(str(romfs_root.resolve()))
    conn.execute("INSERT INTO meta (key, value) VALUES ('root', ?)", (normalized_root,))

    file_count = 0
    batch: list[tuple[str,]] = []

    for root, _, files in os.walk(romfs_root):
        root_path = Path(root)
        for file_name in files:
            disk_path = root_path / file_name
            rel_path = _normalize_rel(str(disk_path.relative_to(romfs_root)))
            batch.append((rel_path,))
            file_count += 1

            if _is_archive_file(file_name):
                try:
                    virtual_files = list_archive_files(str(disk_path), "", str(romfs_root))
                except Exception:
                    virtual_files = []

                for virtual_path in virtual_files:
                    normalized_virtual = _normalize_rel(virtual_path)
                    if normalized_virtual:
                        full_path = f"{rel_path}/{normalized_virtual}"
                        batch.append((full_path,))
                        file_count += 1

            if len(batch) >= 10000:
                conn.executemany("INSERT INTO files (path) VALUES (?)", batch)
                batch.clear()

    if batch:
        conn.executemany("INSERT INTO files (path) VALUES (?)", batch)

    conn.commit()
    conn.close()

    return {"path": str(out_file), "count": file_count}
