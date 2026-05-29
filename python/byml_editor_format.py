"""Format oead BYML documents for editor display."""

import os

import oead

_MAX_COUNT = int(os.environ.get("TOTK_BYML_INLINE_CONTAINER_MAX_COUNT", "1"))

SCALAR_TYPES = (
    str,
    bool,
    int,
    float,
    oead.F32,
    oead.F64,
    oead.S32,
    oead.U32,
    oead.S64,
    oead.U64,
    oead.Bytes,
    type(None),
)


def _fmt_scalar(value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, oead.U64):
        return f"!ul 0x{int(value) & 0xFFFFFFFFFFFFFFFF:x}"
    if isinstance(value, oead.S64):
        signed = int(value)
        if signed < 0:
            return f"!sl 0x{signed & 0xFFFFFFFFFFFFFFFF:x}"
        return f"!sl {signed}"
    if isinstance(value, oead.U32):
        return f"!u 0x{int(value) & 0xFFFFFFFF:08x}"
    if isinstance(value, oead.S32):
        return str(int(value))
    if isinstance(value, oead.F64):
        return f"!f64 {float(value)}"
    if isinstance(value, oead.F32):
        number = float(value)
        s = str(number)
        return s if ("." in s or "e" in s or "nan" in s.lower() or "inf" in s.lower()) else s + ".0"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, oead.Bytes):
        return repr(bytes(value))
    if value is None:
        return "null"
    if isinstance(value, str):
        if not value or any(ch in value for ch in ":#[]{},\"'\n\t") or value[0] in "-?":
            return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
        return value
    return str(value)


def _is_scalar(value) -> bool:
    return isinstance(value, SCALAR_TYPES)


def _serialize_inline(node) -> str:
    if isinstance(node, oead.byml.Hash):
        entries = []
        for key in node:
            val_str = _serialize_inline(node[key])
            entries.append(f"{key}: {val_str}")
        return "{" + ", ".join(entries) + "}"
    elif isinstance(node, oead.byml.Array):
        elements = [_serialize_inline(item) for item in node]
        return "[" + ", ".join(elements) + "]"
    else:
        return _fmt_scalar(node)


def _serialize_hash_entries(node: oead.byml.Hash, indent: int) -> list[str]:
    sp = "  " * indent
    lines: list[str] = []

    for key in node:
        value = node[key]
        if isinstance(value, (oead.byml.Hash, oead.byml.Array)):
            if len(value) <= _MAX_COUNT:
                lines.append(f"{sp}{key}: {_serialize_inline(value)}")
            else:
                lines.append(f"{sp}{key}:")
                lines.extend(_serialize(value, indent + 1))
        else:
            lines.append(f"{sp}{key}: {_fmt_scalar(value)}")

    return lines


def _serialize_array_item_hash(item: oead.byml.Hash, indent: int) -> list[str]:
    sp = "  " * indent
    keys = list(item.keys())

    if len(keys) == 1:
        return _serialize_single_key_hash_item(item, keys[0], indent)

    lines: list[str] = []
    first_key = keys[0]
    first_value = item[first_key]

    if isinstance(first_value, (oead.byml.Hash, oead.byml.Array)):
        if len(first_value) <= _MAX_COUNT:
            lines.append(f"{sp}- {first_key}: {_serialize_inline(first_value)}")
        else:
            lines.append(f"{sp}- {first_key}:")
            lines.extend(_serialize(first_value, indent + 1))
    else:
        lines.append(f"{sp}- {first_key}: {_fmt_scalar(first_value)}")

    for key in keys[1:]:
        value = item[key]
        if isinstance(value, (oead.byml.Hash, oead.byml.Array)):
            if len(value) <= _MAX_COUNT:
                lines.append(f"{sp}  {key}: {_serialize_inline(value)}")
            else:
                lines.append(f"{sp}  {key}:")
                lines.extend(_serialize(value, indent + 2))
        else:
            lines.append(f"{sp}  {key}: {_fmt_scalar(value)}")

    return lines


def _serialize_single_key_hash_item(item: oead.byml.Hash, key: str, indent: int) -> list[str]:
    sp = "  " * indent
    value = item[key]
    lines: list[str] = []

    if isinstance(value, (oead.byml.Hash, oead.byml.Array)):
        if len(value) <= _MAX_COUNT:
            lines.append(f"{sp}- {key}: {_serialize_inline(value)}")
        else:
            lines.append(f"{sp}- {key}:")
            lines.extend(_serialize(value, indent + 1))
    elif _is_scalar(value):
        lines.append(f"{sp}- {key}: {_fmt_scalar(value)}")
    else:
        lines.append(f"{sp}- {key}:")
        lines.extend(_serialize(value, indent + 1))

    return lines


def _serialize_flat_hash_item(item: oead.byml.Hash, indent: int) -> list[str]:
    sp = "  " * indent
    keys = list(item.keys())
    lines: list[str] = []

    first = keys[0]
    lines.append(f"{sp}- {first}: {_fmt_scalar(item[first])}")
    for key in keys[1:]:
        lines.append(f"{sp}  {key}: {_fmt_scalar(item[key])}")

    return lines


def _serialize(node, indent: int = 0) -> list[str]:
    if isinstance(node, (oead.byml.Hash, oead.byml.Array)):
        if len(node) <= _MAX_COUNT:
            sp = "  " * indent
            return [f"{sp}{_serialize_inline(node)}"]

    if isinstance(node, oead.byml.Hash):
        return _serialize_hash_entries(node, indent)

    if isinstance(node, oead.byml.Array):
        sp = "  " * indent
        lines: list[str] = []

        for item in node:
            if isinstance(item, oead.byml.Hash):
                if len(item) <= _MAX_COUNT:
                    lines.append(f"{sp}- {_serialize_inline(item)}")
                else:
                    keys = list(item.keys())
                    if len(keys) == 1:
                        lines.extend(_serialize_single_key_hash_item(item, keys[0], indent))
                    elif keys and all(_is_scalar(item[k]) for k in keys):
                        lines.extend(_serialize_flat_hash_item(item, indent))
                    else:
                        lines.extend(_serialize_array_item_hash(item, indent))
            elif isinstance(item, oead.byml.Array):
                if len(item) <= _MAX_COUNT:
                    lines.append(f"{sp}- {_serialize_inline(item)}")
                else:
                    lines.append(f"{sp}-")
                    lines.extend(_serialize(item, indent + 1))
            else:
                lines.append(f"{sp}- {_fmt_scalar(item)}")

        return lines

    sp = "  " * indent
    return [f"{sp}{_fmt_scalar(node)}"]


def to_editor_text(document) -> str:
    return "\n".join(_serialize(document)).rstrip() + "\n"
