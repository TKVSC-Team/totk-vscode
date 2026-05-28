import sys
import os
import json
import base64
import traceback
from pathlib import Path

# Add vendor/ainb to sys.path
vendor_dir = Path(__file__).parent.parent / "vendor" / "ainb"
if vendor_dir.exists() and str(vendor_dir) not in sys.path:
    sys.path.insert(0, str(vendor_dir))

try:
    import ainb
    from ainb.ainb import AINB
except ImportError as e:
    sys.stderr.write(f"Failed to import ainb: {e}\n")
    sys.exit(1)

def read_ainb(file_path):
    try:
        import io
        from ainb.common import AINBReader
        data = Path(file_path).read_bytes()
        reader = AINBReader(io.BytesIO(data))
        parsed = AINB.read(reader)
        
        result = {
            "version": parsed.version,
            "filename": parsed.filename,
            "category": parsed.category,
            "nodes": [n._as_dict() for n in parsed.nodes],
            "commands": [c._as_dict() for c in parsed.commands] if hasattr(parsed, 'commands') else [],
            "blackboard": parsed.blackboard._as_dict() if parsed.blackboard else None,
            "modules": [m._as_dict() for m in parsed.modules] if hasattr(parsed, 'modules') else [],
            "blackboard_id": parsed.blackboard_id if hasattr(parsed, 'blackboard_id') else 0,
            "parent_blackboard_id": parsed.parent_blackboard_id if hasattr(parsed, 'parent_blackboard_id') else 0
        }
        
        # We may need to pass palette data separately or here. For now, just the file data.
        return {"success": True, "data": result}
    except Exception as e:
        return {"success": False, "error": str(e), "traceback": traceback.format_exc()}

def write_ainb(file_path, json_data):
    try:
        # TODO: Construct AINB object from dict and serialize to binary
        return {"success": False, "error": "Not implemented yet"}
    except Exception as e:
        return {"success": False, "error": str(e), "traceback": traceback.format_exc()}

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Missing command"}))
        return
        
    command = sys.argv[1]
    
    if command == "read":
        if len(sys.argv) < 3:
            print(json.dumps({"error": "Missing file path"}))
            return
        result = read_ainb(sys.argv[2])
        print(json.dumps(result))
    
    elif command == "write":
        if len(sys.argv) < 3:
            print(json.dumps({"error": "Missing file path"}))
            return
        # Read JSON from stdin
        input_data = sys.stdin.read()
        try:
            json_data = json.loads(input_data)
            result = write_ainb(sys.argv[2], json_data)
            print(json.dumps(result))
        except json.JSONDecodeError:
            print(json.dumps({"success": False, "error": "Invalid JSON input"}))
    elif command == "get-palette":
        # Parse aidef.txt
        aidef_path = Path(__file__).parent / "aidef.txt"
        if not aidef_path.exists():
            print(json.dumps({"success": False, "error": "aidef.txt not found"}))
            return
        # A simple parsing (the previous agent made `parse_aidef.py`)
        # Wait, I should just use the JSON the React app needs.
        import yaml
        try:
            data = yaml.safe_load(aidef_path.read_text("utf-8"))
            print(json.dumps({"success": True, "data": data}))
        except Exception as e:
             print(json.dumps({"success": False, "error": str(e)}))
    else:
        print(json.dumps({"error": f"Unknown command: {command}"}))

if __name__ == "__main__":
    main()
