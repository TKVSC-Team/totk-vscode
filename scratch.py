import sys
import tempfile
from pathlib import Path

# Add the python directory to sys.path
sys.path.append(str(Path('e:/Nintendo Stuff/TOTK/TOTK Searcher Dev/totk-vscode/totk-vscode/python').resolve()))

from bntx_renderer import get_texture_metadata, render_texture_to_png
from txtg_reader import read_txtg_texture_result

def test_render():
    romfs_path = "e:/Nintendo Stuff/ROMS/Switch/Tears Dump/romfs"
    bntx_path = romfs_path + "/TexToGo/Armor_001_Lower_Alb.1.txtg"
    try:
        data = Path(bntx_path).read_bytes()
        res = read_txtg_texture_result(data, "Armor_001_Lower_Alb.1")
        if res.get("pngPath"):
            print(f"Generated PNG at: {res['pngPath']}")
        else:
            print(f"Failed to generate PNG: {res.get('error')}")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    test_render()
