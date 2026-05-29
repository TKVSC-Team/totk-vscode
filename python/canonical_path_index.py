"""Build a canonical-path index for archive entries in RomFS."""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

from archive_resolve import list_archive_files
from romfs_index import _ARCHIVE_EXTENSIONS


def _normalize_rel(path_value: str) -> str:
    return path_value.replace("\\", "/").strip("/")


def _is_archive_file(name: str) -> bool:
    lower = name.lower()
    return any(lower.endswith(ext) for ext in _ARCHIVE_EXTENSIONS)


def build_canonical_path_index(romfs_path: str, output_path: str) -> dict:
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
        CREATE TABLE canonical_entries (
            canonical_path TEXT NOT NULL,
            archive_rel_path TEXT NOT NULL
        )
    """)
    conn.execute(
        "CREATE INDEX idx_canonical_entries_path_nocase ON canonical_entries(canonical_path COLLATE NOCASE)"
    )

    normalized_root = _normalize_rel(str(romfs_root.resolve()))
    conn.execute("INSERT INTO meta (key, value) VALUES ('root', ?)", (normalized_root,))

    row_count = 0
    batch: list[tuple[str, str]] = []

    for root, _, files in os.walk(romfs_root):
        root_path = Path(root)
        for file_name in files:
            if not _is_archive_file(file_name):
                continue

            disk_path = root_path / file_name
            archive_rel_path = _normalize_rel(str(disk_path.relative_to(romfs_root)))
            if not archive_rel_path:
                continue

            try:
                virtual_files = list_archive_files(str(disk_path), "", str(romfs_root))
            except Exception:
                virtual_files = []

            for virtual_path in virtual_files:
                normalized_virtual = _normalize_rel(virtual_path)
                if not normalized_virtual:
                    continue
                batch.append((normalized_virtual, archive_rel_path))
                row_count += 1

            if len(batch) >= 10000:
                conn.executemany(
                    """
                    INSERT INTO canonical_entries (
                        canonical_path,
                        archive_rel_path
                    )
                    VALUES (?, ?)
                    """,
                    batch,
                )
                batch.clear()

    if batch:
        conn.executemany(
            """
            INSERT INTO canonical_entries (
                canonical_path,
                archive_rel_path
            )
            VALUES (?, ?)
            """,
            batch,
        )

    conn.commit()
    conn.close()

    return {"path": str(out_file), "count": row_count}
