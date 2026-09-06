import base64
import contextlib
import io
import json
import os
import sys
import tempfile
import traceback
from pathlib import Path

import bwav_io
import oead
from aamp_io import (
    is_aamp_binary,
    read_aamp_content,
    register_custom_hash_names,
    write_aamp_bytes,
)
from archive_resolve import (
    delete_archive_entry,
    list_archive_files,
    load_sarc_file,
    make_sarc_writer,
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
from bntx_editor import BntxEditor
from byml_editor_format import to_editor_text
from byml_yaml_utils import format_byml_for_editor, normalize_byml_u64_literals
from msbt_editor_format import from_editor_text as msbt_from_editor_text
from msbt_editor_format import to_editor_text as msbt_to_editor_text
from tag_product_format import from_editor_text as tag_product_from_editor_text
from tag_product_format import to_editor_text as tag_product_to_editor_text
from totk_compression import compress_container, decompress_container
from txtg_editor import TxtgEditor
from xlink_io import (
    is_xlnk_binary,
    read_xlnk_content,
    write_xlnk_bytes,
)

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
    if not internal_path:
        file_data = Path(archive_path).read_bytes()
        file_name = Path(archive_path).name or "file.bin"
    else:
        file_data = read_archive_file_bytes(archive_path, internal_path, romfs_path)
        file_name = Path(internal_path).name or "file.bin"

    safe_name = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in file_name)
    fd, tmp_path = tempfile.mkstemp(prefix="totk-tool-", suffix=f"-{safe_name}")
    with os.fdopen(fd, "wb") as out:
        out.write(file_data)
    return tmp_path


def _get_bntx_file_bytes(
    archive_path: str, internal_path: str, romfs_path: str
) -> tuple[bytes, str, str, bool, bool]:
    from archive_resolve import _resolve_bntx_data

    result = _resolve_bntx_data(archive_path, internal_path, romfs_path)
    if not result:
        raise ValueError("Could not resolve BNTX data")
    bntx_bytes, remainder, bntx_prefix = result
    bntx_path = bntx_prefix if bntx_prefix else ""
    is_zstd = bntx_path.endswith(".zs") if bntx_path else archive_path.endswith(".zs")
    return bntx_bytes, bntx_path, remainder, is_zstd, False


def _save_bntx_file_bytes(
    archive_path: str, bntx_path: str, new_bytes: bytes, is_zstd: bool, romfs_path: str
):
    if is_zstd:
        new_bytes = compress_container(
            new_bytes, bntx_path or archive_path, romfs_path, was_zstd=True, was_yaz0=False
        )
    if bntx_path:
        from archive_resolve import write_archive_file_bytes

        write_archive_file_bytes(archive_path, bntx_path, new_bytes, romfs_path)
    else:
        Path(archive_path).write_bytes(new_bytes)


def _save_logical_file_bytes(
    archive_path: str, logical_path: str, new_bytes: bytes, is_zstd: bool, romfs_path: str
):
    """Write a payload back to its location: recompress if the source was
    zstd, then write into the containing archive or directly to disk."""
    if is_zstd:
        new_bytes = compress_container(
            new_bytes, logical_path or archive_path, romfs_path, was_zstd=True, was_yaz0=False
        )
    if logical_path != archive_path:
        from archive_resolve import write_archive_file_bytes

        write_archive_file_bytes(archive_path, logical_path, new_bytes, romfs_path)
    else:
        Path(archive_path).write_bytes(new_bytes)


def _save_txtg_file_bytes(
    archive_path: str, logical_path: str, new_bytes: bytes, is_zstd: bool, romfs_path: str
):
    _save_logical_file_bytes(archive_path, logical_path, new_bytes, is_zstd, romfs_path)


def _txtg_extract_linear_mips(txtg_bytes: bytes):
    """Deswizzle every surface of a TXTG into linear per-mip data.

    Returns ``(width, height, key, is_srgb, is_snorm, linear_mips)`` or None.
    """
    import struct as _struct

    import dds_io
    import texture_swizzle as tsw
    from txtg_reader import _read_surface_data, _resolve_format, _u8, _u16

    if not (len(txtg_bytes) >= 8 and txtg_bytes[4:8] == b"6PK0"):
        return None

    header_size = _u16(txtg_bytes, 0) or 0x50
    width = _u16(txtg_bytes, 0x08)
    height = _u16(txtg_bytes, 0x0A)
    array_count = max(_u16(txtg_bytes, 0x0C), 1)
    mip_count = max(_u8(txtg_bytes, 0x0E), 1)
    format_id = _u16(txtg_bytes, 0x3C)
    texture_setting2 = _struct.unpack_from("<I", txtg_bytes, 0x44)[0]

    _name, bpp, blk_w, blk_h, _dec = _resolve_format(format_id, texture_setting2)
    if _dec == "astc":
        key = f"astc{blk_w}x{blk_h}"
    elif _dec in dds_io._BLOCK_INFO:
        key = _dec
    else:
        key = dds_io.txtg_format_to_key(format_id)
    if key is None or key not in dds_io._BLOCK_INFO:
        return None

    surfaces = _read_surface_data(txtg_bytes, header_size, mip_count * array_count)
    bh0 = tsw.block_height_mip0(tsw.div_round_up(height, blk_h))

    linear_mips = []
    for mip in range(mip_count):
        mw = max(1, width >> mip)
        mh = max(1, height >> mip)
        bh = tsw.mip_block_height(tsw.div_round_up(mh, blk_h), bh0)
        lin = tsw.deswizzle_mip(mw, mh, blk_w, blk_h, bpp, bh, surfaces[mip])
        linear_mips.append(lin[: dds_io.mip_linear_size(mw, mh, key)])

    is_srgb = format_id in (0x203, 0x303, 0x505, 0x109, 0x105)
    return width, height, key, is_srgb, False, linear_mips


def _export_texture_dds_bytes(
    archive_path: str, internal_path: str, romfs_path: str, file_data: bytes, logical_path: str
) -> bytes | None:
    """Build a legacy-FourCC DDS for a BNTX or TXTG texture, or None if N/A."""
    import dds_io

    is_txtg = logical_path.lower().endswith(".txtg") or file_data[4:8] == b"6PK0"

    if is_txtg:
        extracted = _txtg_extract_linear_mips(file_data)
        if extracted is None:
            return None
        width, height, key, is_srgb, is_snorm, linear_mips = extracted
        return dds_io.build_dds(width, height, key, linear_mips, is_srgb, is_snorm)

    bntx_ctx = _resolve_bntx_for_read(archive_path, internal_path, romfs_path)
    if bntx_ctx is None:
        return None
    bntx_data, tex_name = bntx_ctx
    from bntx_renderer import extract_texture_linear

    extracted = extract_texture_linear(bntx_data, tex_name)
    if extracted is None:
        return None
    width, height, decoder_key, linear, _mip_count, format_id = extracted
    key = dds_io.bntx_format_to_key(format_id)
    if key is None or key not in dds_io._BLOCK_INFO:
        return None
    # extract_texture_linear returns mip 0; export it as a single-mip DDS.
    mip0 = linear[: dds_io.mip_linear_size(width, height, key)]
    if key in dds_io._SMALL_RGBA8_EXPAND:
        # Export as an editable RGBA8 DDS; import collapses it back.
        rgba = dds_io.expand_to_rgba8(key, mip0, width * height)
        return dds_io.build_dds(width, height, "rgba8", [rgba])
    is_srgb = (format_id & 0xFF) == 0x06
    is_snorm = (format_id & 0xFF) == 0x02
    return dds_io.build_dds(width, height, key, [mip0], is_srgb, is_snorm)


def get_romfs_path():
    return (
        os.environ.get("TKVSC_ROMFS", "").strip() or os.environ.get("TOTK_EDITOR_ROMFS", "").strip()
    )


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


def _patch_python_byml():
    import byml.byml as b

    if not hasattr(b.Byml, "_orig_parse_node"):
        orig_parse = b.Byml._parse_node

        def my_parse(self, nt, off):
            if nt == 0xA2:
                return self._parse_binary_node(self._read_u32(off))
            return orig_parse(self, nt, off)

        b.Byml._orig_parse_node = orig_parse
        b.Byml._parse_node = my_parse

    if not hasattr(b.Writer, "_orig_to_byml_type"):
        orig_to_type = b.Writer._to_byml_type

        def my_to_type(self, data):
            if isinstance(data, bytes):
                return 0xA2
            return orig_to_type(self, data)

        b.Writer._orig_to_byml_type = orig_to_type
        b.Writer._to_byml_type = my_to_type
    return b


def _take_ptcl_binary(byml_doc):
    if not isinstance(byml_doc, oead.byml.Dictionary) or "PtclBin" not in byml_doc:
        return None

    node = byml_doc["PtclBin"]
    if isinstance(node, oead.byml.BinaryWithAlignment):
        ptcl_bin, alignment = bytes(node.data), int(node.alignment)
    elif isinstance(node, (oead.Bytes, bytes, memoryview)):
        ptcl_bin, alignment = bytes(node), 0
    else:
        return None

    del byml_doc["PtclBin"]
    return ptcl_bin, alignment


def _replace_ptcl_binary(byml_doc, ptcl_bin, alignment):
    if alignment:
        byml_doc["PtclBin"] = oead.byml.BinaryWithAlignment(
            oead.Bytes(ptcl_bin), oead.U32(alignment)
        )
    else:
        byml_doc["PtclBin"] = oead.Bytes(ptcl_bin)


def read_byml_content(file_data, logical_path="", romfs_path=""):
    file_data, _, _ = decompress_container(file_data, logical_path, romfs_path)
    if len(file_data) == 0:
        return "{}\n"

    if not file_data.startswith(b"YB") and not file_data.startswith(b"BY"):
        return f"<Unknown BYML Magic: {file_data[:4]}>"

    byml_doc = None
    try:
        byml_doc = oead.byml.from_binary(file_data)
    except Exception:
        pass

    if byml_doc is None:
        try:
            b = _patch_python_byml()
            py_doc = b.Byml(file_data).parse()

            def py_to_oead(node):
                if isinstance(node, dict):
                    return oead.byml.Dictionary({k: py_to_oead(v) for k, v in node.items()})
                elif isinstance(node, list):
                    return oead.byml.Array([py_to_oead(x) for x in node])
                elif isinstance(node, b.Int):
                    return oead.S32(node)
                elif isinstance(node, b.UInt):
                    return oead.U32(node)
                elif isinstance(node, b.Float):
                    return oead.F32(node)
                elif isinstance(node, b.Int64):
                    return oead.S64(node)
                elif isinstance(node, b.UInt64):
                    return oead.U64(node)
                elif isinstance(node, b.Double):
                    return oead.F64(node)
                elif isinstance(node, bytes):
                    return oead.Bytes(node)
                return node

            byml_doc = py_to_oead(py_doc)
        except Exception as e2:
            return f"# Error: Unsupported BYML version or node type\n# Detail: {str(e2)}\n"

    ptcl = _take_ptcl_binary(byml_doc)
    if ptcl is not None:
        from ptcl_io import ptclbin_to_json

        try:
            byml_doc["PTCL_JSON"] = ptclbin_to_json(ptcl[0])
        except Exception:
            _replace_ptcl_binary(byml_doc, ptcl[0], ptcl[1])

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
        import yaml

        try:
            json_data = yaml.safe_load(new_yaml)
            is_tag_product_fmt = isinstance(json_data.get("PathList"), dict)
        except Exception:
            is_tag_product_fmt = False

        if is_tag_product_fmt:
            new_byml_bytes = tag_product_from_editor_text(new_yaml, big_endian, version)
            return compress_container(new_byml_bytes, logical_path, romfs_path, is_zstd, is_yaz0)

    byml_doc = oead.byml.from_text(normalize_byml_u64_literals(new_yaml))

    if isinstance(byml_doc, oead.byml.Dictionary) and "PTCL_JSON" in byml_doc:
        from ptcl_io import json_to_ptclbin

        ptcl_json = str(byml_doc["PTCL_JSON"])
        del byml_doc["PTCL_JSON"]

        orig_doc = None
        try:
            orig_doc = oead.byml.from_binary(orig_file_data)
        except Exception:
            pass

        orig_ptcl = _take_ptcl_binary(orig_doc) if orig_doc is not None else None
        if orig_ptcl is not None:
            new_ptcl_bin = bytes(json_to_ptclbin(orig_ptcl[0], ptcl_json))
            _replace_ptcl_binary(byml_doc, new_ptcl_bin, orig_ptcl[1])
            new_byml_bytes = oead.byml.to_binary(byml_doc, big_endian=big_endian, version=version)
            return compress_container(new_byml_bytes, logical_path, romfs_path, is_zstd, is_yaz0)

        import byml.byml as b

        def oead_to_py(node):
            if isinstance(node, oead.byml.Dictionary):
                return {k: oead_to_py(v) for k, v in node.items()}
            elif isinstance(node, oead.byml.Array):
                return [oead_to_py(x) for x in node]
            elif isinstance(node, oead.S32):
                return b.Int(node)
            elif isinstance(node, oead.U32):
                return b.UInt(node)
            elif isinstance(node, oead.F32):
                return b.Float(node)
            elif isinstance(node, oead.S64):
                return b.Int64(node)
            elif isinstance(node, oead.U64):
                return b.UInt64(node)
            elif isinstance(node, oead.F64):
                return b.Double(node)
            elif isinstance(node, memoryview):
                return bytes(node)
            return node

        py_doc = oead_to_py(byml_doc)

        b_mod = _patch_python_byml()
        orig_ptcl_bin = b_mod.Byml(orig_file_data).parse().get("PtclBin", b"")

        new_ptcl_bin = json_to_ptclbin(orig_ptcl_bin, ptcl_json)
        py_doc["PtclBin"] = new_ptcl_bin

        writer = b_mod.Writer(py_doc, be=big_endian, version=version)
        new_byml_bytes = writer.get_bytes()
        return compress_container(new_byml_bytes, logical_path, romfs_path, is_zstd, is_yaz0)

    new_byml_bytes = oead.byml.to_binary(byml_doc, big_endian=big_endian, version=version)

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
    from handler_manifest import extension_to_handler_kind

    manifest_kind = extension_to_handler_kind(logical_path)
    if manifest_kind:
        return manifest_kind

    if file_data is not None:
        try:
            data, _, _ = decompress_container(file_data, logical_path, romfs_path)
        except ValueError:
            data = file_data
        if is_aamp_binary(data):
            return "aamp"
        if is_xlnk_binary(data):
            return "xlnk"
        if data[:6] == b"RESTBL":
            return "rstb"
    return None


def read_file_content(file_data: bytes, logical_path: str, sarc=None, romfs_path: str = "") -> str:
    from handler_manifest import is_addon_handler_kind, read_addon_content

    kind = _file_kind(logical_path, file_data, romfs_path)
    if kind and is_addon_handler_kind(kind):
        return read_addon_content(kind, file_data, logical_path, romfs_path)
    if kind == "byml":
        return read_byml_content(file_data, logical_path, romfs_path)
    if kind == "msbt":
        return read_msbt_content(file_data, logical_path, romfs_path)
    if kind == "aamp":
        return read_aamp_content(file_data, logical_path, romfs_path)
    if kind == "ainb":
        from ainb_io import read_ainb_content

        return read_ainb_content(file_data, logical_path, romfs_path)
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
    if kind == "rstb":
        from rstb_io import read_rstb_content

        return read_rstb_content(file_data, logical_path, romfs_path)
    return (
        f"<Binary Data: {len(file_data)} bytes. "
        "Editable types: .byml, .byaml, .bgyml, .msbt, .ainb, .asb, .baev, .belnk, .bslnk, "
        ".rsizetable, AAMP (many extensions - see aamp-extensions.json)>"
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
        try:
            orig = read_archive_file_bytes(archive_path, logical_path, romfs_path)
        except Exception:
            orig = None
        kind = _file_kind(logical_path, orig, romfs_path)

    def get_original_bytes():
        try:
            return read_archive_file_bytes(archive_path, logical_path, romfs_path)
        except Exception:
            import re

            parent = Path(logical_path).parent
            name = Path(logical_path).name
            cleaned_name = re.sub(r"_\d+(\..+)?$", r"\1", name)
            romfs_file_path = Path(romfs_path) / parent / cleaned_name
            if romfs_file_path.exists() and romfs_file_path.is_file():
                return romfs_file_path.read_bytes()
            return b""

    if kind == "byml":
        orig = get_original_bytes()
        new_bytes = write_byml_bytes(orig, editor_text, logical_path, romfs_path)
        writer = make_sarc_writer(sarc)
        writer.files[logical_path] = new_bytes
        save_sarc(archive_path, writer.write()[1], is_sarc_compressed)
    elif kind == "msbt":
        orig = get_original_bytes()
        new_bytes = write_msbt_bytes(orig, editor_text, logical_path, romfs_path)
        writer = make_sarc_writer(sarc)
        writer.files[logical_path] = new_bytes
        save_sarc(archive_path, writer.write()[1], is_sarc_compressed)
    elif kind == "aamp":
        orig = get_original_bytes()
        new_bytes = write_aamp_bytes(orig, editor_text, logical_path, romfs_path)
        writer = make_sarc_writer(sarc)
        writer.files[logical_path] = new_bytes
        save_sarc(archive_path, writer.write()[1], is_sarc_compressed)
    elif kind == "ainb":
        from ainb_io import write_ainb_bytes

        orig = get_original_bytes()
        new_bytes = write_ainb_bytes(orig, editor_text, logical_path, romfs_path)
        writer = make_sarc_writer(sarc)
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
        orig = get_original_bytes()
        new_bytes = write_xlnk_bytes(orig, editor_text, logical_path, romfs_path)
        writer = make_sarc_writer(sarc)
        writer.files[logical_path] = new_bytes
        save_sarc(archive_path, writer.write()[1], is_sarc_compressed)
    elif kind == "rstb":
        from rstb_io import write_rstb_bytes

        orig = get_original_bytes()
        new_bytes = write_rstb_bytes(orig, editor_text, logical_path, romfs_path)
        writer = make_sarc_writer(sarc)
        writer.files[logical_path] = new_bytes
        save_sarc(archive_path, writer.write()[1], is_sarc_compressed)
    elif kind:
        from handler_manifest import is_addon_handler_kind, write_addon_bytes

        if is_addon_handler_kind(kind):
            orig = get_original_bytes()
            new_bytes = write_addon_bytes(kind, orig, editor_text, logical_path, romfs_path)
            writer = make_sarc_writer(sarc)
            writer.files[logical_path] = new_bytes
            save_sarc(archive_path, writer.write()[1], is_sarc_compressed)
        else:
            raise ValueError(f"Cannot write file type: {logical_path}")
    else:
        raise ValueError(f"Cannot write file type: {logical_path}")


def main():
    try:
        command = sys.argv[1]
        romfs_path = get_romfs_path()
        register_custom_hash_names()

        if command == "build-romfs-index":
            from romfs_index import build_romfs_index

            output_path = sys.argv[2]
            print(json.dumps(build_romfs_index(romfs_path, output_path)))

        elif command == "build-ainb-node-defs":
            from ainb_node_defs import build_ainb_node_defs

            output_path = sys.argv[2]
            print(json.dumps(build_ainb_node_defs(romfs_path, output_path)))

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
            elif kind == "ainb":
                from ainb_io import write_ainb_disk

                write_ainb_disk(file_path, editor_text, romfs_path)
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
            elif kind == "rstb":
                from rstb_io import write_rstb_bytes

                Path(file_path).write_bytes(
                    write_rstb_bytes(
                        Path(file_path).read_bytes(), editor_text, file_path, romfs_path
                    )
                )
            else:
                raise ValueError(f"Cannot write file type: {file_path}")
            print(json.dumps({"success": True}))

        elif command == "decompress-file":
            input_path = sys.argv[2]
            logical_path = sys.argv[3] if len(sys.argv) > 3 else input_path
            file_data = Path(input_path).read_bytes()
            decompressed, _, _ = decompress_container(file_data, logical_path, romfs_path)
            fd, tmp_path = tempfile.mkstemp(
                prefix="totk-decomp-", suffix="-" + Path(logical_path).name.replace(".zs", "")
            )
            with os.fdopen(fd, "wb") as out:
                out.write(decompressed)
            print(json.dumps({"path": tmp_path}))

        elif command == "read-font-disk":
            from bfttf_io import decrypt_bfttf

            file_path = sys.argv[2]
            file_data = Path(file_path).read_bytes()
            logical_path = file_path.replace("\\", "/")
            if logical_path.lower().endswith(".zs"):
                file_data, _, _ = decompress_container(file_data, logical_path, romfs_path)
                logical_path = logical_path[:-3]
            if logical_path.lower().endswith((".bfotf", ".bfttf")):
                file_data = decrypt_bfttf(file_data)
            safe_name = Path(logical_path).name or "font.bin"
            safe_name = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in safe_name)
            fd, tmp_path = tempfile.mkstemp(prefix="totk-font-", suffix=f"-{safe_name}")
            with os.fdopen(fd, "wb") as out:
                out.write(file_data)
            print(json.dumps({"path": tmp_path}))

        elif command == "prepare-font-replacement":
            from archive_resolve import read_fs_path_bytes
            from bfttf_io import prepare_font_replacement

            import_path = sys.argv[2]
            target_path = sys.argv[3]
            import_data = Path(import_path).read_bytes()
            target_existing = None
            try:
                target_existing = read_fs_path_bytes(target_path, romfs_path)
            except Exception:
                target_existing = None
            out = prepare_font_replacement(import_data, import_path, target_path, target_existing)
            safe_name = Path(target_path).name or "font.bin"
            safe_name = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in safe_name)
            fd, tmp_path = tempfile.mkstemp(prefix="totk-font-out-", suffix=f"-{safe_name}")
            with os.fdopen(fd, "wb") as out_file:
                out_file.write(out)
            print(json.dumps({"path": tmp_path}))

        elif command == "compress-file":
            input_path = sys.argv[2]
            logical_path = sys.argv[3] if len(sys.argv) > 3 else input_path
            file_data = Path(input_path).read_bytes()
            compressed = compress_container(
                file_data, logical_path, romfs_path, was_zstd=True, was_yaz0=False
            )
            fd, tmp_path = tempfile.mkstemp(
                prefix="totk-comp-", suffix="-" + Path(logical_path).name
            )
            with os.fdopen(fd, "wb") as out:
                out.write(compressed)
            print(json.dumps({"path": tmp_path}))

        elif command == "evaluate-hexpat":
            input_path = sys.argv[2]
            file_data = Path(input_path).read_bytes()
            hexpat_code = sys.stdin.read()

            hexpyt_src = os.path.abspath(
                os.path.join(os.path.dirname(os.path.dirname(__file__)), "vendor", "hexpyt", "src")
            )
            if hexpyt_src not in sys.path:
                sys.path.insert(0, hexpyt_src)

            try:
                import primitives
                from compiler import compile_text
            except ImportError as e:
                print(json.dumps({"error": f"Failed to load hexpat compiler: {e}"}))
                sys.exit(0)

            try:
                python_code = compile_text(hexpat_code)
            except Exception as e:
                print(json.dumps({"error": f"Hexpat compile error: {e}"}))
                sys.exit(0)

            with open(r"C:\Users\dmone\Desktop\hexpat_generated.py", "w") as f:
                f.write(python_code)

            local_env = {
                "byts": file_data,
                "primitives": primitives,
            }
            for k in dir(primitives):
                if not k.startswith("_"):
                    local_env[k] = getattr(primitives, k)

            primitives.std.mem.byts = file_data

            import threading

            exec_error = None

            def run_exec():
                nonlocal exec_error
                import sys

                old_limit = sys.getrecursionlimit()
                sys.setrecursionlimit(5000)
                try:
                    primitives.std.mem.byts = file_data
                    exec(python_code, local_env, local_env)
                except Exception as e:
                    exec_error = e
                finally:
                    sys.setrecursionlimit(old_limit)

            threading.stack_size(32 * 1024 * 1024)  # 32 MB
            t = threading.Thread(target=run_exec)
            t.start()
            t.join()

            if exec_error is not None:
                print(
                    json.dumps(
                        {
                            "error": f"Hexpat exec error: {type(exec_error).__name__} - {str(exec_error)}"
                        }
                    )
                )
                sys.exit(0)

            ast_nodes = []

            def dump_ast(obj, name, visited=None, depth=0):
                if depth > 100:
                    return {
                        "name": name,
                        "type": "MaxDepthReached",
                        "start_offset": 0,
                        "size": 0,
                        "children": [],
                    }
                if visited is None:
                    visited = set()
                if id(obj) in visited:
                    return None
                visited.add(id(obj))

                if isinstance(obj, list):
                    if len(obj) == 0:
                        return None
                    if not isinstance(obj[0], primitives.Struct):
                        return None
                    start = int(obj[0].address())
                    end = int(obj[-1].dollar())
                    node = {
                        "name": name,
                        "type": "Array",
                        "start_offset": start,
                        "size": end - start,
                        "children": [],
                    }
                    for i, item in enumerate(obj):
                        child = dump_ast(item, f"[{i}]", visited, depth + 1)
                        if child:
                            node["children"].append(child)
                    return node
                elif isinstance(obj, primitives.Struct):
                    node = {
                        "name": name,
                        "type": obj.__class__.__name__,
                        "start_offset": int(obj.address()),
                        "size": int(obj.size()),
                        "children": [],
                    }
                    if hasattr(obj, "value"):
                        try:
                            node["value"] = str(obj.value())
                        except Exception:
                            pass
                    for k, v in obj.__dict__.items():
                        if not k.startswith("_") and k != "value":
                            child = dump_ast(v, k, visited, depth + 1)
                            if child:
                                node["children"].append(child)
                    return node
                return None

            for k, v in local_env.items():
                if (
                    isinstance(v, primitives.Struct)
                    and not k.startswith("_")
                    and type(v) is not type
                ):
                    node = dump_ast(v, k)
                    if node:
                        ast_nodes.append(node)

            print(json.dumps({"ast": ast_nodes}))

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

            elif command == "read-bwav":
                internal_path = sys.argv[3] if len(sys.argv) > 3 else ""
                if internal_path:
                    file_data = read_archive_file_bytes(archive_path, internal_path, romfs_path)
                    logical_path = internal_path
                else:
                    file_data = Path(archive_path).read_bytes()
                    logical_path = archive_path
                from bwav_io import read_bwav_to_temp_wav

                try:
                    wav_path = read_bwav_to_temp_wav(file_data, logical_path, romfs_path)
                    print(json.dumps({"wavPath": wav_path}))
                except Exception as e:
                    print(json.dumps({"error": str(e)}))

            elif command == "list-bars":
                internal_path = sys.argv[3] if len(sys.argv) > 3 else ""
                if internal_path:
                    file_data = read_archive_file_bytes(archive_path, internal_path, romfs_path)
                    logical_path = internal_path
                else:
                    file_data = Path(archive_path).read_bytes()
                    logical_path = archive_path
                from bars_io import list_bars_entries

                try:
                    entries = list_bars_entries(file_data, logical_path, romfs_path)
                    print(json.dumps({"entries": entries}))
                except Exception as e:
                    print(json.dumps({"error": str(e)}))

            elif command == "read-bars-audio":
                internal_path = sys.argv[3] if len(sys.argv) > 3 else ""
                entry_index = int(sys.argv[4]) if len(sys.argv) > 4 else 0
                force_prefetch = sys.argv[5] == "true" if len(sys.argv) > 5 else False
                if internal_path:
                    file_data = read_archive_file_bytes(archive_path, internal_path, romfs_path)
                    logical_path = internal_path
                else:
                    file_data = Path(archive_path).read_bytes()
                    logical_path = archive_path
                from bars_io import read_bars_entry_audio

                try:
                    res = read_bars_entry_audio(
                        file_data, entry_index, logical_path, romfs_path, force_prefetch
                    )
                    print(
                        json.dumps(
                            {
                                "wavPath": res.wav_path,
                                "name": res.name,
                                "isPrefetch": res.is_prefetch,
                                "loopStart": res.loop_start,
                                "loopEnd": res.loop_end,
                            }
                        )
                    )
                except Exception as e:
                    print(json.dumps({"error": str(e)}))

            elif command == "replace-bars-audio":
                import struct as _struct

                import bwav_writer
                from bars_io import parse_bars
                from bars_writer import rebuild_bars

                internal_path = sys.argv[3] if len(sys.argv) > 3 else ""
                entry_index = int(sys.argv[4]) if len(sys.argv) > 4 else 0

                # Loop args: "auto" (honor the file's own loop metadata),
                # "none" (no loop), or a sample number.
                def _parse_loop_arg(value: str):
                    value = value.strip().lower()
                    if value in ("", "auto", "-1"):
                        return "auto"
                    if value == "none":
                        return "none"
                    return int(value)

                loop_start_arg = _parse_loop_arg(sys.argv[5]) if len(sys.argv) > 5 else "auto"
                loop_end_arg = _parse_loop_arg(sys.argv[6]) if len(sys.argv) > 6 else "auto"
                name_hint = sys.argv[7] if len(sys.argv) > 7 else "audio.bin"

                encoded = sys.stdin.read()
                payload = base64.b64decode(encoded) if encoded else b""

                if internal_path:
                    file_data = read_archive_file_bytes(archive_path, internal_path, romfs_path)
                    logical_path = internal_path
                else:
                    file_data = Path(archive_path).read_bytes()
                    logical_path = archive_path

                data, _, is_zstd = decompress_container(file_data, logical_path, romfs_path)
                bars = parse_bars(data)
                if entry_index >= len(bars.entries):
                    raise IndexError(
                        f"Entry index {entry_index} out of range "
                        f"(BARS has {len(bars.entries)} entries)"
                    )
                entry = bars.entries[entry_index]

                if payload[:4] == b"BWAV":
                    full_bwav = payload
                    if loop_start_arg == "none":
                        full_bwav = bwav_writer.set_bwav_loop(full_bwav, None, None)
                    elif loop_start_arg != "auto":
                        loop_end_val = loop_end_arg if isinstance(loop_end_arg, int) else 0x7FFFFFFF
                        full_bwav = bwav_writer.set_bwav_loop(
                            full_bwav, loop_start_arg, loop_end_val
                        )
                else:
                    if payload[:4] != b"RIFF":
                        # Any other format (MP3, OGG, FLAC, ...) goes through ffmpeg.
                        payload = bwav_writer.decode_audio_to_wav(payload, name_hint)
                    wav = bwav_writer.parse_wav(payload)
                    if loop_start_arg == "none":
                        ls, le = None, None
                    elif loop_start_arg == "auto":
                        ls, le = wav.loop_start, wav.loop_end
                    else:
                        ls = loop_start_arg
                        le = loop_end_arg if isinstance(loop_end_arg, int) else 0x7FFFFFFF
                    full_bwav = bwav_writer.build_bwav(wav.channels, wav.sample_rate, ls, le)

                # Report the loop actually written to the file.
                le_out, ls_out = _struct.unpack_from("<ii", full_bwav, 0x10 + 0x3C)
                used_loop_start = ls_out if le_out != -1 else None
                used_loop_end = le_out if le_out != -1 else None

                # Raw pair-table offset (bars_io reports -1 for dummy clips, but
                # the table may still point at a real, replaceable block).
                num_assets = _struct.unpack_from("<I", data, 0xC)[0]
                pairs_start = 0x10 + num_assets * 4
                raw_bwav_off = _struct.unpack_from("<i", data, pairs_start + entry_index * 8 + 4)[0]

                embedded = None
                needs_stream_file = False
                if raw_bwav_off in (-1, 0):
                    # Stream-only entry: nothing embedded to swap. The caller
                    # gets the full BWAV to drop into Sound/Resource/Stream/.
                    needs_stream_file = True
                else:
                    was_prefetch = _struct.unpack_from("<H", data, raw_bwav_off + 0xC)[0] != 0
                    if was_prefetch:
                        blob = bwav_writer.make_prefetch_bwav(full_bwav)
                        embedded = "prefetch"
                        needs_stream_file = True
                    else:
                        blob = full_bwav
                        embedded = "full"
                    new_data = rebuild_bars(data, {entry_index: blob})
                    _save_logical_file_bytes(
                        archive_path, logical_path, new_data, is_zstd, romfs_path
                    )

                fd, bwav_tmp = tempfile.mkstemp(prefix="totk-bwav-full-", suffix=".bwav")
                with os.fdopen(fd, "wb") as out:
                    out.write(full_bwav)

                print(
                    json.dumps(
                        {
                            "success": True,
                            "name": entry.name,
                            "embedded": embedded,
                            "needsStreamFile": needs_stream_file,
                            "fullBwavTempPath": bwav_tmp,
                            "numSamples": bwav_writer.bwav_num_samples(full_bwav),
                            "channels": bwav_writer.bwav_channel_count(full_bwav),
                            "loopStart": used_loop_start,
                            "loopEnd": used_loop_end,
                        }
                    )
                )

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

            elif command == "export-converted":
                internal_path = sys.argv[3]
                target_ext = sys.argv[4].lower()
                if internal_path:
                    file_data = read_archive_file_bytes(archive_path, internal_path, romfs_path)
                    logical_path = internal_path
                else:
                    file_data = Path(archive_path).read_bytes()
                    logical_path = archive_path

                kind = _file_kind(logical_path, file_data, romfs_path)

                out_path = export_archive_file_to_temp(archive_path, internal_path, romfs_path)

                if target_ext in [".png", ".jpg", ".jpeg", ".bmp", ".tga", ".dds"]:
                    png_path = None
                    is_txtg = (
                        kind == "txtg"
                        or logical_path.lower().endswith(".txtg")
                        or file_data[4:8] == b"6PK0"
                    )

                    bntx_data = None
                    tex_name = None

                    if is_txtg:
                        from txtg_reader import read_txtg_texture_result

                        tex_name = Path(logical_path).name or "texture"
                        res = read_txtg_texture_result(file_data, tex_name)
                        png_path = res.get("pngPath")
                    else:
                        bntx_ctx = _resolve_bntx_for_read(archive_path, internal_path, romfs_path)
                        if bntx_ctx is not None:
                            bntx_data, tex_name = bntx_ctx
                            from bntx_renderer import render_texture_to_png

                            png_path = render_texture_to_png(bntx_data, tex_name)

                    if png_path:
                        try:
                            from PIL import Image

                            img = Image.open(png_path)
                            fd, cvt_path = tempfile.mkstemp(prefix="totk-cvt-", suffix=target_ext)
                            os.close(fd)

                            if target_ext == ".dds":
                                native_dds_bytes = None
                                try:
                                    native_dds_bytes = _export_texture_dds_bytes(
                                        archive_path,
                                        internal_path,
                                        romfs_path,
                                        file_data,
                                        logical_path,
                                    )
                                except Exception:
                                    traceback.print_exc()
                                    native_dds_bytes = None

                                if native_dds_bytes is not None:
                                    with open(cvt_path, "wb") as f:
                                        f.write(native_dds_bytes)
                                else:
                                    img = img.convert("RGBA")
                                    width, height = img.size
                                    pixels = img.tobytes("raw", "RGBA")
                                    header = bytearray(128)
                                    header[0:4] = b"DDS "
                                    header[4:8] = (124).to_bytes(4, "little")
                                    header[8:12] = (0x100F).to_bytes(4, "little")
                                    header[12:16] = height.to_bytes(4, "little")
                                    header[16:20] = width.to_bytes(4, "little")
                                    header[20:24] = (width * 4).to_bytes(4, "little")
                                    header[24:28] = (1).to_bytes(4, "little")
                                    header[28:32] = (1).to_bytes(4, "little")
                                    header[76:80] = (32).to_bytes(4, "little")
                                    header[80:84] = (0x41).to_bytes(4, "little")
                                    header[88:92] = (32).to_bytes(4, "little")
                                    header[92:96] = (0x000000FF).to_bytes(4, "little")
                                    header[96:100] = (0x0000FF00).to_bytes(4, "little")
                                    header[100:104] = (0x00FF0000).to_bytes(4, "little")
                                    header[104:108] = (0xFF000000).to_bytes(4, "little")
                                    header[108:112] = (0x1000).to_bytes(4, "little")
                                    with open(cvt_path, "wb") as f:
                                        f.write(header)
                                        f.write(pixels)
                            else:
                                if target_ext in [".jpg", ".jpeg"] and img.mode in ("RGBA", "P"):
                                    img = img.convert("RGB")
                                img.save(cvt_path)

                            img.close()
                            os.unlink(png_path)
                            if os.path.exists(out_path):
                                os.unlink(out_path)
                            out_path = cvt_path
                        except Exception:
                            traceback.print_exc()
                            out_path = png_path

                elif target_ext in [".yaml", ".yml"]:
                    if kind == "byml" or kind == "bgyml":
                        yaml_text = read_byml_content(file_data, internal_path, romfs_path)
                        fd, yaml_path = tempfile.mkstemp(prefix="totk-cvt-", suffix=target_ext)
                        os.close(fd)
                        Path(yaml_path).write_text(yaml_text, encoding="utf-8")
                        os.unlink(out_path)
                        out_path = yaml_path
                    elif kind == "aamp":
                        from aamp_io import read_aamp_content

                        yaml_text = read_aamp_content(file_data, internal_path, romfs_path)
                        fd, yaml_path = tempfile.mkstemp(prefix="totk-cvt-", suffix=target_ext)
                        os.close(fd)
                        Path(yaml_path).write_text(yaml_text, encoding="utf-8")
                        os.unlink(out_path)
                        out_path = yaml_path
                    elif kind == "rstb":
                        from rstb_io import read_rstb_content

                        yaml_text = read_rstb_content(file_data, logical_path, romfs_path)
                        fd, yaml_path = tempfile.mkstemp(prefix="totk-cvt-", suffix=target_ext)
                        os.close(fd)
                        Path(yaml_path).write_text(yaml_text, encoding="utf-8")
                        os.unlink(out_path)
                        out_path = yaml_path

                elif target_ext in [".json", ".txt"] and kind == "msbt":
                    from msbt_editor_format import to_editor_text

                    res_json = _read_msbt_payload(file_data, internal_path, romfs_path)
                    labels = res_json.get("metadata", {}).get("labels", {})

                    if target_ext == ".json":
                        output_text = json.dumps(labels, indent=2, ensure_ascii=False)
                    else:
                        output_text = to_editor_text(labels)

                    fd, txt_path = tempfile.mkstemp(prefix="totk-cvt-", suffix=target_ext)
                    os.close(fd)
                    Path(txt_path).write_text(output_text, encoding="utf-8")
                    os.unlink(out_path)
                    out_path = txt_path

                print(json.dumps({"path": out_path}))

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

            elif command == "update-metadata":
                internal_path = sys.argv[3]
                metadata_str = sys.argv[4]
                metadata = json.loads(metadata_str)
                bntx_bytes, bntx_path, _, is_zstd, _ = _get_bntx_file_bytes(
                    archive_path, internal_path, romfs_path
                )
                editor = BntxEditor(bntx_bytes)
                tex_name = metadata.get("name", "")
                if not tex_name:
                    from bntx_reader import _read_bntx_string

                    name_addr = editor._read_fmt("q", editor.get_texture_ptrs()[0] + 0x10 + 0x50)
                    tex_name = _read_bntx_string(editor._data, name_addr, editor.le)
                editor.update_metadata(tex_name, metadata)
                _save_bntx_file_bytes(
                    archive_path, bntx_path, editor.to_bytes(), is_zstd, romfs_path
                )
                print(json.dumps({"success": True}))

            elif command == "update-txtg-metadata":
                internal_path = sys.argv[3]
                metadata_str = sys.argv[4]
                metadata = json.loads(metadata_str)
                if internal_path:
                    file_data = read_archive_file_bytes(archive_path, internal_path, romfs_path)
                    logical_path = internal_path
                else:
                    file_data = Path(archive_path).read_bytes()
                    logical_path = archive_path

                try:
                    payload, _, is_zstd = decompress_container(file_data, logical_path, romfs_path)
                except Exception:
                    payload = file_data
                    is_zstd = False

                editor = TxtgEditor(payload)
                if "useSRGB" in metadata and metadata["useSRGB"] is not None:
                    use_srgb = bool(metadata["useSRGB"])
                    fmt = editor.format_id

                    if fmt == 0x101 and editor.texture_setting2 == 32631:
                        fmt = 0x102

                    srgb_map = {
                        0x101: 0x109,
                        0x109: 0x109,  # ASTC 4x4
                        0x102: 0x105,
                        0x105: 0x105,  # ASTC 8x8
                        0x202: 0x203,
                        0x203: 0x203,  # BC1
                        0x302: 0x303,
                        0x303: 0x303,  # BC1
                        0x505: 0x505,  # BC3
                        0x602: 0x602,
                        0x606: 0x606,
                        0x607: 0x607,  # BC4
                        0x702: 0x703,
                        0x703: 0x703,  # BC5
                    }
                    unorm_map = {
                        0x109: 0x101,
                        0x101: 0x101,
                        0x105: 0x102,
                        0x102: 0x102,
                        0x203: 0x202,
                        0x202: 0x202,
                        0x303: 0x302,
                        0x302: 0x302,
                        0x505: 0x505,
                        0x602: 0x602,
                        0x606: 0x606,
                        0x607: 0x607,
                        0x703: 0x702,
                        0x702: 0x702,
                    }
                    if use_srgb:
                        if fmt == 0x101 and editor.texture_setting2 not in (0, 32631):
                            pass
                        elif fmt in srgb_map:
                            editor.format_id = srgb_map[fmt]
                    elif not use_srgb and fmt in unorm_map:
                        editor.format_id = unorm_map[fmt]

                channels = ["Red", "Green", "Blue", "Alpha", "Zero", "One"]
                ch_map = {c: i for i, c in enumerate(channels)}
                if "red" in metadata and metadata["red"] in ch_map:
                    editor.comp_r = ch_map[metadata["red"]]
                if "green" in metadata and metadata["green"] in ch_map:
                    editor.comp_g = ch_map[metadata["green"]]
                if "blue" in metadata and metadata["blue"] in ch_map:
                    editor.comp_b = ch_map[metadata["blue"]]
                if "alpha" in metadata and metadata["alpha"] in ch_map:
                    editor.comp_a = ch_map[metadata["alpha"]]

                _save_txtg_file_bytes(
                    archive_path, logical_path, editor.to_bytes(), is_zstd, romfs_path
                )
                print(json.dumps({"success": True}))

            elif command == "replace-bntx-payload":
                internal_path = sys.argv[3]
                encoded = sys.stdin.read()
                dds_bytes = base64.b64decode(encoded) if encoded else b""

                ctx = _resolve_bntx_for_read(archive_path, internal_path, romfs_path)
                if ctx is None:
                    raise ValueError("Could not resolve BNTX texture for replacement.")
                _bntx_data, tex_name = ctx
                bntx_bytes, bntx_path, _, is_zstd, _ = _get_bntx_file_bytes(
                    archive_path, internal_path, romfs_path
                )

                editor = BntxEditor(bntx_bytes)
                info = editor.import_dds(tex_name, dds_bytes)
                _save_bntx_file_bytes(
                    archive_path, bntx_path, editor.to_bytes(), is_zstd, romfs_path
                )
                print(json.dumps({"success": True, **info}))

            elif command == "replace-txtg-payload":
                internal_path = sys.argv[3]
                encoded = sys.stdin.read()
                dds_bytes = base64.b64decode(encoded) if encoded else b""

                if internal_path:
                    file_data = read_archive_file_bytes(archive_path, internal_path, romfs_path)
                    logical_path = internal_path
                else:
                    file_data = Path(archive_path).read_bytes()
                    logical_path = archive_path

                try:
                    payload, _, is_zstd = decompress_container(file_data, logical_path, romfs_path)
                except Exception:
                    payload = file_data
                    is_zstd = False

                editor = TxtgEditor(payload)
                info = editor.import_dds(dds_bytes)
                _save_txtg_file_bytes(
                    archive_path, logical_path, editor.to_bytes(), is_zstd, romfs_path
                )
                print(json.dumps({"success": True, **info}))

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

            elif command == "read-bwav-audio":
                internal_path = sys.argv[3]

                if internal_path:
                    file_data = read_archive_file_bytes(archive_path, internal_path, romfs_path)
                    bwav_name = internal_path
                else:
                    with open(archive_path, "rb") as f:
                        file_data = f.read()
                    bwav_name = archive_path

                if bwav_io.is_dummy_bwav(file_data, bwav_name, romfs_path):
                    raise ValueError(
                        "This BWAV is a dummy clip (0 samples) and contains no audio data."
                    )

                # Decode to wav and extract loops
                wav_path, loop_start, loop_end = bwav_io.read_bwav_to_temp_wav(
                    file_data, bwav_name, romfs_path
                )

                res = {
                    "wavPath": wav_path,
                    "name": Path(bwav_name).name,
                    "isPrefetch": False,
                    "loopStart": loop_start,
                    "loopEnd": loop_end,
                }
                print(json.dumps(res))

    except Exception as e:
        print(json.dumps({"error": str(e), "traceback": traceback.format_exc()}))
        sys.exit(0)


if __name__ == "__main__":
    main()
