"""Read/write ASB and BAEV using the vendored dt-12345/asb toolkit."""

import io
import json
import os
import sys
import tempfile
from contextlib import contextmanager, redirect_stdout
from pathlib import Path

import oead
import zstandard as zstd

_SCRIPT_DIR = Path(__file__).resolve().parent
_ASB_TOOLKIT_DIRS = [
    _SCRIPT_DIR / 'vendor' / 'asb',
    _SCRIPT_DIR.parent / 'vendor' / 'asb',
]


def _ensure_asb_toolkit_on_path() -> None:
    for toolkit_dir in _ASB_TOOLKIT_DIRS:
        toolkit_str = str(toolkit_dir)
        if toolkit_dir.is_dir() and toolkit_str not in sys.path:
            sys.path.insert(0, toolkit_str)


@contextmanager
def _quiet_asb():
    with redirect_stdout(io.StringIO()):
        yield


def _stem_from_internal_path(internal_path: str) -> str:
    name = os.path.basename(internal_path.replace('\\', '/'))
    if name.endswith('.zs'):
        name = name[:-3]
    if name.endswith('.baev'):
        return name[:-5]
    if name.endswith('.asb'):
        return name[:-4]
    return os.path.splitext(name)[0]


# ASB files live in .../AS/<stem>.asb
# Their paired AsNode BAEV files live in .../AnimationEvent/AsNode/<stem>.baev
# These two functions map between those locations.

def _sibling_baev_path(internal_path: str) -> str:
    """Map a SARC-internal ASB path to its sibling AsNode BAEV path.

    Actor/AS/Foo.root.asb      -> Actor/AnimationEvent/AsNode/Foo.root.baev
    Actor/AS/Foo.root.asb.zs   -> Actor/AnimationEvent/AsNode/Foo.root.baev.zs
    Returns '' if the path is not inside an AS directory.
    """
    normalized = internal_path.replace('\\', '/')

    if normalized.endswith('.asb.zs'):
        stem_path = normalized[:-7]
        baev_ext = '.baev.zs'
    elif normalized.endswith('.asb'):
        stem_path = normalized[:-4]
        baev_ext = '.baev'
    else:
        return ''

    parts = stem_path.split('/')
    stem = parts[-1]
    dir_parts = parts[:-1]

    new_dir_parts = []
    replaced = False
    for p in dir_parts:
        if not replaced and p == 'AS':
            new_dir_parts.extend(['AnimationEvent', 'AsNode'])
            replaced = True
        else:
            new_dir_parts.append(p)

    if not replaced:
        return ''

    return '/'.join(new_dir_parts + [stem + baev_ext])


def _sibling_baev_disk_path(file_path: str) -> str:
    """Map a disk ASB path to its sibling AsNode BAEV path.

    /romfs/Actor/AS/Foo.root.asb    -> /romfs/Actor/AnimationEvent/AsNode/Foo.root.baev
    /romfs/Actor/AS/Foo.root.asb.zs -> /romfs/Actor/AnimationEvent/AsNode/Foo.root.baev.zs
    Returns '' if the path is not inside an AS directory.
    """
    normalized = file_path.replace('\\', '/')

    if normalized.endswith('.asb.zs'):
        stem_path = normalized[:-7]
        baev_ext = '.baev.zs'
    elif normalized.endswith('.asb'):
        stem_path = normalized[:-4]
        baev_ext = '.baev'
    else:
        return ''

    parts = stem_path.split('/')
    stem = parts[-1]
    dir_parts = parts[:-1]

    new_dir_parts = []
    replaced = False
    for p in dir_parts:
        if not replaced and p == 'AS':
            new_dir_parts.extend(['AnimationEvent', 'AsNode'])
            replaced = True
        else:
            new_dir_parts.append(p)

    if not replaced:
        return ''

    return '/'.join(new_dir_parts + [stem + baev_ext])


def _decompress_bytes(data: bytes, internal_path: str, romfs_path: str) -> bytes:
    from zstd_totk import decompress_container

    payload, _, _ = decompress_container(data, internal_path, romfs_path)
    return payload


def _compress_bytes(data: bytes, internal_path: str, romfs_path: str, was_compressed: bool) -> bytes:
    if not was_compressed:
        return data

    from zstd_totk import compress_container

    logical = internal_path
    if not logical.endswith('.zs'):
        if internal_path.endswith('.asb') or internal_path.endswith('.baev'):
            logical = internal_path + '.zs'
    return compress_container(data, logical, romfs_path, was_zstd=True, was_yaz0=False)


def read_asb_content(file_data: bytes, internal_path: str, sarc, romfs_path: str = '') -> str:
    _ensure_asb_toolkit_on_path()
    from asb import ASB

    data = _decompress_bytes(file_data, internal_path, romfs_path)
    with _quiet_asb():
        asb_file = ASB.from_binary(data)

        baev_internal = _sibling_baev_path(internal_path)
        if baev_internal:
            try:
                baev_data = bytes(sarc.get_file(baev_internal).data)
                baev_data = _decompress_bytes(baev_data, baev_internal, romfs_path)
                asb_file.import_baev(baev_data)
            except Exception as e:
                import traceback
                print(f"Warning: Failed to import BAEV from {baev_internal}: {e}\n{traceback.format_exc()}", file=sys.stderr)

    return json.dumps(asb_file.asdict(), indent=2, ensure_ascii=False) + '\n'


def read_baev_content(file_data: bytes, internal_path: str, romfs_path: str = '') -> str:
    _ensure_asb_toolkit_on_path()
    from baev import BAEV

    data = _decompress_bytes(file_data, internal_path, romfs_path)
    filename = _stem_from_internal_path(internal_path)
    with _quiet_asb():
        baev_file = BAEV.from_binary(data, filename)
    return json.dumps(baev_file.events, indent=2, ensure_ascii=False) + '\n'


def write_asb_bytes(
    sarc,
    internal_path: str,
    editor_text: str,
    romfs_path: str = '',
) -> bytes:
    _ensure_asb_toolkit_on_path()
    from asb import ASB

    orig_file_data = bytes(sarc.get_file(internal_path).data)
    was_zstd = orig_file_data.startswith(b'\x28\xb5\x2f\xfd')

    asb_file = ASB.from_dict(json.loads(editor_text))

    with tempfile.TemporaryDirectory() as tmp_dir:
        with _quiet_asb():
            asb_file.to_binary(tmp_dir)

        new_asb_bytes = Path(tmp_dir, f'{asb_file.filename}.asb').read_bytes()
        new_asb_bytes = _compress_bytes(new_asb_bytes, internal_path, romfs_path, was_zstd)

        writer = oead.SarcWriter.from_sarc(sarc)
        writer.files[internal_path] = new_asb_bytes

        baev_internal = _sibling_baev_path(internal_path)
        baev_path = Path(tmp_dir, f'{asb_file.filename}.baev')
        if baev_internal and baev_path.is_file():
            try:
                orig_baev = bytes(sarc.get_file(baev_internal).data)
            except Exception:
                orig_baev = b''
            was_baev_zstd = orig_baev.startswith(b'\x28\xb5\x2f\xfd')
            new_baev_bytes = baev_path.read_bytes()
            new_baev_bytes = _compress_bytes(new_baev_bytes, baev_internal, romfs_path, was_baev_zstd)
            writer.files[baev_internal] = new_baev_bytes

        return writer.write()[1]


def write_baev_bytes(
    sarc,
    internal_path: str,
    editor_text: str,
    romfs_path: str = '',
) -> bytes:
    _ensure_asb_toolkit_on_path()
    from baev import BAEV

    orig_file_data = bytes(sarc.get_file(internal_path).data)
    was_zstd = orig_file_data.startswith(b'\x28\xb5\x2f\xfd')

    filename = _stem_from_internal_path(internal_path)
    baev_file = BAEV.from_dict(json.loads(editor_text), filename)

    with tempfile.TemporaryDirectory() as tmp_dir:
        with _quiet_asb():
            baev_file.to_binary(tmp_dir)

        new_baev_bytes = Path(tmp_dir, f'{baev_file.filename}.baev').read_bytes()
        new_baev_bytes = _compress_bytes(new_baev_bytes, internal_path, romfs_path, was_zstd)

        writer = oead.SarcWriter.from_sarc(sarc)
        writer.files[internal_path] = new_baev_bytes
        return writer.write()[1]


def read_asb_content_disk(file_path: str, romfs_path: str = '') -> str:
    _ensure_asb_toolkit_on_path()
    from asb import ASB

    data = _decompress_bytes(Path(file_path).read_bytes(), file_path, romfs_path)
    with _quiet_asb():
        asb_file = ASB.from_binary(data)

        baev_path = _sibling_baev_disk_path(file_path)
        if baev_path and os.path.isfile(baev_path):
            try:
                baev_data = _decompress_bytes(Path(baev_path).read_bytes(), baev_path, romfs_path)
                asb_file.import_baev(baev_data)
            except Exception as e:
                import traceback
                print(f"Warning: Failed to import BAEV from {baev_path}: {e}\n{traceback.format_exc()}", file=sys.stderr)

    return json.dumps(asb_file.asdict(), indent=2, ensure_ascii=False) + '\n'


def read_baev_content_disk(file_path: str, romfs_path: str = '') -> str:
    return read_baev_content(Path(file_path).read_bytes(), file_path, romfs_path)


def write_asb_disk(file_path: str, editor_text: str, romfs_path: str = '') -> None:
    _ensure_asb_toolkit_on_path()
    from asb import ASB

    orig_file_data = Path(file_path).read_bytes()
    was_zstd = orig_file_data.startswith(b'\x28\xb5\x2f\xfd')

    asb_file = ASB.from_dict(json.loads(editor_text))

    with tempfile.TemporaryDirectory() as tmp_dir:
        with _quiet_asb():
            asb_file.to_binary(tmp_dir)

        new_asb_bytes = Path(tmp_dir, f'{asb_file.filename}.asb').read_bytes()
        new_asb_bytes = _compress_bytes(new_asb_bytes, file_path, romfs_path, was_zstd)
        Path(file_path).write_bytes(new_asb_bytes)

        baev_path = _sibling_baev_disk_path(file_path)
        out_baev = Path(tmp_dir, f'{asb_file.filename}.baev')
        if baev_path and out_baev.is_file():
            orig_baev = Path(baev_path).read_bytes() if os.path.isfile(baev_path) else b''
            was_baev_zstd = orig_baev.startswith(b'\x28\xb5\x2f\xfd')
            new_baev_bytes = _compress_bytes(out_baev.read_bytes(), baev_path, romfs_path, was_baev_zstd)
            Path(baev_path).write_bytes(new_baev_bytes)


def write_baev_disk(file_path: str, editor_text: str, romfs_path: str = '') -> None:
    _ensure_asb_toolkit_on_path()
    from baev import BAEV

    orig_file_data = Path(file_path).read_bytes()
    was_zstd = orig_file_data.startswith(b'\x28\xb5\x2f\xfd')

    filename = _stem_from_internal_path(file_path)
    baev_file = BAEV.from_dict(json.loads(editor_text), filename)

    with tempfile.TemporaryDirectory() as tmp_dir:
        with _quiet_asb():
            baev_file.to_binary(tmp_dir)

        new_baev_bytes = Path(tmp_dir, f'{baev_file.filename}.baev').read_bytes()
        new_baev_bytes = _compress_bytes(new_baev_bytes, file_path, romfs_path, was_zstd)
        Path(file_path).write_bytes(new_baev_bytes)
