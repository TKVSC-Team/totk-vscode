import io
import json
import os
import sys
import tempfile
import contextlib

import zstandard as zstd
import oead
from byml_editor_format import to_editor_text
from msbt_editor_format import to_editor_text as msbt_to_editor_text, from_editor_text as msbt_from_editor_text

sys.stdout.reconfigure(encoding='utf-8')
sys.stdin.reconfigure(encoding='utf-8')

def get_byml_data(file_data):
    is_zstd = False
    is_yaz0 = False
    if file_data.startswith(b'\x28\xb5\x2f\xfd'):
        file_data = zstd.ZstdDecompressor().decompress(file_data)
        is_zstd = True
    elif file_data.startswith(b'Yaz0'):
        file_data = oead.yaz0.decompress(file_data)
        is_yaz0 = True
    return file_data, is_zstd, is_yaz0


def load_sarc(archive_path):
    with open(archive_path, 'rb') as f:
        data = f.read()

    is_sarc_compressed = data.startswith(b'\x28\xb5\x2f\xfd')
    if is_sarc_compressed:
        data = zstd.ZstdDecompressor().decompress(data)

    return oead.Sarc(data), is_sarc_compressed


def save_sarc(archive_path, sarc_bytes, is_sarc_compressed):
    if is_sarc_compressed:
        sarc_bytes = zstd.ZstdCompressor().compress(sarc_bytes)
    with open(archive_path, 'wb') as f:
        f.write(sarc_bytes)


def read_byml_content(file_data):
    file_data, _, _ = get_byml_data(file_data)

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

    return to_editor_text(byml_doc)


def read_msbt_content(file_data):
    from pymsbt.msbt import MSBTFile

    with tempfile.NamedTemporaryFile(suffix='.msbt', delete=False) as tmp:
        tmp.write(file_data)
        tmp_path = tmp.name

    try:
        with contextlib.redirect_stdout(io.StringIO()):
            msbt = MSBTFile(tmp_path)
        return msbt_to_editor_text(msbt.text_labels)
    finally:
        os.unlink(tmp_path)


def write_byml_to_sarc(sarc, internal_path, new_yaml, is_sarc_compressed, archive_path):
    orig_file_data = bytes(sarc.get_file(internal_path).data)
    orig_file_data, is_zstd, is_yaz0 = get_byml_data(orig_file_data)

    if orig_file_data.startswith(b'BY'):
        big_endian = True
        version = int.from_bytes(orig_file_data[2:4], 'big')
    elif orig_file_data.startswith(b'YB'):
        big_endian = False
        version = int.from_bytes(orig_file_data[2:4], 'little')
    else:
        big_endian = False
        version = 7

    byml_doc = oead.byml.from_text(new_yaml)

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

    if is_zstd:
        new_byml_bytes = zstd.ZstdCompressor().compress(new_byml_bytes)
    elif is_yaz0:
        new_byml_bytes = oead.yaz0.compress(new_byml_bytes)

    writer = oead.SarcWriter.from_sarc(sarc)
    writer.files[internal_path] = new_byml_bytes
    save_sarc(archive_path, writer.write()[1], is_sarc_compressed)


def write_msbt_to_sarc(sarc, internal_path, editor_text, is_sarc_compressed, archive_path):
    from pymsbt.msbt import MSBTFile
    from pymsbt.msbt_write import MSBTWriter

    orig_file_data = bytes(sarc.get_file(internal_path).data)

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

        with open(out_path, 'rb') as f:
            new_msbt_bytes = f.read()
    finally:
        os.unlink(tmp_path)
        if os.path.exists(out_path):
            os.unlink(out_path)

    writer = oead.SarcWriter.from_sarc(sarc)
    writer.files[internal_path] = new_msbt_bytes
    save_sarc(archive_path, writer.write()[1], is_sarc_compressed)


def main():
    try:
        command = sys.argv[1]
        archive_path = sys.argv[2]

        sarc, is_sarc_compressed = load_sarc(archive_path)

        if command == 'list':
            files = [file.name for file in sarc.get_files()]
            print(json.dumps(files))

        elif command == 'read':
            internal_path = sys.argv[3]
            file_data = bytes(sarc.get_file(internal_path).data)

            if internal_path.endswith('.byml') or internal_path.endswith('.bgyml'):
                print(json.dumps({'content': read_byml_content(file_data)}))
            elif internal_path.endswith('.msbt'):
                print(json.dumps({'content': read_msbt_content(file_data)}))
            else:
                print(
                    json.dumps(
                        {
                            'content': (
                                f'<Binary Data: {len(file_data)} bytes. '
                                'Editable types: .byml, .bgyml, .msbt>'
                            )
                        }
                    )
                )

        elif command == 'write':
            internal_path = sys.argv[3]
            editor_text = sys.stdin.read()

            if internal_path.endswith('.byml') or internal_path.endswith('.bgyml'):
                write_byml_to_sarc(sarc, internal_path, editor_text, is_sarc_compressed, archive_path)
            elif internal_path.endswith('.msbt'):
                write_msbt_to_sarc(sarc, internal_path, editor_text, is_sarc_compressed, archive_path)
            else:
                raise ValueError(f'Cannot write file type: {internal_path}')

            print(json.dumps({'success': True}))

    except Exception as e:
        print(json.dumps({'error': str(e)}))
        sys.exit(0)


if __name__ == '__main__':
    main()
