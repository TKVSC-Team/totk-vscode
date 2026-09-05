"""Read/write AINB using the vendored TKVSC-Team/AINB toolkit.

The editor representation is the library's own dictionary form (``AINB.as_dict``),
serialized as JSON. That keeps the node graph editor and the plain-text JSON editor
working off exactly the same document, and lets the library own index remapping when
nodes are added or removed.
"""

import json
import sys
from pathlib import Path

_TOTK_VERSION = 0x407


def _ensure_ainb_toolkit_on_path() -> None:
    from vendor_sys import add_vendor_to_path

    add_vendor_to_path("ainb")


def _load_ainb_module():
    _ensure_ainb_toolkit_on_path()
    import ainb

    # Selects the TotK enum database used to resolve enum-valued parameters.
    ainb.set_tears_of_the_kingdom()
    return ainb


def load_ainb_module():
    """The AINB toolkit with the TotK enum database selected."""
    return _load_ainb_module()


def _stem_from_path(logical_path: str) -> str:
    name = Path(logical_path.replace("\\", "/")).name
    if name.endswith(".zs"):
        name = name[:-3]
    if name.endswith(".ainb"):
        name = name[:-5]
    return name


def _decompress_bytes(data: bytes, logical_path: str, romfs_path: str) -> bytes:
    from zstd_totk import decompress_container

    payload, _, _ = decompress_container(data, logical_path, romfs_path)
    return payload


def _compress_bytes(data: bytes, logical_path: str, romfs_path: str, was_compressed: bool) -> bytes:
    if not was_compressed:
        return data

    from zstd_totk import compress_container

    logical = logical_path
    if not logical.endswith(".zs"):
        logical = logical_path + ".zs"
    return compress_container(data, logical, romfs_path, was_zstd=True, was_yaz0=False)


def _to_editor_text(file_data: bytes, logical_path: str, romfs_path: str) -> str:
    ainb = _load_ainb_module()

    data = _decompress_bytes(file_data, logical_path, romfs_path)
    ainb_file = ainb.AINB.from_binary(data)
    return json.dumps(ainb_file.as_dict(), indent=2, ensure_ascii=False) + "\n"


def _repair_invariants(data: dict) -> list:
    """Restore structural invariants the writer depends on.

    Every node referenced by another node's "Queries" list must carry the "Is Query"
    flag - the writer indexes queries by node and raises a bare ``KeyError(index)``
    otherwise, which surfaces as an unhelpful "Failed to save: 20". This holds without
    exception across the retail files (3654/3654 checked), so a node that has lost the
    flag is repaired rather than rejected.

    An output parameter that nothing consumes must have "Is Output" false; retail files
    never mark an unused output (0 of 5354 checked).
    """
    repairs: list = []
    nodes = data.get("Nodes") or []

    for node in nodes:
        for query in node.get("Queries") or []:
            if not isinstance(query, int) or not (0 <= query < len(nodes)):
                continue
            flags = nodes[query].setdefault("Flags", [])
            if "Is Query" not in flags:
                flags.append("Is Query")
                repairs.append(
                    f"node {query} ({nodes[query].get('Name', '')!r}) is used as a query "
                    f"by node {node.get('Node Index')} but was missing the 'Is Query' flag"
                )

    consumed: set = set()
    for node in nodes:
        for params in (node.get("Parameters") or {}).get("Inputs", {}).values():
            for param in params:
                refs = []
                if param.get("Node Index", -1) >= 0:
                    refs.append((param["Node Index"], param.get("Output Index", 0)))
                for source in param.get("Sources") or []:
                    if source.get("Node Index", -1) >= 0:
                        refs.append((source["Node Index"], source.get("Output Index", 0)))
                # An input's declared type is only a hint at which output category holds
                # the source, so treat the index as consumed across every category.
                for node_index, output_index in refs:
                    consumed.add((node_index, output_index))

    for index, node in enumerate(nodes):
        for params in (node.get("Parameters") or {}).get("Outputs", {}).values():
            for output_index, param in enumerate(params):
                if param.get("Is Output") and (index, output_index) not in consumed:
                    param["Is Output"] = False
                    repairs.append(
                        f"node {index} output {param.get('Name', '')!r} was marked as an "
                        "output but nothing consumes it"
                    )

    return repairs


def _to_binary(editor_text: str, logical_path: str) -> bytes:
    ainb = _load_ainb_module()

    data = json.loads(editor_text)
    repairs = _repair_invariants(data)
    for repair in repairs:
        print(f"AINB: repaired before saving - {repair}", file=sys.stderr)

    try:
        ainb_file = ainb.AINB.from_dict(data)
    except KeyError as e:
        raise ValueError(
            f"AINB structure is invalid: no node/index {e}. "
            "This usually means a node references another node that no longer exists."
        ) from e
    try:
        return ainb_file.to_binary()
    except KeyError as e:
        raise ValueError(
            f"Could not serialize this AINB: missing node/index {e}. "
            "Check that every linked node still exists and is flagged correctly."
        ) from e


def read_ainb_content(file_data: bytes, logical_path: str, romfs_path: str = "") -> str:
    return _to_editor_text(file_data, logical_path, romfs_path)


def read_ainb_content_disk(file_path: str, romfs_path: str = "") -> str:
    return _to_editor_text(Path(file_path).read_bytes(), file_path, romfs_path)


def write_ainb_bytes(
    original: bytes,
    editor_text: str,
    logical_path: str,
    romfs_path: str = "",
) -> bytes:
    was_zstd = original.startswith(b"\x28\xb5\x2f\xfd")
    new_bytes = _to_binary(editor_text, logical_path)
    return _compress_bytes(new_bytes, logical_path, romfs_path, was_zstd)


def write_ainb_disk(file_path: str, editor_text: str, romfs_path: str = "") -> None:
    original = Path(file_path).read_bytes() if Path(file_path).is_file() else b""
    Path(file_path).write_bytes(write_ainb_bytes(original, editor_text, file_path, romfs_path))


def get_supported_versions() -> list:
    ainb = _load_ainb_module()
    return list(ainb.get_supported_versions())


def new_ainb_text(filename: str, category: str = "Logic") -> str:
    """Editor text for a brand new, empty AINB file."""
    return (
        json.dumps(
            {
                "Version": _TOTK_VERSION,
                "Filename": filename,
                "Category": category,
                "Blackboard ID": 0,
                "Parent Blackboard ID": 0,
                "Commands": [],
                "Nodes": [],
                "Blackboard": {},
                "Expressions": {},
                "Replacement Table": [],
                "Modules": [],
                "Unknown Section 0x58": {},
                "Has Section 0x6C": False,
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n"
    )
