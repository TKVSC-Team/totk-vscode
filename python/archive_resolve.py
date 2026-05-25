"""Resolve nested .pack / .sarc / .genvb paths to an open SARC and in-archive prefix."""

import re

import oead

from zstd_totk import decompress_container

_ARCHIVE_SEGMENT = re.compile(r'\.(pack|sarc|genvb)(\.zs)?$', re.IGNORECASE)
_ZSTD_MAGIC = b'\x28\xb5\x2f\xfd'


def _is_archive_name(name: str) -> bool:
    return bool(_ARCHIVE_SEGMENT.search(name.replace('\\', '/')))


def _normalize_path(path: str) -> str:
    return path.replace('\\', '/').strip('/')


def load_sarc_file(archive_path: str, romfs_path: str):
    with open(archive_path, 'rb') as handle:
        data = handle.read()

    is_compressed = data.startswith(_ZSTD_MAGIC)
    if is_compressed:
        data, _, _ = decompress_container(data, archive_path, romfs_path)

    return oead.Sarc(data), is_compressed


def _get_file_bytes(sarc, internal_path: str) -> bytes:
    entry = sarc.get_file(internal_path)
    if entry is None:
        raise FileNotFoundError(
            f'File not found in archive: {internal_path!r}. '
            f'Known paths sample: {[f.name for f in list(sarc.get_files())[:5]]}...'
        )
    return bytes(entry.data)


def resolve_sarc_view(disk_archive_path: str, locator_path: str, romfs_path: str):
    """
    Open the on-disk archive and walk nested archive *files* along locator_path.

    Returns (sarc, path_prefix, is_disk_compressed, consumed_archive_prefix) where:
    - path_prefix is the path of ``locator_path`` inside the innermost open SARC
      (after nested archives)
    - consumed_archive_prefix is the virtual path from the disk archive root to
      the current innermost open archive (e.g. "A.sarc" or "dir/A.sarc/B.sarc")
    """
    locator_path = _normalize_path(locator_path)
    sarc, is_compressed = load_sarc_file(disk_archive_path, romfs_path)

    if not locator_path:
        return sarc, '', is_compressed, ''

    segments = locator_path.split('/')
    after_archive = 0
    consumed_archive_segments: list[str] = []

    for index, segment in enumerate(segments):
        if not _is_archive_name(segment):
            continue

        # Relative to the currently open SARC, not always the disk archive root.
        entry_path = '/'.join(segments[after_archive: index + 1])
        file_data = _get_file_bytes(sarc, entry_path)
        file_data, _, _ = decompress_container(file_data, entry_path, romfs_path)
        sarc = oead.Sarc(file_data)
        consumed_archive_segments.extend(segments[after_archive: index + 1])
        after_archive = index + 1

    path_prefix = '/'.join(segments[after_archive:]).strip('/')
    consumed_archive_prefix = '/'.join(consumed_archive_segments).strip('/')
    return sarc, path_prefix, is_compressed, consumed_archive_prefix


def list_archive_files(disk_archive_path: str, locator_path: str, romfs_path: str) -> list[str]:
    sarc, prefix, _, consumed_archive_prefix = resolve_sarc_view(
        disk_archive_path, locator_path, romfs_path
    )
    names = [file.name for file in sarc.get_files()]
    if prefix:
        prefix_slash = prefix + '/'
        names = [name for name in names if name.startswith(prefix_slash)]
    if consumed_archive_prefix:
        return [f'{consumed_archive_prefix}/{name}' for name in names]
    return names


def read_archive_file_bytes(disk_archive_path: str, file_path: str, romfs_path: str) -> bytes:
    file_path = _normalize_path(file_path)
    if not file_path:
        raise IsADirectoryError(file_path)

    leaf = file_path.split('/')[-1]
    if _is_archive_name(leaf):
        raise IsADirectoryError(file_path)

    sarc, lookup, _, _ = resolve_sarc_view(disk_archive_path, file_path, romfs_path)
    return _get_file_bytes(sarc, lookup)
