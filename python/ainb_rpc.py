import argparse
import base64
import json
import sys
from pathlib import Path

_VENDOR_AINB = str(Path(__file__).resolve().parent.parent / 'vendor' / 'ainb')
if _VENDOR_AINB not in sys.path:
    sys.path.insert(0, _VENDOR_AINB)

from ainb.ainb import AINB
from ainb.node import Node, NodeType


def _load_ainb(file_path: str | None, use_stdin: bool) -> tuple["AINB", bool]:
    """Load an AINB from stdin (raw binary) or from a file path.
    Returns (ainb_file, is_binary)."""
    if use_stdin:
        raw = sys.stdin.buffer.read()
        return AINB.from_binary(raw), True

    p = Path(file_path)
    is_binary = p.suffix.lower() == ".ainb"
    if is_binary:
        return AINB.from_file(file_path), True
    else:
        return AINB.from_json(file_path), False


def _parse_node_index(ref) -> int:
    """Accept node refs as `node-12`, `12`, or int."""
    if isinstance(ref, int):
        return ref
    s = str(ref)
    if s.startswith("node-"):
        return int(s.replace("node-", "", 1))
    return int(s)


def _parse_command_index(ref) -> int:
    """Accept command refs as `cmd-3`, `3`, or int."""
    if isinstance(ref, int):
        return ref
    s = str(ref)
    if s.startswith("cmd-"):
        return int(s.replace("cmd-", "", 1))
    return int(s)


def _normalize_param_type_name(name: str) -> str:
    n = str(name).strip().lower()
    alias = {
        "s32": "Int",
        "int": "Int",
        "bool": "Bool",
        "f32": "Float",
        "float": "Float",
        "string": "String",
        "vec3f": "Vector3F",
        "vector3f": "Vector3F",
        "ptr": "Pointer",
        "pointer": "Pointer",
    }
    if n in alias:
        return alias[n]
    # Fall back to title-cased value so the ainb API can attempt a match.
    return str(name)


def handle_rpc(file_path: str | None, command_str: str, use_stdin: bool = False):
    try:
        command = json.loads(command_str)
        action = command.get("action")
        payload = command.get("payload", {})

        if action == "to_json":
            ainb_file, _ = _load_ainb(file_path, use_stdin)
            print(json.dumps({
                "status": "success",
                "data": ainb_file.as_dict()
            }))
            return

        ainb_file, is_binary = _load_ainb(file_path, use_stdin)

        # --- FLOW WIRING ---
        if action == "link_flow_plugs":
            src_ref = payload.get("sourceId")
            tgt_ref = payload.get("targetId")
            tgt_idx = _parse_node_index(tgt_ref)

            src_str = str(src_ref)
            if src_str.startswith("cmd-"):
                cmd_idx = _parse_command_index(src_ref)
                command_obj = ainb_file.get_command(cmd_idx)
                if command_obj is None:
                    raise ValueError(f"Command not found: {src_ref}")
                command_obj.root_node_index = tgt_idx
            else:
                src_idx = _parse_node_index(src_ref)
                source_node = ainb_file.get_node(src_idx)
                if source_node is None:
                    raise ValueError(f"Source node not found: {src_ref}")
                plug_type = payload.get("plugType")
                plug_index = int(payload.get("plugIndex", -1))
                if plug_type is None or plug_index < 0:
                    raise ValueError("Flow link requires plugType and plugIndex")
                source_node.set_plug_target(str(plug_type), plug_index, tgt_idx)

        # --- DATA/PARAM WIRING ---
        elif action == "link_node_params":
            src_idx = _parse_node_index(payload.get("sourceId"))
            tgt_idx = _parse_node_index(payload.get("targetId"))
            target_node = ainb_file.get_node(tgt_idx)
            if target_node is None:
                raise ValueError(f"Target node not found: {tgt_idx}")
            target_node.set_input_from_node_by_index(
                param_type_name=_normalize_param_type_name(payload.get("paramType", "")),
                param_index=int(payload.get("targetIdx", 0)),
                source_node_index=src_idx,
                source_output_index=int(payload.get("sourceIdx", 0)),
            )

        # --- OTHER ACTIONS ---
        elif action == "remove_node":
            node_idx = int(payload.get("nodeId", "").replace("node-", ""))
            ainb_file.remove_node(node_idx)

        elif action == "add_node":
            node_type_name = payload.get("nodeType", "UserDefined")
            new_node = Node(NodeType[node_type_name])
            new_node.name = payload.get("name", "NewNode")
            ainb_file.add_node(new_node)

        elif action == "edit_node_param":
            node_idx = payload.get("nodeId")
            param_group = payload.get("paramType", "")
            param_name = payload.get("paramName")
            new_val = payload.get("newValue")

            node = ainb_file.get_node(node_idx)
            if node:
                from ainb.param_common import ParamType
                clean_type = param_group.lower().split(" ")[0]
                type_map = {
                    "bool": ParamType.Bool,
                    "float": ParamType.Float,
                    "int": ParamType.Int,
                    "string": ParamType.String,
                    "vec3f": ParamType.Vec3f,
                }
                p_type = type_map.get(clean_type)
                if p_type:
                    node.update_input_default(p_type, param_name, new_val)

        out_binary = ainb_file.to_binary()
        b64_data = base64.b64encode(out_binary).decode("utf-8")
        json_model = ainb_file.as_dict()

        print(json.dumps({
            "status": "success",
            "action": action,
            "data": b64_data,
            "model": json_model,
        }))

    except Exception as e:
        print(json.dumps({"status": "error", "message": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=False, help="Path to the AINB file")
    parser.add_argument("--stdin", action="store_true", help="Read raw AINB binary from stdin")
    parser.add_argument("--command", required=True, help="JSON string of the RPC command")
    args = parser.parse_args()

    handle_rpc(args.file, args.command, use_stdin=args.stdin)
