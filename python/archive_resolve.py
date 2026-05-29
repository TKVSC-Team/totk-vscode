"""Resolve nested .pack / .sarc / .genvb / .blarc / .bntx paths to an open SARC and in-archive prefix."""

import re
from pathlib import Path

import oead
from bntx_reader import is_bntx, list_textures, read_texture_data
from zstd_totk import compress_container, decompress_container

_ARCHIVE_SEGMENT = re.compile(r"\.(pack|sarc|genvb|blarc|bfarc|bntx)(\.zs)?$", re.IGNORECASE)
_BNTX_SEGMENT = re.compile(r"\.bntx(\.zs)?$", re.IGNORECASE)
_ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"


def _is_archive_name(name: str) -> bool:
    return bool(_ARCHIVE_SEGMENT.search(name.replace("\\", "/")))


def _is_bntx_name(name: str) -> bool:
    return bool(_BNTX_SEGMENT.search(name.replace("\\", "/")))


def _normalize_path(path: str) -> str:
    return path.replace("\\", "/").strip("/")


def load_sarc_file(archive_path: str, romfs_path: str):
    with open(archive_path, "rb") as handle:
        data = handle.read()

    is_compressed = data.startswith(_ZSTD_MAGIC)
    if is_compressed:
        data, _, _ = decompress_container(data, archive_path, romfs_path)

    if is_bntx(data):
        raise ValueError(
            f"Cannot open BNTX file as SARC: {archive_path}. Use the BNTX reader instead."
        )

    return oead.Sarc(data), is_compressed


def _save_sarc_bytes(
    archive_path: str, out_bytes: bytes, is_compressed: bool, romfs_path: str
) -> None:
    if is_compressed:
        out_bytes = compress_container(
            out_bytes,
            archive_path,
            romfs_path,
            was_zstd=True,
            was_yaz0=False,
        )
    Path(archive_path).write_bytes(out_bytes)


def _get_file_bytes(sarc, internal_path: str) -> bytes:
    entry = sarc.get_file(internal_path)
    if entry is None:
        raise FileNotFoundError(
            f"File not found in archive: {internal_path!r}. "
            f"Known paths sample: {[f.name for f in list(sarc.get_files())[:5]]}..."
        )
    return bytes(entry.data)


def _write_file_bytes(sarc: oead.Sarc, internal_path: str, data: bytes) -> bytes:
    writer = oead.SarcWriter.from_sarc(sarc)
    writer.files[internal_path] = data
    return writer.write()[1]


def _delete_path(sarc: oead.Sarc, internal_path: str) -> bytes:
    writer = oead.SarcWriter.from_sarc(sarc)
    target = internal_path.strip("/")
    prefix = f"{target}/"
    to_delete = [name for name in writer.files.keys() if name == target or name.startswith(prefix)]
    if not to_delete:
        raise FileNotFoundError(target)
    for name in to_delete:
        del writer.files[name]
    return writer.write()[1]


def _rename_path(sarc: oead.Sarc, old_path: str, new_path: str) -> bytes:
    writer = oead.SarcWriter.from_sarc(sarc)
    old_target = old_path.strip("/")
    new_target = new_path.strip("/")
    old_prefix = f"{old_target}/"

    move_pairs: list[tuple[str, str]] = []
    for name in writer.files.keys():
        if name == old_target:
            move_pairs.append((name, new_target))
        elif name.startswith(old_prefix):
            suffix = name[len(old_prefix) :]
            move_pairs.append((name, f"{new_target}/{suffix}"))

    if not move_pairs:
        raise FileNotFoundError(old_target)

    existing = set(writer.files.keys())
    moved_from = {src for src, _ in move_pairs}
    for _, destination in move_pairs:
        if destination in existing and destination not in moved_from:
            raise FileExistsError(destination)

    for source, destination in move_pairs:
        writer.files[destination] = bytes(writer.files[source])
        del writer.files[source]

    return writer.write()[1]


def _next_archive_index(segments: list[str]) -> int:
    for index, segment in enumerate(segments[:-1]):
        if _is_archive_name(segment):
            return index
    return -1


def _mutate_nested_set(
    sarc: oead.Sarc,
    segments: list[str],
    file_data: bytes,
    romfs_path: str,
) -> bytes:
    index = _next_archive_index(segments)
    if index < 0:
        relative = "/".join(segments).strip("/")
        return _write_file_bytes(sarc, relative, file_data)

    entry_path = "/".join(segments[: index + 1])
    remainder = segments[index + 1 :]
    nested_data = _get_file_bytes(sarc, entry_path)
    payload, was_zstd, was_yaz0 = decompress_container(nested_data, entry_path, romfs_path)
    nested_sarc = oead.Sarc(payload)
    nested_out = _mutate_nested_set(nested_sarc, remainder, file_data, romfs_path)
    nested_out = compress_container(
        nested_out, entry_path, romfs_path, was_zstd=was_zstd, was_yaz0=was_yaz0
    )
    return _write_file_bytes(sarc, entry_path, nested_out)


def _mutate_nested_delete(
    sarc: oead.Sarc,
    segments: list[str],
    romfs_path: str,
) -> bytes:
    index = _next_archive_index(segments)
    if index < 0:
        relative = "/".join(segments).strip("/")
        return _delete_path(sarc, relative)

    entry_path = "/".join(segments[: index + 1])
    remainder = segments[index + 1 :]
    nested_data = _get_file_bytes(sarc, entry_path)
    payload, was_zstd, was_yaz0 = decompress_container(nested_data, entry_path, romfs_path)
    nested_sarc = oead.Sarc(payload)
    nested_out = _mutate_nested_delete(nested_sarc, remainder, romfs_path)
    nested_out = compress_container(
        nested_out, entry_path, romfs_path, was_zstd=was_zstd, was_yaz0=was_yaz0
    )
    return _write_file_bytes(sarc, entry_path, nested_out)


def _mutate_nested_rename(
    sarc: oead.Sarc,
    old_segments: list[str],
    new_segments: list[str],
    romfs_path: str,
) -> bytes:
    old_index = _next_archive_index(old_segments)
    new_index = _next_archive_index(new_segments)

    if old_index < 0 and new_index < 0:
        old_relative = "/".join(old_segments).strip("/")
        new_relative = "/".join(new_segments).strip("/")
        return _rename_path(sarc, old_relative, new_relative)

    if old_index != new_index or old_index < 0:
        raise ValueError("Cannot rename across different nested archive levels.")

    old_entry = "/".join(old_segments[: old_index + 1])
    new_entry = "/".join(new_segments[: new_index + 1])
    if old_entry != new_entry:
        raise ValueError("Cannot rename across different nested archives.")

    old_remainder = old_segments[old_index + 1 :]
    new_remainder = new_segments[new_index + 1 :]
    nested_data = _get_file_bytes(sarc, old_entry)
    payload, was_zstd, was_yaz0 = decompress_container(nested_data, old_entry, romfs_path)
    nested_sarc = oead.Sarc(payload)
    nested_out = _mutate_nested_rename(nested_sarc, old_remainder, new_remainder, romfs_path)
    nested_out = compress_container(
        nested_out, old_entry, romfs_path, was_zstd=was_zstd, was_yaz0=was_yaz0
    )
    return _write_file_bytes(sarc, old_entry, nested_out)


def resolve_sarc_view(disk_archive_path: str, locator_path: str, romfs_path: str):
    locator_path = _normalize_path(locator_path)
    sarc, is_compressed = load_sarc_file(disk_archive_path, romfs_path)

    if not locator_path:
        return sarc, "", is_compressed, ""

    segments = locator_path.split("/")
    after_archive = 0
    consumed_archive_segments: list[str] = []

    for index, segment in enumerate(segments):
        if not _is_archive_name(segment) or _is_bntx_name(segment):
            continue

        entry_path = "/".join(segments[after_archive : index + 1])
        file_data = _get_file_bytes(sarc, entry_path)
        file_data, _, _ = decompress_container(file_data, entry_path, romfs_path)
        sarc = oead.Sarc(file_data)
        consumed_archive_segments.extend(segments[after_archive : index + 1])
        after_archive = index + 1

    path_prefix = "/".join(segments[after_archive:]).strip("/")
    consumed_archive_prefix = "/".join(consumed_archive_segments).strip("/")
    return sarc, path_prefix, is_compressed, consumed_archive_prefix


def _load_disk_bytes(disk_archive_path: str, romfs_path: str) -> tuple[bytes, bool]:
    raw = Path(disk_archive_path).read_bytes()
    is_compressed = raw.startswith(_ZSTD_MAGIC)
    if is_compressed:
        raw, _, _ = decompress_container(raw, disk_archive_path, romfs_path)
    return raw, is_compressed


def _resolve_bntx_data(disk_archive_path: str, locator_path: str, romfs_path: str):
    if _is_bntx_name(disk_archive_path):
        data, _ = _load_disk_bytes(disk_archive_path, romfs_path)
        if is_bntx(data):
            return data, _normalize_path(locator_path), ""

    if not locator_path:
        return None

    normalized = _normalize_path(locator_path)
    segments = normalized.split("/")
    for i, seg in enumerate(segments):
        if not _is_bntx_name(seg):
            continue
        parent_locator = "/".join(segments[:i]) if i > 0 else ""
        sarc, prefix, _, _ = resolve_sarc_view(
            disk_archive_path,
            parent_locator,
            romfs_path,
        )
        # The .bntx file path inside the innermost SARC
        bntx_entry = f"{prefix}/{seg}".strip("/") if prefix else seg
        bntx_bytes = _get_file_bytes(sarc, bntx_entry)
        if bntx_bytes[:4] == _ZSTD_MAGIC[:4]:
            bntx_bytes, _, _ = decompress_container(bntx_bytes, seg, romfs_path)
        if is_bntx(bntx_bytes):
            remainder = "/".join(segments[i + 1 :]).strip("/")
            bntx_prefix = "/".join(segments[: i + 1])
            return bntx_bytes, remainder, bntx_prefix
    return None


def list_archive_files(disk_archive_path: str, locator_path: str, romfs_path: str) -> list[str]:
    bntx = _resolve_bntx_data(disk_archive_path, locator_path, romfs_path)
    if bntx is not None:
        bntx_data, remainder, bntx_prefix = bntx
        names = list_textures(bntx_data)
        if bntx_prefix:
            return [f"{bntx_prefix}/{n}" for n in names]
        return names

    sarc, prefix, _, consumed_archive_prefix = resolve_sarc_view(
        disk_archive_path, locator_path, romfs_path
    )
    names = [file.name for file in sarc.get_files()]
    if prefix:
        prefix_slash = prefix + "/"
        names = [name for name in names if name.startswith(prefix_slash)]
    if consumed_archive_prefix:
        return [f"{consumed_archive_prefix}/{name}" for name in names]
    return names


def read_archive_file_bytes(disk_archive_path: str, file_path: str, romfs_path: str) -> bytes:
    file_path = _normalize_path(file_path)
    if not file_path:
        raise IsADirectoryError(file_path)

    leaf = file_path.split("/")[-1]
    if _is_archive_name(leaf):
        raise IsADirectoryError(file_path)

    bntx = _resolve_bntx_data(disk_archive_path, file_path, romfs_path)
    if bntx is not None:
        bntx_data, remainder, _ = bntx
        if not remainder:
            raise IsADirectoryError(file_path)
        return read_texture_data(bntx_data, remainder)

    sarc, lookup, _, _ = resolve_sarc_view(disk_archive_path, file_path, romfs_path)
    return _get_file_bytes(sarc, lookup)


def _reject_bntx_mutation(disk_archive_path: str, operation: str, target_path: str = "") -> None:
    if _is_bntx_name(disk_archive_path):
        raise PermissionError(f"Cannot {operation} inside a BNTX texture container (read-only)")

    if target_path:
        segments = [s for s in target_path.split("/") if s]
        if any(_is_bntx_name(seg) for seg in segments[:-1]):
            raise PermissionError(
                f"Cannot {operation} textures inside a nested BNTX container (read-only)"
            )


def write_archive_file_bytes(
    disk_archive_path: str,
    file_path: str,
    data: bytes,
    romfs_path: str,
) -> None:
    file_path = _normalize_path(file_path)
    _reject_bntx_mutation(disk_archive_path, "write", file_path)
    if not file_path:
        raise ValueError("Missing file path")

    segments = [segment for segment in file_path.split("/") if segment]
    if file_path.lower().endswith(".zs") and not data.startswith(_ZSTD_MAGIC):
        data = compress_container(
            data,
            file_path,
            romfs_path,
            was_zstd=True,
            was_yaz0=False,
        )
    sarc, is_compressed = load_sarc_file(disk_archive_path, romfs_path)
    out_bytes = _mutate_nested_set(sarc, segments, data, romfs_path)
    _save_sarc_bytes(disk_archive_path, out_bytes, is_compressed, romfs_path)


def delete_archive_entry(
    disk_archive_path: str,
    target_path: str,
    romfs_path: str,
) -> None:
    target_path = _normalize_path(target_path)
    _reject_bntx_mutation(disk_archive_path, "delete", target_path)
    if not target_path:
        raise ValueError("Missing target path")

    segments = [segment for segment in target_path.split("/") if segment]
    sarc, is_compressed = load_sarc_file(disk_archive_path, romfs_path)
    out_bytes = _mutate_nested_delete(sarc, segments, romfs_path)
    _save_sarc_bytes(disk_archive_path, out_bytes, is_compressed, romfs_path)


def rename_archive_entry(
    disk_archive_path: str,
    old_path: str,
    new_path: str,
    romfs_path: str,
) -> None:
    old_path = _normalize_path(old_path)
    new_path = _normalize_path(new_path)
    _reject_bntx_mutation(disk_archive_path, "rename", old_path)
    _reject_bntx_mutation(disk_archive_path, "rename", new_path)
    if not old_path or not new_path:
        raise ValueError("Missing rename path")

    old_segments = [segment for segment in old_path.split("/") if segment]
    new_segments = [segment for segment in new_path.split("/") if segment]
    sarc, is_compressed = load_sarc_file(disk_archive_path, romfs_path)
    out_bytes = _mutate_nested_rename(sarc, old_segments, new_segments, romfs_path)
    _save_sarc_bytes(disk_archive_path, out_bytes, is_compressed, romfs_path)
