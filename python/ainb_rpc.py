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
            src_str = str(payload.get("sourceId", ""))
            tgt_str = str(payload.get("targetId", ""))
            
            tgt_idx = int(tgt_str.replace("node-", ""))
            tgt_node = ainb_file.get_node(tgt_idx)

            if src_str.startswith("cmd-"):
                cmd_idx = int(src_str.replace("cmd-", ""))
                command_obj = ainb_file.get_command(cmd_idx)
                if command_obj and tgt_node:
                    command_obj.root_node_index = tgt_node.index

            else:
                src_idx = int(src_str.replace("node-", ""))
                src_node = ainb_file.get_node(src_idx)
                
                # Extract the plug name from the handle (e.g. out-flow-Child-0 -> Child)
                source_handle = payload.get("sourceHandle", "")
                parts = source_handle.split("-")
                conn_name = parts[2] if len(parts) >= 3 else "Linked"
                
                if src_node and tgt_node:
                    src_node.link_child(tgt_node, connection_name=conn_name)

        # --- DATA/PARAM WIRING ---
        elif action == "link_node_params":
            src_idx = int(str(payload.get("sourceId", "")).replace("node-", ""))
            tgt_idx = int(str(payload.get("targetId", "")).replace("node-", ""))
            
            param_group = payload.get("paramType", "")
            source_idx = payload.get("sourceIdx", 0)
            target_idx = payload.get("targetIdx", 0)

            src_node = ainb_file.get_node(src_idx)
            tgt_node = ainb_file.get_node(tgt_idx)

            if src_node and tgt_node:
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
                    target_inputs = tgt_node.params.get_inputs(p_type)
                    if 0 <= target_idx < len(target_inputs):
                        target_param = target_inputs[target_idx]
                        # Correctly assign the source pointer to the existing parameter
                        tgt_node.set_input_from_node(p_type, target_param.name, src_node, source_idx)

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

        if action == "link_flow_plugs":
            source_node = ainb_file.get_node(payload["sourceId"])
            # Uses the new index-based method
            source_node.set_plug_target(
                plug_type_name=payload["plugType"], 
                plug_index=payload["plugIndex"], 
                target_node_index=payload["targetId"]
            )
            
        elif action == "link_node_params":
            target_node = ainb_file.get_node(payload["targetId"])
            # Uses the new index-based method
            target_node.set_input_from_node_by_index(
                param_type_name=payload["paramType"],
                param_index=payload["targetIdx"],
                source_node_index=payload["sourceId"],
                source_output_index=payload["sourceIdx"]
            )

        else:
            raise ValueError(f"Unknown RPC action: {action}")

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
