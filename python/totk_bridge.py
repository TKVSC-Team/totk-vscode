import base64
import contextlib
import io
import json
import os
import sys
import tempfile
from pathlib import Path

import oead
from aamp_io import (
    is_aamp_binary,
    is_aamp_extension,
    read_aamp_content,
    write_aamp_bytes,
)
from archive_resolve import (
    delete_archive_entry,
    list_archive_files,
    load_sarc_file,
    read_archive_file_bytes,
    rename_archive_entry,
    write_archive_file_bytes,
)
from asb_io import (
    read_asb_content,
    read_asb_content_disk,
    read_baev_content,
    read_baev_content_disk,
    write_asb_bytes,
    write_asb_disk,
    write_baev_bytes,
    write_baev_disk,
)
from byml_editor_format import to_editor_text
from byml_yaml_utils import format_byml_for_editor, normalize_byml_u64_literals
from msbt_editor_format import from_editor_text as msbt_from_editor_text
from msbt_editor_format import to_editor_text as msbt_to_editor_text
from tag_product_format import from_editor_text as tag_product_from_editor_text
from tag_product_format import to_editor_text as tag_product_to_editor_text
from xlink_io import (
    is_xlnk_binary,
    is_xlnk_extension,
    read_xlnk_content,
    write_xlnk_bytes,
)
from zstd_totk import compress_container, decompress_container

sys.stdout.reconfigure(encoding="utf-8")
sys.stdin.reconfigure(encoding="utf-8")

_LARGE_CONTENT_BYTES = 8 * 1024 * 1024


def _json_read_payload(content: str) -> dict:
    if len(content.encode("utf-8")) > _LARGE_CONTENT_BYTES:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            suffix=".yaml",
            delete=False,
        ) as tmp:
            tmp.write(content)
            return {"contentPath": tmp.name}
    return {"content": content}


def _resolve_bntx_for_read(archive_path: str, internal_path: str, romfs_path: str):
    """If this read targets a BNTX texture, return (bntx_bytes, texture_name). Else None."""
    from archive_resolve import _resolve_bntx_data

    result = _resolve_bntx_data(archive_path, internal_path, romfs_path)
    if result is None:
        return None
    bntx_data, remainder, _ = result
    if not remainder:
        return None
    return bntx_data, remainder


def _read_bntx_texture_result(bntx_data: bytes, texture_name: str) -> dict:
    """Return a dict with metadata + base64 PNG for a BNTX texture."""
    from bntx_renderer import get_texture_metadata, render_texture_to_png

    metadata = get_texture_metadata(bntx_data, texture_name)
    result: dict = {"bntxTexture": True}
    if metadata:
        result["metadata"] = metadata
    png_path = render_texture_to_png(bntx_data, texture_name)
    if png_path:
        result["pngPath"] = png_path
    return result


def _read_txtg_texture_result(file_data: bytes, texture_name: str, logical_path: str) -> dict:
    from txtg_reader import read_txtg_texture_result

    try:
        payload, _, _ = decompress_container(file_data, logical_path, get_romfs_path())
    except Exception:
        payload = file_data
    return read_txtg_texture_result(payload, texture_name)


def export_archive_file_to_temp(archive_path: str, internal_path: str, romfs_path: str = "") -> str:
    file_data = read_archive_file_bytes(archive_path, internal_path, romfs_path)
    file_name = Path(internal_path).name or "file.bin"
    safe_name = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in file_name)
    fd, tmp_path = tempfile.mkstemp(prefix="totk-tool-", suffix=f"-{safe_name}")
    with os.fdopen(fd, "wb") as out:
        out.write(file_data)
    return tmp_path


def get_romfs_path():
    return os.environ.get("TOTK_EDITOR_ROMFS", "").strip()


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
    with open(archive_path, "wb") as f:
        f.write(sarc_bytes)


def read_byml_content(file_data, logical_path="", romfs_path=""):
    file_data, _, _ = decompress_container(file_data, logical_path, romfs_path)
    if len(file_data) == 0:
        return "{}\n"

    if not (file_data.startswith(b"YB") or file_data.startswith(b"BY")):
        return f"<Unknown BYML Magic: {file_data[:4]}>"

    is_little = file_data.startswith(b"YB")

    try:
        byml_doc = oead.byml.from_binary(file_data)
    except Exception as e:
        if "version" in str(e).lower():
            mutable = bytearray(file_data)
            if is_little:
                mutable[2:4] = (4).to_bytes(2, "little")
            else:
                mutable[2:4] = (4).to_bytes(2, "big")
            byml_doc = oead.byml.from_binary(bytes(mutable))
        else:
            raise e

    file_name = Path(logical_path).name.lower()
    if file_name.startswith("tag.product.") and "rstbl" in file_name:
        try:
            return tag_product_to_editor_text(byml_doc)
        except Exception:
            pass

    try:
        return to_editor_text(byml_doc)
    except Exception:
        return format_byml_for_editor(byml_doc)


def read_msbt_content(file_data, logical_path="", romfs_path=""):
    from pymsbt.msbt import MSBTFile

    file_data, _, _ = decompress_container(file_data, logical_path, romfs_path)
    if len(file_data) == 0:
        return (
            "# New MSBT file detected.\n"
            "# Creating MSBT from empty data is not supported yet.\n"
            "# Copy an existing MSBT as a template, then edit labels.\n"
        )

    with tempfile.NamedTemporaryFile(suffix=".msbt", delete=False) as tmp:
        tmp.write(file_data)
        tmp_path = tmp.name

    try:
        with contextlib.redirect_stdout(io.StringIO()):
            msbt = MSBTFile(tmp_path)
        return msbt_to_editor_text(msbt.text_labels)
    finally:
        os.unlink(tmp_path)


def write_byml_bytes(orig_file_data, new_yaml, logical_path="", romfs_path=""):
    orig_file_data, is_zstd, is_yaz0 = decompress_container(
        orig_file_data, logical_path, romfs_path
    )
    if logical_path.lower().endswith(".zs"):
        is_zstd = True

    if orig_file_data.startswith(b"BY"):
        big_endian = True
        version = int.from_bytes(orig_file_data[2:4], "big")
    elif orig_file_data.startswith(b"YB"):
        big_endian = False
        version = int.from_bytes(orig_file_data[2:4], "little")
    else:
        big_endian = False
        version = 7

    file_name = Path(logical_path).name.lower()
    if file_name.startswith("tag.product.") and "rstbl" in file_name:
        new_byml_bytes = tag_product_from_editor_text(new_yaml, big_endian, version)
        return compress_container(new_byml_bytes, logical_path, romfs_path, is_zstd, is_yaz0)

    byml_doc = oead.byml.from_text(normalize_byml_u64_literals(new_yaml))

    try:
        new_byml_bytes = oead.byml.to_binary(byml_doc, big_endian=big_endian, version=version)
    except Exception as e:
        if "version" in str(e).lower():
            new_byml_bytes = bytearray(
                oead.byml.to_binary(byml_doc, big_endian=big_endian, version=4)
            )
            if big_endian:
                new_byml_bytes[2:4] = version.to_bytes(2, "big")
            else:
                new_byml_bytes[2:4] = version.to_bytes(2, "little")
            new_byml_bytes = bytes(new_byml_bytes)
        else:
            raise e

    return compress_container(new_byml_bytes, logical_path, romfs_path, is_zstd, is_yaz0)


def write_msbt_bytes(orig_file_data, editor_text, logical_path="", romfs_path=""):
    from pymsbt.msbt import MSBTFile
    from pymsbt.msbt_write import MSBTWriter

    orig_file_data, is_zstd, is_yaz0 = decompress_container(
        orig_file_data, logical_path, romfs_path
    )
    if logical_path.lower().endswith(".zs"):
        is_zstd = True
    if len(orig_file_data) == 0:
        raise ValueError(
            "Cannot create MSBT from empty file yet. Copy an existing .msbt as a template first."
        )

    with tempfile.NamedTemporaryFile(suffix=".msbt", delete=False) as tmp:
        tmp.write(orig_file_data)
        tmp_path = tmp.name

    out_path = tmp_path + ".out"

    try:
        with contextlib.redirect_stdout(io.StringIO()):
            msbt = MSBTFile(tmp_path)

        updated = msbt_from_editor_text(editor_text)
        for label, components in updated.items():
            if label not in msbt.text_labels:
                raise ValueError(f"Unknown MSBT label: {label}")
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


def _file_kind(
    logical_path: str, file_data: bytes | None = None, romfs_path: str = ""
) -> str | None:
    lower = logical_path.lower().replace("\\", "/")
    if (
        lower.endswith(".byml")
        or lower.endswith(".bgyml")
        or lower.endswith(".byml.zs")
        or lower.endswith(".bgyml.zs")
    ):
        return "byml"
    if lower.endswith(".msbt") or lower.endswith(".msbt.zs"):
        return "msbt"
    if lower.endswith(".asb") or lower.endswith(".asb.zs"):
        return "asb"
    if lower.endswith(".baev") or lower.endswith(".baev.zs"):
        return "baev"
    if is_aamp_extension(logical_path):
        return "aamp"
    if is_xlnk_extension(logical_path):
        return "xlnk"
    if file_data is not None:
        try:
            data, _, _ = decompress_container(file_data, logical_path, romfs_path)
        except ValueError:
            data = file_data
        if is_aamp_binary(data):
            return "aamp"
        if is_xlnk_binary(data):
            return "xlnk"
    return None


def read_file_content(file_data: bytes, logical_path: str, sarc=None, romfs_path: str = "") -> str:
    kind = _file_kind(logical_path, file_data, romfs_path)
    if kind == "byml":
        return read_byml_content(file_data, logical_path, romfs_path)
    if kind == "msbt":
        return read_msbt_content(file_data, logical_path, romfs_path)
    if kind == "aamp":
        return read_aamp_content(file_data, logical_path, romfs_path)
    if kind == "asb":
        if sarc is not None:
            return read_asb_content(file_data, logical_path, sarc, romfs_path)
        return read_asb_content_disk(logical_path, romfs_path)
    if kind == "baev":
        if sarc is not None:
            return read_baev_content(file_data, logical_path, romfs_path)
        return read_baev_content_disk(logical_path, romfs_path)
    if kind == "xlnk":
        return read_xlnk_content(file_data, logical_path, romfs_path)
    return (
        f"<Binary Data: {len(file_data)} bytes. "
        "Editable types: .byml, .bgyml, .msbt, .asb, .baev, .belnk, .bslnk, "
        "AAMP (many extensions - see aamp-extensions.json)>"
    )


def write_file_content(
    logical_path: str,
    editor_text: str,
    sarc,
    is_sarc_compressed,
    archive_path,
    romfs_path: str = "",
):
    kind = _file_kind(logical_path)
    if kind is None:
        kind = _file_kind(
            logical_path,
            read_archive_file_bytes(archive_path, logical_path, romfs_path),
            romfs_path,
        )
    if kind == "byml":
        orig = read_archive_file_bytes(archive_path, logical_path, romfs_path)
        new_bytes = write_byml_bytes(orig, editor_text, logical_path, romfs_path)
        writer = oead.SarcWriter.from_sarc(sarc)
        writer.files[logical_path] = new_bytes
        save_sarc(archive_path, writer.write()[1], is_sarc_compressed)
    elif kind == "msbt":
        orig = read_archive_file_bytes(archive_path, logical_path, romfs_path)
        new_bytes = write_msbt_bytes(orig, editor_text, logical_path, romfs_path)
        writer = oead.SarcWriter.from_sarc(sarc)
        writer.files[logical_path] = new_bytes
        save_sarc(archive_path, writer.write()[1], is_sarc_compressed)
    elif kind == "aamp":
        orig = read_archive_file_bytes(archive_path, logical_path, romfs_path)
        new_bytes = write_aamp_bytes(orig, editor_text, logical_path, romfs_path)
        writer = oead.SarcWriter.from_sarc(sarc)
        writer.files[logical_path] = new_bytes
        save_sarc(archive_path, writer.write()[1], is_sarc_compressed)
    elif kind == "asb":
        if sarc is not None:
            new_sarc_bytes = write_asb_bytes(sarc, logical_path, editor_text, romfs_path)
            save_sarc(archive_path, new_sarc_bytes, is_sarc_compressed)
        else:
            write_asb_disk(logical_path, editor_text, romfs_path)
    elif kind == "baev":
        if sarc is not None:
            new_sarc_bytes = write_baev_bytes(sarc, logical_path, editor_text, romfs_path)
            save_sarc(archive_path, new_sarc_bytes, is_sarc_compressed)
        else:
            write_baev_disk(logical_path, editor_text, romfs_path)
    elif kind == "xlnk":
        orig = read_archive_file_bytes(archive_path, logical_path, romfs_path)
        new_bytes = write_xlnk_bytes(orig, editor_text, logical_path, romfs_path)
        writer = oead.SarcWriter.from_sarc(sarc)
        writer.files[logical_path] = new_bytes
        save_sarc(archive_path, writer.write()[1], is_sarc_compressed)
    else:
        raise ValueError(f"Cannot write file type: {logical_path}")


def main():
    try:
        command = sys.argv[1]
        romfs_path = get_romfs_path()

        if command == "build-romfs-index":
            from romfs_index import build_romfs_index

            output_path = sys.argv[2]
            print(json.dumps(build_romfs_index(romfs_path, output_path)))

        elif command == "build-canonical-path-index":
            from canonical_path_index import build_canonical_path_index

            output_path = sys.argv[2]
            print(json.dumps(build_canonical_path_index(romfs_path, output_path)))

        elif command == "read-disk":
            file_path = sys.argv[2]
            file_data = Path(file_path).read_bytes()
            print(
                json.dumps(
                    _json_read_payload(read_file_content(file_data, file_path, None, romfs_path))
                )
            )

        elif command == "write-disk":
            file_path = sys.argv[2]
            editor_text = sys.stdin.read()
            kind = _file_kind(file_path)
            if kind is None:
                kind = _file_kind(file_path, Path(file_path).read_bytes(), romfs_path)
            if kind == "byml":
                Path(file_path).write_bytes(
                    write_byml_bytes(
                        Path(file_path).read_bytes(), editor_text, file_path, romfs_path
                    )
                )
            elif kind == "msbt":
                Path(file_path).write_bytes(
                    write_msbt_bytes(
                        Path(file_path).read_bytes(), editor_text, file_path, romfs_path
                    )
                )
            elif kind == "aamp":
                Path(file_path).write_bytes(
                    write_aamp_bytes(
                        Path(file_path).read_bytes(), editor_text, file_path, romfs_path
                    )
                )
            elif kind == "asb":
                write_asb_disk(file_path, editor_text, romfs_path)
            elif kind == "baev":
                write_baev_disk(file_path, editor_text, romfs_path)
            elif kind == "xlnk":
                Path(file_path).write_bytes(
                    write_xlnk_bytes(
                        Path(file_path).read_bytes(), editor_text, file_path, romfs_path
                    )
                )
            else:
                raise ValueError(f"Cannot write file type: {file_path}")
            print(json.dumps({"success": True}))

        else:
            archive_path = sys.argv[2]

            if command == "list":
                locator_path = sys.argv[3] if len(sys.argv) > 3 else ""
                files = list_archive_files(archive_path, locator_path, romfs_path)
                print(json.dumps(files))

            elif command == "read":
                internal_path = sys.argv[3]
                bntx_ctx = _resolve_bntx_for_read(archive_path, internal_path, romfs_path)
                if bntx_ctx is not None:
                    bntx_data, tex_name = bntx_ctx
                    result = _read_bntx_texture_result(bntx_data, tex_name)
                    print(json.dumps(result))
                else:
                    sarc, is_sarc_compressed = load_sarc(archive_path)
                    file_data = read_archive_file_bytes(archive_path, internal_path, romfs_path)
                    print(
                        json.dumps(
                            _json_read_payload(
                                read_file_content(file_data, internal_path, sarc, romfs_path)
                            )
                        )
                    )

            elif command == "render-bntx-texture":
                internal_path = sys.argv[3]
                bntx_ctx = _resolve_bntx_for_read(archive_path, internal_path, romfs_path)
                if bntx_ctx is None:
                    print(json.dumps({"error": "Not a BNTX texture path"}))
                else:
                    bntx_data, tex_name = bntx_ctx
                    from bntx_renderer import render_texture_to_png

                    png_path = render_texture_to_png(bntx_data, tex_name)
                    if png_path:
                        print(json.dumps({"path": png_path}))
                    else:
                        print(json.dumps({"error": f"Failed to render texture: {tex_name}"}))

            elif command == "render-txtg":
                internal_path = sys.argv[3] if len(sys.argv) > 3 else ""
                if internal_path:
                    file_data = read_archive_file_bytes(archive_path, internal_path, romfs_path)
                    logical_path = internal_path
                    texture_name = Path(internal_path).name or "texture"
                else:
                    file_data = Path(archive_path).read_bytes()
                    logical_path = archive_path
                    texture_name = Path(archive_path).name or "texture"
                print(json.dumps(_read_txtg_texture_result(file_data, texture_name, logical_path)))

            elif command == "export-temp":
                internal_path = sys.argv[3]
                print(
                    json.dumps(
                        {
                            "path": export_archive_file_to_temp(
                                archive_path, internal_path, romfs_path
                            )
                        }
                    )
                )

            elif command == "write-raw":
                internal_path = sys.argv[3]
                encoded = sys.stdin.read()
                raw = base64.b64decode(encoded) if encoded else b""
                write_archive_file_bytes(archive_path, internal_path, raw, romfs_path)
                print(json.dumps({"success": True}))

            elif command == "delete-entry":
                internal_path = sys.argv[3]
                delete_archive_entry(archive_path, internal_path, romfs_path)
                print(json.dumps({"success": True}))

            elif command == "rename-entry":
                old_path = sys.argv[3]
                new_path = sys.argv[4]
                rename_archive_entry(archive_path, old_path, new_path, romfs_path)
                print(json.dumps({"success": True}))

            elif command == "write":
                sarc, is_sarc_compressed = load_sarc(archive_path)
                internal_path = sys.argv[3]
                editor_text = sys.stdin.read()
                write_file_content(
                    internal_path, editor_text, sarc, is_sarc_compressed, archive_path, romfs_path
                )
                print(json.dumps({"success": True}))

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(0)


if __name__ == "__main__":
    main()
