"""Read/write Nintendo RESTBL resource size tables (``.rsizetable``).

TotK ships one at ``System/Resource/ResourceSizeTable.Product.<ver>.rsizetable.zs``;
it tells the game how much memory to reserve for every resource it loads. The
binary layout is::

    char[6] magic               "RESTBL"
    u32     version             1
    u32     string_block_size   bytes reserved per name-table string
    u32     crc_table_count
    u32     name_table_count
    { u32 hash, u32 size }[crc_table_count]                      sorted by hash
    { char[string_block_size] name, u32 size }[name_table_count]  sorted by name

Hash entries key on the CRC32 of a resource's canonical path (the RomFS-relative
path with the ``.zs`` extension removed), so the editor text resolves those
hashes back to readable paths using the game-dump indexes when they exist.
Anything that cannot be recovered stays a raw ``0x`` hash and is written back
unchanged.
"""

from __future__ import annotations

import os
import sqlite3
import struct
import zlib

from totk_compression import compress_container, decompress_container

MAGIC = b"RESTBL"
HEADER_SIZE = 22
DEFAULT_STRING_BLOCK_SIZE = 160
DEFAULT_VERSION = 1

_HASH_SECTION = "Hash"
_NAME_SECTION = "Name"

_ARCHIVE_SEPARATORS = (".pack/", ".sarc/", ".genvb/", ".blarc/", ".bfarc/", ".bkres/", ".bntx/")


class RstbError(ValueError):
    """Raised for malformed RESTBL binaries or editor text."""


def is_rstb_extension(logical_path: str) -> bool:
    lower = logical_path.lower().replace("\\", "/")
    if lower.endswith(".zs"):
        lower = lower[:-3]
    return lower.endswith(".rsizetable")


def is_rstb_binary(file_data: bytes) -> bool:
    if file_data[:6] == MAGIC:
        return True
    try:
        data, _, _ = decompress_container(file_data, "", "")
    except ValueError:
        return False
    return data[:6] == MAGIC


class ResourceSizeTable:
    def __init__(
        self,
        version: int = DEFAULT_VERSION,
        string_block_size: int = DEFAULT_STRING_BLOCK_SIZE,
        hash_entries: dict[int, int] | None = None,
        name_entries: dict[str, int] | None = None,
    ) -> None:
        self.version = version
        self.string_block_size = string_block_size
        self.hash_entries: dict[int, int] = hash_entries or {}
        self.name_entries: dict[str, int] = name_entries or {}


def parse_rstb(data: bytes) -> ResourceSizeTable:
    if len(data) < HEADER_SIZE:
        raise RstbError(f"File is too small to be a RESTBL ({len(data)} bytes).")
    if data[:6] != MAGIC:
        raise RstbError(f"Unknown RESTBL magic: {data[:6]!r}")

    version, string_block_size, crc_count, name_count = struct.unpack_from("<IIII", data, 6)
    if string_block_size == 0:
        raise RstbError("RESTBL header declares a zero-length string block.")

    expected = HEADER_SIZE + crc_count * 8 + name_count * (string_block_size + 4)
    if len(data) < expected:
        raise RstbError(
            f"RESTBL is truncated: header describes {expected} bytes, file has {len(data)}."
        )

    table = ResourceSizeTable(version, string_block_size)

    offset = HEADER_SIZE
    for hash_value, size in struct.iter_unpack("<II", data[offset : offset + crc_count * 8]):
        table.hash_entries[hash_value] = size

    offset += crc_count * 8
    stride = string_block_size + 4
    for index in range(name_count):
        start = offset + index * stride
        raw_name = data[start : start + string_block_size]
        name = raw_name.split(b"\x00", 1)[0].decode("utf-8", errors="replace")
        table.name_entries[name] = struct.unpack_from("<I", data, start + string_block_size)[0]

    return table


def build_rstb(table: ResourceSizeTable) -> bytes:
    string_block_size = table.string_block_size or DEFAULT_STRING_BLOCK_SIZE

    for name in table.name_entries:
        encoded = len(name.encode("utf-8"))
        if encoded >= string_block_size:
            raise RstbError(
                f"Name entry is too long for the {string_block_size}-byte string block "
                f"({encoded + 1} bytes needed): {name}. Raise StringBlockSize in the header "
                "to make room."
            )

    out = bytearray()
    out += MAGIC
    out += struct.pack(
        "<IIII",
        table.version,
        string_block_size,
        len(table.hash_entries),
        len(table.name_entries),
    )

    for hash_value in sorted(table.hash_entries):
        out += struct.pack("<II", hash_value, table.hash_entries[hash_value])

    for name in sorted(table.name_entries, key=lambda value: value.encode("utf-8")):
        out += name.encode("utf-8").ljust(string_block_size, b"\x00")
        out += struct.pack("<I", table.name_entries[name])

    return bytes(out)


def _resolve_names_enabled() -> bool:
    return os.environ.get("TKVSC_RSTB_RESOLVE_NAMES", "1").strip() != "0"


def _index_databases() -> list[tuple[str, str]]:
    sources = [
        (
            os.environ.get("TKVSC_CANONICAL_INDEX", "").strip(),
            "SELECT DISTINCT canonical_path FROM canonical_entries",
        ),
        (os.environ.get("TKVSC_ROMFS_INDEX", "").strip(), "SELECT path FROM files"),
    ]
    return [(path, query) for path, query in sources if path and os.path.isfile(path)]


def _path_candidates(path: str) -> list[str]:
    if path.endswith(".zs"):
        path = path[:-3]

    candidates = [path]
    if path.endswith(".mc"):
        candidates.append(path[:-3])

    best = -1
    best_length = 0
    for separator in _ARCHIVE_SEPARATORS:
        position = path.rfind(separator)
        if position > best:
            best = position
            best_length = len(separator)
    if best >= 0:
        candidates.append(path[best + best_length :])

    return candidates


def resolve_hash_names(hashes: set[int]) -> dict[int, str]:
    names: dict[int, str] = {}
    if not hashes or not _resolve_names_enabled():
        return names

    for db_path, query in _index_databases():
        try:
            connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        except sqlite3.Error:
            continue
        try:
            for (indexed_path,) in connection.execute(query):
                if not indexed_path:
                    continue
                for candidate in _path_candidates(indexed_path):
                    hash_value = zlib.crc32(candidate.encode("utf-8"))
                    if hash_value in hashes and hash_value not in names:
                        names[hash_value] = candidate
        except sqlite3.Error:
            continue
        finally:
            connection.close()

        if len(names) == len(hashes):
            break

    return names


def _quote_key(key: str) -> str:
    return '"' + key.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _unquote_key(key: str) -> str:
    if len(key) >= 2 and key[0] == key[-1] and key[0] in ('"', "'"):
        inner = key[1:-1]
        if key[0] == '"':
            return inner.replace('\\"', '"').replace("\\\\", "\\")
        return inner
    return key


def to_editor_text(table: ResourceSizeTable) -> str:
    names = resolve_hash_names(set(table.hash_entries))
    resolved = sorted((name, table.hash_entries[h]) for h, name in names.items())
    unresolved = sorted(h for h in table.hash_entries if h not in names)

    lines = [
        f"# Resource Size Table (RESTBL v{table.version})",
        "#",
        "# Hash: entries keyed by resource path - the path's CRC32 is what gets written",
        "#   back, so renaming a key re-points the entry. Paths that could not be",
        f"#   recovered from the game-dump index stay as raw 0x hashes ({len(unresolved)} of",
        f"#   {len(table.hash_entries)} here); their sizes are still editable.",
        "# Name: entries the table stores with an explicit name, used by the game when",
        "#   two paths collide. Names must fit in StringBlockSize bytes.",
        "",
        f"Version: {table.version}",
        f"StringBlockSize: {table.string_block_size}",
        "",
        f"{_HASH_SECTION}:",
    ]

    lines.extend(f"  {_quote_key(name)}: {size}" for name, size in resolved)
    if unresolved:
        lines.append("  # Unresolved hashes")
        lines.extend(f'  "0x{h:08x}": {table.hash_entries[h]}' for h in unresolved)

    lines.append("")
    lines.append(f"{_NAME_SECTION}:")
    lines.extend(
        f"  {_quote_key(name)}: {table.name_entries[name]}"
        for name in sorted(table.name_entries, key=lambda value: value.encode("utf-8"))
    )
    lines.append("")

    return "\n".join(lines)


def _parse_size(raw: str, line_number: int, key: str) -> int:
    text = raw.strip()
    try:
        size = int(text, 16) if text.lower().startswith("0x") else int(text)
    except ValueError:
        raise RstbError(f"Line {line_number}: size for {key} is not a number: {text}") from None
    if size < 0 or size > 0xFFFFFFFF:
        raise RstbError(f"Line {line_number}: size for {key} does not fit in a u32: {size}")
    return size


def from_editor_text(
    editor_text: str, fallback: ResourceSizeTable | None = None
) -> ResourceSizeTable:
    base = fallback or ResourceSizeTable()
    table = ResourceSizeTable(base.version, base.string_block_size)
    hash_sources: dict[int, str] = {}
    section: str | None = None

    for line_number, raw_line in enumerate(editor_text.splitlines(), start=1):
        line = raw_line.rstrip()
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        if not line[0].isspace():
            head, _, tail = stripped.partition(":")
            head = head.strip()
            tail = tail.strip()
            if head in (_HASH_SECTION, _NAME_SECTION) and not tail:
                section = head
                continue
            if head == "Version":
                table.version = _parse_size(tail, line_number, "Version")
                continue
            if head == "StringBlockSize":
                table.string_block_size = _parse_size(tail, line_number, "StringBlockSize")
                continue
            raise RstbError(f"Line {line_number}: unexpected top-level entry: {stripped}")

        if section is None:
            raise RstbError(
                f"Line {line_number}: entry outside a '{_HASH_SECTION}:' or "
                f"'{_NAME_SECTION}:' section: {stripped}"
            )

        key_text, separator, value_text = stripped.rpartition(":")
        if not separator:
            raise RstbError(f"Line {line_number}: expected '<key>: <size>', got: {stripped}")
        key = _unquote_key(key_text.strip())
        if not key:
            raise RstbError(f"Line {line_number}: entry has an empty key.")
        size = _parse_size(value_text, line_number, key)

        if section == _NAME_SECTION:
            table.name_entries[key] = size
            continue

        if key.lower().startswith("0x"):
            try:
                hash_value = int(key, 16)
            except ValueError:
                raise RstbError(f"Line {line_number}: invalid hash key: {key}") from None
            if hash_value > 0xFFFFFFFF:
                raise RstbError(f"Line {line_number}: hash does not fit in a u32: {key}")
        else:
            hash_value = zlib.crc32(key.encode("utf-8"))

        previous = hash_sources.get(hash_value)
        if previous is not None and previous != key:
            raise RstbError(
                f"Line {line_number}: {key} and {previous} share CRC32 0x{hash_value:08x}. "
                f"Move one of them to the '{_NAME_SECTION}:' section."
            )
        hash_sources[hash_value] = key
        table.hash_entries[hash_value] = size

    if table.string_block_size <= 0:
        raise RstbError("StringBlockSize must be greater than zero.")

    return table


def read_rstb_content(file_data: bytes, logical_path: str = "", romfs_path: str = "") -> str:
    file_data, _, _ = decompress_container(file_data, logical_path, romfs_path)
    if len(file_data) == 0:
        return to_editor_text(ResourceSizeTable())
    return to_editor_text(parse_rstb(file_data))


def write_rstb_bytes(
    orig_file_data: bytes,
    editor_text: str,
    logical_path: str = "",
    romfs_path: str = "",
) -> bytes:
    orig_file_data, is_zstd, is_yaz0 = decompress_container(
        orig_file_data, logical_path, romfs_path
    )
    if logical_path.lower().endswith(".zs"):
        is_zstd = True

    fallback: ResourceSizeTable | None = None
    if orig_file_data[:6] == MAGIC:
        try:
            fallback = parse_rstb(orig_file_data)
        except RstbError:
            fallback = None

    table = from_editor_text(editor_text, fallback)
    return compress_container(build_rstb(table), logical_path, romfs_path, is_zstd, is_yaz0)
