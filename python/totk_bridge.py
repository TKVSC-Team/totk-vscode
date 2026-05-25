import io
import json
import os
import sys
import tempfile
import contextlib
from pathlib import Path

import oead
from byml_editor_format import to_editor_text
from byml_yaml_utils import format_byml_for_editor, normalize_byml_u64_literals
from msbt_editor_format import to_editor_text as msbt_to_editor_text, from_editor_text as msbt_from_editor_text
from asb_io import (
    read_asb_content,
    read_baev_content,
    read_asb_content_disk,
    read_baev_content_disk,
    write_asb_bytes,
    write_baev_bytes,
    write_asb_disk,
    write_baev_disk,
)
from aamp_io import (
    is_aamp_binary,
    is_aamp_extension,
    read_aamp_content,
    write_aamp_bytes,
)
from xlink_io import (
    is_xlnk_binary,
    is_xlnk_extension,
    read_xlnk_content,
    write_xlnk_bytes,
)
from archive_resolve import list_archive_files, load_sarc_file, read_archive_file_bytes
from zstd_totk import compress_container, decompress_container

sys.stdout.reconfigure(encoding='utf-8')
sys.stdin.reconfigure(encoding='utf-8')

_LARGE_CONTENT_BYTES = 8 * 1024 * 1024


def _json_read_payload(content: str) -> dict:
    if len(content.encode('utf-8')) > _LARGE_CONTENT_BYTES:
        with tempfile.NamedTemporaryFile(
            mode='w',
            encoding='utf-8',
            suffix='.yaml',
            delete=False,
        ) as tmp:
            tmp.write(content)
            return {'contentPath': tmp.name}
    return {'content': content}


def export_archive_file_to_temp(archive_path: str, internal_path: str, romfs_path: str = '') -> str:
    file_data = read_archive_file_bytes(archive_path, internal_path, romfs_path)
    file_name = Path(internal_path).name or 'file.bin'
    safe_name = ''.join(ch if ch.isalnum() or ch in '._-' else '_' for ch in file_name)
    fd, tmp_path = tempfile.mkstemp(prefix='totk-tool-', suffix=f'-{safe_name}')
    with os.fdopen(fd, 'wb') as out:
        out.write(file_data)
    return tmp_path


def get_romfs_path():
    return os.environ.get('TOTK_EDITOR_ROMFS', '').strip()


def load_sarc(archive_path):
    return load_sarc_file(archive_path, get_romfs_path())


def save_sarc(archive_path, sarc_bytes, is_sarc_compressed):
    if is_sarc_compressed:
        romfs_path = get_romfs_path()
        sarc_bytes = compress_container(
            sarc_bytes,
            archive_path,
            romfs_path,
            was_zstd=True,
            was_yaz0=False,
        )
    with open(archive_path, 'wb') as f:
        f.write(sarc_bytes)


def read_byml_content(file_data, logical_path='', romfs_path=''):
    file_data, _, _ = decompress_container(file_data, logical_path, romfs_path)

    if not (file_data.startswith(b'YB') or file_data.startswith(b'BY')):
        return f'<Unknown BYML Magic: {file_data[:4]}>'

    is_little = file_data.startswith(b'YB')

    try:
        byml_doc = oead.byml.from_binary(file_data)
    except Exception as e:
        if 'version' in str(e).lower():
            mutable = bytearray(file_data)
            if is_little:
                mutable[2:4] = (4).to_bytes(2, 'little')
            else:
                mutable[2:4] = (4).to_bytes(2, 'big')
            byml_doc = oead.byml.from_binary(bytes(mutable))
        else:
            raise e

    try:
        return format_byml_for_editor(byml_doc)
    except Exception:
        return to_editor_text(byml_doc)


def read_msbt_content(file_data, logical_path='', romfs_path=''):
    from pymsbt.msbt import MSBTFile

    file_data, _, _ = decompress_container(file_data, logical_path, romfs_path)

    with tempfile.NamedTemporaryFile(suffix='.msbt', delete=False) as tmp:
        tmp.write(file_data)
        tmp_path = tmp.name

    try:
        with contextlib.redirect_stdout(io.StringIO()):
            msbt = MSBTFile(tmp_path)
        return msbt_to_editor_text(msbt.text_labels)
    finally:
        os.unlink(tmp_path)


def write_byml_bytes(orig_file_data, new_yaml, logical_path='', romfs_path=''):
    orig_file_data, is_zstd, is_yaz0 = decompress_container(
        orig_file_data, logical_path, romfs_path
    )

    if orig_file_data.startswith(b'BY'):
        big_endian = True
        version = int.from_bytes(orig_file_data[2:4], 'big')
    elif orig_file_data.startswith(b'YB'):
        big_endian = False
        version = int.from_bytes(orig_file_data[2:4], 'little')
    else:
        big_endian = False
        version = 7

    byml_doc = oead.byml.from_text(normalize_byml_u64_literals(new_yaml))

    try:
        new_byml_bytes = oead.byml.to_binary(byml_doc, big_endian=big_endian, version=version)
    except Exception as e:
        if 'version' in str(e).lower():
            new_byml_bytes = bytearray(oead.byml.to_binary(byml_doc, big_endian=big_endian, version=4))
            if big_endian:
                new_byml_bytes[2:4] = version.to_bytes(2, 'big')
            else:
                new_byml_bytes[2:4] = version.to_bytes(2, 'little')
            new_byml_bytes = bytes(new_byml_bytes)
        else:
            raise e

    return compress_container(new_byml_bytes, logical_path, romfs_path, is_zstd, is_yaz0)


def write_msbt_bytes(orig_file_data, editor_text, logical_path='', romfs_path=''):
    from pymsbt.msbt import MSBTFile
    from pymsbt.msbt_write import MSBTWriter

    orig_file_data, is_zstd, is_yaz0 = decompress_container(
        orig_file_data, logical_path, romfs_path
    )

    with tempfile.NamedTemporaryFile(suffix='.msbt', delete=False) as tmp:
        tmp.write(orig_file_data)
        tmp_path = tmp.name

    out_path = tmp_path + '.out'

    try:
        with contextlib.redirect_stdout(io.StringIO()):
            msbt = MSBTFile(tmp_path)

        updated = msbt_from_editor_text(editor_text)
        for label, components in updated.items():
            if label not in msbt.text_labels:
                raise ValueError(f'Unknown MSBT label: {label}')
            index = msbt.get_text_index(label)
            msbt.TXT2.texts[index] = components

        with contextlib.redirect_stdout(io.StringIO()):
            MSBTWriter(msbt, out_path)

        new_bytes = Path(out_path).read_bytes()
        return compress_container(new_bytes, logical_path, romfs_path, is_zstd, is_yaz0)
    finally:
        os.unlink(tmp_path)
        if os.path.exists(out_path):
            os.unlink(out_path)


def _file_kind(logical_path: str, file_data: bytes | None = None, romfs_path: str = '') -> str | None:
    lower = logical_path.lower().replace('\\', '/')
    if lower.endswith('.byml') or lower.endswith('.bgyml') or lower.endswith('.byml.zs') or lower.endswith('.bgyml.zs'):
        return 'byml'
    if lower.endswith('.msbt') or lower.endswith('.msbt.zs'):
        return 'msbt'
    if lower.endswith('.asb') or lower.endswith('.asb.zs'):
        return 'asb'
    if lower.endswith('.baev') or lower.endswith('.baev.zs'):
        return 'baev'
    if is_aamp_extension(logical_path):
        return 'aamp'
    if is_xlnk_extension(logical_path):
        return 'xlnk'
    if lower.endswith('.ainb') or lower.endswith('.ainb.zs'):
        return 'ainb'
    if file_data is not None:
        try:
            data, _, _ = decompress_container(file_data, logical_path, romfs_path)
        except ValueError:
            data = file_data
        if is_aamp_binary(data):
            return 'aamp'
        if is_xlnk_binary(data):
            return 'xlnk'
    return None


def read_file_content(file_data: bytes, logical_path: str, sarc=None, romfs_path: str = '') -> str:
    kind = _file_kind(logical_path, file_data, romfs_path)
    if kind == 'byml':
        return read_byml_content(file_data, logical_path, romfs_path)
    if kind == 'msbt':
        return read_msbt_content(file_data, logical_path, romfs_path)
    if kind == 'aamp':
        return read_aamp_content(file_data, logical_path, romfs_path)
    if kind == 'asb':
        if sarc is not None:
            return read_asb_content(file_data, logical_path, sarc, romfs_path)
        return read_asb_content_disk(logical_path, romfs_path)
    if kind == 'baev':
        if sarc is not None:
            return read_baev_content(file_data, logical_path, romfs_path)
        return read_baev_content_disk(logical_path, romfs_path)
    if kind == 'xlnk':
        return read_xlnk_content(file_data, logical_path, romfs_path)
    if kind == 'ainb':
        import subprocess, shutil
        bin_path = shutil.which('ainb')
        result = subprocess.run([bin_path, logical_path], capture_output=True, text=True, check=True)
        return result.stdout
    return (
        f'<Binary Data: {len(file_data)} bytes. '
        'Editable types: .byml, .bgyml, .msbt, .asb, .baev, .belnk, .bslnk, '
        'AAMP (many extensions — see aamp-extensions.json)>'
    )


def write_file_content(logical_path: str, editor_text: str, sarc, is_sarc_compressed, archive_path, romfs_path: str = ''):
    kind = _file_kind(logical_path)
    if kind is None:
        kind = _file_kind(logical_path, read_archive_file_bytes(archive_path, logical_path, romfs_path), romfs_path)
    if kind == 'byml':
        orig = read_archive_file_bytes(archive_path, logical_path, romfs_path)
        new_bytes = write_byml_bytes(orig, editor_text, logical_path, romfs_path)
        writer = oead.SarcWriter.from_sarc(sarc)
        writer.files[logical_path] = new_bytes
        save_sarc(archive_path, writer.write()[1], is_sarc_compressed)
    elif kind == 'msbt':
        orig = read_archive_file_bytes(archive_path, logical_path, romfs_path)
        new_bytes = write_msbt_bytes(orig, editor_text, logical_path, romfs_path)
        writer = oead.SarcWriter.from_sarc(sarc)
        writer.files[logical_path] = new_bytes
        save_sarc(archive_path, writer.write()[1], is_sarc_compressed)
    elif kind == 'aamp':
        orig = read_archive_file_bytes(archive_path, logical_path, romfs_path)
        new_bytes = write_aamp_bytes(orig, editor_text, logical_path, romfs_path)
        writer = oead.SarcWriter.from_sarc(sarc)
        writer.files[logical_path] = new_bytes
        save_sarc(archive_path, writer.write()[1], is_sarc_compressed)
    elif kind == 'asb':
        if sarc is not None:
            new_sarc_bytes = write_asb_bytes(sarc, logical_path, editor_text, romfs_path)
            save_sarc(archive_path, new_sarc_bytes, is_sarc_compressed)
        else:
            write_asb_disk(logical_path, editor_text, romfs_path)
    elif kind == 'baev':
        if sarc is not None:
            new_sarc_bytes = write_baev_bytes(sarc, logical_path, editor_text, romfs_path)
            save_sarc(archive_path, new_sarc_bytes, is_sarc_compressed)
        else:
            write_baev_disk(logical_path, editor_text, romfs_path)
    elif kind == 'xlnk':
        orig = read_archive_file_bytes(archive_path, logical_path, romfs_path)
        new_bytes = write_xlnk_bytes(orig, editor_text, logical_path, romfs_path)
        writer = oead.SarcWriter.from_sarc(sarc)
        writer.files[logical_path] = new_bytes
        save_sarc(archive_path, writer.write()[1], is_sarc_compressed)
    elif kind == 'ainb':
        raise ValueError('AINB writing is not yet supported')
    else:
        raise ValueError(f'Cannot write file type: {logical_path}')


def main():
    try:
        command = sys.argv[1]
        romfs_path = get_romfs_path()

        if command == 'read-disk':
            file_path = sys.argv[2]
            file_data = Path(file_path).read_bytes()
            print(json.dumps(_json_read_payload(read_file_content(file_data, file_path, None, romfs_path))))

        elif command == 'write-disk':
            file_path = sys.argv[2]
            editor_text = sys.stdin.read()
            kind = _file_kind(file_path)
            if kind is None:
                kind = _file_kind(file_path, Path(file_path).read_bytes(), romfs_path)
            if kind == 'byml':
                Path(file_path).write_bytes(
                    write_byml_bytes(Path(file_path).read_bytes(), editor_text, file_path, romfs_path)
                )
            elif kind == 'msbt':
                Path(file_path).write_bytes(
                    write_msbt_bytes(Path(file_path).read_bytes(), editor_text, file_path, romfs_path)
                )
            elif kind == 'aamp':
                Path(file_path).write_bytes(
                    write_aamp_bytes(Path(file_path).read_bytes(), editor_text, file_path, romfs_path)
                )
            elif kind == 'asb':
                write_asb_disk(file_path, editor_text, romfs_path)
            elif kind == 'baev':
                write_baev_disk(file_path, editor_text, romfs_path)
            elif kind == 'xlnk':
                Path(file_path).write_bytes(
                    write_xlnk_bytes(Path(file_path).read_bytes(), editor_text, file_path, romfs_path)
                )
            else:
                raise ValueError(f'Cannot write file type: {file_path}')
            print(json.dumps({'success': True}))

        else:
            archive_path = sys.argv[2]

            if command == 'list':
                locator_path = sys.argv[3] if len(sys.argv) > 3 else ''
                files = list_archive_files(archive_path, locator_path, romfs_path)
                print(json.dumps(files))

            elif command == 'read':
                internal_path = sys.argv[3]
                file_data = read_archive_file_bytes(archive_path, internal_path, romfs_path)
                print(
                    json.dumps(
                        _json_read_payload(
                            read_file_content(file_data, internal_path, None, romfs_path)
                        )
                    )
                )

            elif command == 'export-temp':
                internal_path = sys.argv[3]
                print(
                    json.dumps(
                        {'path': export_archive_file_to_temp(archive_path, internal_path, romfs_path)}
                    )
                )

            elif command == 'write':
                sarc, is_sarc_compressed = load_sarc(archive_path)
                internal_path = sys.argv[3]
                editor_text = sys.stdin.read()
                write_file_content(internal_path, editor_text, sarc, is_sarc_compressed, archive_path, romfs_path)
                print(json.dumps({'success': True}))

    except Exception as e:
        print(json.dumps({'error': str(e)}))
        sys.exit(0)


if __name__ == '__main__':
    main()
