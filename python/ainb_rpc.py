import argparse
import json
import sys
from pathlib import Path

# Add vendor ainb library to sys.path so we can import it directly.
_VENDOR_AINB = str(Path(__file__).resolve().parent.parent / 'vendor' / 'ainb')
if _VENDOR_AINB not in sys.path:
    sys.path.insert(0, _VENDOR_AINB)

from ainb.ainb import AINB
from ainb.node import Node, NodeType

def handle_rpc(file_path: str, command_str: str):
    try:
        command = json.loads(command_str)
        action = command.get("action")
        payload = command.get("payload", {})

        file_path_obj = Path(file_path)
        is_binary = file_path_obj.suffix.lower() == ".ainb"

        # 1. Handle decoding binary files for the frontend
        if action == "to_json":
            ainb_file = AINB.from_file(file_path) # Load as binary
            print(json.dumps({
                "status": "success", 
                "data": ainb_file.as_dict()
            }))
            return

        # 2. Handle Editor RPC Actions
        # Conditionally load based on file extension
        if is_binary:
            ainb_file = AINB.from_file(file_path)
        else:
            ainb_file = AINB.from_json(file_path)

        # Route the actions mapped to your Editing API
        if action == "link_nodes":
            src_str = payload["source"]
            tgt_str = payload["target"]
            
            # The target will always be a node (you can't link to a command)
            tgt_idx = int(tgt_str.replace("node-", ""))
            tgt_node = ainb_file.get_node(tgt_idx)

            # Check if the source is a Command (Entry Point)
            if src_str.startswith("cmd-"):
                cmd_idx = int(src_str.replace("cmd-", ""))
                command = ainb_file.get_command(cmd_idx)
                
                if command and tgt_node:
                    # Update the command to point to the new root node
                    command.root_node_index = tgt_node.index

            # Otherwise, it's a standard Node-to-Node connection
            elif src_str.startswith("node-"):
                src_idx = int(src_str.replace("node-", ""))
                src_node = ainb_file.get_node(src_idx)
                
                if src_node and tgt_node:
                    # Use your existing API to link children
                    src_node.link_child(tgt_node, connection_name="Linked")

        elif action == "remove_node":
            node_idx = int(payload["nodeId"].replace("node-", ""))
            ainb_file.remove_node(node_idx)

        elif action == "add_node":
            node_type_name = payload.get("nodeType", "UserDefined")
            new_node = Node(NodeType[node_type_name])
            new_node.name = payload.get("name", "NewNode")
            ainb_file.add_node(new_node)

        elif action == "edit_node_param":
            node_idx = payload.get("nodeId")
            param_group = payload.get("paramType")
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
                    "vec3f": ParamType.Vec3f
                }
                
                p_type = type_map.get(clean_type)
                if p_type:
                    node.update_input_default(p_type, param_name, new_val)

        else:
            raise ValueError(f"Unknown RPC action: {action}")

        # --- IN-MEMORY SAVING (NO MORE DISK LOCKS!) ---
        # Instead of writing to disk and angering the VS Code file watcher,
        # we export the new file to a base64 string and let VS Code write it.
        import base64

        if is_binary:
            out_data = ainb_file.to_binary()
            b64_data = base64.b64encode(out_data).decode('utf-8')
            print(json.dumps({"status": "success", "action": action, "data": b64_data}))
        else:
            out_data = ainb_file.to_json()
            b64_data = base64.b64encode(out_data.encode('utf-8')).decode('utf-8')
            print(json.dumps({"status": "success", "action": action, "data": b64_data}))

    except Exception as e:
        print(json.dumps({"status": "error", "message": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True, help="Path to the AINB JSON file")
    parser.add_argument("--command", required=True, help="JSON string of the RPC command")
    args = parser.parse_args()

    handle_rpc(args.file, args.command)