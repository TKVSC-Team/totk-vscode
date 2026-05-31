import sys
from pathlib import Path

# Add the python directory to sys.path
sys.path.append(str(Path('e:/Nintendo Stuff/TOTK/TOTK Searcher Dev/totk-vscode/totk-vscode/python').resolve()))

from bntx_renderer import render_texture_to_png

def test_render():
    romfs_path = "e:/Nintendo Stuff/ROMS/Switch/Tears Dump/romfs"
    bntx_path = romfs_path + "/Armor/Armor_001_Lower.bntx"
    try:
        data = Path(bntx_path).read_bytes()
        from bntx_renderer import _parse_textures
        textures = _parse_textures(data)
        for tex in textures:
            if tex.name == "Armor_001_Lower_Alb":
                print(f"Texture: {tex.name}, {tex.width}x{tex.height}")
                png_path = render_texture_to_png(data, tex.name)
                from PIL import Image
                img = Image.open(png_path)
                pixels = img.load()
                w, h = img.size
                print(f"  Generated PNG size: {img.size}")
                for x in range(w - 20, w):
                    transparent = True
                    for y in range(h):
                        if img.mode == 'RGBA':
                            if pixels[x, y][3] > 0:
                                transparent = False
                                break
                    if transparent:
                        print(f"Column {x} is fully transparent!")
                    else:
                        print(f"Column {x} has data.")
                break
            
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    test_render()
