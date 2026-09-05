"""Build the AINB node definition catalog from a RomFS dump.

Node signatures are recovered the way Starlight's AINBNodeMgr does it: decode every
AINB in the dump and merge what each node instance reveals - its parameters, its
properties, and the flow-output names its child plugs carry. A definition is the union
across every instance, so a parameter only a handful of actors set still shows up.

Two things node instances cannot tell us, so both are layered on top:

- Defaults come from the game's own ``<Category>/NodeDefinition/Node.Product.*.aidefn.byml``
  tables, which list every registered node's inputs (but none of its outputs). Their
  Pointer defaults are C++ source literals - "nullptr", "sead::Matrix33f::ident" - rather
  than AINB values, so only the primitive buckets are carried over. A game whose dump has
  no such tables still gets the harvested structure, just without defaults or tags.
- The Element_* flow-control nodes are fixed by the AINB format rather than by actor
  data and barely appear as harvestable instances, so they are declared below. The shapes
  match Starlight's hardcoded table.

The output is the gzipped catalog shape ``src/ainbNodeDefs.ts`` loads, so a catalog built
here and the one TKVSC ships as a fallback are interchangeable.

Which directories hold loose AINB, and where the definition tables live, come from the
active game profile's ``ainb`` section by way of the bridge environment - see
``config/games/totk.json``. The defaults below describe TotK.
"""

from __future__ import annotations

import gzip
import json
import os
from pathlib import Path

# Bumped when the catalog shape changes; the extension rebuilds on a mismatch.
CATALOG_VERSION = 2

# Fallbacks for a game profile that declares no `ainb` section; a dump without these
# directories simply contributes no loose files.
_DEFAULT_CATEGORY_DIRS = ("Logic", "AI", "Sequence")
_DEFAULT_NODE_DEFINITION_GLOB = "{category}/NodeDefinition/Node.Product.*.aidefn.byml*"

# The map editor writes this in place of a real connection name.
_NO_CONNECTION = "MapEditor_AINB_NoVal"

# aidefn input bucket -> the AINB library's value type name. Every other bucket is a
# C++ class name, i.e. a Pointer parameter.
_PRIMITIVE_BUCKETS = {
    "Bool": "Bool",
    "Int": "Int",
    "Float": "Float",
    "String": "String",
    "Vector3": "Vector3F",
}

# Flow-control nodes, whose shape comes from the format rather than from the dump.
# Ported from Starlight's AINBNodeMgr::Initialize.
_ELEMENT_DEFS = [
    {
        "name": "Element_BoolSelector",
        "type": "Element_BoolSelector",
        "cats": ["AI", "Sequence"],
        "flow": ["True", "False"],
        "in": [{"n": "Input", "t": "Bool"}],
        "props": [
            {"n": "CalculateTiming", "t": "Int"},
            {"n": "ChildFrameSync", "t": "Bool"},
            {"n": "InputValue", "t": "Bool"},
            {"n": "IsNoSelectWhenChildBusy", "t": "Bool"},
        ],
    },
    {
        "name": "Element_S32Selector",
        "type": "Element_S32Selector",
        "cats": ["AI", "Sequence"],
        "flow": ["Default"],
        "in": [{"n": "Input", "t": "Int"}],
        "props": [
            {"n": "CalculateTiming", "t": "Int"},
            {"n": "InputValue", "t": "Int"},
            {"n": "ChildFrameSync", "t": "Bool"},
            {"n": "IsNoSelectIfSameInstance", "t": "Bool"},
            {"n": "IsNoSelectWhenChildBusy", "t": "Bool"},
        ],
    },
    {
        "name": "Element_F32Selector",
        "type": "Element_F32Selector",
        "cats": ["AI", "Sequence"],
        "flow": ["Default"],
        "in": [{"n": "Input", "t": "Float"}],
        "props": [
            {"n": "CalculateTiming", "t": "Int"},
            {"n": "InputValue", "t": "Float"},
            {"n": "ChildFrameSync", "t": "Bool"},
            {"n": "IsNoSelectIfSameInstance", "t": "Bool"},
            {"n": "IsNoSelectWhenChildBusy", "t": "Bool"},
        ],
    },
    {
        "name": "Element_StringSelector",
        "type": "Element_StringSelector",
        "cats": ["AI", "Sequence"],
        "flow": ["Default"],
        "in": [{"n": "Input", "t": "String"}],
        "props": [
            {"n": "CalculateTiming", "t": "Int"},
            {"n": "InputValue", "t": "String"},
            {"n": "ChildFrameSync", "t": "Bool"},
            {"n": "IsNoSelectIfSameInstance", "t": "Bool"},
            {"n": "IsNoSelectWhenChildBusy", "t": "Bool"},
        ],
    },
    {
        "name": "Element_Sequential",
        "type": "Element_Sequential",
        "cats": ["AI", "Sequence"],
        "props": [
            {"n": "BusyPolicy", "t": "Int"},
            {"n": "NumLoop", "t": "Int"},
            {"n": "PlayPolicy", "t": "Int"},
            {"n": "ResultPolicy", "t": "Int"},
            {"n": "IsDealyJudge", "t": "Bool"},
            {"n": "IsLoop", "t": "Bool"},
            {"n": "IsUpdateNextInFrame", "t": "Bool"},
        ],
    },
    {
        "name": "Element_Simultaneous",
        "type": "Element_Simultaneous",
        "cats": ["AI", "Sequence"],
        "flow": ["Control"],
        # String in the harvested data, but the format says Int.
        "props": [{"n": "EndPolicy", "t": "Int"}, {"n": "ResultPolicy", "t": "Int"}],
    },
    {
        "name": "Element_SplitTiming",
        "type": "Element_SplitTiming",
        "cats": ["AI", "Sequence"],
        "flow": ["Enter", "Update", "Leave"],
        "props": [{"n": "ChildStateSyncPolicy", "t": "Int"}],
    },
]


def _load_ainb():
    from ainb_io import load_ainb_module

    return load_ainb_module()


def _env_list(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    parts = tuple(part.strip() for part in raw.split(",") if part.strip())
    return parts or default


def _category_dirs() -> tuple[str, ...]:
    return _env_list("TKVSC_AINB_CATEGORY_DIRS", _DEFAULT_CATEGORY_DIRS)


def _node_definition_glob() -> str:
    return os.environ.get("TKVSC_AINB_NODE_DEFS_GLOB", "").strip() or _DEFAULT_NODE_DEFINITION_GLOB


def _archive_extensions() -> tuple[str, ...]:
    from romfs_index import get_archive_extensions

    # The profile's archive list is shared with the file index, and BNTX is on it: a
    # texture container, never a SARC, and 14k+ of them in a TotK dump. Opening each one
    # only to be rejected is the difference between a minute and several.
    return tuple(ext for ext in get_archive_extensions() if not ext.startswith(".bntx"))


def _new_entry(node_type: str) -> dict:
    # Parameters are keyed by (name, value type) so the union stays deduplicated the way
    # Starlight does it, while insertion order keeps the game's own parameter order.
    return {"type": node_type, "cats": [], "flow": [], "in": {}, "out": {}, "props": {}}


def _merge_params(target: dict, groups) -> None:
    for value_type, entries in (groups or {}).items():
        for param in entries:
            name = param.get("Name")
            if not name:
                continue
            key = (name, value_type)
            if key not in target:
                target[key] = param.get("Classname") or ""


def _harvest_file(defs: dict, data: bytes, ainb_module) -> bool:
    try:
        doc = ainb_module.AINB.from_binary(data).as_dict()
    except Exception:
        return False

    category = doc.get("Category") or ""
    for node in doc.get("Nodes") or []:
        # Element_* nodes carry no name and their shape is declared above, not harvested.
        if node.get("Node Type") != "UserDefined":
            continue
        name = node.get("Name") or ""
        if not name:
            continue

        entry = defs.get(name)
        if entry is None:
            entry = defs[name] = _new_entry("UserDefined")
        if category and category not in entry["cats"]:
            entry["cats"].append(category)

        params = node.get("Parameters") or {}
        _merge_params(entry["in"], params.get("Inputs"))
        _merge_params(entry["out"], params.get("Outputs"))
        _merge_params(entry["props"], node.get("Properties"))

        for plug in (node.get("Plugs") or {}).get("Child") or []:
            plug_name = plug.get("Name")
            if plug_name and plug_name != _NO_CONNECTION and plug_name not in entry["flow"]:
                entry["flow"].append(plug_name)

    return True


def _iter_loose_ainb(romfs_root: Path, category_dirs: tuple[str, ...]):
    for category in category_dirs:
        directory = romfs_root / category
        if not directory.is_dir():
            continue
        for path in sorted(directory.rglob("*.ainb")):
            try:
                yield path.read_bytes()
            except OSError:
                continue


def _iter_archived_ainb(romfs_root: Path, romfs_path: str, counters: dict):
    from archive_resolve import load_sarc_file

    extensions = _archive_extensions()
    archives = []
    for root, _, files in os.walk(romfs_root):
        for file_name in files:
            if file_name.lower().endswith(extensions):
                archives.append(Path(root) / file_name)
    archives.sort()

    for archive_path in archives:
        counters["archives"] += 1
        try:
            sarc, _ = load_sarc_file(str(archive_path), romfs_path)
        except Exception:
            counters["unreadable_archives"] += 1
            continue
        for entry in sarc.get_files():
            if entry.name.endswith(".ainb"):
                yield bytes(entry.data)


def _default_value(bucket: str, raw):
    """An aidefn default as a JSON value, or None when it cannot be trusted."""
    if bucket == "Bool":
        return bool(raw)
    if bucket == "Int":
        try:
            return int(raw)
        except (TypeError, ValueError):
            return None
    if bucket == "Float":
        try:
            return float(raw)
        except (TypeError, ValueError):
            return None
    if bucket == "String":
        return str(raw)
    if bucket == "Vector3":
        try:
            values = [float(component) for component in raw]
        except (TypeError, ValueError):
            return None
        return values if len(values) == 3 else None
    # Pointer buckets hold C++ source literals, not AINB values.
    return None


def _node_definition_paths(romfs_root: Path, category_dirs: tuple[str, ...], pattern: str) -> list:
    """Every node definition table the profile's glob matches, in a stable order."""
    if "{category}" not in pattern:
        return sorted(romfs_root.glob(pattern))
    paths = []
    for category in category_dirs:
        paths.extend(sorted(romfs_root.glob(pattern.replace("{category}", category))))
    return paths


def _load_aidefn(
    romfs_root: Path,
    romfs_path: str,
    category_dirs: tuple[str, ...],
    pattern: str,
) -> tuple[dict, dict]:
    """Per-node input defaults and category tags from the game's own definition tables.

    A game whose dump has no such tables just yields nothing, leaving the harvested
    structure to stand on its own.
    """
    import oead

    from totk_compression import decompress_container

    defaults: dict[str, dict] = {}
    tags: dict[str, list] = {}

    for path in _node_definition_paths(romfs_root, category_dirs, pattern):
        try:
            raw = path.read_bytes()
            if path.suffix == ".zs":
                raw, _, _ = decompress_container(raw, path.name, romfs_path)
            table = oead.byml.from_binary(raw)
        except Exception:
            continue

        # oead's BYML containers hand out scalars by reference, so read them by
        # indexing rather than .get() - the latter raises on plain bools.
        for name, definition in table.items():
            node_defaults = defaults.setdefault(name, {})
            inputs = definition["Inputs"] if "Inputs" in definition else {}
            for bucket, params in inputs.items():
                value_type = _PRIMITIVE_BUCKETS.get(bucket, "Pointer")
                for param_name, param in params.items():
                    if "default" not in param:
                        continue
                    value = _default_value(bucket, param["default"])
                    if value is not None:
                        node_defaults.setdefault((param_name, value_type), value)
            for tag in definition["Tags"] if "Tags" in definition else []:
                node_tags = tags.setdefault(name, [])
                if tag not in node_tags:
                    node_tags.append(str(tag))

    return defaults, tags


def _serialize_params(params: dict, defaults: dict) -> list:
    out = []
    for (name, value_type), classname in params.items():
        entry = {"n": name, "t": value_type}
        if classname:
            entry["c"] = classname
        default = defaults.get((name, value_type))
        if default is not None:
            entry["d"] = default
        out.append(entry)
    return out


def build_ainb_node_defs(romfs_path: str, output_path: str) -> dict:
    if not romfs_path:
        raise ValueError("TKVSC_ROMFS is not set.")

    romfs_root = Path(romfs_path)
    if not romfs_root.is_dir():
        raise ValueError(f"RomFS path does not exist: {romfs_path}")

    ainb_module = _load_ainb()
    category_dirs = _category_dirs()
    defs: dict[str, dict] = {}
    counters = {"archives": 0, "unreadable_archives": 0}
    parsed = 0
    unparsed = 0

    for data in _iter_loose_ainb(romfs_root, category_dirs):
        if _harvest_file(defs, data, ainb_module):
            parsed += 1
        else:
            unparsed += 1

    for data in _iter_archived_ainb(romfs_root, romfs_path, counters):
        if _harvest_file(defs, data, ainb_module):
            parsed += 1
        else:
            unparsed += 1

    if not defs:
        raise ValueError(f"No AINB files found under {romfs_path}")

    defaults, tags = _load_aidefn(
        romfs_root, romfs_path, category_dirs, _node_definition_glob()
    )

    definitions = []
    for name, entry in defs.items():
        node_defaults = defaults.get(name, {})
        serialized = {"name": name, "type": entry["type"]}
        if entry["cats"]:
            serialized["cats"] = sorted(entry["cats"])
        if entry["flow"]:
            serialized["flow"] = entry["flow"]
        for key, source in (("in", "in"), ("out", "out"), ("props", "props")):
            # Only inputs have declared defaults; outputs are never written by the game.
            params = _serialize_params(entry[source], node_defaults if key == "in" else {})
            if params:
                serialized[key] = params
        node_tags = tags.get(name)
        if node_tags:
            serialized["tags"] = node_tags
        definitions.append(serialized)

    harvested = {definition["name"] for definition in definitions}
    definitions.extend(element for element in _ELEMENT_DEFS if element["name"] not in harvested)
    definitions.sort(key=lambda definition: definition["name"].lower())

    payload = json.dumps(
        {
            "version": CATALOG_VERSION,
            "source": f"RomFS harvest ({romfs_root.name})",
            "definitions": definitions,
        },
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")

    out_file = Path(output_path)
    out_file.parent.mkdir(parents=True, exist_ok=True)
    out_file.write_bytes(gzip.compress(payload, 9))

    return {
        "path": str(out_file),
        "count": len(definitions),
        "files": parsed,
        "unparsed": unparsed,
        "archives": counters["archives"],
    }
